import os
import sys
import argparse
from flask import Flask, jsonify, request, send_from_directory, Response
from tbparse import SummaryReader
import pandas as pd
from collections import defaultdict
import logging
import time
import webbrowser
import threading
import re # For regex matching in log files
from pathlib import Path # For easier path manipulation
import atexit # To handle thread shutdown

# --- Globals ---
RUN_DATA_CACHE = {} # Now stores {'run_name': {'scalars': {...}, 'hydra_overrides': '...' | None}}
CACHE_LOAD_TIME = 0
LOG_ROOT_DIR = None
HYDRA_MULTIRUN_DIR = None # Store the path to hydra multirun
REFRESH_INTERVAL_SECONDS = 60 # Refresh cache every 60 seconds
background_thread = None
stop_event = threading.Event() # Used to signal the background thread to stop

# --- Flask App Setup ---
frontend_folder = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")
app = Flask(__name__, static_folder=frontend_folder)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
app.logger.setLevel(logging.INFO)
for handler in app.logger.handlers:
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s: %(message)s"))


# --- Helper Function: Find Hydra Overrides ---
def find_hydra_overrides(tb_run_name, hydra_multirun_root, log_root_dir):
    """
    Tries to find the hydra overrides.yaml content for a given TensorBoard run name.

    Args:
        tb_run_name (str): The directory name of the TensorBoard run.
        hydra_multirun_root (str): The absolute path to the hydra multirun directory.
        log_root_dir (str): The absolute path to the main log directory (parent of tb_run_name).

    Returns:
        str | None: The content of the overrides.yaml file, or None if not found/error.
    """
    if not hydra_multirun_root or not os.path.isdir(hydra_multirun_root):
        return None

    # Construct the full path to the TB run directory to potentially search for in logs
    # This assumes the tb_run_name itself might be logged. Adjust if a different ID is logged.
    tb_run_path_identifier = os.path.join(log_root_dir, tb_run_name)
    # Alternative: Just use the run name as the identifier to search for
    search_term = tb_run_name

    app.logger.debug(f"Searching for Hydra overrides for '{tb_run_name}' using search term '{search_term}' in '{hydra_multirun_root}'")

    try:
        # Search recursively for .out files containing the search term
        # Using pathlib and glob for potentially better cross-platform compatibility
        hydra_path = Path(hydra_multirun_root)
        # Search within .submitit directories for log files
        matching_log_files = []
        # Look for typical submitit log patterns
        for log_file in hydra_path.rglob(".submitit/*/*_log.out"):
            try:
                with open(log_file, 'r', encoding='utf-8', errors='ignore') as f:
                    # Read file content efficiently (check first N lines/KB?)
                    # For simplicity now, read the whole file if small, or chunk it
                    content_to_check = f.read(50 * 1024) # Check first 50KB
                    if search_term in content_to_check:
                        matching_log_files.append(log_file)
                        app.logger.debug(f"Found potential match in log file: {log_file}")
                        break # Take the first match found
            except Exception as e_read:
                app.logger.warning(f"Could not read or search log file {log_file}: {e_read}")
                continue # Skip this file

        if not matching_log_files:
            # Try another common pattern: jobid_taskid.out
            for log_file in hydra_path.rglob(".submitit/*/*.out"):
                 try:
                     with open(log_file, 'r', encoding='utf-8', errors='ignore') as f:
                         content_to_check = f.read(50 * 1024)
                         if search_term in content_to_check:
                             matching_log_files.append(log_file)
                             app.logger.debug(f"Found potential match in log file (pattern 2): {log_file}")
                             break
                 except Exception as e_read:
                     app.logger.warning(f"Could not read or search log file {log_file} (pattern 2): {e_read}")
                     continue

        if not matching_log_files:
            app.logger.debug(f"No Submitit log file found containing '{search_term}' for run '{tb_run_name}'.")
            return None

        # Take the first match
        submitit_log_path = matching_log_files[0]
        app.logger.debug(f"Using Submitit log file: {submitit_log_path} for run '{tb_run_name}'")

        # --- Derive Hydra run directory ---
        # Example submitit_log_path: /path/to/multirun/DATE/TIME/.submitit/JOB_ARRAY/JOB_ARRAY_TASK_log.out
        # Target Hydra Dir:          /path/to/multirun/DATE/TIME/TASK/
        try:
            submitit_dir = submitit_log_path.parent # .submitit/JOB_ARRAY/ or .submitit/JOB_TASK/
            multirun_timestamp_dir = submitit_dir.parent.parent # DATE/TIME/

            # Extract task ID from filename (e.g., 12345_0_log.out -> 0)
            log_filename = submitit_log_path.name
            task_id = None

            # Pattern 1: jobid_taskid_log.out
            match1 = re.match(r'(\d+)_(\d+)_log\.out', log_filename)
            if match1:
                task_id = match1.group(2)
                app.logger.debug(f"Extracted Task ID '{task_id}' from filename '{log_filename}' (pattern 1)")

            # Pattern 2: jobid_taskid.out
            if not task_id:
                match2 = re.match(r'(\d+)_(\d+)\.out', log_filename)
                if match2:
                    task_id = match2.group(2)
                    app.logger.debug(f"Extracted Task ID '{task_id}' from filename '{log_filename}' (pattern 2)")

            # Pattern 3: Check directory name like JOB_TASK
            if not task_id:
                dir_match = re.match(r'(\d+)_(\d+)', submitit_dir.name)
                if dir_match:
                    task_id = dir_match.group(2)
                    app.logger.debug(f"Extracted Task ID '{task_id}' from directory name '{submitit_dir.name}'")

            # Pattern 4: SLURM-like slurm-%j_%t.out (less reliable for task ID alone)
            # If still no task_id, we might need more sophisticated logic or user config

            if task_id is None:
                app.logger.warning(f"Could not extract task ID from log filename '{log_filename}' or dir '{submitit_dir.name}' for run '{tb_run_name}'. Cannot find Hydra overrides.")
                return None

            # Construct potential Hydra run directory path
            hydra_run_dir = multirun_timestamp_dir / task_id

            if not hydra_run_dir.is_dir():
                # Sometimes the task ID might be zero-padded, try that
                try:
                    padded_task_id = f"{int(task_id):03d}" # Example: 3 digits padding
                    hydra_run_dir_padded = multirun_timestamp_dir / padded_task_id
                    if hydra_run_dir_padded.is_dir():
                        hydra_run_dir = hydra_run_dir_padded
                        app.logger.debug(f"Using zero-padded task ID directory: {hydra_run_dir}")
                    else:
                         app.logger.warning(f"Derived Hydra run directory '{hydra_run_dir}' (and padded variants) do not exist for run '{tb_run_name}'.")
                         return None
                except ValueError: # If task_id wasn't an integer
                     app.logger.warning(f"Derived Hydra run directory '{hydra_run_dir}' does not exist for run '{tb_run_name}'.")
                     return None


            # Look for overrides.yaml
            overrides_file = hydra_run_dir / ".hydra" / "overrides.yaml"
            if overrides_file.is_file():
                app.logger.info(f"Found Hydra overrides file for run '{tb_run_name}': {overrides_file}")
                try:
                    content = overrides_file.read_text(encoding='utf-8')
                    return content
                except Exception as e_read_yaml:
                    app.logger.error(f"Error reading overrides file {overrides_file}: {e_read_yaml}")
                    return None # Indicate error reading
            else:
                app.logger.debug(f"Overrides file not found at '{overrides_file}' for run '{tb_run_name}'.")
                return None

        except Exception as e_derive:
            app.logger.error(f"Error deriving Hydra path for run '{tb_run_name}' from log '{submitit_log_path}': {e_derive}", exc_info=True)
            return None

    except Exception as e_glob:
        app.logger.error(f"Error searching for log files in '{hydra_multirun_root}': {e_glob}", exc_info=True)
        return None


