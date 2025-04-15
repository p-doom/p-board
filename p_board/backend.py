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
import glob # For finding log files

# --- Globals ---
RUN_DATA_CACHE = {} # Now stores {'run_name': {'scalars': {...}, 'hydra_overrides': '...' | None}}
CACHE_LOAD_TIME = 0
LOG_ROOT_DIR = None
HYDRA_MULTIRUN_DIR = None # Store the path to hydra multirun

# --- Flask App Setup --- (Keep as before)
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
            app.logger.debug(f"No Submitit log file found containing '{search_term}' for run '{tb_run_name}'.")
            return None

        # Take the first match
        submitit_log_path = matching_log_files[0]
        app.logger.debug(f"Using Submitit log file: {submitit_log_path} for run '{tb_run_name}'")

        # --- Derive Hydra run directory ---
        # Example submitit_log_path: /path/to/multirun/DATE/TIME/.submitit/JOB_ARRAY/JOB_ARRAY_TASK_log.out
        # Target Hydra Dir:          /path/to/multirun/DATE/TIME/TASK/
        try:
            submitit_dir = submitit_log_path.parent # .submitit/JOB_ARRAY/
            multirun_timestamp_dir = submitit_dir.parent.parent # DATE/TIME/

            # Extract task ID from filename (e.g., 12345_0_log.out -> 0)
            log_filename = submitit_log_path.name
            match = re.match(r'(\d+)_(\d+)_log\.out', log_filename) # Simple pattern, adjust if needed
            if not match:
                 # Try another common pattern like jobid_taskid.out
                 match = re.match(r'(\d+)_(\d+)\.out', log_filename)
                 if not match:
                     # Try SLURM pattern like slurm-%j_%t.out -> task id might not be in filename
                     # Let's try parsing the *directory name* if filename fails
                     task_id_match = re.match(r'(\d+)_(\d+)', submitit_dir.name) # Check if dir is JOB_TASK
                     if task_id_match:
                         task_id = task_id_match.group(2)
                         app.logger.debug(f"Extracted Task ID '{task_id}' from directory name '{submitit_dir.name}'")
                     else:
                        app.logger.warning(f"Could not extract task ID from log filename '{log_filename}' or dir '{submitit_dir.name}' for run '{tb_run_name}'. Cannot find Hydra overrides.")
                        return None
                 else:
                    task_id = match.group(2) # Task ID is the second group
                    app.logger.debug(f"Extracted Task ID '{task_id}' from filename '{log_filename}' (pattern 2)")
            else:
                task_id = match.group(2) # Task ID is the second group
                app.logger.debug(f"Extracted Task ID '{task_id}' from filename '{log_filename}' (pattern 1)")

            # Construct potential Hydra run directory path
            hydra_run_dir = multirun_timestamp_dir / task_id

            if not hydra_run_dir.is_dir():
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


