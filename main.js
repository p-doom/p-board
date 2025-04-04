// main.js
const { WebglPlot, WebglLine, ColorRGBA } = WebglPlotBundle;

// --- DOM Elements ---
const appContainer = document.getElementById('app-container'); // Get main container
const dashboardContainer = document.getElementById('dashboard-container');
const runSelectorContainer = document.getElementById('run-selector');
const loadingIndicator = document.getElementById('loading-indicator');
const errorMessageDiv = document.getElementById('error-message');
const sidebar = document.getElementById('sidebar'); // Get sidebar
const resizer = document.getElementById('resizer'); // Get resizer
const mainContent = document.getElementById('main-content'); // Get main content
const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn'); // Collapse button
const sidebarReopenBtn = document.getElementById('sidebar-reopen-btn'); // Reopen button (NEW)
const placeholderText = document.querySelector('#dashboard-container .placeholder-text'); // Get placeholder
const runBulkControls = document.getElementById('run-bulk-controls'); // Bulk controls div
const selectAllBtn = document.getElementById('select-all-runs');
const deselectAllBtn = document.getElementById('deselect-all-runs');


// --- Configuration ---
const API_BASE_URL = 'http://localhost:5001'; // Adjust if backend runs elsewhere

// --- State ---
let availableRuns = [];
let selectedRuns = [];
let activePlots = {}; // Structure: { metric_name: { wglp, zoomRectLine, lines: { run_name: line }, minStep, maxStep, minY, maxY, isInitialLoad } }
let debounceTimer = null;
let frontendDataCache = {}; // Structure: { run_name: { metric_name: { steps, values, wall_times } } }
let isResizing = false; // State for sidebar resizing

// --- Color Palette & Mapping ---
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
async function fetchRuns() {
    clearError();
    try {
        const response = await fetch(`${API_BASE_URL}/api/runs`);
        if (!response.ok) throw new Error(`Failed to fetch runs: ${response.status} ${response.statusText}`);
        availableRuns = await response.json();
        populateRunSelector();
        // Show bulk controls only if runs are available
        if (availableRuns.length > 0) {
             runBulkControls.style.display = 'flex';
        } else {
             runBulkControls.style.display = 'none';
        }
    } catch (error) {
        displayError(error.message || 'Could not connect to backend. Is server.py running?');
        runSelectorContainer.innerHTML = '<p style="color: red;">Could not load runs.</p>';
        runBulkControls.style.display = 'none'; // Hide if error
    }
}

async function fetchDataForSelectedRuns() {
    clearError();

    // Show placeholder if no runs are selected
    if (placeholderText) {
        placeholderText.style.display = selectedRuns.length === 0 ? 'block' : 'none';
    }

    if (selectedRuns.length === 0) {
        console.log("No runs selected, clearing plots.");
        updatePlots({}); // Clear plots
        return;
    }

    const runsToFetch = selectedRuns.filter(runName => !(runName in frontendDataCache));
    const cachedRuns = selectedRuns.filter(runName => runName in frontendDataCache);

    console.log(`Selected: ${selectedRuns.join(', ')}`);
    console.log(`Cached: ${cachedRuns.join(', ') || 'None'}`);
    console.log(`Need to fetch: ${runsToFetch.join(', ') || 'None'}`);

    let fetchedData = null;

    if (runsToFetch.length > 0) {
        loadingIndicator.style.display = 'block';
        errorMessageDiv.style.display = 'none';
        try {
            const runsParam = runsToFetch.join(',');
            console.log(`Fetching data for: ${runsParam}`);
            const response = await fetch(`${API_BASE_URL}/api/data?runs=${encodeURIComponent(runsParam)}`);
            if (!response.ok) {
                let errorMsg = `Failed to fetch data for ${runsParam}: ${response.status} ${response.statusText}`;
                try { const errorData = await response.json(); if (errorData && errorData.error) { errorMsg += ` - ${errorData.error}`; } } catch(e) {}
                throw new Error(errorMsg);
            }
            fetchedData = await response.json();
            console.log(`Received data for ${Object.keys(fetchedData || {}).length} metrics for newly fetched runs.`);

            for (const metricName in fetchedData) {
                for (const runName in fetchedData[metricName]) {
                    if (!frontendDataCache[runName]) {
                        frontendDataCache[runName] = {};
                    }
                    frontendDataCache[runName][metricName] = fetchedData[metricName][runName];
                }
            }
            console.log(`Frontend cache updated for runs: ${runsToFetch.join(', ')}`);

        } catch (error) {
            displayError(error.message || `Could not fetch data for runs: ${runsToFetch.join(', ')}`);
        } finally {
            loadingIndicator.style.display = 'none';
        }
    } else {
        console.log("All selected runs are already cached. Skipping fetch.");
        loadingIndicator.style.display = 'none';
    }

    const metricsDataForUpdate = {};
    for (const runName of selectedRuns) {
        if (frontendDataCache[runName]) {
            for (const metricName in frontendDataCache[runName]) {
                if (!metricsDataForUpdate[metricName]) {
                    metricsDataForUpdate[metricName] = {};
                }
                 if (selectedRuns.includes(runName)) {
                     metricsDataForUpdate[metricName][runName] = frontendDataCache[runName][metricName];
                 }
            }
        }
    }

    console.log(`Updating plots with data for ${Object.keys(metricsDataForUpdate).length} metrics covering runs: ${selectedRuns.join(', ')}`);
    updatePlots(metricsDataForUpdate);
}


