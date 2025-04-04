# server.py
import os
import sys
from flask import Flask, jsonify, request
from flask_cors import CORS
from tbparse import SummaryReader
import pandas as pd
from collections import defaultdict
import logging
import time

# --- Configuration ---
# !!! CHANGE THIS to the root directory containing your run folders !!!
LOG_ROOT_DIR = (
    "./tensorboard_logs"  # Or absolute path: "/path/to/your/tensorboard/logs"
)

# --- Globals for Caching ---
RUN_DATA_CACHE = {}  # Structure: { run_name: { metric_name: { steps: [], values: [], wall_times: [] } } }
CACHE_LOAD_TIME = 0

# --- Flask App Setup ---
app = Flask(__name__)
CORS(app)  # Enable Cross-Origin Resource Sharing

logging.basicConfig(level=logging.INFO)
app.logger.setLevel(logging.INFO)


# --- Helper Functions ---
def find_runs(root_dir):
    """Finds subdirectories in the root_dir, considering them as runs."""
    runs = []
    if not os.path.isdir(root_dir):
        app.logger.error(f"Log root directory not found: {root_dir}")
        return []
    try:
        for item in os.listdir(root_dir):
            item_path = os.path.join(root_dir, item)
            # Check if it's a directory AND contains tfevents files
            if os.path.isdir(item_path):
                try:
                    # A simple check for existence of *any* tfevents file
                    if any(
                        fname.startswith("events.out.tfevents.")
                        for fname in os.listdir(item_path)
                    ):
                        runs.append(item)
                    else:
                        app.logger.warning(
                            f"Directory '{item}' found but contains no tfevents files, skipping."
                        )
                except OSError as e_inner:
                    app.logger.error(
                        f"Error accessing directory '{item_path}': {e_inner}"
                    )

    except OSError as e:
        app.logger.error(f"Error listing runs in {root_dir}: {e}")
    return sorted(runs)


def read_run_data_from_disk(run_name):
    """Reads scalar data for a specific run using tbparse FROM DISK."""
    run_path = os.path.join(LOG_ROOT_DIR, run_name)
    app.logger.info(f"Reading data from disk for run: {run_name} (path: {run_path})")
    if not os.path.isdir(run_path):
        app.logger.warning(f"Run directory not found during disk read: {run_path}")
        return None
    try:
        start_time = time.time()
        # Use LONG format for easier processing and include wall_time
        reader = SummaryReader(run_path, pivot=False, extra_columns={"wall_time"})
        df = reader.scalars

        if df is None or df.empty:
            app.logger.warning(f"No scalar data found in run: {run_name}")
            return None

        duration = time.time() - start_time
        app.logger.info(
            f"Read {len(df)} scalar points for {run_name} in {duration:.2f}s"
        )

        # Group data by tag (metric name)
        grouped_data = defaultdict(
            lambda: {"steps": [], "values": [], "wall_times": []}
        )
        step_col = "step"
        value_col = "value"
        time_col = "wall_time"
        tag_col = "tag"

        # Ensure required columns exist
        required_cols = {step_col, value_col, time_col, tag_col}
        if not required_cols.issubset(df.columns):
            app.logger.error(
                f"Missing expected columns in tbparse output for run {run_name}. Found: {df.columns}, Required: {required_cols}"
            )
            return None

        # Sort by step for predictable plotting order
        df = df.sort_values(by=step_col)

        # Iterate and populate grouped_data
        for _, row in df.iterrows():
            tag = row[tag_col]
            # Basic type checking/conversion
            try:
                step = int(row[step_col])
                value = float(row[value_col])
                wall_time = float(row[time_col])

                # Skip NaN/Inf values as they break JSON/plotting
                if (
                    not pd.notna(value)
                    or not pd.notna(step)
                    or not pd.notna(wall_time)
                    or not all(map(pd.notna, [value, step, wall_time]))
                ):
                    app.logger.debug(
                        f"Skipping NaN/Inf entry: run={run_name}, tag={tag}, step={step}, value={value}"
                    )
                    continue

                grouped_data[tag]["steps"].append(step)
                grouped_data[tag]["values"].append(value)
                grouped_data[tag]["wall_times"].append(wall_time)

            except (ValueError, TypeError) as conv_err:
                app.logger.warning(
                    f"Skipping entry due to conversion error in run {run_name}, tag {tag}: {conv_err} (row data: {row.to_dict()})"
                )
                continue

        return dict(grouped_data)  # Convert back to regular dict for storage
    except Exception as e:
        app.logger.error(
            f"Error reading data for run {run_name} from disk: {e}", exc_info=True
        )
        return None


