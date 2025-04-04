// main.js
const { WebglPlot, WebglLine, ColorRGBA } = WebglPlotBundle;

const dashboardContainer = document.getElementById('dashboard-container');
const runSelectorContainer = document.getElementById('run-selector');
const loadingIndicator = document.getElementById('loading-indicator');
const errorMessageDiv = document.getElementById('error-message');

// --- Configuration ---
const API_BASE_URL = 'http://localhost:5001'; // Adjust if backend runs elsewhere

// --- State ---
let availableRuns = [];
let selectedRuns = [];
// Structure: { metric_name: { wglp: WebglPlot, zoomRectLine: WebglLine, lines: { run_name: WebglLine }, minStep: Number, maxStep: Number, minY: Number, maxY: Number, isInitialLoad: Boolean } }
let activePlots = {};
let debounceTimer = null;
// *** NEW: Frontend Cache ***
// Structure: { run_name: { metric_name: { steps: [], values: [], wall_times: [] }, ... }, ... }
let frontendDataCache = {};

// --- Color Palette & Mapping ---
// (Keep Color functions the same)
const COLORS = [
    new ColorRGBA(0.12, 0.56, 1.0, 1), new ColorRGBA(1.0, 0.5, 0.05, 1),
    new ColorRGBA(0.17, 0.63, 0.17, 1), new ColorRGBA(0.84, 0.15, 0.16, 1),
    new ColorRGBA(0.58, 0.4, 0.74, 1),  new ColorRGBA(0.55, 0.34, 0.29, 1),
    new ColorRGBA(0.89, 0.47, 0.76, 1), new ColorRGBA(0.5, 0.5, 0.5, 1),
    new ColorRGBA(0.74, 0.74, 0.13, 1), new ColorRGBA(0.09, 0.75, 0.81, 1)
];
let colorIndex = 0;
const runColorMap = new Map();

function getRunColor(runName) {
    if (!runColorMap.has(runName)) {
        runColorMap.set(runName, COLORS[colorIndex % COLORS.length]);
        colorIndex++;
    }
    return runColorMap.get(runName);
}

// --- Error Handling ---
// (Keep Error functions the same)
function displayError(message) {
    console.error("Error:", message);
    errorMessageDiv.textContent = `Error: ${message}`;
    errorMessageDiv.style.display = 'block';
}
function clearError() {
    errorMessageDiv.textContent = '';
    errorMessageDiv.style.display = 'none';
}


// --- API Fetching ---
async function fetchRuns() { // (Keep fetchRuns the same)
    clearError();
    try {
        const response = await fetch(`${API_BASE_URL}/api/runs`);
        if (!response.ok) throw new Error(`Failed to fetch runs: ${response.status} ${response.statusText}`);
        availableRuns = await response.json();
        populateRunSelector();
    } catch (error) {
        displayError(error.message || 'Could not connect to backend. Is server.py running?');
        runSelectorContainer.innerHTML = '<p style="color: red;">Could not load runs.</p>';
    }
}

// *** MODIFIED: fetchDataForSelectedRuns ***
async function fetchDataForSelectedRuns() {
    clearError();

    if (selectedRuns.length === 0) {
        console.log("No runs selected, clearing plots.");
        updatePlots({}); // Clear plots
        return;
    }

    // 1. Identify runs to fetch vs. runs already cached
    const runsToFetch = selectedRuns.filter(runName => !(runName in frontendDataCache));
    const cachedRuns = selectedRuns.filter(runName => runName in frontendDataCache);

    console.log(`Selected: ${selectedRuns.join(', ')}`);
    console.log(`Cached: ${cachedRuns.join(', ') || 'None'}`);
    console.log(`Need to fetch: ${runsToFetch.join(', ') || 'None'}`);

    let fetchedData = null; // Will store data *only* for runsToFetch

    // 2. Fetch data only for non-cached runs
    if (runsToFetch.length > 0) {
        loadingIndicator.style.display = 'block';
        errorMessageDiv.style.display = 'none'; // Hide error during loading
        try {
            const runsParam = runsToFetch.join(',');
            console.log(`Fetching data for: ${runsParam}`);
            const response = await fetch(`${API_BASE_URL}/api/data?runs=${encodeURIComponent(runsParam)}`);
            if (!response.ok) {
                let errorMsg = `Failed to fetch data for ${runsParam}: ${response.status} ${response.statusText}`;
                try { const errorData = await response.json(); if (errorData && errorData.error) { errorMsg += ` - ${errorData.error}`; } } catch(e) {}
                throw new Error(errorMsg);
            }
            // Fetched data has structure: { metric: { run: data } }
            fetchedData = await response.json();
            console.log(`Received data for ${Object.keys(fetchedData || {}).length} metrics for newly fetched runs.`);

            // 3. Add newly fetched data to the frontend cache
            // Iterate through metrics, then runs within that metric from fetchedData
            for (const metricName in fetchedData) {
                for (const runName in fetchedData[metricName]) {
                     // Ensure run exists in cache structure
                    if (!frontendDataCache[runName]) {
                        frontendDataCache[runName] = {};
                    }
                    // Store the data for this specific metric under the run
                    frontendDataCache[runName][metricName] = fetchedData[metricName][runName];
                }
            }
            console.log(`Frontend cache updated for runs: ${runsToFetch.join(', ')}`);

        } catch (error) {
            displayError(error.message || `Could not fetch data for runs: ${runsToFetch.join(', ')}`);
            // Continue without the newly fetched data, will use only cached data below
        } finally {
            loadingIndicator.style.display = 'none';
        }
    } else {
        console.log("All selected runs are already cached. Skipping fetch.");
        // Ensure loading indicator is hidden if we skipped fetch
        loadingIndicator.style.display = 'none';
    }

    // 4. Construct the final data object for updatePlots using ALL selected runs from the cache
    // Structure needed for updatePlots: { metric_name: { run_name: { steps, values,... } } }
    const metricsDataForUpdate = {};
    for (const runName of selectedRuns) {
        if (frontendDataCache[runName]) { // Check if run exists in cache (might have failed fetch)
            for (const metricName in frontendDataCache[runName]) {
                if (!metricsDataForUpdate[metricName]) {
                    metricsDataForUpdate[metricName] = {};
                }
                 // Only add if the run is actually selected
                 if (selectedRuns.includes(runName)) {
                     metricsDataForUpdate[metricName][runName] = frontendDataCache[runName][metricName];
                 }
            }
        }
    }

    // 5. Update the plots with the combined data (cached + newly fetched)
    console.log(`Updating plots with data for ${Object.keys(metricsDataForUpdate).length} metrics covering runs: ${selectedRuns.join(', ')}`);
    updatePlots(metricsDataForUpdate);
}


// --- UI Update ---
// (Keep populateRunSelector and handleRunSelectionChange the same)
function populateRunSelector() {
    runSelectorContainer.innerHTML = '';
    if (availableRuns.length === 0) {
        runSelectorContainer.innerHTML = '<p>No runs found or loaded by backend.</p>';
        return;
    }
    availableRuns.forEach(runName => {
        const div = document.createElement('div'); div.className = 'run-checkbox-item';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
        checkbox.id = `run-${runName}`; checkbox.value = runName;
        // Clear cache if run list changes? Maybe not necessary for simple case.
        checkbox.addEventListener('change', handleRunSelectionChange);
        const label = document.createElement('label'); label.htmlFor = `run-${runName}`;
        label.textContent = runName;
        const swatch = document.createElement('span'); swatch.className = 'color-swatch';
        swatch.style.backgroundColor = getRunColor(runName).toString();
        label.prepend(swatch, ' ');
        div.appendChild(checkbox); div.appendChild(label);
        runSelectorContainer.appendChild(div);
    });
}

function handleRunSelectionChange() {
    selectedRuns = Array.from(runSelectorContainer.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
        await fetchDataForSelectedRuns();
        // Reset the view for each plot after fetching data
        for (const metricName in activePlots) {
            const plotInfo = activePlots[metricName];
            if (plotInfo && isFinite(plotInfo.minStep) && isFinite(plotInfo.maxStep) && isFinite(plotInfo.minY) && isFinite(plotInfo.maxY)) {
                setPlotAxes(plotInfo.wglp, plotInfo.minStep, plotInfo.maxStep, plotInfo.minY, plotInfo.maxY);
            }
        }
    }, 300); // Keep debounce
}