# --- Preloading Function (Modified) ---
def preload_all_runs_unified():
    """Loads scalar data and potentially Hydra overrides for ALL runs."""
    global RUN_DATA_CACHE, CACHE_LOAD_TIME, LOG_ROOT_DIR, HYDRA_MULTIRUN_DIR
    start_time = time.time()
    app.logger.info(f"--- Starting unified data preloading from: {LOG_ROOT_DIR} ---")
    if HYDRA_MULTIRUN_DIR:
        app.logger.info(f"--- Will attempt to find Hydra overrides in: {HYDRA_MULTIRUN_DIR} ---")

    RUN_DATA_CACHE = {}  # Clear previous cache

    if not LOG_ROOT_DIR or not os.path.isdir(LOG_ROOT_DIR):
        app.logger.error(f"Invalid log directory for preloading: {LOG_ROOT_DIR}")
        CACHE_LOAD_TIME = time.time() - start_time
        app.logger.info(f"--- Preloading skipped (invalid logdir). Duration: {CACHE_LOAD_TIME:.2f}s ---")
        return

    try:
        # --- Core Change: Read all runs at once ---
        app.logger.info(f"Reading all runs in {LOG_ROOT_DIR} using SummaryReader...")
        reader = SummaryReader(
            LOG_ROOT_DIR,
            pivot=False,
            extra_columns={"wall_time", "dir_name"},
            event_types={"scalars"},
        )
        df_all = reader.scalars
        read_duration = time.time() - start_time
        app.logger.info(f"SummaryReader finished in {read_duration:.2f}s.")

        if df_all is None or df_all.empty:
            app.logger.warning(f"No scalar data found in any runs within {LOG_ROOT_DIR}")
            # Still check for overrides for directories that *might* be runs even if no scalars
            # This is complex. Let's stick to runs found by tbparse for now.
            CACHE_LOAD_TIME = time.time() - start_time
            app.logger.info(f"--- Preloading finished (no scalar data). Duration: {CACHE_LOAD_TIME:.2f}s ---")
            return

        app.logger.info(f"Read {len(df_all)} total scalar points. Processing...")

        # --- Data Cleaning (on the combined DataFrame) ---
        step_col, value_col, time_col, tag_col, run_col = ("step", "value", "wall_time", "tag", "dir_name")
        required_cols = {step_col, value_col, time_col, tag_col, run_col}
        if not required_cols.issubset(df_all.columns):
            app.logger.error(f"Missing required columns in combined DataFrame. Found: {df_all.columns}, Required: {required_cols}")
            # Handle missing 'dir_name' specifically
            if "dir_name" not in df_all.columns:
                 app.logger.error("Crucially, 'dir_name' column is missing from SummaryReader output! Cannot process runs.")
                 CACHE_LOAD_TIME = time.time() - start_time
                 app.logger.info(f"--- Preloading failed (missing 'dir_name'). Duration: {CACHE_LOAD_TIME:.2f}s ---")
                 return
            # Attempt to continue if other columns missing, but log warning
            missing = required_cols - set(df_all.columns)
            app.logger.warning(f"Missing optional columns: {missing}. Proceeding with available data.")
            required_cols = set(df_all.columns).intersection(required_cols) # Use only available required cols

        # Select only necessary columns that exist
        df_all = df_all[list(required_cols)].copy()

        # Coerce types, handling potential errors
        for col in [step_col, value_col, time_col]:
             if col in df_all.columns:
                 df_all[col] = pd.to_numeric(df_all[col], errors='coerce')

        initial_rows = len(df_all)
        cols_to_check_na = [col for col in [step_col, value_col, time_col] if col in df_all.columns]
        if cols_to_check_na:
             df_all.dropna(subset=cols_to_check_na, inplace=True)
        if value_col in df_all.columns:
             df_all = df_all[~df_all[value_col].isin([float("inf"), -float("inf")])]

        dropped_rows = initial_rows - len(df_all)
        if dropped_rows > 0:
            app.logger.debug(f"Dropped {dropped_rows} rows with NaN/Inf values from combined data.")

        if df_all.empty:
            app.logger.warning(f"No valid scalar data remaining after cleaning.")
            CACHE_LOAD_TIME = time.time() - start_time
            app.logger.info(f"--- Preloading finished (no valid data). Duration: {CACHE_LOAD_TIME:.2f}s ---")
            return

        # Final type conversions
        if step_col in df_all.columns: df_all[step_col] = df_all[step_col].astype(int)
        if time_col in df_all.columns: df_all[time_col] = df_all[time_col].astype(float)
        if run_col in df_all.columns: df_all[run_col] = df_all[run_col].astype(str) # Ensure run name is string

        # --- Restructure data into the nested cache format ---
        app.logger.info("Restructuring data for cache...")
        grouped_by_run = df_all.groupby(run_col)
        processed_runs_count = 0

        for run_name, run_df in grouped_by_run:
            # Initialize cache entry for this run
            RUN_DATA_CACHE[run_name] = {
                'scalars': defaultdict(lambda: {"steps": [], "values": [], "wall_times": []}),
                'hydra_overrides': None # Initialize overrides as None
            }

            # Process scalars
            run_scalar_data = RUN_DATA_CACHE[run_name]['scalars']
            grouped_by_tag = run_df.groupby(tag_col)
            has_scalar_data_for_run = False
            for tag, tag_df in grouped_by_tag:
                # Sort by step within each tag group for this run
                tag_df = tag_df.sort_values(by=step_col)
                if not tag_df.empty:
                    if step_col in tag_df: run_scalar_data[tag]["steps"] = tag_df[step_col].to_list()
                    if value_col in tag_df: run_scalar_data[tag]["values"] = tag_df[value_col].to_list()
                    if time_col in tag_df: run_scalar_data[tag]["wall_times"] = tag_df[time_col].to_list()
                    has_scalar_data_for_run = True

            # --- Find Hydra Overrides if directory provided ---
            if HYDRA_MULTIRUN_DIR:
                overrides_content = find_hydra_overrides(run_name, HYDRA_MULTIRUN_DIR, LOG_ROOT_DIR)
                if overrides_content:
                    RUN_DATA_CACHE[run_name]['hydra_overrides'] = overrides_content
                    app.logger.debug(f"Successfully stored overrides for run '{run_name}'.")

            if has_scalar_data_for_run or RUN_DATA_CACHE[run_name]['hydra_overrides']:
                # Keep the run if it has scalars OR overrides
                processed_runs_count += 1
                # Convert defaultdict back to dict for cleaner JSON later
                RUN_DATA_CACHE[run_name]['scalars'] = dict(run_scalar_data)
            else:
                 # Remove run from cache if it has neither scalars nor overrides
                 del RUN_DATA_CACHE[run_name]
                 app.logger.debug(f"Run '{run_name}' had no valid scalar data or overrides. Removed from cache.")


        CACHE_LOAD_TIME = time.time() - start_time
        app.logger.info(
            f"--- Unified preloading finished in {CACHE_LOAD_TIME:.2f}s. "
            f"Processed data/overrides for {processed_runs_count} runs into cache. ---"
        )

    except ImportError as e:
        app.logger.error(f"ImportError during tbparse read: {e}. Is TensorFlow installed?", exc_info=True)
        CACHE_LOAD_TIME = time.time() - start_time
        app.logger.info(f"--- Preloading failed (ImportError). Duration: {CACHE_LOAD_TIME:.2f}s ---")
    except Exception as e:
        app.logger.error(f"Error during unified preloading: {e}", exc_info=True)
        CACHE_LOAD_TIME = time.time() - start_time
        app.logger.info(f"--- Preloading failed (Exception). Duration: {CACHE_LOAD_TIME:.2f}s ---")
        RUN_DATA_CACHE = {} # Clear potentially partial cache on error