// --- UI Update ---
function populateRunSelector() {
    runSelectorContainer.innerHTML = '';
    if (availableRuns.length === 0) {
        runSelectorContainer.innerHTML = '<p>No runs found.</p>'; // Updated message
        return;
    }
    availableRuns.forEach(runName => {
        const div = document.createElement('div'); div.className = 'run-checkbox-item';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
        checkbox.id = `run-${runName}`; checkbox.value = runName;
        checkbox.checked = selectedRuns.includes(runName); // Restore checked state
        checkbox.addEventListener('change', handleRunSelectionChange);
        const label = document.createElement('label'); label.htmlFor = `run-${runName}`;
        const swatch = document.createElement('span'); swatch.className = 'color-swatch';
        swatch.style.backgroundColor = getRunColor(runName).toString();
        label.append(swatch, ` ${runName}`); // Add space
        label.title = runName; // Tooltip for long names
        div.appendChild(checkbox); div.appendChild(label);
        runSelectorContainer.appendChild(div);
    });
}

function handleRunSelectionChange(event, fromBulkAction = false) {
    // Update selectedRuns state
    selectedRuns = Array.from(runSelectorContainer.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);

    // Update placeholder visibility based on selection
     if (placeholderText) {
         placeholderText.style.display = selectedRuns.length === 0 ? 'block' : 'none';
     }


    // If called from a bulk action, skip debounce and fetch immediately
    if (fromBulkAction) {
        clearTimeout(debounceTimer); // Clear any pending debounce
        fetchDataAndResetView();
    } else {
        // Debounce for individual checkbox clicks
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(fetchDataAndResetView, 300);
    }
}

async function fetchDataAndResetView() {
    await fetchDataForSelectedRuns();
    // Reset the view for each plot after fetching data
    for (const metricName in activePlots) {
        const plotInfo = activePlots[metricName];
        if (plotInfo && isFinite(plotInfo.minStep) && isFinite(plotInfo.maxStep) && isFinite(plotInfo.minY) && isFinite(plotInfo.maxY)) {
            setPlotAxes(plotInfo.wglp, plotInfo.minStep, plotInfo.maxStep, plotInfo.minY, plotInfo.maxY);
        }
    }
}

// --- Bulk Run Selection ---
function setupBulkActions() {
    selectAllBtn.addEventListener('click', () => {
        runSelectorContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.checked = true;
        });
        // Trigger update (passing true to skip debounce)
        handleRunSelectionChange(null, true);
    });

    deselectAllBtn.addEventListener('click', () => {
        runSelectorContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.checked = false;
        });
        // Trigger update (passing true to skip debounce)
        handleRunSelectionChange(null, true);
    });
}


