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
RUN_DATA_CACHE = {} # Now stores {
                    #   'run_name': {
                    #     'scalars': {...},
                    #     'hydra_overrides': '...' | None,
                    #     'hparams': {'hparam_dict': {...}, 'metric_dict': {...}} | None
                    #   }
                    # }
CACHE_LOAD_TIME = 0
LOG_ROOT_DIR = None
HYDRA_MULTIRUN_DIR = None # Store the path to hydra multirun
HYDRA_SINGLE_RUN_LOG_DIR = None # New: Store the path to normal hydra log outputs
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

def find_hydra_overrides_single_run(tb_run_name, hydra_single_run_root, tb_log_root_dir_context):
    """
    Tries to find Hydra overrides.yaml or config.yaml for a given TensorBoard run
    by searching log files in 'normal' Hydra output directories. The expected structure
    for these directories is hydra_single_run_root/YYYY-MM-DD/HH-MM-SS/, where the
    HH-MM-SS directory contains the log files and the .hydra configuration.
    Args:
        tb_run_name (str): The directory name of the TensorBoard run (search term).
        hydra_single_run_root (str): Absolute path to the root of Hydra single-run outputs
                                     (e.g., 'outputs/' or 'logs/hydra/').
        tb_log_root_dir_context (str): Absolute path to the main TensorBoard log directory
                                       (parent of tb_run_name), for context.

    Returns:
        str | None: Content of overrides.yaml or config.yaml, or None if not found.
    """
    if not hydra_single_run_root or not os.path.isdir(hydra_single_run_root):
        app.logger.debug(f"Single-run Hydra override search: hydra_single_run_root '{hydra_single_run_root}' is not a valid directory.")
        return None

    search_term = tb_run_name # This is the dir_name from tbparse
    app.logger.debug(f"Single-run Hydra override search for TB run '{tb_run_name}' "
                     f"using search term '{search_term}' in Hydra root '{hydra_single_run_root}' "
                     f"(expected structure: DATE_DIR/TIME_DIR/*.log)")

    hydra_root_path = Path(hydra_single_run_root)

    # Iterate through date-stamped directories (e.g., YYYY-MM-DD)
    for date_dir in hydra_root_path.iterdir():
        if not date_dir.is_dir():
            continue

        # Iterate through time-stamped directories (e.g., HH-MM-SS)
        # These are the actual Hydra job output directories
        for hydra_job_output_dir in date_dir.iterdir():
            if not hydra_job_output_dir.is_dir():
                continue

            app.logger.debug(f"Single-run search: Checking potential Hydra job output directory: {hydra_job_output_dir}")

            # Look for common log files (e.g., *.log) within this hydra_job_output_dir
            log_files_to_check = list(hydra_job_output_dir.glob('*.log'))
            if not log_files_to_check:
                app.logger.debug(f"Single-run search: No '*.log' files found in {hydra_job_output_dir}")
                continue # Move to the next hydra_job_output_dir

            found_in_log = False
            for log_file in log_files_to_check:
                # Path.glob should yield files, but an explicit check is safe.
                if log_file.is_file():
                    try:
                        content_to_check = ""
                        with open(log_file, 'r', encoding='utf-8', errors='ignore') as f:
                            content_to_check = f.read(200 * 1024) # Check first 200KB

                        if search_term in content_to_check:
                            app.logger.info(f"Single-run search: Found search term '{search_term}' for TB run '{tb_run_name}' "
                                            f"in Hydra log file: {log_file}")
                            found_in_log = True
                            break # Found the term, proceed with this hydra_job_output_dir
                    except Exception as e_read:
                        app.logger.warning(f"Single-run search: Could not read or search log file {log_file}: {e_read}")
                        # Continue to the next log file if this one fails
                        continue
            
            if found_in_log:
                # If the search term was found, this hydra_job_output_dir is our candidate.
                # Look for .hydra/overrides.yaml or .hydra/config.yaml within it.
                hydra_config_subdir = hydra_job_output_dir / ".hydra"
                
                overrides_file = hydra_config_subdir / "overrides.yaml"
                if overrides_file.is_file():
                    app.logger.info(f"Single-run search: Found Hydra overrides.yaml for TB run '{tb_run_name}' at: {overrides_file}")
                    try: return overrides_file.read_text(encoding='utf-8')
                    except Exception as e_read_yaml: app.logger.error(f"Single-run search: Error reading overrides file {overrides_file}: {e_read_yaml}"); return None

                config_yaml_file = hydra_config_subdir / "config.yaml" 
                if config_yaml_file.is_file():
                    app.logger.info(f"Single-run search: Found Hydra config.yaml (as fallback) for TB run '{tb_run_name}' at: {config_yaml_file}")
                    try: return config_yaml_file.read_text(encoding='utf-8')
                    except Exception as e_read_yaml: app.logger.error(f"Single-run search: Error reading config.yaml file {config_yaml_file}: {e_read_yaml}"); return None

                # Log match found, but neither overrides.yaml nor config.yaml exists in .hydra for this candidate
                app.logger.warning(f"Single-run search: Log match for '{tb_run_name}' in {hydra_job_output_dir}, "
                                   f"but no .hydra/overrides.yaml or .hydra/config.yaml found.")
                return None # This candidate, despite log match, didn't have the required Hydra files

    # If loops complete without finding a log file containing the search term in the expected structure
    app.logger.debug(f"Single-run search: No Hydra job output directory in '{hydra_root_path}' "
                     f"(with structure DATE_DIR/TIME_DIR/*.log) found whose logs contain the term '{search_term}' "
                     f"for TB run '{tb_run_name}'.")
    return None

