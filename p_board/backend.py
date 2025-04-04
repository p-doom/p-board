import os
import sys
import argparse
from flask import Flask, jsonify, request, send_from_directory
from tbparse import SummaryReader
import pandas as pd
from collections import defaultdict
import logging
import time
import webbrowser
import threading
# concurrent.futures is no longer needed for the primary preload if using this strategy
# import concurrent.futures

# --- Globals ---
RUN_DATA_CACHE = {}
CACHE_LOAD_TIME = 0
LOG_ROOT_DIR = None

# --- Flask App Setup --- (Keep as before)
frontend_folder = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")
app = Flask(__name__, static_folder=frontend_folder)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
app.logger.setLevel(logging.INFO)
for handler in app.logger.handlers:
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s: %(message)s"))


# --- Helper Function (find_runs might still be useful for other things, but not preload) ---
def find_runs(root_dir):
    # ... (keep find_runs as it was, it might be useful later,
    #      or remove if only used for the old preload)
    runs = []
    if not root_dir or not os.path.isdir(root_dir):
        app.logger.error(f"Log root directory not found or not specified: {root_dir}")
        return []
    try:
        for item in os.listdir(root_dir):
            item_path = os.path.join(root_dir, item)
            if os.path.isdir(item_path):
                try:
                    has_tfevents = False
                    for fname in os.listdir(item_path):
                        if "tfevents" in fname:
                            has_tfevents = True
                            break
                    if has_tfevents:
                        runs.append(item)
                except OSError as e_inner:
                    app.logger.error(
                        f"Error accessing subdirectory '{item_path}': {e_inner}"
                    )
                except Exception as e_inner_generic:
                    app.logger.error(
                        f"Unexpected error scanning subdirectory '{item_path}': {e_inner_generic}"
                    )
    except OSError as e:
        app.logger.error(f"Error listing runs in {root_dir}: {e}")
    except Exception as e_generic:
        app.logger.error(f"Unexpected error listing runs in {root_dir}: {e_generic}")
    return sorted(runs)