// --- Plotting Logic ---
// (updatePlots, createOrUpdateMetricGroupTab, removePlot, createOrUpdatePlot, setPlotAxes, setupInteractions remain mostly the same)
// ... copy the existing functions updatePlots, createOrUpdateMetricGroupTab, removePlot, createOrUpdatePlot, setPlotAxes, setupInteractions here ...
// ... (Make sure createOrUpdatePlot uses parentElement.appendChild(wrapper) correctly) ...
// ... (Make sure createOrUpdateMetricGroupTab uses wrapper.dataset.metricName for cleanup) ...
// --- Plotting Logic (Copied and verified relevant parts) ---
function updatePlots(metricsData) {
    console.log("Updating plots...");
    const currentMetricNames = Object.keys(metricsData);
    const existingMetricNames = Object.keys(activePlots);

    // Hide placeholder if we have metrics to plot
    if (placeholderText) {
        placeholderText.style.display = currentMetricNames.length === 0 && selectedRuns.length === 0 ? 'block' : 'none';
    }

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
             }
         }
     });
     // --- End Remove Empty Group Containers ---


    // Create or update tabs for each metric group, sorting alphabetically
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
    let plotsContainer;

    if (!groupContainer) {
        groupContainer = document.createElement('div');
        groupContainer.id = groupContainerId;
        groupContainer.className = 'metric-group'; // Initially expanded

        const header = document.createElement('div');
        header.className = 'metric-group-header';
        header.innerHTML = `<h3 title="${groupName}">${groupName}</h3><button class="toggle-button" aria-expanded="true" aria-controls="plots-${groupName}"></button>`;
        header.addEventListener('click', () => {
            const isCollapsed = groupContainer.classList.toggle('collapsed');
            header.querySelector('button').setAttribute('aria-expanded', !isCollapsed);
        });

        plotsContainer = document.createElement('div');
        plotsContainer.className = 'metric-group-plots';
        plotsContainer.id = `plots-${groupName}`;

        groupContainer.appendChild(header);
        groupContainer.appendChild(plotsContainer);
        dashboardContainer.appendChild(groupContainer);
        console.log(`Created metric group container: ${groupName}`);
    } else {
        plotsContainer = groupContainer.querySelector('.metric-group-plots');
        if (!plotsContainer) {
            console.warn(`Plots container missing for group ${groupName}. Recreating.`);
            plotsContainer = document.createElement('div');
            plotsContainer.className = 'metric-group-plots';
            plotsContainer.id = `plots-${groupName}`;
            groupContainer.appendChild(plotsContainer);
        }
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
    const currentPlotWrappersInGroup = Array.from(plotsContainer.children);
    currentPlotWrappersInGroup.forEach(wrapperElement => {
        // *** Get the original metricName from the data attribute ***
        const existingMetricNameInGroup = wrapperElement.dataset.metricName;
        if (existingMetricNameInGroup) {
            if (!metricNames.includes(existingMetricNameInGroup)) {
                console.log(`Removing plot ${existingMetricNameInGroup} from group ${groupName} as it no longer belongs.`);
                try {
                    plotsContainer.removeChild(wrapperElement);
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
             console.warn("Found element in plots container without data-metric-name:", wrapperElement.id);
             try {
                 plotsContainer.removeChild(wrapperElement); // Remove orphaned element
                 console.warn(`Removed orphaned plot wrapper ${wrapperElement.id} from group ${groupName}.`);
             } catch (e) {
                 console.warn(`Error removing orphaned plot wrapper ${wrapperElement.id} from group ${groupName}:`, e);
             }
        }
    });
}

function removePlot(metricName) {
    const plotInfo = activePlots[metricName];
    if (plotInfo) {
        const plotContainerId = `plot-wrapper-${metricName.replace(/[^a-zA-Z0-9]/g, '-')}`;
        const plotWrapper = document.getElementById(plotContainerId);

        if (plotWrapper && plotWrapper.parentNode) {
            try {
                plotWrapper.parentNode.removeChild(plotWrapper);
            } catch (e) {
                console.warn(`Error removing plot wrapper DOM element for ${metricName}:`, e);
            }
        } else if (plotWrapper) {
             console.warn(`Plot wrapper for ${metricName} found but has no parent during removal.`);
        }

        // TODO: Clean up WebGL resources if the library provides a method
        // Example: if (plotInfo.wglp && typeof plotInfo.wglp.dispose === 'function') { plotInfo.wglp.dispose(); }

        delete activePlots[metricName];
        console.log(`Removed plot state for: ${metricName}`);
    }
}

function createOrUpdatePlot(metricName, plotDataForMetric, parentElement) {
    let plotInfo = activePlots[metricName];
    let wglp, zoomRectLine;
    const plotContainerId = `plot-wrapper-${metricName.replace(/[^a-zA-Z0-9]/g, '-')}`;

    // --- Calculate Overall Data Range ---
    let overallMinStep = Infinity, overallMaxStep = -Infinity;
    let overallMinY = Infinity, overallMaxY = -Infinity;
    let hasValidData = false;

    const runsInMetric = Object.keys(plotDataForMetric);

    runsInMetric.forEach(runName => {
        if (!selectedRuns.includes(runName)) return;

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

    if (!hasValidData) {
        if (plotInfo) {
            console.log(`Removing plot (no valid data): ${metricName}`);
            removePlot(metricName);
        } else {
            const existingWrapper = document.getElementById(plotContainerId);
            if (existingWrapper && existingWrapper.parentNode) {
                console.warn(`Found orphaned plot wrapper ${plotContainerId} with no data or state. Removing.`);
                existingWrapper.parentNode.removeChild(existingWrapper);
            }
        }
        return;
    }

    if (!isFinite(overallMinStep)) overallMinStep = 0;
    if (!isFinite(overallMaxStep)) overallMaxStep = 1;
    if (!isFinite(overallMinY)) overallMinY = 0;
    if (!isFinite(overallMaxY)) overallMaxY = 1;
    if (overallMaxStep - overallMinStep < 1e-9) { overallMinStep -= 0.5; overallMaxStep += 0.5; }
    if (overallMaxY - overallMinY < 1e-9) { overallMinY -= Math.abs(overallMinY * 0.1) || 0.1; overallMaxY += Math.abs(overallMaxY * 0.1) || 0.1; }


    // --- Create Plot or Ensure Correct Parent ---
    let wrapper = document.getElementById(plotContainerId);
    let canvas;
    let needsInitialization = false;

    if (!plotInfo) {
        needsInitialization = true;
        if (wrapper) {
            console.warn(`Plot wrapper ${plotContainerId} exists but no state. Reusing element, initializing state.`);
            if (wrapper.parentNode !== parentElement) {
                console.warn(`Moving existing plot wrapper ${plotContainerId} to correct parent.`);
                parentElement.appendChild(wrapper);
            }
            canvas = wrapper.querySelector('canvas');
            if (!canvas) {
                console.error("Wrapper exists but canvas missing. Recreating canvas.");
                canvas = document.createElement('canvas'); canvas.className = 'plot-canvas';
                wrapper.appendChild(canvas);
            }
        } else {
            wrapper = document.createElement('div');
            wrapper.className = 'plot-wrapper';
            wrapper.id = plotContainerId;
            wrapper.dataset.metricName = metricName; // Store metric name
            const title = document.createElement('h3');
            title.textContent = metricName; title.title = metricName;
            canvas = document.createElement('canvas'); canvas.className = 'plot-canvas';
            wrapper.appendChild(title); wrapper.appendChild(canvas);
            parentElement.appendChild(wrapper); // Append to the correct group plot container
        }

        const devicePixelRatio = window.devicePixelRatio || 1;
        const initialWidth = canvas.clientWidth || 400; const initialHeight = canvas.clientHeight || 300;
        canvas.width = Math.max(1, Math.round(initialWidth * devicePixelRatio));
        canvas.height = Math.max(1, Math.round(initialHeight * devicePixelRatio));

        wglp = new WebglPlot(canvas);
        zoomRectLine = new WebglLine(new ColorRGBA(0.9, 0.9, 0.9, 0.7), 4);
        zoomRectLine.loop = true; zoomRectLine.xy = new Float32Array(8).fill(0); zoomRectLine.visible = false;
        wglp.addLine(zoomRectLine);

        plotInfo = { wglp, zoomRectLine, lines: {}, isInitialLoad: true };
        activePlots[metricName] = plotInfo;

        setupInteractions(canvas, wglp, zoomRectLine, plotInfo);

        if (canvas.width > 0 && canvas.height > 0) {
            wglp.viewport(0, 0, canvas.width, canvas.height);
        } else { console.error(`Canvas ${metricName} has zero dimensions AFTER setup.`); }

    } else {
        wglp = plotInfo.wglp; zoomRectLine = plotInfo.zoomRectLine;
        if (!wrapper) {
            console.error(`Plot state exists for ${metricName} but wrapper element not found. Cannot update.`);
            removePlot(metricName); return;
        }
        if (wrapper.parentNode !== parentElement) {
            console.warn(`Moving existing plot ${metricName} to new group parent.`);
            parentElement.appendChild(wrapper);
        }
        if (!wglp) {
            console.error(`Plot state exists for ${metricName} but wglp is missing. Re-initializing.`);
            needsInitialization = true;
            canvas = wrapper.querySelector('canvas');
            if (!canvas) { console.error("Cannot re-initialize plot: canvas missing."); removePlot(metricName); return; }
            wglp = new WebglPlot(canvas);
            zoomRectLine = new WebglLine(new ColorRGBA(0.9, 0.9, 0.9, 0.7), 4);
            zoomRectLine.loop = true; zoomRectLine.xy = new Float32Array(8).fill(0); zoomRectLine.visible = false;
            wglp.addLine(zoomRectLine);
            plotInfo.wglp = wglp; plotInfo.zoomRectLine = zoomRectLine;
            plotInfo.lines = {}; plotInfo.isInitialLoad = true;
            setupInteractions(canvas, wglp, zoomRectLine, plotInfo);
            if (canvas.width > 0 && canvas.height > 0) { wglp.viewport(0, 0, canvas.width, canvas.height); }
        }
    }

    plotInfo.minStep = overallMinStep; plotInfo.maxStep = overallMaxStep;
    plotInfo.minY = overallMinY; plotInfo.maxY = overallMaxY;

    if (plotInfo.isInitialLoad || needsInitialization) {
        setPlotAxes(wglp, overallMinStep, overallMaxStep, overallMinY, overallMaxY);
        plotInfo.isInitialLoad = false;
    }

    if (wrapper && wrapper.style.display === 'none') { wrapper.style.display = ''; }

    // --- Update Lines ---
    const existingRunsInPlotLines = Object.keys(plotInfo.lines);
    const currentRunsForMetric = Object.keys(plotDataForMetric).filter(runName => selectedRuns.includes(runName));

    existingRunsInPlotLines.forEach(runName => {
        if (!currentRunsForMetric.includes(runName)) {
            if (plotInfo.lines[runName]) { plotInfo.lines[runName].visible = false; }
        }
    });

    currentRunsForMetric.forEach(runName => {
        const runData = plotDataForMetric[runName];
        if (!runData || !runData.steps || runData.steps.length === 0 || runData.steps.length !== runData.values.length) {
            if (plotInfo.lines[runName]) { plotInfo.lines[runName].visible = false; }
            if (runData && runData.steps && runData.values && runData.steps.length !== runData.values.length) {
                 console.warn(`Step/value length mismatch for ${metricName}/${runName}. Hiding line.`);
            }
            return;
        }

        let line = plotInfo.lines[runName];
        const numPoints = runData.steps.length;
        const color = getRunColor(runName);

        if (!line) {
            line = new WebglLine(color, numPoints);
            plotInfo.lines[runName] = line;
            wglp.addLine(line);
        } else if (line.numPoints !== numPoints && numPoints > 0) { // Handle point count change, only if new count > 0
             console.warn(`Point count changed for ${metricName}/${runName} (${line.numPoints} -> ${numPoints}). Recreating line.`);
             // Temporarily remove from wglp if possible, or just hide
             line.visible = false; // Hide old one
             // If wglp had removeLine: try { wglp.removeLine(line); } catch(e){}

             line = new WebglLine(color, numPoints); // Create new
             plotInfo.lines[runName] = line; // Update map
             wglp.addLine(line); // Add new one
        } else if (numPoints === 0 && line) { // If new data is empty, hide existing line
             line.visible = false;
             return; // Skip data update
        } else if (line) {
             // Ensure color is up-to-date if line exists
             line.color = color;
        }


        // Update line data (filtering NaNs)
        const xyData = new Float32Array(numPoints * 2);
        let validPointCount = 0;
        for (let i = 0; i < numPoints; i++) {
            const step = runData.steps[i];
            const value = runData.values[i];
            if (isFinite(step) && isFinite(value)) {
                xyData[validPointCount * 2] = step;
                xyData[validPointCount * 2 + 1] = value;
                validPointCount++;
            }
        }

        if (validPointCount > 0) {
             // Recreate line buffer only if the *valid* point count changes significantly
             // This avoids excessive buffer recreation if only a few NaNs appear/disappear
             if (line.numPoints !== validPointCount) {
                  console.warn(`Filtered point count changed significantly for ${metricName}/${runName} (${line.numPoints} -> ${validPointCount}). Recreating line.`);
                  line.visible = false; // Hide old one
                  line = new WebglLine(color, validPointCount);
                  plotInfo.lines[runName] = line;
                  wglp.addLine(line);
             }
            line.xy = xyData.slice(0, validPointCount * 2);
            line.visible = true;
        } else {
            line.visible = false;
            if (numPoints > 0) {
                console.warn(`All data points for ${metricName}/${runName} were non-finite. Hiding line.`);
            }
        }
    });
}

function setPlotAxes(wglp, minX, maxX, minY, maxY) {
    let rangeX = maxX - minX; let rangeY = maxY - minY;
    if (rangeX <= 1e-9) rangeX = 1;
    if (rangeY <= 1e-9) rangeY = Math.abs(maxY * 0.2) || 0.2;
    const paddingX = rangeX * 0.05; const paddingY = rangeY * 0.05;
    const finalMinX = minX - paddingX; const finalMaxX = maxX + paddingX;
    const finalMinY = minY - paddingY; const finalMaxY = maxY + paddingY;
    const finalRangeX = finalMaxX - finalMinX; const finalRangeY = finalMaxY - finalMinY;

    wglp.gScaleX = (finalRangeX > 1e-9) ? (2 / finalRangeX) : 1;
    wglp.gOffsetX = -1 - finalMinX * wglp.gScaleX;
    wglp.gScaleY = (finalRangeY > 1e-9) ? (2 / finalRangeY) : 1;
    wglp.gOffsetY = -1 - finalMinY * wglp.gScaleY;
    wglp.gScaleX = Math.max(1e-6, Math.min(1e6, wglp.gScaleX));
    wglp.gScaleY = Math.max(1e-6, Math.min(1e6, wglp.gScaleY));
}

function setupInteractions(canvas, wglp, zoomRectLine, plotInfo) {
     // (Keep the existing interaction code the same)
     // ... (Copy the existing setupInteractions function here) ...
     let isDragging = false; let isZoomingRect = false;
     let dragStartX = 0, dragStartY = 0; // Screen coords
     let plotOffsetXOld = 0, plotOffsetYOld = 0; // Plot offset state
     let zoomRectStartXNDC = 0, zoomRectStartYNDC = 0; // NDC coords
     const devicePixelRatio = window.devicePixelRatio || 1;

     const ndcToPlotCoords = (ndcX, ndcY) => {
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

     canvas.addEventListener('dblclick', (e) => {
        e.preventDefault();
        if (plotInfo && isFinite(plotInfo.minStep) && isFinite(plotInfo.maxStep) && isFinite(plotInfo.minY) && isFinite(plotInfo.maxY)) {
            setPlotAxes(wglp, plotInfo.minStep, plotInfo.maxStep, plotInfo.minY, plotInfo.maxY);
        } else {
            console.warn("Cannot reset plot axes: Stored range data missing or invalid.", plotInfo);
        }
        zoomRectLine.visible = false;
     });

     canvas.addEventListener('mousedown', (e) => {
        e.preventDefault(); canvas.focus();
        const currentNdcX = (2 * (e.offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
        const currentNdcY = (-2 * (e.offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;

        if (e.button === 0) { // Left Click: Start Zoom Rect
            isZoomingRect = true; isDragging = false;
            zoomRectStartXNDC = currentNdcX; zoomRectStartYNDC = currentNdcY;
            try {
                const startPlotCoords = ndcToPlotCoords(zoomRectStartXNDC, zoomRectStartYNDC);
                 if (!isFinite(startPlotCoords.x) || !isFinite(startPlotCoords.y)) throw new Error("Invalid start plot coords");
                 zoomRectLine.xy = new Float32Array([ startPlotCoords.x, startPlotCoords.y, startPlotCoords.x, startPlotCoords.y, startPlotCoords.x, startPlotCoords.y, startPlotCoords.x, startPlotCoords.y, ]);
                 zoomRectLine.visible = true; canvas.style.cursor = 'crosshair';
            } catch (convErr) { console.error("Error starting zoom rect:", convErr); isZoomingRect = false; zoomRectLine.visible = false; canvas.style.cursor = 'grab'; }
        } else if (e.button === 2) { // Right Click: Start Pan
            isDragging = true; isZoomingRect = false; zoomRectLine.visible = false;
            dragStartX = e.clientX; dragStartY = e.clientY;
            plotOffsetXOld = wglp.gOffsetX; plotOffsetYOld = wglp.gOffsetY;
            canvas.style.cursor = 'grabbing';
        }
     });

    canvas.addEventListener('mousemove', (e) => {
        if (!isDragging && !isZoomingRect) { canvas.style.cursor = 'grab'; return; }
        e.preventDefault();
         const currentNdcX = (2 * (e.offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
         const currentNdcY = (-2 * (e.offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;

        if (isDragging) {
            const dx = (e.clientX - dragStartX) * devicePixelRatio; const dy = (e.clientY - dragStartY) * devicePixelRatio;
            const deltaOffsetX = (Math.abs(wglp.gScaleX) > 1e-9) ? (dx / canvas.width) * 2 / wglp.gScaleX : 0;
            const deltaOffsetY = (Math.abs(wglp.gScaleY) > 1e-9) ? (-dy / canvas.height) * 2 / wglp.gScaleY : 0;
            wglp.gOffsetX = plotOffsetXOld + deltaOffsetX; wglp.gOffsetY = plotOffsetYOld + deltaOffsetY;
            canvas.style.cursor = 'grabbing';
        } else if (isZoomingRect) {
             try {
                const startPlot = ndcToPlotCoords(zoomRectStartXNDC, zoomRectStartYNDC);
                const currentPlot = ndcToPlotCoords(currentNdcX, currentNdcY);
                 if (!isFinite(startPlot.x) || !isFinite(startPlot.y) || !isFinite(currentPlot.x) || !isFinite(currentPlot.y)) { throw new Error("Invalid plot coords during zoom rect move"); }
                zoomRectLine.xy = new Float32Array([ startPlot.x, startPlot.y, currentPlot.x, startPlot.y, currentPlot.x, currentPlot.y, startPlot.x, currentPlot.y ]);
                zoomRectLine.visible = true;
            } catch (convErr) { console.error("Error updating zoom rect:", convErr); }
            canvas.style.cursor = 'crosshair';
        }
    });

     canvas.addEventListener('mouseup', (e) => {
        if (!isDragging && !isZoomingRect) return;
        e.preventDefault();
         const endNdcX = (2 * (e.offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
         const endNdcY = (-2 * (e.offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;

        if (isDragging) { isDragging = false; canvas.style.cursor = 'grab'; }
        else if (isZoomingRect) {
            isZoomingRect = false; zoomRectLine.visible = false; canvas.style.cursor = 'grab';
            const minDragThresholdNDC = 0.02;
            if (Math.abs(endNdcX - zoomRectStartXNDC) > minDragThresholdNDC || Math.abs(endNdcY - zoomRectStartYNDC) > minDragThresholdNDC) {
                 try {
                     const startPlot = ndcToPlotCoords(zoomRectStartXNDC, zoomRectStartYNDC); const endPlot = ndcToPlotCoords(endNdcX, endNdcY);
                     if (!isFinite(startPlot.x) || !isFinite(startPlot.y) || !isFinite(endPlot.x) || !isFinite(endPlot.y)) { throw new Error("Invalid plot coords for zoom calculation"); }
                     const minPlotX = Math.min(startPlot.x, endPlot.x); const maxPlotX = Math.max(startPlot.x, endPlot.x);
                     const minPlotY = Math.min(startPlot.y, endPlot.y); const maxPlotY = Math.max(startPlot.y, endPlot.y);
                     const centerX = (minPlotX + maxPlotX) / 2; const centerY = (minPlotY + maxPlotY) / 2;
                     const rangeX = maxPlotX - minPlotX; const rangeY = maxPlotY - minPlotY;
                     if (rangeX > 1e-9 && rangeY > 1e-9) {
                         let newScaleX = 2 / rangeX; let newScaleY = 2 / rangeY;
                         newScaleX = Math.max(1e-6, Math.min(1e6, newScaleX)); newScaleY = Math.max(1e-6, Math.min(1e6, newScaleY));
                         wglp.gScaleX = newScaleX; wglp.gScaleY = newScaleY;
                         wglp.gOffsetX = -centerX * wglp.gScaleX; wglp.gOffsetY = -centerY * wglp.gScaleY;
                     } else { console.warn("Zoom range too small or invalid, zoom cancelled."); }
                 } catch (convErr) { console.error("Error performing zoom:", convErr); }
            }
        }
     });

    canvas.addEventListener('mouseleave', (e) => {
        if (isDragging) { isDragging = false; canvas.style.cursor = 'grab'; }
        if (isZoomingRect) { isZoomingRect = false; zoomRectLine.visible = false; canvas.style.cursor = 'grab'; }
    });

    canvas.addEventListener('wheel', (e) => {
        if (e.shiftKey) {
            e.preventDefault();
            const zoomFactor = 1.1; const scaleDelta = e.deltaY < 0 ? zoomFactor : 1 / zoomFactor;
            const cursorNDC_X = (2 * (e.offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
            const cursorNDC_Y = (-2 * (e.offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;
            const gScaleXOld = wglp.gScaleX; const gScaleYOld = wglp.gScaleY;
            let newScaleX = gScaleXOld * scaleDelta; let newScaleY = gScaleYOld * scaleDelta;
            newScaleX = Math.max(1e-6, Math.min(1e6, newScaleX)); newScaleY = Math.max(1e-6, Math.min(1e6, newScaleY));
            const actualScaleChangeX = (Math.abs(gScaleXOld) > 1e-9) ? newScaleX / gScaleXOld : 1;
            const actualScaleChangeY = (Math.abs(gScaleYOld) > 1e-9) ? newScaleY / gScaleYOld : 1;
            wglp.gOffsetX = cursorNDC_X + (wglp.gOffsetX - cursorNDC_X) * actualScaleChangeX;
            wglp.gOffsetY = cursorNDC_Y + (wglp.gOffsetY - cursorNDC_Y) * actualScaleChangeY;
            wglp.gScaleX = newScaleX; wglp.gScaleY = newScaleY;
        }
    }, { passive: false }); // Need passive: false for preventDefault inside wheel

    // --- Basic Touch ---
     let isPinching = false; let isTouchPanning = false;
     let touchStartX0 = 0, touchStartY0 = 0;
     let initialPinchDistance = 0;
     let touchPlotOffsetXOld = 0, touchPlotOffsetYOld = 0;
     let initialPinchCenterX = 0, initialPinchCenterY = 0;

    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault(); zoomRectLine.visible = false;
        if (e.touches.length === 1) {
            isTouchPanning = true; isPinching = false; const touch = e.touches[0];
            touchStartX0 = touch.clientX; touchStartY0 = touch.clientY;
            touchPlotOffsetXOld = wglp.gOffsetX; touchPlotOffsetYOld = wglp.gOffsetY;
        } else if (e.touches.length === 2) {
            isPinching = true; isTouchPanning = false; const t0 = e.touches[0]; const t1 = e.touches[1];
             initialPinchCenterX = (t0.clientX + t1.clientX) / 2; initialPinchCenterY = (t0.clientY + t1.clientY) / 2;
             initialPinchDistance = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
            touchPlotOffsetXOld = wglp.gOffsetX; touchPlotOffsetYOld = wglp.gOffsetY;
        } else { isTouchPanning = false; isPinching = false; }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (isTouchPanning && e.touches.length === 1) {
            const touch = e.touches[0]; const dx = (touch.clientX - touchStartX0) * devicePixelRatio; const dy = (touch.clientY - touchStartY0) * devicePixelRatio;
            const deltaOffsetX = (Math.abs(wglp.gScaleX) > 1e-9) ? (dx / canvas.width) * 2 / wglp.gScaleX : 0;
            const deltaOffsetY = (Math.abs(wglp.gScaleY) > 1e-9) ? (-dy / canvas.height) * 2 / wglp.gScaleY : 0;
            wglp.gOffsetX = touchPlotOffsetXOld + deltaOffsetX; wglp.gOffsetY = touchPlotOffsetYOld + deltaOffsetY;
        } else if (isPinching && e.touches.length === 2) {
            const t0 = e.touches[0]; const t1 = e.touches[1];
            const currentDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
            const currentCenterX = (t0.clientX + t1.clientX) / 2 * devicePixelRatio; const currentCenterY = (t0.clientY + t1.clientY) / 2 * devicePixelRatio;
            const scaleDelta = (initialPinchDistance > 1e-6) ? currentDist / initialPinchDistance : 1;
            const centerNDC_X = (2 * (currentCenterX - canvas.width / 2)) / canvas.width; const centerNDC_Y = (-2 * (currentCenterY - canvas.height / 2)) / canvas.height;
            const gScaleXOld = wglp.gScaleX; const gScaleYOld = wglp.gScaleY;
            let newScaleX = gScaleXOld * scaleDelta; let newScaleY = gScaleYOld * scaleDelta;
            newScaleX = Math.max(1e-6, Math.min(1e6, newScaleX)); newScaleY = Math.max(1e-6, Math.min(1e6, newScaleY));
            const actualScaleChangeX = (Math.abs(gScaleXOld) > 1e-9) ? newScaleX / gScaleXOld : 1;
            const actualScaleChangeY = (Math.abs(gScaleYOld) > 1e-9) ? newScaleY / gScaleYOld : 1;
            wglp.gOffsetX = centerNDC_X + (touchPlotOffsetXOld - centerNDC_X) * actualScaleChangeX;
            wglp.gOffsetY = centerNDC_Y + (touchPlotOffsetYOld - centerNDC_Y) * actualScaleChangeY;
            wglp.gScaleX = newScaleX; wglp.gScaleY = newScaleY;
            // Update state for next move? Debatable, causes potential drift/jerkiness.
            // initialPinchDistance = currentDist; touchPlotOffsetXOld = wglp.gOffsetX; touchPlotOffsetYOld = wglp.gOffsetY;
        }
    }, { passive: false });

     canvas.addEventListener('touchend', (e) => {
          e.preventDefault();
          if (e.touches.length < 2) { isPinching = false; }
          if (e.touches.length < 1) { isTouchPanning = false; }
     }, { passive: false });
}


// --- Global Animation & Resize ---
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
             const newWidth = canvas.clientWidth; const newHeight = canvas.clientHeight;
             if (newWidth > 0 && newHeight > 0) {
                const targetWidth = Math.round(newWidth * devicePixelRatio);
                const targetHeight = Math.round(newHeight * devicePixelRatio);
                if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
                    canvas.width = targetWidth; canvas.height = targetHeight;
                    wglp.viewport(0, 0, canvas.width, canvas.height);
                     console.log(`Resized canvas for ${metricName} to ${targetWidth}x${targetHeight}`);
                }
             } else { console.warn(`Canvas for ${metricName} client dimensions zero during resize.`); }
        }
    }, 250);
});

// --- Sidebar Resizer Logic ---
// Combined function to handle toggling the sidebar state
function toggleSidebar() {
    const isCurrentlyCollapsed = appContainer.classList.contains('sidebar-collapsed');
    appContainer.classList.toggle('sidebar-collapsed');

    // Update ARIA attributes and titles (optional but good practice)
    if (isCurrentlyCollapsed) {
        // Expanding
        sidebarToggleBtn.title = "Collapse Sidebar";
        sidebarReopenBtn.setAttribute('aria-expanded', 'false'); // Reopen button is now hidden
        sidebarToggleBtn.setAttribute('aria-expanded', 'true'); // Original button is now visible
    } else {
        // Collapsing
        sidebarToggleBtn.title = "Expand Sidebar"; // Title changes on the button *about* to be hidden
        sidebarReopenBtn.title = "Expand Sidebar";
        sidebarToggleBtn.setAttribute('aria-expanded', 'false');
        sidebarReopenBtn.setAttribute('aria-expanded', 'true'); // Reopen button is now visible
    }

    // Important: Trigger resize after transition
    setTimeout(() => {
        // console.log("Triggering resize after sidebar toggle");
        window.dispatchEvent(new Event('resize'));
    }, 300); // Match transition duration + buffer
}

function setupSidebarToggle() {
    // Attach the *same* toggle function to both buttons
    sidebarToggleBtn.addEventListener('click', toggleSidebar);
    sidebarReopenBtn.addEventListener('click', toggleSidebar); // NEW

    // Initial ARIA state (assuming starts expanded)
    sidebarToggleBtn.setAttribute('aria-expanded', 'true');
    sidebarReopenBtn.setAttribute('aria-expanded', 'false');
}

function setupResizer() {
    const minSidebarWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-min-width'), 10);
    const maxSidebarWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-max-width'), 10);

    const doDrag = (e) => {
        if (!isResizing) return;
        e.preventDefault(); // Prevent text selection, etc.

        // Calculate new width, respecting bounds
        let newSidebarWidth = e.clientX;
        newSidebarWidth = Math.max(minSidebarWidth, newSidebarWidth);
        newSidebarWidth = Math.min(maxSidebarWidth, newSidebarWidth);

        // Update the CSS variable and grid template directly
        appContainer.style.setProperty('--sidebar-width', `${newSidebarWidth}px`);
        // No need to update grid-template-columns if it uses the variable

        // Potential optimization: Throttle DOM updates if needed
    };

    const stopDrag = (e) => {
        if (isResizing) {
            isResizing = false;
            document.removeEventListener('mousemove', doDrag, false);
            document.removeEventListener('mouseup', stopDrag, false);
            document.body.style.cursor = ''; // Reset cursor
             // Trigger plot resize after sidebar resize finishes
             window.dispatchEvent(new Event('resize'));
        }
    };

    resizer.addEventListener('mousedown', (e) => {
        // Ignore if sidebar is collapsed
        if (appContainer.classList.contains('sidebar-collapsed')) {
             return;
        }
        e.preventDefault();
        isResizing = true;
        document.body.style.cursor = 'col-resize'; // Indicate resizing
        document.addEventListener('mousemove', doDrag, false);
        document.addEventListener('mouseup', stopDrag, false);
    });
}


// --- Initialization ---
async function initialize() {
    setupSidebarToggle(); // Setup BOTH collapse/reopen button listeners
    setupResizer();
    setupBulkActions();
    await fetchRuns();
    if (placeholderText) {
        placeholderText.style.display = selectedRuns.length === 0 ? 'block' : 'none';
    }
    requestAnimationFrame(updateDashboard);
}

initialize();