# --- Preloading Function (Modified for Atomicity) ---
def preload_all_runs_unified():
    """Loads scalar data and potentially Hydra overrides for ALL runs into a temporary cache,
       then atomically replaces the global cache."""
    global RUN_DATA_CACHE, CACHE_LOAD_TIME, LOG_ROOT_DIR, HYDRA_MULTIRUN_DIR
    start_time = time.time()
    app.logger.info(f"--- Background Refresh: Starting unified data loading from: {LOG_ROOT_DIR} ---")
    if HYDRA_MULTIRUN_DIR:
        app.logger.info(f"--- Background Refresh: Will attempt to find Hydra overrides in: {HYDRA_MULTIRUN_DIR} ---")

    temp_cache = {} # Build data into a temporary dictionary

    if not LOG_ROOT_DIR or not os.path.isdir(LOG_ROOT_DIR):
        app.logger.error(f"Background Refresh: Invalid log directory: {LOG_ROOT_DIR}")
        # Don't update the main cache if logdir is invalid
        load_duration = time.time() - start_time
        app.logger.info(f"--- Background Refresh: Skipped (invalid logdir). Duration: {load_duration:.2f}s ---")
        return

    try:
        # --- Core Change: Read all runs at once ---
        app.logger.info(f"Background Refresh: Reading all runs in {LOG_ROOT_DIR} using SummaryReader...")
        reader = SummaryReader(
            LOG_ROOT_DIR,
            pivot=False,
            extra_columns={"wall_time", "dir_name"},
            event_types={"scalars"},
        )
        df_all = reader.scalars
        read_duration = time.time() - start_time
        app.logger.info(f"Background Refresh: SummaryReader finished in {read_duration:.2f}s.")

        if df_all is None or df_all.empty:
            app.logger.warning(f"Background Refresh: No scalar data found in any runs within {LOG_ROOT_DIR}")
            # Still check for overrides for directories that *might* be runs even if no scalars
            # For simplicity, only process dirs found by tbparse or existing dirs if hydra is enabled
            run_dirs_to_check_overrides = set()
            if HYDRA_MULTIRUN_DIR:
                 try:
                     # Get all immediate subdirectories of LOG_ROOT_DIR
                     run_dirs_to_check_overrides = {d.name for d in Path(LOG_ROOT_DIR).iterdir() if d.is_dir()}
                     app.logger.info(f"Background Refresh: No scalars, but checking {len(run_dirs_to_check_overrides)} dirs for overrides due to --hydra-multirun-dir.")
                 except Exception as e_dir:
                     app.logger.error(f"Background Refresh: Error listing directories in {LOG_ROOT_DIR} for override check: {e_dir}")

            if not run_dirs_to_check_overrides:
                 # No scalars and no dirs to check for overrides
                 RUN_DATA_CACHE = {} # Atomically clear the cache
                 CACHE_LOAD_TIME = time.time() - start_time
                 app.logger.info(f"--- Background Refresh: Finished (no data/overrides found). Cache cleared. Duration: {CACHE_LOAD_TIME:.2f}s ---")
                 return
            else:
                 # Proceed to check overrides even without scalar data
                 df_all = pd.DataFrame(columns=["step", "value", "wall_time", "tag", "dir_name"]) # Empty df for structure
                 # Add the directories found to the processing list
                 for dir_name in run_dirs_to_check_overrides:
                      temp_cache[dir_name] = {
                          'scalars': {}, # No scalars found
                          'hydra_overrides': None
                      }
                 app.logger.info("Background Refresh: Proceeding to check for overrides only.")


        else: # df_all is not empty
            app.logger.info(f"Background Refresh: Read {len(df_all)} total scalar points. Processing...")

            # --- Data Cleaning (on the combined DataFrame) ---
            step_col, value_col, time_col, tag_col, run_col = ("step", "value", "wall_time", "tag", "dir_name")
            required_cols = {step_col, value_col, time_col, tag_col, run_col}
            if not required_cols.issubset(df_all.columns):
                app.logger.error(f"Background Refresh: Missing required columns in combined DataFrame. Found: {df_all.columns}, Required: {required_cols}")
                if "dir_name" not in df_all.columns:
                     app.logger.error("Background Refresh: Crucially, 'dir_name' column is missing! Cannot process runs.")
                     # Don't update cache if dir_name is missing
                     load_duration = time.time() - start_time
                     app.logger.info(f"--- Background Refresh: Failed (missing 'dir_name'). Duration: {load_duration:.2f}s ---")
                     return
                missing = required_cols - set(df_all.columns)
                app.logger.warning(f"Background Refresh: Missing optional columns: {missing}. Proceeding.")
                required_cols = set(df_all.columns).intersection(required_cols)

            df_all = df_all[list(required_cols)].copy()
            for col in [step_col, value_col, time_col]:
                 if col in df_all.columns:
                     df_all[col] = pd.to_numeric(df_all[col], errors='coerce')
            initial_rows = len(df_all)
            cols_to_check_na = [col for col in [step_col, value_col, time_col] if col in df_all.columns]
            if cols_to_check_na: df_all.dropna(subset=cols_to_check_na, inplace=True)
            if value_col in df_all.columns: df_all = df_all[~df_all[value_col].isin([float("inf"), -float("inf")])]
            dropped_rows = initial_rows - len(df_all)
            if dropped_rows > 0: app.logger.debug(f"Background Refresh: Dropped {dropped_rows} rows with NaN/Inf values.")

            if df_all.empty:
                app.logger.warning(f"Background Refresh: No valid scalar data remaining after cleaning.")
                # Still check for overrides if hydra dir is set
                if not HYDRA_MULTIRUN_DIR:
                    RUN_DATA_CACHE = {} # Atomically clear cache
                    CACHE_LOAD_TIME = time.time() - start_time
                    app.logger.info(f"--- Background Refresh: Finished (no valid data). Cache cleared. Duration: {CACHE_LOAD_TIME:.2f}s ---")
                    return
                else:
                    # Get run names from original reader output before cleaning
                    try:
                        all_run_names = set(reader.scalars['dir_name'].unique()) if reader.scalars is not None and 'dir_name' in reader.scalars else set()
                        app.logger.info(f"Background Refresh: No valid scalars, but checking {len(all_run_names)} dirs for overrides.")
                        for run_name in all_run_names:
                             temp_cache[run_name] = {'scalars': {}, 'hydra_overrides': None}
                    except Exception as e:
                         app.logger.error(f"Background Refresh: Error getting run names for override check: {e}")
                         RUN_DATA_CACHE = {} # Clear cache on error
                         CACHE_LOAD_TIME = time.time() - start_time
                         app.logger.info(f"--- Background Refresh: Failed (error getting run names). Cache cleared. Duration: {CACHE_LOAD_TIME:.2f}s ---")
                         return


            else: # df_all has valid data after cleaning
                if step_col in df_all.columns: df_all[step_col] = df_all[step_col].astype(int)
                if time_col in df_all.columns: df_all[time_col] = df_all[time_col].astype(float)
                if run_col in df_all.columns: df_all[run_col] = df_all[run_col].astype(str)

                # --- Restructure data into the temporary cache ---
                app.logger.info("Background Refresh: Restructuring data for cache...")
                grouped_by_run = df_all.groupby(run_col)

                for run_name, run_df in grouped_by_run:
                    temp_cache[run_name] = {
                        'scalars': defaultdict(lambda: {"steps": [], "values": [], "wall_times": []}),
                        'hydra_overrides': None
                    }
                    run_scalar_data = temp_cache[run_name]['scalars']
                    grouped_by_tag = run_df.groupby(tag_col)
                    for tag, tag_df in grouped_by_tag:
                        tag_df = tag_df.sort_values(by=step_col)
                        if not tag_df.empty:
                            if step_col in tag_df: run_scalar_data[tag]["steps"] = tag_df[step_col].to_list()
                            if value_col in tag_df: run_scalar_data[tag]["values"] = tag_df[value_col].to_list()
                            if time_col in tag_df: run_scalar_data[tag]["wall_times"] = tag_df[time_col].to_list()
                    # Convert defaultdict back to dict
                    temp_cache[run_name]['scalars'] = dict(run_scalar_data)

        # --- Find Hydra Overrides for all runs in temp_cache ---
        processed_runs_count = 0
        runs_with_data_or_overrides = set()
        if HYDRA_MULTIRUN_DIR:
            app.logger.info(f"Background Refresh: Checking for Hydra overrides for {len(temp_cache)} potential runs...")
            for run_name in list(temp_cache.keys()): # Iterate over keys list for safe modification
                overrides_content = find_hydra_overrides(run_name, HYDRA_MULTIRUN_DIR, LOG_ROOT_DIR)
                if overrides_content:
                    temp_cache[run_name]['hydra_overrides'] = overrides_content
                    runs_with_data_or_overrides.add(run_name)
                    app.logger.debug(f"Background Refresh: Stored overrides for run '{run_name}'.")
                # Check if the run has scalar data
                if temp_cache[run_name].get('scalars'):
                    runs_with_data_or_overrides.add(run_name)

            # Filter temp_cache: keep only runs with data or overrides
            final_temp_cache = {
                run: data for run, data in temp_cache.items()
                if run in runs_with_data_or_overrides
            }
            removed_count = len(temp_cache) - len(final_temp_cache)
            if removed_count > 0:
                app.logger.info(f"Background Refresh: Removed {removed_count} runs from cache that had neither scalar data nor overrides.")
            temp_cache = final_temp_cache # Use the filtered cache
            processed_runs_count = len(temp_cache)

        else: # No hydra dir, count runs with scalar data
             processed_runs_count = len(temp_cache)


        # --- Atomically update the global cache ---
        RUN_DATA_CACHE = temp_cache
        CACHE_LOAD_TIME = time.time() - start_time
        app.logger.info(
            f"--- Background Refresh: Finished in {CACHE_LOAD_TIME:.2f}s. "
            f"Processed data/overrides for {processed_runs_count} runs into cache. ---"
        )

    except ImportError as e:
        app.logger.error(f"Background Refresh: ImportError during tbparse read: {e}. Is TensorFlow installed?", exc_info=True)
        # Don't update cache on error
        load_duration = time.time() - start_time
        app.logger.info(f"--- Background Refresh: Failed (ImportError). Duration: {load_duration:.2f}s ---")
    except Exception as e:
        app.logger.error(f"Background Refresh: Error during unified preloading: {e}", exc_info=True)
        # Don't update cache on error
        load_duration = time.time() - start_time
        app.logger.info(f"--- Background Refresh: Failed (Exception). Duration: {load_duration:.2f}s ---")