# --- Preloading Function (Modified for Atomicity) ---
def preload_all_runs_unified():
    """Loads scalar data and potentially Hydra overrides for ALL runs into a temporary cache,
       then atomically replaces the global cache."""
    global RUN_DATA_CACHE, CACHE_LOAD_TIME, LOG_ROOT_DIR, HYDRA_MULTIRUN_DIR, HYDRA_SINGLE_RUN_LOG_DIR
    start_time = time.time()
    app.logger.info(f"--- Background Refresh: Starting unified data loading from: {LOG_ROOT_DIR} ---")
    if HYDRA_MULTIRUN_DIR:
        app.logger.info(f"--- Background Refresh: Will attempt to find Hydra overrides in: {HYDRA_MULTIRUN_DIR} ---")
    if HYDRA_SINGLE_RUN_LOG_DIR:
        app.logger.info(f"--- Background Refresh: Will attempt to find Hydra single-run overrides in: {HYDRA_SINGLE_RUN_LOG_DIR} ---")

    if not LOG_ROOT_DIR or not os.path.isdir(LOG_ROOT_DIR):
        app.logger.error(f"Background Refresh: Invalid log directory: {LOG_ROOT_DIR}")
        load_duration = time.time() - start_time
        app.logger.info(f"--- Background Refresh: Skipped (invalid logdir). Duration: {load_duration:.2f}s ---")
        return

    temp_cache = {} # Build data into a temporary dictionary

    try:
        # 1. Initialize SummaryReader
        app.logger.info(f"Background Refresh: Initializing SummaryReader for {LOG_ROOT_DIR}...")
        reader = SummaryReader(
            LOG_ROOT_DIR,
            pivot=False, # Keep pivot=False for detailed scalar data
            extra_columns={"wall_time", "dir_name"},
            event_types={"scalars", "hparams"}, # For reader.scalars and reader.hparams
        )
        df_scalars = reader.scalars
        df_hparams = reader.hparams # Accesses hparams data
        tbparse_read_duration = time.time() - start_time
        app.logger.info(f"Background Refresh: tbparse read scalars/hparams in {tbparse_read_duration:.2f}s.")

        # 2. Collect all unique base run directory names
        all_base_run_names = set()
        if df_scalars is not None and not df_scalars.empty and 'dir_name' in df_scalars:
            all_base_run_names.update(df_scalars['dir_name'].unique())

        hparam_base_run_map = defaultdict(list) # Maps base_run_name to list of hparam rows
        if df_hparams is not None and not df_hparams.empty and 'dir_name' in df_hparams:
            # Sort by wall_time to pick the earliest hparam entry if multiple exist for the same base run
            if 'wall_time' in df_hparams.columns:
                df_hparams = df_hparams.sort_values('wall_time')
            
            for index, row in df_hparams.iterrows():
                hparam_event_dir_name = row['dir_name'] # e.g., "actual_run_name/hparam_timestamp"
                # Derive base run name (e.g., "actual_run_name")
                base_run_name = Path(hparam_event_dir_name).parts[0]
                all_base_run_names.add(base_run_name)
                hparam_base_run_map[base_run_name].append(row)

        # 3. If no runs from TB, but Hydra dir is set, check LOG_ROOT_DIR subdirs
        if not all_base_run_names and HYDRA_MULTIRUN_DIR:
            app.logger.info("Background Refresh: No TensorBoard data found. Checking LOG_ROOT_DIR subdirectories for potential Hydra overrides.")
            try:
                for item in Path(LOG_ROOT_DIR).iterdir():
                    if item.is_dir():
                        all_base_run_names.add(item.name)
            except Exception as e_dir_list:
                app.logger.error(f"Background Refresh: Error listing directories in {LOG_ROOT_DIR} for override check: {e_dir_list}")

        if not all_base_run_names:
            app.logger.info("Background Refresh: No runs found from TensorBoard data or filesystem scan. Clearing cache.")
            RUN_DATA_CACHE = {}
            CACHE_LOAD_TIME = time.time() - start_time
            app.logger.info(f"--- Background Refresh: Finished (no runs found). Cache cleared. Duration: {CACHE_LOAD_TIME:.2f}s ---")
            return

        # 4. Initialize temp_cache for all identified base run names
        for run_name in all_base_run_names:
            temp_cache[run_name] = {
                'scalars': {},
                'hydra_overrides': None,
                'hparams': None  # Initialize hparams entry
            }
        app.logger.info(f"Background Refresh: Identified {len(all_base_run_names)} potential runs to process.")

        # 5. Process scalars
        if df_scalars is not None and not df_scalars.empty:
            app.logger.info(f"Background Refresh: Processing {len(df_scalars)} scalar data points...")
            step_col, value_col, time_col, tag_col, run_col = ("step", "value", "wall_time", "tag", "dir_name")
            required_cols = {step_col, value_col, time_col, tag_col, run_col}
            if not required_cols.issubset(df_scalars.columns):
                app.logger.error(f"Background Refresh: Missing required columns in scalar DataFrame. Found: {df_scalars.columns}, Required: {required_cols}")
                # Handle critical missing 'dir_name' specifically if necessary, though tbparse should provide it.
                missing = required_cols - set(df_scalars.columns)
                app.logger.warning(f"Background Refresh: Missing optional columns: {missing}. Proceeding.")
                required_cols = set(df_scalars.columns).intersection(required_cols)

            df_scalars_cleaned = df_scalars[list(required_cols)].copy()
            for col in [step_col, value_col, time_col]:
                 if col in df_scalars_cleaned.columns:
                     df_scalars_cleaned[col] = pd.to_numeric(df_scalars_cleaned[col], errors='coerce')
            initial_rows = len(df_scalars_cleaned)
            cols_to_check_na = [col for col in [step_col, value_col, time_col] if col in df_scalars_cleaned.columns]
            if cols_to_check_na: df_scalars_cleaned.dropna(subset=cols_to_check_na, inplace=True)
            if value_col in df_scalars_cleaned.columns: df_scalars_cleaned = df_scalars_cleaned[~df_scalars_cleaned[value_col].isin([float("inf"), -float("inf")])]
            dropped_rows = initial_rows - len(df_scalars_cleaned)
            if dropped_rows > 0: app.logger.debug(f"Background Refresh: Dropped {dropped_rows} rows with NaN/Inf values.")

            if df_scalars_cleaned.empty:
                app.logger.warning(f"Background Refresh: No valid scalar data remaining after cleaning.")
            else: # df_scalars_cleaned has valid data
                if step_col in df_scalars_cleaned.columns: df_scalars_cleaned[step_col] = df_scalars_cleaned[step_col].astype(int)
                if time_col in df_scalars_cleaned.columns: df_scalars_cleaned[time_col] = df_scalars_cleaned[time_col].astype(float)
                if run_col in df_scalars_cleaned.columns: df_scalars_cleaned[run_col] = df_scalars_cleaned[run_col].astype(str)

                app.logger.info("Background Refresh: Restructuring scalar data for cache...")
                grouped_by_run = df_scalars_cleaned.groupby(run_col)
                for run_name, run_df in grouped_by_run:
                    if run_name in temp_cache:
                        # Ensure 'scalars' key is a defaultdict for this run
                        temp_cache[run_name]['scalars'] = defaultdict(lambda: {"steps": [], "values": [], "wall_times": []})
                        run_scalar_data_for_current_run = temp_cache[run_name]['scalars']
                        grouped_by_tag = run_df.groupby(tag_col)
                        for tag, tag_df in grouped_by_tag:
                            tag_df_sorted = tag_df.sort_values(by=step_col) if step_col in tag_df.columns else tag_df
                            if not tag_df_sorted.empty:
                                if step_col in tag_df_sorted: run_scalar_data_for_current_run[tag]["steps"] = tag_df_sorted[step_col].to_list()
                                if value_col in tag_df_sorted: run_scalar_data_for_current_run[tag]["values"] = tag_df_sorted[value_col].to_list()
                                if time_col in tag_df_sorted: run_scalar_data_for_current_run[tag]["wall_times"] = tag_df_sorted[time_col].to_list()
                        temp_cache[run_name]['scalars'] = dict(run_scalar_data_for_current_run) # Convert back to dict
                    else:
                        app.logger.warning(f"Background Refresh: Scalar data found for run '{run_name}' which was not in the initial list of runs. Skipping.")
        else:
            app.logger.info("Background Refresh: No scalar data found by tbparse.")

        # 6. Initialize a set to keep track of runs that have any data (scalars, hparams, or overrides)
        runs_to_keep = set()

        # Populate runs_to_keep based on SCALARS processed earlier
        for run_name, data in temp_cache.items():
            if data.get('scalars') and data['scalars']: # Check for non-empty scalars dict
                runs_to_keep.add(run_name)

        # 7. Process HParams (using hparam_base_run_map)
        if hparam_base_run_map:
            app.logger.info(f"Background Refresh: Processing TensorBoard HParams for {len(hparam_base_run_map)} base runs...")
            for base_run_name, hparam_rows_for_run in hparam_base_run_map.items():
                if base_run_name in temp_cache and temp_cache[base_run_name]['hparams'] is None and hparam_rows_for_run:
                    hparam_dict_to_store = {}
                    metric_dict_to_store = {} # Reflects metric_dict={} in add_hparams call
        
                    processed_an_entry = False
                    example_dir_name_for_log = "N/A"
                    if hparam_rows_for_run:
                         example_dir_name_for_log = hparam_rows_for_run[0].get('dir_name', "N/A")
        
                    for hparam_entry_row in hparam_rows_for_run: # hparam_entry_row is a pandas Series
                        tag = hparam_entry_row.get('tag')
                        value = hparam_entry_row.get('value')
        
                        if tag is not None:
                            hparam_dict_to_store[tag] = value
                            processed_an_entry = True
        
                    if not processed_an_entry and hparam_rows_for_run:
                        app.logger.warning(
                            f"Background Refresh: Hparam data from tbparse for run '{base_run_name}' "
                            f"(from event file dir like '{example_dir_name_for_log}') did not yield "
                            f"extractable tag/value pairs from its rows, or was structured unexpectedly. "
                            f"Number of hparam event rows: {len(hparam_rows_for_run)}."
                        )
        
                    temp_cache[base_run_name]['hparams'] = {
                        'hparam_dict': hparam_dict_to_store,
                        'metric_dict': metric_dict_to_store
                    }
                    if hparam_dict_to_store: # If any hparams were actually stored
                        runs_to_keep.add(base_run_name)
                    app.logger.debug(f"Background Refresh: Stored/updated TensorBoard hparams for run '{base_run_name}' from {len(hparam_rows_for_run)} event entries. HParams count: {len(hparam_dict_to_store)}, Metrics count: {len(metric_dict_to_store)}.")
        else:
            app.logger.info("Background Refresh: No TensorBoard hparam data found by tbparse.")

        # 8. Find Hydra Overrides
        # 8.1. Try Multirun Hydra overrides
        if HYDRA_MULTIRUN_DIR:
            app.logger.info(f"Background Refresh: Checking for Multirun Hydra overrides for {len(temp_cache)} potential runs...")
            for run_name in list(temp_cache.keys()): # Iterate over keys list for safe modification
                # temp_cache entries are pre-initialized, so no need to check for run_name existence here
                overrides_content = find_hydra_overrides(run_name, HYDRA_MULTIRUN_DIR, LOG_ROOT_DIR)
                if overrides_content:
                    temp_cache[run_name]['hydra_overrides'] = overrides_content
                    runs_to_keep.add(run_name)
                    app.logger.debug(f"Background Refresh: Stored overrides for run '{run_name}'.")

        # 8.2. Try Single-Run Hydra overrides if not found by multirun and dir is configured
        if HYDRA_SINGLE_RUN_LOG_DIR:
            app.logger.info(f"Background Refresh: Checking for Single-run Hydra overrides for runs not yet having multirun overrides...")
            for run_name in list(temp_cache.keys()): # Iterate over all runs known so far
                if temp_cache[run_name].get('hydra_overrides') is None: # Only if not already found by multirun
                    app.logger.debug(f"Attempting single-run override search for: {run_name}")
                    overrides_content_single = find_hydra_overrides_single_run(
                        run_name,
                        HYDRA_SINGLE_RUN_LOG_DIR,
                        LOG_ROOT_DIR 
                    )
                    if overrides_content_single:
                        temp_cache[run_name]['hydra_overrides'] = overrides_content_single
                        runs_to_keep.add(run_name)
                        app.logger.info(f"Background Refresh: Stored single-run overrides for run '{run_name}'.")

        # 9. Filter temp_cache: keep only runs that have scalars, hparams, or overrides
        final_temp_cache = {
            run: data_dict for run, data_dict in temp_cache.items()
            if run in runs_to_keep
        }
        removed_count = len(temp_cache) - len(final_temp_cache)
        if removed_count > 0:
            app.logger.info(f"Background Refresh: Removed {removed_count} entries from cache that had no scalar data, hparams, or Hydra overrides.")
        temp_cache = final_temp_cache
        processed_runs_count = len(temp_cache)

        # 10. Atomically update the global cache
        RUN_DATA_CACHE = temp_cache
        CACHE_LOAD_TIME = time.time() - start_time
        app.logger.info(
            f"--- Background Refresh: Finished in {CACHE_LOAD_TIME:.2f}s. "
            f"Processed data for {processed_runs_count} runs into cache. ---"
        )

    except ImportError as e: # Specific to tbparse/TensorFlow
        app.logger.error(f"Background Refresh: ImportError during tbparse read: {e}. Is TensorFlow (or tbparse's backend) installed correctly?", exc_info=True)
        load_duration = time.time() - start_time
        app.logger.info(f"--- Background Refresh: Failed (ImportError). Duration: {load_duration:.2f}s ---")
    except Exception as e:
        app.logger.error(f"Background Refresh: Error during unified preloading: {e}", exc_info=True)
        load_duration = time.time() - start_time
        app.logger.info(f"--- Background Refresh: Failed (Exception). Duration: {load_duration:.2f}s ---")