def preload_all_runs():
    """Loads data for all runs into the cache on startup."""
    global RUN_DATA_CACHE, CACHE_LOAD_TIME
    start_time = time.time()
    app.logger.info("--- Starting data preloading ---")
    runs = find_runs(LOG_ROOT_DIR)
    loaded_count = 0
    for run_name in runs:
        run_data = read_run_data_from_disk(run_name)
        if run_data:
            RUN_DATA_CACHE[run_name] = run_data
            loaded_count += 1
        else:
            # Store None to indicate failed load, prevent retries
            RUN_DATA_CACHE[run_name] = None
            app.logger.warning(
                f"Failed to load data for run '{run_name}', it will be unavailable."
            )

    CACHE_LOAD_TIME = time.time() - start_time
    app.logger.info(
        f"--- Preloading finished in {CACHE_LOAD_TIME:.2f}s. Loaded data for {loaded_count}/{len(runs)} runs. ---"
    )
    if loaded_count == 0 and len(runs) > 0:
        app.logger.error(
            "!!! No data successfully loaded for any runs. Check logs above for errors. !!!"
        )
    elif loaded_count < len(runs):
        app.logger.warning(
            f"!!! Failed to load data for {len(runs) - loaded_count} runs. Check logs. !!!"
        )


# --- API Endpoints ---
@app.route("/api/runs")
def get_runs():
    """Endpoint to list available runs (based on cache keys after preload)."""
    app.logger.info(f"Request received for /api/runs")
    # Return runs for which data was successfully loaded (or attempted)
    # Filter out runs marked as None (load failure)
    available_cached_runs = sorted(
        [run for run, data in RUN_DATA_CACHE.items() if data is not None]
    )
    app.logger.info(f"Returning available runs from cache: {available_cached_runs}")
    return jsonify(available_cached_runs)


@app.route("/api/data")
def get_data():
    """Endpoint to fetch scalar data for selected runs FROM CACHE."""
    selected_runs_str = request.args.get("runs", "")
    if not selected_runs_str:
        return jsonify({"error": "No runs specified"}), 400

    selected_runs = selected_runs_str.split(",")
    app.logger.info(
        f"Request received for /api/data?runs={selected_runs_str} (serving from cache)"
    )

    # Structure: { metric_name: { run_name: { steps: [], values: [], wall_times: [] } } }
    all_metrics_data = defaultdict(dict)

    start_time = time.time()
    runs_found_in_cache = 0
    metrics_collected = set()

    for run_name in selected_runs:
        if run_name in RUN_DATA_CACHE:
            run_data_from_cache = RUN_DATA_CACHE[run_name]
            # Only include data if load was successful (not None)
            if run_data_from_cache is not None:
                runs_found_in_cache += 1
                for metric_name, metric_data in run_data_from_cache.items():
                    # Ensure metric_data is not empty (paranoid check)
                    if metric_data and metric_data.get("steps"):
                        all_metrics_data[metric_name][run_name] = metric_data
                        metrics_collected.add(metric_name)
            else:
                app.logger.warning(
                    f"Requested run '{run_name}' had load errors, returning no data for it."
                )
        else:
            app.logger.warning(
                f"Requested run '{run_name}' not found in cache (was it present during preload?)."
            )

    duration = time.time() - start_time
    app.logger.info(
        f"Data assembly from cache took {duration * 1000:.2f}ms. Found data for {runs_found_in_cache}/{len(selected_runs)} requested runs, covering {len(metrics_collected)} metrics."
    )

    if not all_metrics_data and runs_found_in_cache > 0:
        app.logger.warning(
            f"No common metrics found or runs had no scalar data for selected runs: {selected_runs}"
        )
        return jsonify({})  # Return empty if runs exist but no common/scalar data

    # Convert outer defaultdict before returning
    return jsonify(dict(all_metrics_data))


# --- Run the Server ---
if __name__ == "__main__":
    print(f"TensorBoard Log Directory: {os.path.abspath(LOG_ROOT_DIR)}")
    if not os.path.isdir(LOG_ROOT_DIR):
        print(
            "!!! WARNING: Log directory does not exist. Please create it and add run data. !!!",
            file=sys.stderr,
        )
    preload_all_runs()  # Load data into cache on startup
    print("--- Server Ready ---")
    print(f"Preloading took {CACHE_LOAD_TIME:.2f}s. Access the UI via index.html.")
    # Use host='0.0.0.0' to make accessible on the network
    app.run(
        debug=False, port=5001, host="0.0.0.0"
    )  # Disable debug for potentially better performance after preload