// --- Plotting Logic ---
// (Keep updatePlots, removePlot, createOrUpdatePlot, setPlotAxes, setupInteractions the same)
// No changes needed in the actual plotting functions, they just receive the data.
function updatePlots(metricsData) {
    console.log("Updating plots...");
    const currentMetricNames = Object.keys(metricsData);
    const existingMetricNames = Object.keys(activePlots);

    // Remove plots for metrics entirely gone from the latest data
    existingMetricNames.forEach(metricName => {
        if (!currentMetricNames.includes(metricName)) {
            console.log(`Removing plot (metric no longer present): ${metricName}`);
            removePlot(metricName);
        }
    });

    // *** MODIFIED GROUPING LOGIC START ***
    const metricGroups = {};
    const defaultGroupName = 'General'; // Name for metrics without a '/' prefix

    currentMetricNames.forEach(metricName => {
        let groupName;
        const slashIndex = metricName.indexOf('/'); // Find the first slash

        if (slashIndex !== -1) {
            // Contains a slash, take the part *before* the first one
            groupName = metricName.substring(0, slashIndex);
        } else {
            // No slash found, assign to the default group
            groupName = defaultGroupName;
        }

        // Ensure the group array exists and add the metric name
        if (!metricGroups[groupName]) {
            metricGroups[groupName] = [];
        }
        metricGroups[groupName].push(metricName);
    });
    // *** MODIFIED GROUPING LOGIC END ***

    // --- Remove Empty Group Containers ---
    const currentGroupContainerIds = Array.from(dashboardContainer.querySelectorAll('.metric-group')).map(el => el.id);
    currentGroupContainerIds.forEach(groupId => {
        const groupNameFromId = groupId.replace('metric-group-', '');
        // If a group container exists in the DOM but is NOT in our calculated metricGroups, remove it
        if (!(groupNameFromId in metricGroups)) {
            const groupContainerToRemove = document.getElementById(groupId);
            if (groupContainerToRemove) {
                console.log(`Removing empty metric group container: ${groupNameFromId}`);
                dashboardContainer.removeChild(groupContainerToRemove);
                // Also remove associated plots from activePlots if they weren't caught earlier?
                // This part might be redundant if the first loop in updatePlots already removed them.
            }
        }
    });
    // --- End Remove Empty Group Containers ---

    // Create or update tabs for each metric group, sorting alphabetically
    // Make sure the 'General' group (or default) appears last or first if desired
    const sortedGroupNames = Object.keys(metricGroups).sort((a, b) => {
        if (a === defaultGroupName) return 1; // Push default group towards the end
        if (b === defaultGroupName) return -1;
        return a.localeCompare(b); // Alphabetical sort for others
    });

    sortedGroupNames.forEach(groupName => {
        createOrUpdateMetricGroupTab(groupName, metricGroups[groupName], metricsData);
    });

    console.log("Plot update finished.");
}

function createOrUpdateMetricGroupTab(groupName, metricNames, metricsData) {
    const groupContainerId = `metric-group-${groupName}`;
    let groupContainer = document.getElementById(groupContainerId);
    let plotsContainer; // Define plotsContainer variable

    if (!groupContainer) {
        // Create a new group container if it doesn't exist
        groupContainer = document.createElement('div');
        groupContainer.id = groupContainerId;
        groupContainer.className = 'metric-group'; // Initially expanded

        const header = document.createElement('div');
        header.className = 'metric-group-header';
        // Add title attribute for full name on hover
        header.innerHTML = `<h3 title="${groupName}">${groupName}</h3><button class="toggle-button" aria-expanded="true" aria-controls="plots-${groupName}"></button>`;
        header.addEventListener('click', () => {
            const isCollapsed = groupContainer.classList.toggle('collapsed');
            header.querySelector('button').setAttribute('aria-expanded', !isCollapsed);
        });

        plotsContainer = document.createElement('div'); // Assign here
        plotsContainer.className = 'metric-group-plots';
        plotsContainer.id = `plots-${groupName}`; // Add ID for aria-controls

        groupContainer.appendChild(header);
        groupContainer.appendChild(plotsContainer);
        dashboardContainer.appendChild(groupContainer); // Add to main dashboard
        console.log(`Created metric group container: ${groupName}`);
    } else {
        // If group container exists, find its plots container
        plotsContainer = groupContainer.querySelector('.metric-group-plots');
        if (!plotsContainer) {
            // Safety check: If somehow plots container is missing, recreate it
            console.warn(`Plots container missing for group ${groupName}. Recreating.`);
            plotsContainer = document.createElement('div');
            plotsContainer.className = 'metric-group-plots';
            plotsContainer.id = `plots-${groupName}`;
            groupContainer.appendChild(plotsContainer); // Append to existing group container
        }
        // Ensure header title is up-to-date (might not change often, but safe)
        const headerH3 = groupContainer.querySelector('.metric-group-header h3');
        if (headerH3) headerH3.title = groupName;
    }

    // Create or update plots for each metric in the group
    metricNames.forEach(metricName => {
        const plotDataForMetric = metricsData[metricName];
        // *** Pass plotsContainer as the third argument ***
        createOrUpdatePlot(metricName, plotDataForMetric, plotsContainer);
    });

    // --- Clean up plots no longer in this specific group ---
    // Get all plot wrappers currently inside *this* group's plotsContainer
    const currentPlotWrappersInGroup = Array.from(plotsContainer.children);

    currentPlotWrappersInGroup.forEach(wrapperElement => {
        // *** Get the original metricName from the data attribute ***
        const existingMetricNameInGroup = wrapperElement.dataset.metricName;
        if (existingMetricNameInGroup) {
            // If a plot wrapper inside this group corresponds to a metric
            // that is NOT in the 'metricNames' list for *this specific group* anymore, remove it.
            if (!metricNames.includes(existingMetricNameInGroup)) {
                console.log(`Removing plot ${existingMetricNameInGroup} from group ${groupName} as it no longer belongs.`);
                // Directly remove the element since we have it, no need to call removePlot which deletes from activePlots too soon
                try {
                    plotsContainer.removeChild(wrapperElement);
                    // Now also remove from the global activePlots if it was removed from its *last* group
                    // Check if this metric still exists in *any* group
                    const stillExistsInAnyGroup = Object.values(metricGroups).flat().includes(existingMetricNameInGroup);
                    if (!stillExistsInAnyGroup && activePlots[existingMetricNameInGroup]) {
                        delete activePlots[existingMetricNameInGroup];
                        console.log(`Deleted ${existingMetricNameInGroup} from activePlots as it was removed from its last group.`);
                    }
                } catch (e) {
                    console.warn(`Error removing plot wrapper ${wrapperElement.id} from group ${groupName}:`, e);
                }
            }
        } else {
            console.warn("Found element in plots container with unexpected ID or missing data-metric-name:", wrapperElement.id);
            // *** Add a check to remove the element if it's missing the data attribute ***
            try {
                plotsContainer.removeChild(wrapperElement);
                console.warn(`Removed orphaned plot wrapper ${wrapperElement.id} from group ${groupName}.`);
            } catch (e) {
                console.warn(`Error removing orphaned plot wrapper ${wrapperElement.id} from group ${groupName}:`, e);
            }
        }
    });
    // --- End cleanup ---
}

function removePlot(metricName) {
    const plotInfo = activePlots[metricName];
    if (plotInfo) {
        const plotContainerId = `plot-wrapper-${metricName.replace(/[^a-zA-Z0-9]/g, '-')}`;
        const plotWrapper = document.getElementById(plotContainerId);

        // Remove the DOM element if it exists and has a parent
        if (plotWrapper && plotWrapper.parentNode) {
            try {
                // *** Remove from its actual parent ***
                plotWrapper.parentNode.removeChild(plotWrapper);
            } catch (e) {
                console.warn(`Error removing plot wrapper DOM element for ${metricName}:`, e);
            }
        } else if (plotWrapper) {
            console.warn(`Plot wrapper for ${metricName} found but has no parent during removal.`);
        } else {
            // console.log(`Plot wrapper DOM element for ${metricName} not found during removal (might have been removed by group cleanup).`);
        }

        // TODO: Clean up WebGL resources if the library provides a method
        // Example: if (plotInfo.wglp && typeof plotInfo.wglp.dispose === 'function') {
        //     plotInfo.wglp.dispose();
        // }

        // Remove from the active plots tracking object
        delete activePlots[metricName];
        console.log(`Removed plot state for: ${metricName}`);
    }
}