# --- Background Refresh Task ---
def background_refresh_task():
    """Periodically calls preload_all_runs_unified."""
    app.logger.info(f"Background refresh thread started. Interval: {REFRESH_INTERVAL_SECONDS}s")
    while not stop_event.is_set():
        try:
            preload_all_runs_unified()
        except Exception as e:
            app.logger.error(f"Exception in background refresh task: {e}", exc_info=True)
        # Wait for the interval or until the stop event is set
        stop_event.wait(REFRESH_INTERVAL_SECONDS)
    app.logger.info("Background refresh thread stopped.")

def start_background_refresh():
    """Starts the background refresh thread."""
    global background_thread
    if background_thread is None or not background_thread.is_alive():
        stop_event.clear()
        background_thread = threading.Thread(target=background_refresh_task, daemon=True)
        background_thread.start()
        app.logger.info("Background refresh thread initiated.")

def stop_background_refresh():
    """Signals the background refresh thread to stop."""
    global background_thread
    if background_thread and background_thread.is_alive():
        app.logger.info("Signaling background refresh thread to stop...")
        stop_event.set()
        background_thread.join(timeout=5) # Wait briefly for thread to finish
        if background_thread.is_alive():
            app.logger.warning("Background refresh thread did not stop gracefully.")
        else:
            app.logger.info("Background refresh thread joined.")
        background_thread = None