# --- Preloading Function (Strategy 1: Single tbparse Call) ---
def preload_all_runs_unified():
    """Loads data for ALL runs using a single SummaryReader call."""
    global RUN_DATA_CACHE, CACHE_LOAD_TIME, LOG_ROOT_DIR
    start_time = time.time()
    app.logger.info(f"--- Starting unified data preloading from: {LOG_ROOT_DIR} ---")

    RUN_DATA_CACHE = {}  # Clear previous cache

    if not LOG_ROOT_DIR or not os.path.isdir(LOG_ROOT_DIR):
        app.logger.error(f"Invalid log directory for preloading: {LOG_ROOT_DIR}")
        CACHE_LOAD_TIME = time.time() - start_time
        app.logger.info(
            f"--- Preloading skipped (invalid logdir). Duration: {CACHE_LOAD_TIME:.2f}s ---"
        )
        return

    try:
        # --- Core Change: Read all runs at once ---
        app.logger.info(f"Reading all runs in {LOG_ROOT_DIR} using SummaryReader...")
        # tbparse uses 'dir_name' for the run directory by default
        reader = SummaryReader(
            LOG_ROOT_DIR,
            pivot=False,
            extra_columns={"wall_time", "dir_name"},  # Ensure dir_name is included
            event_types={"scalars"},
        )
        df_all = reader.scalars
        read_duration = time.time() - start_time
        app.logger.info(f"SummaryReader finished in {read_duration:.2f}s.")

        if df_all is None or df_all.empty:
            app.logger.warning(
                f"No scalar data found in any runs within {LOG_ROOT_DIR}"
            )
            CACHE_LOAD_TIME = time.time() - start_time
            app.logger.info(
                f"--- Preloading finished (no data). Duration: {CACHE_LOAD_TIME:.2f}s ---"
            )
            return

        app.logger.info(
            f"Read {len(df_all)} total scalar points across all runs. Processing..."
        )

        # --- Data Cleaning (on the combined DataFrame) ---
        step_col, value_col, time_col, tag_col, run_col = (
            "step",
            "value",
            "wall_time",
            "tag",
            "dir_name",
        )
        required_cols = {step_col, value_col, time_col, tag_col, run_col}
        if not required_cols.issubset(df_all.columns):
            app.logger.error(
                f"Missing required columns in combined DataFrame. Found: {df_all.columns}, Required: {required_cols}"
            )
            # Attempt to proceed if dir_name is missing, but log clearly
            if "dir_name" not in df_all.columns:
                app.logger.error(
                    "Crucially, 'dir_name' column is missing from SummaryReader output!"
                )
                # Handle this case: maybe assign a default run name or fail?
                # For now, let's try adding it manually based on file path if possible (complex)
                # Or fail:
                CACHE_LOAD_TIME = time.time() - start_time
                app.logger.info(
                    f"--- Preloading failed (missing 'dir_name'). Duration: {CACHE_LOAD_TIME:.2f}s ---"
                )
                return
            # Select only necessary columns
            df_all = df_all[list(required_cols)].copy()

        df_all[step_col] = pd.to_numeric(df_all[step_col], errors="coerce")
        df_all[value_col] = pd.to_numeric(df_all[value_col], errors="coerce")
        df_all[time_col] = pd.to_numeric(df_all[time_col], errors="coerce")

        initial_rows = len(df_all)
        df_all.dropna(subset=[step_col, value_col, time_col], inplace=True)
        df_all = df_all[~df_all[value_col].isin([float("inf"), -float("inf")])]

        dropped_rows = initial_rows - len(df_all)
        if dropped_rows > 0:
            app.logger.debug(
                f"Dropped {dropped_rows} rows with NaN/Inf values from combined data."
            )

        if df_all.empty:
            app.logger.warning(f"No valid scalar data remaining after cleaning.")
            CACHE_LOAD_TIME = time.time() - start_time
            app.logger.info(
                f"--- Preloading finished (no valid data). Duration: {CACHE_LOAD_TIME:.2f}s ---"
            )
            return

        df_all[step_col] = df_all[step_col].astype(int)
        df_all[time_col] = df_all[time_col].astype(float)
        df_all[run_col] = df_all[run_col].astype(str)  # Ensure run name is string

        # --- Restructure data into the nested cache format ---
        app.logger.info("Restructuring data for cache...")
        grouped_by_run = df_all.groupby(run_col)
        processed_runs_count = 0

        for run_name, run_df in grouped_by_run:
            run_data = defaultdict(
                lambda: {"steps": [], "values": [], "wall_times": []}
            )
            grouped_by_tag = run_df.groupby(tag_col)
            has_data_for_run = False
            for tag, tag_df in grouped_by_tag:
                # Sort by step within each tag group for this run
                tag_df = tag_df.sort_values(by=step_col)
                if not tag_df.empty:
                    run_data[tag]["steps"] = tag_df[step_col].to_list()
                    run_data[tag]["values"] = tag_df[value_col].to_list()
                    run_data[tag]["wall_times"] = tag_df[time_col].to_list()
                    has_data_for_run = True

            if has_data_for_run:
                RUN_DATA_CACHE[run_name] = dict(run_data)
                processed_runs_count += 1
            # else: # Optionally log runs found by tbparse but had no valid scalars after cleaning
            #    app.logger.debug(f"Run '{run_name}' had no valid scalar data after cleaning.")

        CACHE_LOAD_TIME = time.time() - start_time
        app.logger.info(
            f"--- Unified preloading finished in {CACHE_LOAD_TIME:.2f}s. "
            f"Processed data for {processed_runs_count} runs into cache. ---"
        )

    except ImportError as e:
        app.logger.error(
            f"ImportError during tbparse read: {e}. Is TensorFlow installed and accessible?",
            exc_info=True,
        )
        CACHE_LOAD_TIME = time.time() - start_time
        app.logger.info(
            f"--- Preloading failed (ImportError). Duration: {CACHE_LOAD_TIME:.2f}s ---"
        )
    except Exception as e:
        app.logger.error(f"Error during unified preloading: {e}", exc_info=True)
        CACHE_LOAD_TIME = time.time() - start_time
        app.logger.info(
            f"--- Preloading failed (Exception). Duration: {CACHE_LOAD_TIME:.2f}s ---"
        )
        RUN_DATA_CACHE = {}  # Clear potentially partial cache on error