function createOrUpdatePlot(metricName, plotDataForMetric, parentElement) {
    let plotInfo = activePlots[metricName];
    let wglp, zoomRectLine;
    const plotContainerId = `plot-wrapper-${metricName.replace(/[^a-zA-Z0-9]/g, '-')}`; // Define ID early

    // --- Calculate Overall Data Range ---
    let overallMinStep = Infinity, overallMaxStep = -Infinity;
    let overallMinY = Infinity, overallMaxY = -Infinity;
    let hasValidData = false; // Flag if any *selected* run has data for this metric

    const runsInMetric = Object.keys(plotDataForMetric);

    runsInMetric.forEach(runName => {
        if (!selectedRuns.includes(runName)) return; // Ensure run is actually selected

        const runData = plotDataForMetric[runName];
        if (runData && runData.steps && runData.steps.length > 0 && runData.steps.length === runData.values.length) {
            const validSteps = runData.steps.filter(s => isFinite(s));
            const validValues = runData.values.filter(v => isFinite(v));

            if (validSteps.length > 0) {
                hasValidData = true;
                overallMinStep = Math.min(overallMinStep, ...validSteps);
                overallMaxStep = Math.max(overallMaxStep, ...validSteps);
            }
            if (validValues.length > 0) {
                hasValidData = true;
                overallMinY = Math.min(overallMinY, ...validValues);
                overallMaxY = Math.max(overallMaxY, ...validValues);
            }
        }
    });

    // If no selected run has valid data for this metric, ensure it's removed
    if (!hasValidData) {
        if (plotInfo) {
            // Plot state exists, but no data. Remove it completely.
            console.log(`Removing plot (no valid data): ${metricName}`);
            removePlot(metricName);
        } else {
            // Plot state doesn't exist and no data, check if DOM element exists erroneously and remove it
            const existingWrapper = document.getElementById(plotContainerId);
            if (existingWrapper && existingWrapper.parentNode) {
                console.warn(`Found orphaned plot wrapper ${plotContainerId} with no data or state. Removing.`);
                existingWrapper.parentNode.removeChild(existingWrapper);
            }
        }
        return; // Exit if no data to plot for selection
    }

    // Handle range defaults if only one point or infinite values encountered
    if (!isFinite(overallMinStep)) overallMinStep = 0;
    if (!isFinite(overallMaxStep)) overallMaxStep = 1;
    if (!isFinite(overallMinY)) overallMinY = 0;
    if (!isFinite(overallMaxY)) overallMaxY = 1;
    // Add buffer only if min/max are the same
    if (overallMaxStep - overallMinStep < 1e-9) { overallMinStep -= 0.5; overallMaxStep += 0.5; }
    if (overallMaxY - overallMinY < 1e-9) { overallMinY -= Math.abs(overallMinY * 0.1) || 0.1; overallMaxY += Math.abs(overallMaxY * 0.1) || 0.1; }


    // --- Create Plot or Ensure Correct Parent ---
    let wrapper = document.getElementById(plotContainerId);
    let canvas;
    let needsInitialization = false;

    if (!plotInfo) { // Case 1: Plot state doesn't exist
        needsInitialization = true;
        // console.log(`Creating plot state and element: ${metricName} inside parent`, parentElement);

        if (wrapper) { // Element exists but state doesn't (e.g., error recovery)
            console.warn(`Plot wrapper ${plotContainerId} exists but no state. Reusing element, initializing state.`);
            // Ensure it's in the correct parent
            if (wrapper.parentNode !== parentElement) {
                console.warn(`Moving existing plot wrapper ${plotContainerId} to correct parent.`);
                parentElement.appendChild(wrapper); // Move it
            }
            canvas = wrapper.querySelector('canvas');
            if (!canvas) {
                console.error("Wrapper exists but canvas missing. Recreating canvas.");
                canvas = document.createElement('canvas');
                canvas.className = 'plot-canvas';
                // Clear wrapper and append? Just append for now.
                wrapper.appendChild(canvas);
            }
        } else { // Element also doesn't exist, create it
            wrapper = document.createElement('div');
            wrapper.className = 'plot-wrapper';
            wrapper.id = plotContainerId;
            // *** Store the original metricName as a data attribute ***
            wrapper.dataset.metricName = metricName; // Add this line
            const title = document.createElement('h3');
            title.textContent = metricName;
            title.title = metricName; // Add title attribute for long names
            canvas = document.createElement('canvas');
            // canvas.id = `canvas-${metricName.replace(/[^a-zA-Z0-9]/g, '-')}`; // ID might not be needed if accessed via wrapper
            canvas.className = 'plot-canvas';
            wrapper.appendChild(title);
            wrapper.appendChild(canvas);
            // *** Append to the correct parentElement ***
            parentElement.appendChild(wrapper);
        }

        const devicePixelRatio = window.devicePixelRatio || 1;
        const initialWidth = canvas.clientWidth || 400;
        const initialHeight = canvas.clientHeight || 300;
        canvas.width = Math.max(1, Math.round(initialWidth * devicePixelRatio)); // Ensure non-zero
        canvas.height = Math.max(1, Math.round(initialHeight * devicePixelRatio)); // Ensure non-zero

        wglp = new WebglPlot(canvas);
        zoomRectLine = new WebglLine(new ColorRGBA(0.9, 0.9, 0.9, 0.7), 4);
        zoomRectLine.loop = true; zoomRectLine.xy = new Float32Array(8).fill(0); zoomRectLine.visible = false;
        wglp.addLine(zoomRectLine);

        plotInfo = { wglp, zoomRectLine, lines: {}, isInitialLoad: true }; // Mark for initial axis set
        activePlots[metricName] = plotInfo; // Add to active plots state map

        setupInteractions(canvas, wglp, zoomRectLine, plotInfo); // Setup interactions

        if (canvas.width > 0 && canvas.height > 0) {
            wglp.viewport(0, 0, canvas.width, canvas.height);
        } else {
            console.error(`Canvas ${metricName} has zero dimensions AFTER setup.`);
        }

    } else { // Case 2: Plot state *does* exist
        wglp = plotInfo.wglp;
        zoomRectLine = plotInfo.zoomRectLine;

        // Ensure the existing DOM element is in the correct parent
        if (!wrapper) {
            console.error(`Plot state exists for ${metricName} but wrapper element not found. Cannot update.`);
            // Attempt recovery? Maybe recreate element? For now, log error and skip update.
            removePlot(metricName); // Clean up broken state
            return;
        }
        if (wrapper.parentNode !== parentElement) {
            console.warn(`Moving existing plot ${metricName} to new group parent.`);
            parentElement.appendChild(wrapper); // Move it
        }
        // If state exists, but wglp object is missing (e.g. error during previous init), try re-init
        if (!wglp) {
            console.error(`Plot state exists for ${metricName} but wglp is missing. Re-initializing.`);
            needsInitialization = true;
            canvas = wrapper.querySelector('canvas');
            if (!canvas) { // Should have canvas if wrapper exists, but check
                console.error("Cannot re-initialize plot: canvas missing.");
                removePlot(metricName); return;
            }
            // Re-create WebGL plot and lines
            wglp = new WebglPlot(canvas);
            zoomRectLine = new WebglLine(new ColorRGBA(0.9, 0.9, 0.9, 0.7), 4);
            zoomRectLine.loop = true; zoomRectLine.xy = new Float32Array(8).fill(0); zoomRectLine.visible = false;
            wglp.addLine(zoomRectLine);
            plotInfo.wglp = wglp; // Update state
            plotInfo.zoomRectLine = zoomRectLine;
            plotInfo.lines = {}; // Reset lines map
            plotInfo.isInitialLoad = true; // Force axis reset

            setupInteractions(canvas, wglp, zoomRectLine, plotInfo);
            if (canvas.width > 0 && canvas.height > 0) {
                wglp.viewport(0, 0, canvas.width, canvas.height);
            }
        }
    }


    // Store calculated ranges for reset (always update ranges)
    plotInfo.minStep = overallMinStep;
    plotInfo.maxStep = overallMaxStep;
    plotInfo.minY = overallMinY;
    plotInfo.maxY = overallMaxY;

    // --- Set Axis Scales on Initialization/Re-initialization ---
    if (plotInfo.isInitialLoad) {
        // console.log(`Setting initial axes for plot: ${metricName}`);
        setPlotAxes(wglp, overallMinStep, overallMaxStep, overallMinY, overallMaxY);
        plotInfo.isInitialLoad = false; // Mark initial load as done
    }

    // Ensure plot wrapper is visible
    if (wrapper && wrapper.style.display === 'none') {
        wrapper.style.display = '';
    }


    // --- Update Lines ---
    const existingRunsInPlotLines = Object.keys(plotInfo.lines);
    const currentRunsForMetric = Object.keys(plotDataForMetric).filter(runName => selectedRuns.includes(runName)); // Runs selected AND having data

    // Hide or remove lines for runs no longer selected OR runs with no data now for this metric
    existingRunsInPlotLines.forEach(runName => {
        if (!currentRunsForMetric.includes(runName)) {
            if (plotInfo.lines[runName]) {
                // Instead of just hiding, let's try removing the line object entirely from wglp
                // This requires wglp library support, assuming it has removeLine or similar
                // If not, just setting visible=false is the fallback.
                // Assuming wglp doesn't have removeLine, stick to visible=false:
                plotInfo.lines[runName].visible = false;
                // console.log(`Hiding line (no longer selected/no data): ${metricName}/${runName}`);

                // If wglp HAD removeLine:
                // try {
                //    wglp.removeLine(plotInfo.lines[runName]);
                // } catch (removeErr) { console.error("Error removing line:", removeErr); }
                // delete plotInfo.lines[runName]; // Remove from our tracking map too
            }
        }
    });

    // Add/Update lines for currently selected runs that HAVE data for this metric
    currentRunsForMetric.forEach(runName => {
        const runData = plotDataForMetric[runName];

        // Data validity check
        if (!runData || !runData.steps || runData.steps.length === 0 || runData.steps.length !== runData.values.length) {
            if (plotInfo.lines[runName]) { plotInfo.lines[runName].visible = false; }
            if (runData && runData.steps && runData.values && runData.steps.length !== runData.values.length) {
                console.warn(`Step/value length mismatch for ${metricName}/${runName}. Hiding line.`);
            }
            return; // Skip this run for this metric
        }

        let line = plotInfo.lines[runName];
        const numPoints = runData.steps.length;
        const color = getRunColor(runName);

        if (!line) { // Create line if new
            line = new WebglLine(color, numPoints);
            plotInfo.lines[runName] = line;
            wglp.addLine(line);
            // console.log(`Added line for ${runName} to ${metricName}`);
        } else if (line.numPoints !== numPoints) { // Recreate if point count changed
            console.warn(`Point count changed for ${metricName}/${runName} (${line.numPoints} -> ${numPoints}). Recreating line.`);
            // Best practice: remove old line from wglp if possible, then add new one.
            // Fallback: Hide old, create & add new. (Using fallback)
            line.visible = false; // Hide old JS object visually

            line = new WebglLine(color, numPoints); // Create new JS object
            plotInfo.lines[runName] = line; // Replace in our map
            wglp.addLine(line); // Add NEW line object to WebGL context
            // console.log(`Re-added line for ${runName} to ${metricName} after point count change.`);
        }

        // Update line data
        const xyData = new Float32Array(numPoints * 2);
        let dataIsValid = true; // Track if ALL points are valid
        let validPointCount = 0;
        for (let i = 0; i < numPoints; i++) {
            const step = runData.steps[i];
            const value = runData.values[i];
            if (!isFinite(step) || !isFinite(value)) {
                // Skip non-finite points entirely - don't plot them
                // console.warn(`Non-finite data point at index ${i} for ${metricName}/${runName}. Skipping point.`);
                dataIsValid = false; // Mark that some data was skipped
                continue; // Don't increment validPointCount or add to xyData
            } else {
                xyData[validPointCount * 2] = step;
                xyData[validPointCount * 2 + 1] = value;
                validPointCount++;
            }
        }

        // Assign data and control visibility
        if (validPointCount > 0) {
            // If point count changed due to filtering NaNs, we might need to recreate the line buffer
            if (line.numPoints !== validPointCount) {
                console.warn(`Filtered point count changed for ${metricName}/${runName} (${line.numPoints} -> ${validPointCount}). Recreating line.`);
                line.visible = false; // Hide old one
                line = new WebglLine(color, validPointCount);
                plotInfo.lines[runName] = line;
                wglp.addLine(line);
            }
            // Use slice to only pass the valid points if filtering occurred
            line.xy = xyData.slice(0, validPointCount * 2);
            line.color = color; // Ensure color is current
            line.visible = true; // Make visible
        } else {
            line.visible = false; // Hide if no valid points remain
            if (numPoints > 0) { // Log if there were points initially but all were invalid
                console.warn(`All data points for ${metricName}/${runName} were non-finite. Hiding line.`);
            }
        }
    });

} // End of createOrUpdatePlot