# --- Background Refresh Task ---
def background_refresh_task():
    """Periodically calls preload_all_runs_unified."""
    app.logger.info(f"Background refresh thread started. Interval: {REFRESH_INTERVAL_SECONDS}s")
    while not stop_event.is_set():
        try:
            preload_all_runs_unified()
        except Exception as e: # Catch broad exceptions here to keep the thread alive
            app.logger.error(f"Exception in background refresh task loop: {e}", exc_info=True)
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
        background_thread.join(timeout=10) # Increased timeout slightly
        if background_thread.is_alive():
            app.logger.warning("Background refresh thread did not stop gracefully after 10s.")
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
             'has_overrides': bool(run_entry.get('hydra_overrides')),
             'has_hparams': bool(run_entry.get('hparams')) # New field
         })
    return available_runs_info

@app.route("/api/runs")
def get_runs():
    app.logger.debug(f"Request received for /api/runs")
    current_cache_snapshot = RUN_DATA_CACHE.copy() # Shallow copy for safe iteration
    available_runs_info = _get_runs_info_from_cache(current_cache_snapshot)
    app.logger.debug(f"Returning {len(available_runs_info)} available runs from cache with override and hparam status.")
    return jsonify(available_runs_info)

# New: Endpoint to get TensorBoard hparams for a specific run
@app.route("/api/hparams")
def get_hparams():
    run_name = request.args.get("run")
    if not run_name:
        return jsonify({"error": "No run specified"}), 400

    app.logger.debug(f"Request: /api/hparams for run: {run_name}")

    # Access cache safely (RUN_DATA_CACHE is thread-safe for reads due to GIL and atomic replacement)
    run_data = RUN_DATA_CACHE.get(run_name)
    if not run_data:
        app.logger.warning(f"Run '{run_name}' not found in current cache for hparams request.")
        return jsonify({"error": f"Run '{run_name}' not found in cache"}), 404

    hparams_content = run_data.get('hparams')
    if hparams_content is None:
        app.logger.debug(f"No TensorBoard hparams found in cache for run '{run_name}'.")
        return jsonify({"error": f"No TensorBoard hparams found for run '{run_name}'"}), 404

    app.logger.debug(f"Returning TensorBoard hparams for run '{run_name}'.")
    return jsonify(hparams_content)