# --- API Endpoints (Should work with the new cache structure) ---
# Keep get_runs and get_data as they were in the previous version.
# They rely on the RUN_DATA_CACHE having the format:
# {'run_name': {'metric_tag': {'steps': [], 'values': [], 'wall_times': []}}}
# The new preload function populates the cache in this exact format.


@app.route("/api/runs")
def get_runs():
    app.logger.debug(f"Request received for /api/runs")
    available_cached_runs = sorted(RUN_DATA_CACHE.keys())  # Simpler now
    app.logger.debug(
        f"Returning {len(available_cached_runs)} available runs from cache."
    )
    return jsonify(available_cached_runs)


@app.route("/api/data")
def get_data():
    selected_runs_str = request.args.get("runs", "")
    if not selected_runs_str:
        return jsonify({"error": "No runs specified"}), 400

    selected_runs = selected_runs_str.split(",")
    app.logger.info(
        f"Request: /api/data for runs: {selected_runs} (serving from cache)"
    )

    all_metrics_data = defaultdict(dict)
    start_time = time.time()
    runs_served_count = 0
    runs_missing = []
    metrics_collected = set()

    for run_name in selected_runs:
        run_data_from_cache = RUN_DATA_CACHE.get(run_name)  # Use .get for safety
        if run_data_from_cache:  # Check if run exists in cache
            runs_served_count += 1
            for metric_name, metric_data in run_data_from_cache.items():
                # Basic check if data structure is valid
                if isinstance(metric_data, dict) and metric_data.get("steps"):
                    all_metrics_data[metric_name][run_name] = metric_data
                    metrics_collected.add(metric_name)
        else:
            runs_missing.append(run_name)

    duration = time.time() - start_time
    log_message = (
        f"Data assembly took {duration * 1000:.2f}ms. "
        f"Served data for {runs_served_count}/{len(selected_runs)} requested runs. "
        f"Collected {len(metrics_collected)} distinct metrics."
    )
    if runs_missing:
        log_message += f" Missing runs: {runs_missing}"
    app.logger.info(log_message)

    if not all_metrics_data and runs_served_count > 0:
        app.logger.warning(
            f"No common/valid scalar data found across the successfully served runs: {selected_runs}"
        )
        return jsonify({})

    return jsonify(dict(all_metrics_data))


# --- Static File Serving (Keep as before) ---
@app.route("/")
def serve_index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/<path:filename>")
def serve_static(filename):
    if ".." in filename or filename.startswith("/"):
        return "Invalid path", 400
    return send_from_directory(app.static_folder, filename)


# --- Main Execution / CLI Entry Point ---
def main():
    global LOG_ROOT_DIR

    parser = argparse.ArgumentParser(
        description="p-board: A faster TensorBoard log viewer."
    )
    # Remove --workers argument as it's not used in the unified strategy
    parser.add_argument(
        "--logdir",
        type=str,
        required=True,
        help="Root directory containing TensorBoard run subdirectories.",
    )
    parser.add_argument("--port", type=int, default=5001, help="Port number.")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host address.")
    parser.add_argument(
        "--no-browser", action="store_true", help="Do not open browser."
    )
    parser.add_argument("--debug", action="store_true", help="Enable Flask debug mode.")

    args = parser.parse_args()

    LOG_ROOT_DIR = os.path.abspath(args.logdir)
    print(f"p-board: Using log directory: {LOG_ROOT_DIR}")

    if not os.path.isdir(LOG_ROOT_DIR):
        print(
            f"!!! ERROR: Log directory does not exist: {LOG_ROOT_DIR}", file=sys.stderr
        )
        sys.exit(1)

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
        app.logger.setLevel(logging.DEBUG)
        print("p-board: Debug mode enabled.")
    else:
        logging.getLogger().setLevel(logging.INFO)
        app.logger.setLevel(logging.INFO)

    # --- Call the new unified preload function ---
    preload_all_runs_unified()

    # --- Browser opening and server start (Keep as before) ---
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
    app.run(debug=args.debug, port=args.port, host=args.host, use_reloader=args.debug)


if __name__ == "__main__":
    main()