# --- API Endpoints ---

def _get_runs_info_from_cache(cache_to_inspect):
    available_runs_info = []
    for run_name in sorted(cache_to_inspect.keys()):
         run_entry = cache_to_inspect.get(run_name, {})
         available_runs_info.append({
             'name': run_name,
             'has_overrides': bool(run_entry.get('hydra_overrides'))
         })
    return available_runs_info

@app.route("/api/runs")
def get_runs():
    app.logger.debug(f"Request received for /api/runs")
    current_cache_snapshot = RUN_DATA_CACHE.copy()
    available_runs_info = _get_runs_info_from_cache(current_cache_snapshot)
    app.logger.debug(f"Returning {len(available_runs_info)} available runs from cache with override status.")
    return jsonify(available_runs_info)








# New: Endpoint to get hydra overrides for a specific run
@app.route("/api/overrides")
def get_overrides():
    run_name = request.args.get("run")
    if not run_name:
        return jsonify({"error": "No run specified"}), 400

    app.logger.debug(f"Request: /api/overrides for run: {run_name}")

    # Access cache safely
    run_data = RUN_DATA_CACHE.get(run_name)
    if not run_data:
        # Check if the run *might* exist on disk but wasn't cached (e.g., error during load)
        # For simplicity, we only report based on the current cache.
        app.logger.warning(f"Run '{run_name}' not found in current cache for overrides request.")
        return jsonify({"error": f"Run '{run_name}' not found in cache"}), 404

    overrides_content = run_data.get('hydra_overrides')
    if overrides_content is None:
        app.logger.debug(f"No Hydra overrides found in cache for run '{run_name}'.")
        return jsonify({"error": f"No Hydra overrides found for run '{run_name}'"}), 404

    app.logger.debug(f"Returning Hydra overrides for run '{run_name}'.")
    return Response(overrides_content, mimetype='text/plain')