# Endpoint to get hydra overrides for a specific run
@app.route("/api/overrides")
def get_overrides():
    run_name = request.args.get("run")
    if not run_name:
        return jsonify({"error": "No run specified"}), 400

    app.logger.debug(f"Request: /api/overrides for run: {run_name}")

    run_data = RUN_DATA_CACHE.get(run_name)
    if not run_data:
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
    current_cache_snapshot = RUN_DATA_CACHE # Direct access is fine due to GIL / atomic replacement

    for run_name in selected_runs:
        run_cache_entry = current_cache_snapshot.get(run_name)
        run_scalars_from_cache = run_cache_entry.get('scalars') if run_cache_entry else None

        if run_scalars_from_cache: # Check if run exists AND has scalar data
            served_run = False
            for metric_name, metric_data in run_scalars_from_cache.items():
                if isinstance(metric_data, dict) and metric_data.get("steps"): # Check for actual data
                    all_metrics_data[metric_name][run_name] = metric_data
                    metrics_collected.add(metric_name)
                    served_run = True
            if served_run:
                runs_served_count += 1
            else:
                # This case means the run was in cache, 'scalars' key existed, but was empty or malformed.
                runs_missing_or_no_scalars.append(f"{run_name} (no valid scalar entries)")
        else:
            runs_missing_or_no_scalars.append(run_name)

    duration = time.time() - start_time
    log_message = (
        f"Scalar data assembly took {duration * 1000:.2f}ms. "
        f"Served scalar data for {runs_served_count}/{len(selected_runs)} requested runs. "
        f"Collected {len(metrics_collected)} distinct scalar metrics."
    )
    if runs_missing_or_no_scalars:
        log_message += f" Runs missing or no/empty scalars: {runs_missing_or_no_scalars}"
    app.logger.info(log_message)

    if not all_metrics_data: # Covers cases where no runs served, or served runs had no common/valid data
         app.logger.warning(f"No scalar data to return for selected runs: {selected_runs}")
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
    except FileNotFoundError: # More specific exception
         app.logger.warning(f"Static file not found: {filename}")
         return "File not found", 404