// --- setPlotAxes and Interactions ---
// (Keep setPlotAxes and setupInteractions the same as before)
// Double-click reset will now reliably use the overall range of the *currently plotted* data
// stored in plotInfo.minStep, plotInfo.maxStep, etc.
function setPlotAxes(wglp, minX, maxX, minY, maxY) {
    // Add padding (ensure range is non-zero first)
    let rangeX = maxX - minX;
    let rangeY = maxY - minY;

    // Handle zero range cases robustly
    if (rangeX <= 1e-9) rangeX = 1; // Default range if single point or zero range
    if (rangeY <= 1e-9) rangeY = Math.abs(maxY * 0.2) || 0.2; // Default range

    const paddingX = rangeX * 0.05;
    const paddingY = rangeY * 0.05;

    const finalMinX = minX - paddingX;
    const finalMaxX = maxX + paddingX;
    const finalMinY = minY - paddingY;
    const finalMaxY = maxY + paddingY;

    const finalRangeX = finalMaxX - finalMinX;
    const finalRangeY = finalMaxY - finalMinY;

    // Calculate and set scale/offset, guarding against zero division
    wglp.gScaleX = (finalRangeX > 1e-9) ? (2 / finalRangeX) : 1;
    wglp.gOffsetX = -1 - finalMinX * wglp.gScaleX;

    wglp.gScaleY = (finalRangeY > 1e-9) ? (2 / finalRangeY) : 1;
    wglp.gOffsetY = -1 - finalMinY * wglp.gScaleY;

     // Clamp scale to prevent extreme zooms from bad data ranges or interactions
     wglp.gScaleX = Math.max(1e-6, Math.min(1e6, wglp.gScaleX));
     wglp.gScaleY = Math.max(1e-6, Math.min(1e6, wglp.gScaleY));

     // console.log(`Set Axes: X=[${finalMinX.toFixed(2)}, ${finalMaxX.toFixed(2)}] Y=[${finalMinY.toFixed(2)}, ${finalMaxY.toFixed(2)}] Scale=(${wglp.gScaleX.toFixed(2)}, ${wglp.gScaleY.toFixed(2)}) Offset=(${wglp.gOffsetX.toFixed(2)}, ${wglp.gOffsetY.toFixed(2)})`);
}