# --- API Endpoints ---

# Modified: Return run name and whether overrides exist
@app.route("/api/runs")
def get_runs():
    app.logger.debug(f"Request received for /api/runs")
    # Sort runs alphabetically by name
    available_runs_info = []
    for run_name in sorted(RUN_DATA_CACHE.keys()):
         run_entry = RUN_DATA_CACHE.get(run_name, {})
         available_runs_info.append({
             'name': run_name,
             'has_overrides': bool(run_entry.get('hydra_overrides'))
         })

    app.logger.debug(f"Returning {len(available_runs_info)} available runs from cache with override status.")
    return jsonify(available_runs_info)

# New: Endpoint to get hydra overrides for a specific run
@app.route("/api/overrides")
def get_overrides():
    run_name = request.args.get("run")
    if not run_name:
        return jsonify({"error": "No run specified"}), 400

    app.logger.debug(f"Request: /api/overrides for run: {run_name}")

    run_data = RUN_DATA_CACHE.get(run_name)
    if not run_data:
        return jsonify({"error": f"Run '{run_name}' not found in cache"}), 404

    overrides_content = run_data.get('hydra_overrides')
    if overrides_content is None:
        # Distinguish between "no overrides found" and "run doesn't exist"
        app.logger.debug(f"No Hydra overrides found in cache for run '{run_name}'.")
        return jsonify({"error": f"No Hydra overrides found for run '{run_name}'"}), 404 # Or return empty content? 404 seems ok.

    app.logger.debug(f"Returning Hydra overrides for run '{run_name}'.")
    # Return as plain text, which is typical for YAML overrides
    return Response(overrides_content, mimetype='text/plain')


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

    for run_name in selected_runs:
        run_cache_entry = RUN_DATA_CACHE.get(run_name)
        run_scalars_from_cache = run_cache_entry.get('scalars') if run_cache_entry else None

        if run_scalars_from_cache: # Check if run exists AND has scalar data
            served_run = False
            for metric_name, metric_data in run_scalars_from_cache.items():
                # Basic check if data structure is valid
                if isinstance(metric_data, dict) and metric_data.get("steps"):
                    all_metrics_data[metric_name][run_name] = metric_data
                    metrics_collected.add(metric_name)
                    served_run = True # Mark that we served at least one metric for this run
            if served_run:
                runs_served_count += 1
            else:
                # Run exists in cache but had no valid scalar data after processing
                runs_missing_or_no_scalars.append(run_name)
        else:
            # Run wasn't found in cache or had no 'scalars' key
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
        # Return empty dict, frontend handles placeholder
        return jsonify({})
    elif not all_metrics_data:
         # No runs served had any scalar data at all
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
    global LOG_ROOT_DIR, HYDRA_MULTIRUN_DIR # Add HYDRA_MULTIRUN_DIR

    parser = argparse.ArgumentParser(
        description="p-board: A faster TensorBoard log viewer with Hydra support."
    )
    parser.add_argument(
        "--logdir",
        type=str,
        required=True,
        help="Root directory containing TensorBoard run subdirectories.",
    )
    # New optional argument for Hydra
    parser.add_argument(
        "--hydra-multirun-dir",
        type=str,
        default=None, # Optional
        help="Path to the Hydra multirun directory (e.g., 'multirun/'). If provided, attempts to link runs to overrides.",
    )
    parser.add_argument("--port", type=int, default=5001, help="Port number.")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host address.")
    parser.add_argument("--no-browser", action="store_true", help="Do not open browser.")
    parser.add_argument("--debug", action="store_true", help="Enable Flask debug mode.")

    args = parser.parse_args()

    LOG_ROOT_DIR = os.path.abspath(args.logdir)
    print(f"p-board: Using log directory: {LOG_ROOT_DIR}")

    if not os.path.isdir(LOG_ROOT_DIR):
        print(f"!!! ERROR: Log directory does not exist: {LOG_ROOT_DIR}", file=sys.stderr)
        sys.exit(1)

    # Process Hydra directory argument
    if args.hydra_multirun_dir:
        HYDRA_MULTIRUN_DIR = os.path.abspath(args.hydra_multirun_dir)
        if not os.path.isdir(HYDRA_MULTIRUN_DIR):
            print(f"!!! WARNING: Specified Hydra multirun directory does not exist: {HYDRA_MULTIRUN_DIR}. Overrides will not be loaded.", file=sys.stderr)
            HYDRA_MULTIRUN_DIR = None # Disable if invalid
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

    # --- Call the preload function ---
    preload_all_runs_unified()

    # --- Browser opening and server start (Keep as before) ---
    if not args.no_browser:
        url = f"http://{args.host}:{args.port}"
        def open_browser():
            time.sleep(1.0) # Give server a moment to start
            print(f"p-board: Opening browser at {url} ...")
            webbrowser.open(url)
        browser_thread = threading.Thread(target=open_browser, daemon=True)
        browser_thread.start()
        print(f"p-board: View at {url}")
    else:
        print(f"p-board: View at http://{args.host}:{args.port}")

    print("--- Server Ready ---")
    # Disable reloader if not in debug mode for stability
    use_reloader_flag = args.debug
    app.run(debug=args.debug, port=args.port, host=args.host, use_reloader=use_reloader_flag)


if __name__ == "__main__":
    main()