@app.route("/api/refresh", methods=['POST'])
def trigger_refresh_and_return_cached_runs():
    app.logger.info("POST /api/refresh: Request received. Will return current cached runs and trigger background refresh.")

    current_cache_snapshot = RUN_DATA_CACHE.copy()
    runs_to_return = _get_runs_info_from_cache(current_cache_snapshot)
    app.logger.debug(f"/api/refresh: Prepared {len(runs_to_return)} cached runs for immediate response.")

    def do_refresh_on_demand():
        app.logger.info("/api/refresh: Starting on-demand background refresh.")
        try:
            preload_all_runs_unified()
            app.logger.info("/api/refresh: On-demand background refresh completed successfully.")
        except Exception as e:
            app.logger.error(f"/api/refresh: Exception during on-demand background refresh: {e}", exc_info=True)

    refresh_thread = threading.Thread(target=do_refresh_on_demand, daemon=True)
    refresh_thread.start()
    app.logger.info("/api/refresh: Initiated on-demand background refresh in a new thread.")

    return jsonify(runs_to_return)



# Modified: Access data within the 'scalars' key
@app.route("/api/data")
def get_data():
    selected_runs_str = request.args.get("runs", "")
    if not selected_runs_str:
        return jsonify({"error": "No runs specified"}), 400

    selected_runs = selected_runs_str.split(",")
    app.logger.info(f"Request: /api/data for runs: {selected_runs} (serving scalars from cache)")

    all_metrics_data = defaultdict(dict)
    start_time = time.time()
    runs_served_count = 0
    runs_missing_or_no_scalars = []
    metrics_collected = set()

    # Access cache safely
    current_cache_snapshot = RUN_DATA_CACHE

    for run_name in selected_runs:
        run_cache_entry = current_cache_snapshot.get(run_name)
        run_scalars_from_cache = run_cache_entry.get('scalars') if run_cache_entry else None

        if run_scalars_from_cache: # Check if run exists AND has scalar data
            served_run = False
            for metric_name, metric_data in run_scalars_from_cache.items():
                if isinstance(metric_data, dict) and metric_data.get("steps"):
                    all_metrics_data[metric_name][run_name] = metric_data
                    metrics_collected.add(metric_name)
                    served_run = True
            if served_run:
                runs_served_count += 1
            else:
                runs_missing_or_no_scalars.append(run_name)
        else:
            runs_missing_or_no_scalars.append(run_name)

    duration = time.time() - start_time
    log_message = (
        f"Scalar data assembly took {duration * 1000:.2f}ms. "
        f"Served scalar data for {runs_served_count}/{len(selected_runs)} requested runs. "
        f"Collected {len(metrics_collected)} distinct scalar metrics."
    )
    if runs_missing_or_no_scalars:
        log_message += f" Runs missing or no scalars: {runs_missing_or_no_scalars}"
    app.logger.info(log_message)

    if not all_metrics_data and runs_served_count > 0:
        app.logger.warning(f"No common/valid scalar data found across the successfully served runs: {selected_runs}")
        return jsonify({})
    elif not all_metrics_data:
         return jsonify({})

    return jsonify(dict(all_metrics_data))