function setupInteractions(canvas, wglp, zoomRectLine, plotInfo) {
     let isDragging = false; let isZoomingRect = false;
     let dragStartX = 0, dragStartY = 0; // Screen coords
     let plotOffsetXOld = 0, plotOffsetYOld = 0; // Plot offset state
     let zoomRectStartXNDC = 0, zoomRectStartYNDC = 0; // NDC coords
     const devicePixelRatio = window.devicePixelRatio || 1;

     const ndcToPlotCoords = (ndcX, ndcY) => {
         // Prevent division by zero if scale is somehow 0
        const plotX = Math.abs(wglp.gScaleX) > 1e-9 ? (ndcX - wglp.gOffsetX) / wglp.gScaleX : 0;
        const plotY = Math.abs(wglp.gScaleY) > 1e-9 ? (ndcY - wglp.gOffsetY) / wglp.gScaleY : 0;
        return { x: plotX, y: plotY };
     };

     const screenToPlotCoords = (screenX, screenY) => {
        const ndcX = (2 * (screenX * devicePixelRatio - canvas.width / 2)) / canvas.width;
        const ndcY = (-2 * (screenY * devicePixelRatio - canvas.height / 2)) / canvas.height;
        return ndcToPlotCoords(ndcX, ndcY);
     };


     canvas.addEventListener('contextmenu', (e) => e.preventDefault());

     // Double click: Reset view using the stored overall data range for this plot
     canvas.addEventListener('dblclick', (e) => {
        e.preventDefault();
        // Use the min/max values stored in plotInfo, calculated in createOrUpdatePlot
        if (plotInfo && isFinite(plotInfo.minStep) && isFinite(plotInfo.maxStep) && isFinite(plotInfo.minY) && isFinite(plotInfo.maxY)) {
            console.log(`Resetting axes for plot '${canvas.id.replace('canvas-','')}' using stored range: X=[${plotInfo.minStep}, ${plotInfo.maxStep}], Y=[${plotInfo.minY}, ${plotInfo.maxY}]`);
            setPlotAxes(wglp, plotInfo.minStep, plotInfo.maxStep, plotInfo.minY, plotInfo.maxY);
        } else {
            console.warn("Cannot reset plot axes: Stored range data missing or invalid.", plotInfo);
            // Fallback: Reset to some default? Or do nothing? Doing nothing is safer.
        }
        zoomRectLine.visible = false;
     });

     canvas.addEventListener('mousedown', (e) => {
        e.preventDefault();
        canvas.focus(); // Helps with potential focus issues?

        // Convert screen coords (e.offsetX/Y) to NDC for consistency
        const currentNdcX = (2 * (e.offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
        const currentNdcY = (-2 * (e.offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;

        if (e.button === 0) { // Left Click: Start Zoom Rect
            isZoomingRect = true; isDragging = false;
            zoomRectStartXNDC = currentNdcX;
            zoomRectStartYNDC = currentNdcY;
            try {
                const startPlotCoords = ndcToPlotCoords(zoomRectStartXNDC, zoomRectStartYNDC);
                 if (!isFinite(startPlotCoords.x) || !isFinite(startPlotCoords.y)) throw new Error("Invalid start plot coords");
                 zoomRectLine.xy = new Float32Array([
                     startPlotCoords.x, startPlotCoords.y, startPlotCoords.x, startPlotCoords.y,
                     startPlotCoords.x, startPlotCoords.y, startPlotCoords.x, startPlotCoords.y,
                 ]);
                 zoomRectLine.visible = true;
                 canvas.style.cursor = 'crosshair';
            } catch (convErr) {
                 console.error("Error starting zoom rect:", convErr);
                 isZoomingRect = false; zoomRectLine.visible = false; canvas.style.cursor = 'grab';
            }

        } else if (e.button === 2) { // Right Click: Start Pan
            isDragging = true; isZoomingRect = false; zoomRectLine.visible = false;
            // Use clientX/Y for panning start reference as offsetX/Y can be relative to padding/border
            dragStartX = e.clientX; dragStartY = e.clientY;
            plotOffsetXOld = wglp.gOffsetX; plotOffsetYOld = wglp.gOffsetY;
            canvas.style.cursor = 'grabbing';
        }
     });

    canvas.addEventListener('mousemove', (e) => {
        if (!isDragging && !isZoomingRect) {
             canvas.style.cursor = 'grab'; // Default cursor when not interacting
             return;
        }
        e.preventDefault();

         // Convert current mouse position (screen coords) to NDC
         const currentNdcX = (2 * (e.offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
         const currentNdcY = (-2 * (e.offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;

        if (isDragging) {
            // Calculate delta using clientX/Y relative to drag start
            const dx = (e.clientX - dragStartX) * devicePixelRatio;
            const dy = (e.clientY - dragStartY) * devicePixelRatio;

            // Convert screen pixel delta to plot offset delta
            // deltaOffset = (pixelDelta / canvasDimension) * 2 / scale
            const deltaOffsetX = (Math.abs(wglp.gScaleX) > 1e-9) ? (dx / canvas.width) * 2 / wglp.gScaleX : 0;
            const deltaOffsetY = (Math.abs(wglp.gScaleY) > 1e-9) ? (-dy / canvas.height) * 2 / wglp.gScaleY : 0; // dy is negative in screen Y

            wglp.gOffsetX = plotOffsetXOld + deltaOffsetX;
            wglp.gOffsetY = plotOffsetYOld + deltaOffsetY;
            canvas.style.cursor = 'grabbing';

        } else if (isZoomingRect) {
             try {
                const startPlot = ndcToPlotCoords(zoomRectStartXNDC, zoomRectStartYNDC);
                const currentPlot = ndcToPlotCoords(currentNdcX, currentNdcY);
                 if (!isFinite(startPlot.x) || !isFinite(startPlot.y) || !isFinite(currentPlot.x) || !isFinite(currentPlot.y)) {
                     throw new Error("Invalid plot coords during zoom rect move");
                 }
                // Update zoom rectangle corners
                zoomRectLine.xy = new Float32Array([
                    startPlot.x, startPlot.y, currentPlot.x, startPlot.y,
                    currentPlot.x, currentPlot.y, startPlot.x, currentPlot.y
                ]);
                zoomRectLine.visible = true; // Ensure visible
            } catch (convErr) {
                 console.error("Error updating zoom rect:", convErr);
                 // Optionally stop zoom rect drawing here?
                 // isZoomingRect = false; zoomRectLine.visible = false; canvas.style.cursor = 'grab';
            }
            canvas.style.cursor = 'crosshair';
        }
    });

     canvas.addEventListener('mouseup', (e) => {
        if (!isDragging && !isZoomingRect) return; // Only handle if interaction was active
        e.preventDefault();

         const endNdcX = (2 * (e.offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
         const endNdcY = (-2 * (e.offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;

        if (isDragging) {
            isDragging = false;
            canvas.style.cursor = 'grab';
        } else if (isZoomingRect) {
            isZoomingRect = false;
            zoomRectLine.visible = false; // Hide rect immediately
            canvas.style.cursor = 'grab';

            const minDragThresholdNDC = 0.02; // Minimum size in NDC to trigger zoom
            // Check if the rectangle is large enough to be considered a zoom action
            if (Math.abs(endNdcX - zoomRectStartXNDC) > minDragThresholdNDC || Math.abs(endNdcY - zoomRectStartYNDC) > minDragThresholdNDC)
            {
                 try {
                     // Convert NDC corners to plot coordinates *before* the zoom
                     const startPlot = ndcToPlotCoords(zoomRectStartXNDC, zoomRectStartYNDC);
                     const endPlot = ndcToPlotCoords(endNdcX, endNdcY);

                      if (!isFinite(startPlot.x) || !isFinite(startPlot.y) || !isFinite(endPlot.x) || !isFinite(endPlot.y)) {
                          throw new Error("Invalid plot coords for zoom calculation");
                      }

                     const minPlotX = Math.min(startPlot.x, endPlot.x);
                     const maxPlotX = Math.max(startPlot.x, endPlot.x);
                     const minPlotY = Math.min(startPlot.y, endPlot.y);
                     const maxPlotY = Math.max(startPlot.y, endPlot.y);

                     const centerX = (minPlotX + maxPlotX) / 2;
                     const centerY = (minPlotY + maxPlotY) / 2;
                     const rangeX = maxPlotX - minPlotX;
                     const rangeY = maxPlotY - minPlotY;

                     // Check ranges are valid before calculating new scale
                     if (rangeX > 1e-9 && rangeY > 1e-9) {
                         // Calculate new scale based on the selected range
                         let newScaleX = 2 / rangeX;
                         let newScaleY = 2 / rangeY;

                         // Clamp scale
                         newScaleX = Math.max(1e-6, Math.min(1e6, newScaleX));
                         newScaleY = Math.max(1e-6, Math.min(1e6, newScaleY));

                         // Calculate new offset to center the zoomed area
                         wglp.gScaleX = newScaleX;
                         wglp.gScaleY = newScaleY;
                         wglp.gOffsetX = -centerX * wglp.gScaleX;
                         wglp.gOffsetY = -centerY * wglp.gScaleY;

                         // console.log(`Zoomed: Center=(${centerX.toFixed(2)}, ${centerY.toFixed(2)}) Range=(${rangeX.toFixed(2)}, ${rangeY.toFixed(2)}) NewScale=(${wglp.gScaleX.toFixed(2)}, ${wglp.gScaleY.toFixed(2)}) NewOffset=(${wglp.gOffsetX.toFixed(2)}, ${wglp.gOffsetY.toFixed(2)})`);

                     } else {
                         console.warn("Zoom range too small or invalid, zoom cancelled.");
                     }
                 } catch (convErr) {
                     console.error("Error performing zoom:", convErr);
                 }
            } else {
                // console.log("Zoom rectangle too small, treating as click (no zoom).");
            }
        }
     });

    canvas.addEventListener('mouseleave', (e) => {
         // If mouse leaves while dragging/zooming, cancel the action
        if (isDragging) {
            isDragging = false;
            canvas.style.cursor = 'grab';
             // console.log("Mouse left during drag, cancelling.");
        }
        if (isZoomingRect) {
            isZoomingRect = false;
            zoomRectLine.visible = false;
            canvas.style.cursor = 'grab';
             // console.log("Mouse left during zoom rect, cancelling.");
        }
    });

    canvas.addEventListener('wheel', (e) => {
        if (e.shiftKey) {
            e.preventDefault(); // Prevent page scroll when Shift is pressed
            const zoomFactor = 1.1;
            const scaleDelta = e.deltaY < 0 ? zoomFactor : 1 / zoomFactor; // Zoom in or out

            // Get cursor position in NDC
            const cursorNDC_X = (2 * (e.offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
            const cursorNDC_Y = (-2 * (e.offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;

            const gScaleXOld = wglp.gScaleX;
            const gScaleYOld = wglp.gScaleY;

            // Calculate new scale
            let newScaleX = gScaleXOld * scaleDelta;
            let newScaleY = gScaleYOld * scaleDelta;

            // Clamp the new scale to prevent extreme zoom
            newScaleX = Math.max(1e-6, Math.min(1e6, newScaleX));
            newScaleY = Math.max(1e-6, Math.min(1e6, newScaleY));

            // Calculate scale change factor, avoid division by zero
            const actualScaleChangeX = (Math.abs(gScaleXOld) > 1e-9) ? newScaleX / gScaleXOld : 1;
            const actualScaleChangeY = (Math.abs(gScaleYOld) > 1e-9) ? newScaleY / gScaleYOld : 1;

            // Adjust offset to keep the point under the cursor stationary
            // newOffset = cursorNDC + (oldOffset - cursorNDC) * (newScale / oldScale)
            wglp.gOffsetX = cursorNDC_X + (wglp.gOffsetX - cursorNDC_X) * actualScaleChangeX;
            wglp.gOffsetY = cursorNDC_Y + (wglp.gOffsetY - cursorNDC_Y) * actualScaleChangeY;

            // Apply the clamped new scale
            wglp.gScaleX = newScaleX;
            wglp.gScaleY = newScaleY;
            // console.log(`Wheeled: Delta=${scaleDelta.toFixed(2)} Scale=(${wglp.gScaleX.toFixed(2)}, ${wglp.gScaleY.toFixed(2)}) Offset=(${wglp.gOffsetX.toFixed(2)}, ${wglp.gOffsetY.toFixed(2)})`);
        }
    });

    // --- Basic Touch (Similar logic, simplified) ---
     let isPinching = false; let isTouchPanning = false;
     let touchStartX0 = 0, touchStartY0 = 0; // For panning
     let initialPinchDistance = 0;
     let touchPlotOffsetXOld = 0, touchPlotOffsetYOld = 0; // Store offset at touch start
     let initialPinchCenterX = 0, initialPinchCenterY = 0; // Store center at pinch start

    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        zoomRectLine.visible = false; // Hide zoom rect on touch

        if (e.touches.length === 1) { // Single touch: Pan start
            isTouchPanning = true; isPinching = false;
            const touch = e.touches[0];
            // Use clientX/Y for touch start reference
            touchStartX0 = touch.clientX; touchStartY0 = touch.clientY;
            touchPlotOffsetXOld = wglp.gOffsetX; touchPlotOffsetYOld = wglp.gOffsetY;
        } else if (e.touches.length === 2) { // Double touch: Pinch start
            isPinching = true; isTouchPanning = false;
            const t0 = e.touches[0]; const t1 = e.touches[1];

            // Calculate initial center point and distance
             initialPinchCenterX = (t0.clientX + t1.clientX) / 2;
             initialPinchCenterY = (t0.clientY + t1.clientY) / 2;
             initialPinchDistance = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);

            touchPlotOffsetXOld = wglp.gOffsetX; touchPlotOffsetYOld = wglp.gOffsetY; // Store current state
        } else {
             // Ignore 3+ touches for simplicity
             isTouchPanning = false; isPinching = false;
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();

        if (isTouchPanning && e.touches.length === 1) {
            const touch = e.touches[0];
            const dx = (touch.clientX - touchStartX0) * devicePixelRatio;
            const dy = (touch.clientY - touchStartY0) * devicePixelRatio;

            const deltaOffsetX = (Math.abs(wglp.gScaleX) > 1e-9) ? (dx / canvas.width) * 2 / wglp.gScaleX : 0;
            const deltaOffsetY = (Math.abs(wglp.gScaleY) > 1e-9) ? (-dy / canvas.height) * 2 / wglp.gScaleY : 0;

            wglp.gOffsetX = touchPlotOffsetXOld + deltaOffsetX;
            wglp.gOffsetY = touchPlotOffsetYOld + deltaOffsetY;

        } else if (isPinching && e.touches.length === 2) {
            const t0 = e.touches[0]; const t1 = e.touches[1];

            const currentDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
             // Use current center, not initial, for better feel? Or initial? Let's try current.
            const currentCenterX = (t0.clientX + t1.clientX) / 2 * devicePixelRatio;
            const currentCenterY = (t0.clientY + t1.clientY) / 2 * devicePixelRatio;

            // Calculate scale delta, avoid division by zero
            const scaleDelta = (initialPinchDistance > 1e-6) ? currentDist / initialPinchDistance : 1;

            // Get pinch center in NDC coordinates
            const centerNDC_X = (2 * (currentCenterX - canvas.width / 2)) / canvas.width;
            const centerNDC_Y = (-2 * (currentCenterY - canvas.height / 2)) / canvas.height;

            const gScaleXOld = wglp.gScaleX; const gScaleYOld = wglp.gScaleY;

            // Calculate new scale
            let newScaleX = gScaleXOld * scaleDelta; let newScaleY = gScaleYOld * scaleDelta;
            newScaleX = Math.max(1e-6, Math.min(1e6, newScaleX)); // Clamp
            newScaleY = Math.max(1e-6, Math.min(1e6, newScaleY));

            // Calculate scale change factor
            const actualScaleChangeX = (Math.abs(gScaleXOld) > 1e-9) ? newScaleX / gScaleXOld : 1;
            const actualScaleChangeY = (Math.abs(gScaleYOld) > 1e-9) ? newScaleY / gScaleYOld : 1;

            // Adjust offset based on pinch center
            // Use the offset *at the start of the pinch* (touchPlotOffsetOld) for stability
            wglp.gOffsetX = centerNDC_X + (touchPlotOffsetXOld - centerNDC_X) * actualScaleChangeX;
            wglp.gOffsetY = centerNDC_Y + (touchPlotOffsetYOld - centerNDC_Y) * actualScaleChangeY;

            // Apply new scale
            wglp.gScaleX = newScaleX; wglp.gScaleY = newScaleY;

            // Update state for the *next* move event during this pinch
             // Need to update the 'old' offset and distance to reflect the scaling just applied
             // touchPlotOffsetXOld = wglp.gOffsetX; // Is this right? Or keep the original start? Let's try updating.
             // touchPlotOffsetYOld = wglp.gOffsetY;
             // initialPinchDistance = currentDist; // Update distance for next delta calculation

             // Alternative: Keep initial pinch state constant, calculate full transform each move?
             // Let's stick to incremental updates for now, but it can be jerky.

        }
    }, { passive: false });

     canvas.addEventListener('touchend', (e) => {
          e.preventDefault();
          // Check touches *remaining*
          if (e.touches.length < 2) {
              isPinching = false;
              // If one touch remains, potentially switch to panning? Or just stop? Stop is simpler.
          }
          if (e.touches.length < 1) {
               isTouchPanning = false;
          }
     }, { passive: false });

}

// --- Global Animation & Resize ---
// (Keep Animation/Resize handlers the same)
let animationFrameId = null;
function updateDashboard() {
    for (const metricName in activePlots) {
        const plotInfo = activePlots[metricName];
        if (plotInfo && plotInfo.wglp) {
            plotInfo.wglp.update();
        }
    }
    animationFrameId = requestAnimationFrame(updateDashboard);
}
window.addEventListener('resize', () => {
    clearTimeout(window.resizeTimeout);
    window.resizeTimeout = setTimeout(() => {
        console.log("Resizing plots..."); const devicePixelRatio = window.devicePixelRatio || 1;
        for (const metricName in activePlots) {
             const plotInfo = activePlots[metricName]; if (!plotInfo || !plotInfo.wglp) continue;
             const wglp = plotInfo.wglp; const canvas = wglp.canvas; if (!canvas) continue;
             // Use clientWidth/Height which reflect CSS sizing
             const newWidth = canvas.clientWidth; const newHeight = canvas.clientHeight;
             if (newWidth > 0 && newHeight > 0) {
                const targetWidth = Math.round(newWidth * devicePixelRatio);
                const targetHeight = Math.round(newHeight * devicePixelRatio);
                // Only resize if necessary
                if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
                    canvas.width = targetWidth; canvas.height = targetHeight;
                    wglp.viewport(0, 0, canvas.width, canvas.height);
                     console.log(`Resized canvas for ${metricName} to ${targetWidth}x${targetHeight}`);
                }
             } else { console.warn(`Canvas for ${metricName} client dimensions zero during resize.`); }
        }
    }, 250); // Debounce resize handler
});


// --- Initialization ---
async function initialize() {// main.js
// ... (rest of your code)

function updatePlots(metricsData) {
    console.log("Updating plots...");
    const currentMetricNames = Object.keys(metricsData);
    const existingMetricNames = Object.keys(activePlots);

    // Remove plots for metrics entirely gone from the latest data
    existingMetricNames.forEach(metricName => {
        if (!currentMetricNames.includes(metricName)) {
            // removePlot correctly finds the element by ID and removes it from its parent
            removePlot(metricName);
        }
    });


    // *** MODIFIED GROUPING LOGIC START ***
    const metricGroups = {};
    const defaultGroupName = 'General'; // Name for metrics without a '/' prefix

    currentMetricNames.forEach(metricName => {
        let groupName;
        const slashIndex = metricName.indexOf('/'); // Find the first slash

        if (slashIndex !== -1) {
            // Contains a slash, take the part *before* the first one
            groupName = metricName.substring(0, slashIndex);
        } else {
            // No slash found, assign to the default group
            groupName = defaultGroupName;
        }

        // Ensure the group array exists and add the metric name
        if (!metricGroups[groupName]) {
            metricGroups[groupName] = [];
        }
        metricGroups[groupName].push(metricName);
    });
    // *** MODIFIED GROUPING LOGIC END ***


     // --- Remove Empty Group Containers ---
     const currentGroupContainerIds = Array.from(dashboardContainer.querySelectorAll('.metric-group')).map(el => el.id);
     currentGroupContainerIds.forEach(groupId => {
         const groupNameFromId = groupId.replace('metric-group-', '');
         // If a group container exists in the DOM but is NOT in our calculated metricGroups, remove it
         if (!(groupNameFromId in metricGroups)) {
             const groupContainerToRemove = document.getElementById(groupId);
             if (groupContainerToRemove) {
                 console.log(`Removing empty metric group container: ${groupNameFromId}`);
                 dashboardContainer.removeChild(groupContainerToRemove);
                 // Also remove associated plots from activePlots if they weren't caught earlier?
                 // This part might be redundant if the first loop in updatePlots already removed them.
             }
         }
     });
     // --- End Remove Empty Group Containers ---


    // Create or update tabs for each metric group, sorting alphabetically
    // Make sure the 'General' group (or default) appears last or first if desired
    const sortedGroupNames = Object.keys(metricGroups).sort((a, b) => {
         if (a === defaultGroupName) return 1; // Push default group towards the end
         if (b === defaultGroupName) return -1;
         return a.localeCompare(b); // Alphabetical sort for others
    });

    sortedGroupNames.forEach(groupName => {
        createOrUpdateMetricGroupTab(groupName, metricGroups[groupName], metricsData);
    });


    console.log("Plot update finished.");
}

function createOrUpdateMetricGroupTab(groupName, metricNames, metricsData) {
    const groupContainerId = `metric-group-${groupName}`;
    let groupContainer = document.getElementById(groupContainerId);
    let plotsContainer; // Define plotsContainer variable

    if (!groupContainer) {
        // Create a new group container if it doesn't exist
        groupContainer = document.createElement('div');
        groupContainer.id = groupContainerId;
        groupContainer.className = 'metric-group'; // Initially expanded

        const header = document.createElement('div');
        header.className = 'metric-group-header';
        // Add title attribute for full name on hover
        header.innerHTML = `<h3 title="${groupName}">${groupName}</h3><button class="toggle-button" aria-expanded="true" aria-controls="plots-${groupName}"></button>`;
        header.addEventListener('click', () => {
            const isCollapsed = groupContainer.classList.toggle('collapsed');
            header.querySelector('button').setAttribute('aria-expanded', !isCollapsed);
        });

        plotsContainer = document.createElement('div'); // Assign here
        plotsContainer.className = 'metric-group-plots';
        plotsContainer.id = `plots-${groupName}`; // Add ID for aria-controls

        groupContainer.appendChild(header);
        groupContainer.appendChild(plotsContainer);
        dashboardContainer.appendChild(groupContainer); // Add to main dashboard
         console.log(`Created metric group container: ${groupName}`);
    } else {
        // If group container exists, find its plots container
        plotsContainer = groupContainer.querySelector('.metric-group-plots');
        if (!plotsContainer) {
            // Safety check: If somehow plots container is missing, recreate it
            console.warn(`Plots container missing for group ${groupName}. Recreating.`);
            plotsContainer = document.createElement('div');
            plotsContainer.className = 'metric-group-plots';
            plotsContainer.id = `plots-${groupName}`;
            groupContainer.appendChild(plotsContainer); // Append to existing group container
        }
        // Ensure header title is up-to-date (might not change often, but safe)
        const headerH3 = groupContainer.querySelector('.metric-group-header h3');
        if (headerH3) headerH3.title = groupName;
    }

    // Create or update plots for each metric in the group
    metricNames.forEach(metricName => {
        const plotDataForMetric = metricsData[metricName];
        // *** Pass plotsContainer as the third argument ***
        createOrUpdatePlot(metricName, plotDataForMetric, plotsContainer);
    });

    // --- Clean up plots no longer in this specific group ---
    // Get all plot wrappers currently inside *this* group's plotsContainer
    const currentPlotWrappersInGroup = Array.from(plotsContainer.children);

    currentPlotWrappersInGroup.forEach(wrapperElement => {
        // Derive metric name from ID. Handle potential errors if ID is unexpected.
        const metricNameMatch = wrapperElement.id.match(/^plot-wrapper-(.+)$/);
        if (metricNameMatch && metricNameMatch[1]) {
             // Reconstruct the original metric name (replace hyphens used for ID safety)
             // This assumes metric names don't contain hyphens that clash with the replacement pattern.
             // A more robust way would be to store the metric name as a data attribute on the wrapper.
             const existingMetricNameInGroup = metricNameMatch[1].replace(/-/g, '/'); // Adjust if name convention differs

            // If a plot wrapper inside this group corresponds to a metric
            // that is NOT in the 'metricNames' list for *this specific group* anymore, remove it.
             if (!metricNames.includes(existingMetricNameInGroup)) {
                 console.log(`Removing plot ${existingMetricNameInGroup} from group ${groupName} as it no longer belongs.`);
                 // Directly remove the element since we have it, no need to call removePlot which deletes from activePlots too soon
                  try {
                      plotsContainer.removeChild(wrapperElement);
                      // Now also remove from the global activePlots if it was removed from its *last* group
                      // Check if this metric still exists in *any* group
                      const stillExistsInAnyGroup = Object.values(metricGroups).flat().includes(existingMetricNameInGroup);
                      if (!stillExistsInAnyGroup && activePlots[existingMetricNameInGroup]) {
                         delete activePlots[existingMetricNameInGroup];
                         console.log(`Deleted ${existingMetricNameInGroup} from activePlots as it was removed from its last group.`);
                      }
                  } catch (e) {
                      console.warn(`Error removing plot wrapper ${wrapperElement.id} from group ${groupName}:`, e);
                  }
            }
        } else {
             console.warn("Found element in plots container with unexpected ID:", wrapperElement.id);
        }
    });
     // --- End cleanup ---
}

// ... (rest of your code)

    await fetchRuns();// main.js
    // ... (rest of your code)
    
    function createOrUpdatePlot(metricName, plotDataForMetric, parentElement) {
        // ... (existing code)
    
        // --- Create Plot or Ensure Correct Parent ---
        let wrapper = document.getElementById(plotContainerId);
        let canvas;
        let needsInitialization = false;
    
        if (!plotInfo) { // Case 1: Plot state doesn't exist
            needsInitialization = true;
            // console.log(`Creating plot state and element: ${metricName} inside parent`, parentElement);
    
            if (wrapper) { // Element exists but state doesn't (e.g., error recovery)
                console.warn(`Plot wrapper ${plotContainerId} exists but no state. Reusing element, initializing state.`);
                 // Ensure it's in the correct parent
                 if (wrapper.parentNode !== parentElement) {
                     console.warn(`Moving existing plot wrapper ${plotContainerId} to correct parent.`);
                     parentElement.appendChild(wrapper); // Move it
                 }
                canvas = wrapper.querySelector('canvas');
                if (!canvas) {
                     console.error("Wrapper exists but canvas missing. Recreating canvas.");
                     canvas = document.createElement('canvas');
                     canvas.className = 'plot-canvas';
                     // Clear wrapper and append? Just append for now.
                     wrapper.appendChild(canvas);
                }
            } else { // Element also doesn't exist, create it
                 wrapper = document.createElement('div');
                 wrapper.className = 'plot-wrapper';
                 wrapper.id = plotContainerId;
                 // *** Store the original metricName as a data attribute ***
                 wrapper.dataset.metricName = metricName; // Add this line
                 const title = document.createElement('h3');
                 title.textContent = metricName;
                 title.title = metricName; // Add title attribute for long names
                 canvas = document.createElement('canvas');
                 // canvas.id = `canvas-${metricName.replace(/[^a-zA-Z0-9]/g, '-')}`; // ID might not be needed if accessed via wrapper
                 canvas.className = 'plot-canvas';
                 wrapper.appendChild(title);
                 wrapper.appendChild(canvas);
                 // *** Append to the correct parentElement ***
                 parentElement.appendChild(wrapper);
            }
    
            const devicePixelRatio = window.devicePixelRatio || 1;
            const initialWidth = canvas.clientWidth || 400;
            const initialHeight = canvas.clientHeight || 300;
            canvas.width = Math.max(1, Math.round(initialWidth * devicePixelRatio)); // Ensure non-zero
            canvas.height = Math.max(1, Math.round(initialHeight * devicePixelRatio)); // Ensure non-zero
    
            wglp = new WebglPlot(canvas);
            zoomRectLine = new WebglLine(new ColorRGBA(0.9, 0.9, 0.9, 0.7), 4);
            zoomRectLine.loop = true; zoomRectLine.xy = new Float32Array(8).fill(0); zoomRectLine.visible = false;
            wglp.addLine(zoomRectLine);
    
            plotInfo = { wglp, zoomRectLine, lines: {}, isInitialLoad: true }; // Mark for initial axis set
            activePlots[metricName] = plotInfo; // Add to active plots state map
    
            setupInteractions(canvas, wglp, zoomRectLine, plotInfo); // Setup interactions
    
            if (canvas.width > 0 && canvas.height > 0) {
                 wglp.viewport(0, 0, canvas.width, canvas.height);
            } else {
                 console.error(`Canvas ${metricName} has zero dimensions AFTER setup.`);
            }
    
        } else { // Case 2: Plot state *does* exist
            wglp = plotInfo.wglp;
            zoomRectLine = plotInfo.zoomRectLine;
    
            // Ensure the existing DOM element is in the correct parent
            if (!wrapper) {
                 console.error(`Plot state exists for ${metricName} but wrapper element not found. Cannot update.`);
                 // Attempt recovery? Maybe recreate element? For now, log error and skip update.
                 removePlot(metricName); // Clean up broken state
                 return;
            }
            if (wrapper.parentNode !== parentElement) {
                console.warn(`Moving existing plot ${metricName} to new group parent.`);
                parentElement.appendChild(wrapper); // Move it
            }
             // If state exists, but wglp object is missing (e.g. error during previous init), try re-init
             if (!wglp) {
                 console.error(`Plot state exists for ${metricName} but wglp is missing. Re-initializing.`);
                 needsInitialization = true;
                 canvas = wrapper.querySelector('canvas');
                 if (!canvas) { // Should have canvas if wrapper exists, but check
                     console.error("Cannot re-initialize plot: canvas missing.");
                     removePlot(metricName); return;
                 }
                 // Re-create WebGL plot and lines
                 wglp = new WebglPlot(canvas);
                 zoomRectLine = new WebglLine(new ColorRGBA(0.9, 0.9, 0.9, 0.7), 4);
                 zoomRectLine.loop = true; zoomRectLine.xy = new Float32Array(8).fill(0); zoomRectLine.visible = false;
                 wglp.addLine(zoomRectLine);
                 plotInfo.wglp = wglp; // Update state
                 plotInfo.zoomRectLine = zoomRectLine;
                 plotInfo.lines = {}; // Reset lines map
                 plotInfo.isInitialLoad = true; // Force axis reset
    
                 setupInteractions(canvas, wglp, zoomRectLine, plotInfo);
                 if (canvas.width > 0 && canvas.height > 0) {
                      wglp.viewport(0, 0, canvas.width, canvas.height);
                 }
             }
        }
    
        // ... (rest of the code)
    }
    
    function createOrUpdateMetricGroupTab(groupName, metricNames, metricsData) {
        // ... (existing code)
    
        currentPlotWrappersInGroup.forEach(wrapperElement => {
            // *** Get the original metricName from the data attribute ***
            const existingMetricNameInGroup = wrapperElement.dataset.metricName; // Change this line
            if (existingMetricNameInGroup) {
                // If a plot wrapper inside this group corresponds to a metric
                // that is NOT in the 'metricNames' list for *this specific group* anymore, remove it.
                if (!metricNames.includes(existingMetricNameInGroup)) {
                    console.log(`Removing plot ${existingMetricNameInGroup} from group ${groupName} as it no longer belongs.`);
                    // Directly remove the element since we have it, no need to call removePlot which deletes from activePlots too soon
                    try {
                        plotsContainer.removeChild(wrapperElement);
                        // Now also remove from the global activePlots if it was removed from its *last* group
                        // Check if this metric still exists in *any* group
                        const stillExistsInAnyGroup = Object.values(metricGroups).flat().includes(existingMetricNameInGroup);
                        if (!stillExistsInAnyGroup && activePlots[existingMetricNameInGroup]) {
                            delete activePlots[existingMetricNameInGroup];
                            console.log(`Deleted ${existingMetricNameInGroup} from activePlots as it was removed from its last group.`);
                        }
                    } catch (e) {
                        console.warn(`Error removing plot wrapper ${wrapperElement.id} from group ${groupName}:`, e);
                    }
                }
            } else {
                console.warn("Found element in plots container with unexpected ID or missing data-metric-name:", wrapperElement.id);
                // *** Add a check to remove the element if it's missing the data attribute ***
                try {
                    plotsContainer.removeChild(wrapperElement);
                    console.warn(`Removed orphaned plot wrapper ${wrapperElement.id} from group ${groupName}.`);
                } catch (e) {
                    console.warn(`Error removing orphaned plot wrapper ${wrapperElement.id} from group ${groupName}:`, e);
                }
            }
        });
        // --- End cleanup ---
    }
    
    // Data is now fetched on demand by handleRunSelectionChange -> fetchDataForSelectedRuns
    requestAnimationFrame(updateDashboard);
}
initialize();
