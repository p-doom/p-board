import os
import sys
import argparse  # <-- Import argparse
from flask import (
    Flask,
    jsonify,
    request,
    send_from_directory,
    send_file,
)  # <-- Import send_from_directory/send_file

# from flask_cors import CORS # <-- Remove CORS
from tbparse import SummaryReader
import pandas as pd
from collections import defaultdict
import logging
import time
import webbrowser  # <-- Import webbrowser
import threading  # <-- Import threading

# --- Globals for Caching & Dynamic Log Dir ---
RUN_DATA_CACHE = {}
CACHE_LOAD_TIME = 0
LOG_ROOT_DIR = None  # <-- Initialize as None, will be set by args

# --- Flask App Setup ---
# Serve static files from the 'frontend' subdirectory relative to this script
frontend_folder = os.path.join(os.path.dirname(__file__), "frontend")
app = Flask(__name__, static_folder=frontend_folder)
# CORS(app) # <-- Remove CORS

logging.basicConfig(level=logging.INFO)
app.logger.setLevel(logging.INFO)


# --- Helper Functions (Modified to use dynamic LOG_ROOT_DIR) ---
def find_runs(root_dir):
    """Finds subdirectories in the root_dir, considering them as runs."""
    runs = []
    if not root_dir or not os.path.isdir(root_dir):  # Check if root_dir is valid
        app.logger.error(f"Log root directory not found or not specified: {root_dir}")
        return []
    try:
        for item in os.listdir(root_dir):
            item_path = os.path.join(root_dir, item)
            if os.path.isdir(item_path):
                try:
                    if any(
                        fname.startswith("events.out.tfevents.")
                        for fname in os.listdir(item_path)
                    ):
                        runs.append(item)
                    # Optional: Add back warning for directories without tfevents if needed
                    # else:
                    #     app.logger.warning(f"Directory '{item}' contains no tfevents, skipping.")
                except OSError as e_inner:
                    app.logger.error(
                        f"Error accessing subdirectory '{item_path}': {e_inner}"
                    )
    except OSError as e:
        app.logger.error(f"Error listing runs in {root_dir}: {e}")
    return sorted(runs)


def read_run_data_from_disk(run_name):
    """Reads scalar data for a specific run using tbparse FROM DISK."""
    global LOG_ROOT_DIR  # <-- Access the global LOG_ROOT_DIR
    if not LOG_ROOT_DIR:
        app.logger.error("LOG_ROOT_DIR not set. Cannot read run data.")
        return None

    run_path = os.path.join(LOG_ROOT_DIR, run_name)
    app.logger.info(f"Reading data from disk for run: {run_name} (path: {run_path})")
    if not os.path.isdir(run_path):
        app.logger.warning(f"Run directory not found during disk read: {run_path}")
        return None
    try:
        start_time = time.time()
        reader = SummaryReader(run_path, pivot=False, extra_columns={"wall_time"})
        df = reader.scalars

        if df is None or df.empty:
            app.logger.warning(f"No scalar data found in run: {run_name}")
            return None

        duration = time.time() - start_time
        app.logger.info(
            f"Read {len(df)} scalar points for {run_name} in {duration:.2f}s"
        )

        grouped_data = defaultdict(
            lambda: {"steps": [], "values": [], "wall_times": []}
        )
        step_col, value_col, time_col, tag_col = "step", "value", "wall_time", "tag"
        required_cols = {step_col, value_col, time_col, tag_col}

        if not required_cols.issubset(df.columns):
            app.logger.error(
                f"Missing columns in {run_name}. Found: {df.columns}, Required: {required_cols}"
            )
            return None

        df = df.sort_values(by=step_col)

        for _, row in df.iterrows():
            tag = row[tag_col]
            try:
                step = int(row[step_col])
                value = float(row[value_col])
                wall_time = float(row[time_col])

                if not all(map(pd.notna, [value, step, wall_time])):
                    continue  # Skip NaN/Inf silently or add debug log

                grouped_data[tag]["steps"].append(step)
                grouped_data[tag]["values"].append(value)
                grouped_data[tag]["wall_times"].append(wall_time)
            except (ValueError, TypeError) as conv_err:
                app.logger.warning(
                    f"Skipping entry (conversion error) in {run_name}/{tag}: {conv_err}"
                )
                continue
        return dict(grouped_data)
    except Exception as e:
        app.logger.error(f"Error reading data for run {run_name}: {e}", exc_info=True)
        return None