# --- Static File Serving (Keep as before) ---
@app.route("/")
def serve_index():
    return send_from_directory(app.static_folder, "index.html")

@app.route("/<path:filename>")
def serve_static(filename):
    # Basic path validation
    if ".." in filename or filename.startswith(("/", "\\")):
        app.logger.warning(f"Invalid static file path requested: {filename}")
        return "Invalid path", 400
    try:
        return send_from_directory(app.static_folder, filename)
    except FileNotFoundError:
         app.logger.warning(f"Static file not found: {filename}")
         return "File not found", 404


# --- Main Execution / CLI Entry Point (Modified) ---
def main():
    global LOG_ROOT_DIR, HYDRA_MULTIRUN_DIR, REFRESH_INTERVAL_SECONDS

    parser = argparse.ArgumentParser(
        description="p-board: A faster TensorBoard log viewer with Hydra support."
    )
    parser.add_argument(
        "--logdir",
        type=str,
        required=True,
        help="Root directory containing TensorBoard run subdirectories.",
    )
    parser.add_argument(
        "--hydra-multirun-dir",
        type=str,
        default=None,
        help="Path to the Hydra multirun directory (e.g., 'multirun/'). If provided, attempts to link runs to overrides.",
    )
    parser.add_argument(
        "--refresh-interval",
        type=int,
        default=REFRESH_INTERVAL_SECONDS, # Use global default
        help=f"Interval (seconds) for background data refresh (default: {REFRESH_INTERVAL_SECONDS}). Set to 0 to disable.",
    )
    parser.add_argument("--port", type=int, default=5001, help="Port number.")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host address.")
    parser.add_argument("--no-browser", action="store_true", help="Do not open browser.")
    parser.add_argument("--debug", action="store_true", help="Enable Flask debug mode.")

    args = parser.parse_args()

    REFRESH_INTERVAL_SECONDS = args.refresh_interval

    LOG_ROOT_DIR = os.path.abspath(args.logdir)
    print(f"p-board: Using log directory: {LOG_ROOT_DIR}")

    if not os.path.isdir(LOG_ROOT_DIR):
        print(f"!!! ERROR: Log directory does not exist: {LOG_ROOT_DIR}", file=sys.stderr)
        sys.exit(1)

    if args.hydra_multirun_dir:
        HYDRA_MULTIRUN_DIR = os.path.abspath(args.hydra_multirun_dir)
        if not os.path.isdir(HYDRA_MULTIRUN_DIR):
            print(f"!!! WARNING: Specified Hydra multirun directory does not exist: {HYDRA_MULTIRUN_DIR}. Overrides will not be loaded.", file=sys.stderr)
            HYDRA_MULTIRUN_DIR = None
        else:
             print(f"p-board: Using Hydra multirun directory: {HYDRA_MULTIRUN_DIR}")
    else:
        print("p-board: Hydra multirun directory not specified. Overrides will not be loaded.")


    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
        app.logger.setLevel(logging.DEBUG)
        print("p-board: Debug mode enabled.")
    else:
        logging.getLogger().setLevel(logging.INFO)
        app.logger.setLevel(logging.INFO)

    # --- Initial Preload ---
    # Call directly first to populate cache before server starts fully
    preload_all_runs_unified()

    # --- Start Background Refresh Thread (if interval > 0) ---
    if REFRESH_INTERVAL_SECONDS > 0:
        start_background_refresh()
        # Register the stop function to be called on exit
        atexit.register(stop_background_refresh)
        print(f"p-board: Background refresh enabled every {REFRESH_INTERVAL_SECONDS} seconds.")
    else:
        print("p-board: Background refresh disabled.")


    # --- Browser opening and server start ---
    if not args.no_browser:
        url = f"http://{args.host}:{args.port}"
        def open_browser():
            time.sleep(1.0)
            print(f"p-board: Opening browser at {url} ...")
            webbrowser.open(url)
        browser_thread = threading.Thread(target=open_browser, daemon=True)
        browser_thread.start()
        print(f"p-board: View at {url}")
    else:
        print(f"p-board: View at http://{args.host}:{args.port}")

    print("--- Server Ready ---")
    # Disable Flask's reloader when using our background thread or debug mode
    # Flask's reloader can cause issues with background threads.
    use_reloader_flag = False # Generally safer to disable Flask reloader with threads
    if args.debug:
         print("p-board: Flask debug mode is ON, but Flask's auto-reloader is disabled for stability with background tasks.")

    app.run(debug=args.debug, port=args.port, host=args.host, use_reloader=use_reloader_flag)


if __name__ == "__main__":
    main()