# --- Main Execution / CLI Entry Point (Modified) ---
def main():
    global LOG_ROOT_DIR, HYDRA_MULTIRUN_DIR, REFRESH_INTERVAL_SECONDS, HYDRA_SINGLE_RUN_LOG_DIR

    parser = argparse.ArgumentParser(
        description="p-board: A faster TensorBoard log viewer with Hydra and HParams support."
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
        "--hydra-log-dir", 
        type=str,
        default=None,
        help="Path to the root directory of 'normal' Hydra job outputs (e.g., 'outputs/'). "
             "If provided, p-board will search these directories for logs containing "
             "TensorBoard run names to link them to Hydra configs (overrides.yaml or config.yaml). "
             "This is for non-multirun Hydra setups.",
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

    if args.hydra_log_dir:
        HYDRA_SINGLE_RUN_LOG_DIR = os.path.abspath(args.hydra_log_dir)
        if not os.path.isdir(HYDRA_SINGLE_RUN_LOG_DIR):
            print(f"!!! WARNING: Specified Hydra single-run log directory does not exist: {HYDRA_SINGLE_RUN_LOG_DIR}. "
                  "This type of override linking will be disabled.", file=sys.stderr)
            HYDRA_SINGLE_RUN_LOG_DIR = None
        else:
            print(f"p-board: Using Hydra single-run log directory: {HYDRA_SINGLE_RUN_LOG_DIR} for override correlation.")
    else:
        print("p-board: Hydra single-run log directory not specified. Linking overrides via this method is disabled.")


    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
        app.logger.setLevel(logging.DEBUG)
        for handler in logging.getLogger().handlers: # Ensure all handlers get debug level
            handler.setLevel(logging.DEBUG)
        print("p-board: Debug mode enabled.")
    else:
        logging.getLogger().setLevel(logging.INFO)
        app.logger.setLevel(logging.INFO)

    # --- Initial Preload ---
    print("p-board: Performing initial data load...")
    preload_all_runs_unified()
    print(f"p-board: Initial load complete. Found {len(RUN_DATA_CACHE)} runs in cache.")

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
            time.sleep(1.0) # Give server a moment to start
            print(f"p-board: Opening browser at {url} ...")
            webbrowser.open(url)
        browser_thread = threading.Thread(target=open_browser, daemon=True)
        browser_thread.start()
        print(f"p-board: View at {url}")
    else:
        print(f"p-board: View at http://{args.host}:{args.port}")

    print("--- Server Ready ---")
    # Disable Flask's reloader when using our background thread or debug mode
    use_reloader_flag = False # Generally safer to disable Flask reloader with threads
    if args.debug:
         print("p-board: Flask debug mode is ON, but Flask's auto-reloader is disabled for stability with background tasks.")

    app.run(debug=args.debug, port=args.port, host=args.host, use_reloader=use_reloader_flag)


if __name__ == "__main__":
    main()