def preload_all_runs():
    """Loads data for all runs into the cache on startup."""
    global RUN_DATA_CACHE, CACHE_LOAD_TIME, LOG_ROOT_DIR  # <-- Use global LOG_ROOT_DIR
    start_time = time.time()
    app.logger.info(f"--- Starting data preloading from: {LOG_ROOT_DIR} ---")
    if not LOG_ROOT_DIR or not os.path.isdir(LOG_ROOT_DIR):
        app.logger.error(f"Invalid log directory for preloading: {LOG_ROOT_DIR}")
        CACHE_LOAD_TIME = time.time() - start_time
        app.logger.info(
            f"--- Preloading skipped (invalid logdir). Duration: {CACHE_LOAD_TIME:.2f}s ---"
        )
        return

    runs = find_runs(LOG_ROOT_DIR)
    if not runs:
        app.logger.warning(f"No runs found in {LOG_ROOT_DIR}")

    loaded_count = 0
    for run_name in runs:
        run_data = read_run_data_from_disk(run_name)
        if run_data:
            RUN_DATA_CACHE[run_name] = run_data
            loaded_count += 1
        else:
            RUN_DATA_CACHE[run_name] = None  # Mark failure
            app.logger.warning(f"Failed to load data for run '{run_name}'.")

    CACHE_LOAD_TIME = time.time() - start_time
    app.logger.info(
        f"--- Preloading finished in {CACHE_LOAD_TIME:.2f}s. Loaded {loaded_count}/{len(runs)} runs. ---"
    )
    # Add more specific warnings if loading failed


# --- API Endpoints (Keep as they were) ---
@app.route("/api/runs")
def get_runs():
    app.logger.info(f"Request received for /api/runs")
    available_cached_runs = sorted(
        [run for run, data in RUN_DATA_CACHE.items() if data is not None]
    )
    app.logger.info(f"Returning available runs from cache: {available_cached_runs}")
    return jsonify(available_cached_runs)


@app.route("/api/data")
def get_data():
    selected_runs_str = request.args.get("runs", "")
    if not selected_runs_str:
        return jsonify({"error": "No runs specified"}), 400

    selected_runs = selected_runs_str.split(",")
    app.logger.info(f"Request: /api/data?runs={selected_runs_str} (serving from cache)")

    all_metrics_data = defaultdict(dict)
    start_time = time.time()
    runs_found_in_cache = 0
    metrics_collected = set()

    for run_name in selected_runs:
        if run_name in RUN_DATA_CACHE:
            run_data_from_cache = RUN_DATA_CACHE[run_name]
            if run_data_from_cache is not None:
                runs_found_in_cache += 1
                for metric_name, metric_data in run_data_from_cache.items():
                    if metric_data and metric_data.get("steps"):
                        all_metrics_data[metric_name][run_name] = metric_data
                        metrics_collected.add(metric_name)
            else:
                app.logger.warning(f"Skipping run '{run_name}' (load error).")
        else:
            app.logger.warning(f"Run '{run_name}' not found in cache.")

    duration = time.time() - start_time
    app.logger.info(
        f"Data assembly took {duration * 1000:.2f}ms. Found {runs_found_in_cache}/{len(selected_runs)} runs, {len(metrics_collected)} metrics."
    )

    if not all_metrics_data and runs_found_in_cache > 0:
        app.logger.warning(f"No common/scalar data for selected runs: {selected_runs}")
        return jsonify({})

    return jsonify(dict(all_metrics_data))


# --- Static File Serving ---
@app.route("/")
def serve_index():
    """Serves the main index.html file."""
    return send_from_directory(app.static_folder, "index.html")


@app.route("/<path:filename>")
def serve_static(filename):
    """Serves other static files (CSS, JS) from the frontend folder."""
    return send_from_directory(app.static_folder, filename)


# --- Main Execution / CLI Entry Point ---
def main():
    global LOG_ROOT_DIR  # <-- Declare intent to modify global

    parser = argparse.ArgumentParser(description="p-board: A TensorBoard log viewer.")
    parser.add_argument(
        "--logdir",
        type=str,
        required=True,
        help="Directory containing TensorBoard run subdirectories.",
    )
    parser.add_argument(
        "--port", type=int, default=5001, help="Port number to run the web server on."
    )
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",  # Default to localhost for security
        help="Host address to bind the server to (e.g., '0.0.0.0' for network access).",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Do not automatically open the browser.",
    )
    # Add more arguments if needed (e.g., --reload-interval)

    args = parser.parse_args()

    # Set the global LOG_ROOT_DIR based on the argument
    LOG_ROOT_DIR = os.path.abspath(args.logdir)  # Use absolute path
    print(f"p-board: Using log directory: {LOG_ROOT_DIR}")

    if not os.path.isdir(LOG_ROOT_DIR):
        print(
            f"!!! ERROR: Log directory does not exist: {LOG_ROOT_DIR}", file=sys.stderr
        )
        sys.exit(1)

    # Preload data *after* LOG_ROOT_DIR is set
    preload_all_runs()

    # Open browser automatically (in a separate thread to avoid blocking server start)
    if not args.no_browser:
        url = f"http://{args.host}:{args.port}"
        # Delay slightly to give server time to start
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
        print(f"p-board: View at {url} (opening in browser...)")
    else:
        print(f"p-board: View at http://{args.host}:{args.port}")

    print("--- Server Ready ---")
    # Run the Flask server
    app.run(debug=False, port=args.port, host=args.host)


# This ensures the main() function is called when the script is run directly
# It won't run automatically when imported as a package, which is correct.
if __name__ == "__main__":
    main()
