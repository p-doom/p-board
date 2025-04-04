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
const AXIS_DIVISIONS = 8; // Number of ticks/labels on axes
const AXIS_TEXT_STYLE = {
    font: getComputedStyle(document.documentElement).getPropertyValue('--axis-font') || '10px sans-serif',
    fillStyle: getComputedStyle(document.documentElement).getPropertyValue('--axis-text-color') || '#9a9fa6',
    strokeStyle: getComputedStyle(document.documentElement).getPropertyValue('--axis-text-color') || '#9a9fa6',
    tickSize: 5,
};

/**
 * Initializes a 2D canvas for axis drawing.
 * @param {HTMLCanvasElement} canvas
 * @returns {CanvasRenderingContext2D | null}
 */
function initAxisCanvas(canvas) {
    if (!canvas) return null;
    try {
        const devicePixelRatio = window.devicePixelRatio || 1;
        // Ensure client dimensions are read correctly *after* layout
        const clientWidth = canvas.clientWidth;
        const clientHeight = canvas.clientHeight;

        if (clientWidth <= 0 || clientHeight <= 0) {
             console.warn("Axis canvas has zero client dimensions during init", canvas.id);
             // Set a minimal size to avoid errors, will be corrected on resize
             canvas.width = 1 * devicePixelRatio;
             canvas.height = 1 * devicePixelRatio;
        } else {
            canvas.width = Math.round(clientWidth * devicePixelRatio);
            canvas.height = Math.round(clientHeight * devicePixelRatio);
        }


        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.font = AXIS_TEXT_STYLE.font;
            ctx.fillStyle = AXIS_TEXT_STYLE.fillStyle;
            ctx.strokeStyle = AXIS_TEXT_STYLE.strokeStyle;
            ctx.lineWidth = 1; // Ensure thin lines for ticks
        }
        return ctx;
    } catch (e) {
        console.error("Error initializing axis canvas:", canvas.id, e);
        return null;
    }
}

/**
 * Resizes both axis canvases for a given plotInfo.
 * @param {object} plotInfo The plot info object containing axis canvases.
 */
function sizeAxisCanvases(plotInfo) {
    if (plotInfo.xAxisCanvas && plotInfo.ctxX) {
        const ctxX = initAxisCanvas(plotInfo.xAxisCanvas);
        if (ctxX) plotInfo.ctxX = ctxX; // Update context if re-initialized
    }
     if (plotInfo.yAxisCanvas && plotInfo.ctxY) {
         const ctxY = initAxisCanvas(plotInfo.yAxisCanvas);
         if (ctxY) plotInfo.ctxY = ctxY; // Update context if re-initialized
     }
}

/**
 * Formats a number for axis display.
 * Avoids overly long decimals or exponentials for typical ranges.
 * @param {number} value The number to format.
 * @param {number} range The approximate range (max-min) of the axis.
 * @returns {string} Formatted string label.
 */
function formatAxisValue(value, range) {
    if (!isFinite(value)) return "";
    if (Math.abs(value) < 1e-9 && Math.abs(value) !== 0) return "0"; // Handle very small non-zeros

    const absVal = Math.abs(value);
    const absRange = Math.abs(range);

    // Use exponential if value is very large or very small compared to range, or range itself is tiny/huge
    if (absRange > 1e6 || absRange < 1e-3 || absVal > 1e7 || (absVal < 1e-4 && absVal !== 0) ) {
        return value.toExponential(1);
    }

    // Determine number of decimal places based on range
    let decimals = 0;
    if (absRange < 1) decimals = 3;
    else if (absRange < 10) decimals = 2;
    else if (absRange < 100) decimals = 1;

     // Adjust decimals if the value itself is small
     if (absVal > 0 && absVal < 1) {
         decimals = Math.max(decimals, Math.min(3, Math.ceil(-Math.log10(absVal)) + 1));
     } else if (absVal === 0) {
         decimals = 0;
     }


    // Use toFixed for reasonable ranges
    return value.toFixed(decimals);
}


/**
 * Draws the X-axis ticks and labels.
 * @param {CanvasRenderingContext2D} ctx2d
 * @param {number} width Canvas width (pixels)
 * @param {number} height Canvas height (pixels)
 * @param {number} scale WebGL plot gScaleX
 * @param {number} offset WebGL plot gOffsetX
 * @param {number} divs Number of divisions/ticks
 */
function drawAxisX(ctx2d, width, height, scale, offset, divs) {
    if (!ctx2d || width <= 0 || height <= 0 || !isFinite(scale) || !isFinite(offset)) return;

    ctx2d.clearRect(0, 0, width, height);
    ctx2d.textAlign = "center";
    ctx2d.textBaseline = "top"; // Align text below the tick

    const axisRange = (Math.abs(scale) > 1e-9) ? 2 / scale : 0; // Approximate data range visible

    for (let i = 0; i <= divs; i++) {
        const normX = (i / divs) * 2 - 1; // Normalized coordinate [-1, 1]
        // Convert normalized coordinate back to data coordinate
        const dataX = (Math.abs(scale) > 1e-9) ? (normX - offset) / scale : 0;
        const canvasX = (i / divs) * width; // Pixel position on canvas

        const label = formatAxisValue(dataX, axisRange);
        ctx2d.fillText(label, canvasX, AXIS_TEXT_STYLE.tickSize + 2); // Text below tick

        // Draw tick mark
        ctx2d.beginPath();
        ctx2d.moveTo(canvasX, 0);
        ctx2d.lineTo(canvasX, AXIS_TEXT_STYLE.tickSize);
        ctx2d.stroke();
    }
}

/**
 * Draws the Y-axis ticks and labels.
 * @param {CanvasRenderingContext2D} ctx2d
 * @param {number} width Canvas width (pixels)
 * @param {number} height Canvas height (pixels)
 * @param {number} scale WebGL plot gScaleY
 * @param {number} offset WebGL plot gOffsetY
 * @param {number} divs Number of divisions/ticks
 */
function drawAxisY(ctx2d, width, height, scale, offset, divs) {
    if (!ctx2d || width <= 0 || height <= 0 || !isFinite(scale) || !isFinite(offset)) return;

    ctx2d.clearRect(0, 0, width, height);
    ctx2d.textAlign = "right"; // Align text left of the tick
    ctx2d.textBaseline = "middle"; // Center text vertically

    const axisRange = (Math.abs(scale) > 1e-9) ? 2 / scale : 0; // Approximate data range visible

    for (let i = 0; i <= divs; i++) {
        const normY = 1 - (i / divs) * 2; // Normalized coordinate [1, -1] (inverted Y)
         // Convert normalized coordinate back to data coordinate
        const dataY = (Math.abs(scale) > 1e-9) ? (normY - offset) / scale : 0;
        const canvasY = (i / divs) * height; // Pixel position on canvas

        const label = formatAxisValue(dataY, axisRange);
        ctx2d.fillText(label, width - AXIS_TEXT_STYLE.tickSize - 4, canvasY); // Text left of tick

        // Draw tick mark
        ctx2d.beginPath();
        ctx2d.moveTo(width - AXIS_TEXT_STYLE.tickSize, canvasY);
        ctx2d.lineTo(width, canvasY); // Tick goes to the right edge
        ctx2d.stroke();
    }
}

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
    // Use the metricName for IDs, ensure it's DOM-safe
    const safeMetricName = metricName.replace(/[^a-zA-Z0-9]/g, '-');
    const plotContainerId = `plot-wrapper-${safeMetricName}`;

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
    let canvas, yAxisCanvas, xAxisCanvas; // Declare axis canvases
    let needsInitialization = false;

    if (!plotInfo) {
        needsInitialization = true;
        // --- Create wrapper and internal grid structure ---
        if (wrapper) {
            console.warn(`Plot wrapper ${plotContainerId} exists but no state. Reusing element, initializing state.`);
             // Ensure it's in the correct parent group container
             if (wrapper.parentNode !== parentElement) {
                 console.warn(`Moving existing plot wrapper ${plotContainerId} to correct parent group.`);
                 parentElement.appendChild(wrapper);
             }
             // Find existing elements (might be missing if structure changed)
             yAxisCanvas = wrapper.querySelector('.plot-yaxis');
             canvas = wrapper.querySelector('.plot-canvas'); // Main plot canvas
             xAxisCanvas = wrapper.querySelector('.plot-xaxis');
             // Recreate missing elements if necessary
             if (!yAxisCanvas || !canvas || !xAxisCanvas) {
                console.error(`Plot wrapper ${plotContainerId} exists but internal structure is missing. Rebuilding.`);
                wrapper.innerHTML = ''; // Clear potentially broken content
                // Re-add title and create grid elements below
             }
        } else {
            wrapper = document.createElement('div');
            wrapper.className = 'plot-wrapper'; // This now defines the grid container
            wrapper.id = plotContainerId;
            wrapper.dataset.metricName = metricName; // Store metric name
            parentElement.appendChild(wrapper); // Append to the correct group plot container
        }

        // --- Always ensure grid children exist if initializing or rebuilding ---
        if (needsInitialization || wrapper.children.length < 4) {
             wrapper.innerHTML = ''; // Clear previous content if rebuilding

             const title = document.createElement('h3');
             title.textContent = metricName; title.title = metricName;
             wrapper.appendChild(title);

             // Create containers for canvases (for styling separation)
             const yAxisContainer = document.createElement('div');
             yAxisContainer.className = 'plot-yaxis-container';
             yAxisCanvas = document.createElement('canvas');
             yAxisCanvas.className = 'plot-yaxis';
             yAxisCanvas.id = `plot-yaxis-${safeMetricName}`;
             yAxisContainer.appendChild(yAxisCanvas);
             wrapper.appendChild(yAxisContainer);

             const canvasContainer = document.createElement('div');
             canvasContainer.className = 'plot-canvas-container';
             canvas = document.createElement('canvas'); // Main plot canvas
             canvas.className = 'plot-canvas';
             canvas.id = `plot-canvas-${safeMetricName}`;
             canvasContainer.appendChild(canvas);
             wrapper.appendChild(canvasContainer);

             const cornerDiv = document.createElement('div'); // Filler
             cornerDiv.className = 'plot-corner';
             wrapper.appendChild(cornerDiv);

             const xAxisContainer = document.createElement('div');
             xAxisContainer.className = 'plot-xaxis-container';
             xAxisCanvas = document.createElement('canvas');
             xAxisCanvas.className = 'plot-xaxis';
             xAxisCanvas.id = `plot-xaxis-${safeMetricName}`;
             xAxisContainer.appendChild(xAxisCanvas);
             wrapper.appendChild(xAxisContainer);

        } else {
             // If reusing wrapper and structure exists, just get references
             yAxisCanvas = wrapper.querySelector('.plot-yaxis');
             canvas = wrapper.querySelector('.plot-canvas');
             xAxisCanvas = wrapper.querySelector('.plot-xaxis');
        }


        // --- Initialize WebGL Plot and Axis Contexts ---
        if (!canvas) {
             console.error("Main plot canvas could not be found or created for", metricName);
             // Attempt cleanup?
             if(wrapper && wrapper.parentNode) parentElement.removeChild(wrapper);
             return; // Cannot proceed
        }

        const devicePixelRatio = window.devicePixelRatio || 1;
        // Size the main canvas (axes will be sized in sizeAxisCanvases)
        const initialWidth = canvas.clientWidth || 400;
        const initialHeight = canvas.clientHeight || 300;
        canvas.width = Math.max(1, Math.round(initialWidth * devicePixelRatio));
        canvas.height = Math.max(1, Math.round(initialHeight * devicePixelRatio));

        wglp = new WebglPlot(canvas);
        zoomRectLine = new WebglLine(new ColorRGBA(0.9, 0.9, 0.9, 0.7), 4);
        zoomRectLine.loop = true; zoomRectLine.xy = new Float32Array(8).fill(0); zoomRectLine.visible = false;
        wglp.addLine(zoomRectLine);

        // --- Initialize Axis Contexts ---
        const ctxX = initAxisCanvas(xAxisCanvas);
        const ctxY = initAxisCanvas(yAxisCanvas);

        plotInfo = {
            wglp,
            zoomRectLine,
            lines: {},
            isInitialLoad: true,
            canvas,        // Main canvas
            yAxisCanvas,   // Y axis canvas element
            xAxisCanvas,   // X axis canvas element
            ctxX,          // X axis 2D context
            ctxY,          // Y axis 2D context
            // Store range data
            minStep: overallMinStep, maxStep: overallMaxStep,
            minY: overallMinY, maxY: overallMaxY,
        };
        activePlots[metricName] = plotInfo;

        // Size axis canvases based on initial client rects AFTER appending
        sizeAxisCanvases(plotInfo);

        setupInteractions(canvas, wglp, zoomRectLine, plotInfo); // Interactions on main canvas only

        if (canvas.width > 0 && canvas.height > 0) {
            wglp.viewport(0, 0, canvas.width, canvas.height);
        } else { console.error(`Main canvas ${metricName} has zero dimensions AFTER setup.`); }

    } else {
        // --- Plot state exists, ensure elements and context are valid ---
        wglp = plotInfo.wglp; zoomRectLine = plotInfo.zoomRectLine;
        canvas = plotInfo.canvas; // Get main canvas from state
        yAxisCanvas = plotInfo.yAxisCanvas;
        xAxisCanvas = plotInfo.xAxisCanvas;

        if (!wrapper) {
             console.error(`Plot state exists for ${metricName} but wrapper element not found. Cannot update.`);
             removePlot(metricName); return;
        }
         // Ensure correct parent group
        if (wrapper.parentNode !== parentElement) {
            console.warn(`Moving existing plot ${metricName} to new group parent.`);
            parentElement.appendChild(wrapper);
        }
        // Check if canvases or contexts are missing (e.g., after error or structure change)
        if (!canvas || !yAxisCanvas || !xAxisCanvas || !plotInfo.ctxX || !plotInfo.ctxY || !wglp) {
            console.error(`Plot state for ${metricName} is incomplete (missing canvas/context/wglp). Re-initializing.`);
            // Clear existing potentially bad state
            delete activePlots[metricName];
            // Remove the old wrapper fully before recreating
            if (wrapper.parentNode) parentElement.removeChild(wrapper);
             // Recurse or call a dedicated rebuild function
             createOrUpdatePlot(metricName, plotDataForMetric, parentElement);
             return; // Stop current execution
        }
    }

    // --- Update stored range and potentially reset view ---
    plotInfo.minStep = overallMinStep; plotInfo.maxStep = overallMaxStep;
    plotInfo.minY = overallMinY; plotInfo.maxY = overallMaxY;

    if (plotInfo.isInitialLoad || needsInitialization) {
        setPlotAxes(wglp, overallMinStep, overallMaxStep, overallMinY, overallMaxY);
        plotInfo.isInitialLoad = false;
    }

    // Ensure wrapper is visible if it was hidden
    if (wrapper && wrapper.style.display === 'none') { wrapper.style.display = ''; }

    // --- Update Lines (Keep existing logic) ---
    // ... (The logic for adding/updating/removing WebglLine instances) ...
    const existingRunsInPlotLines = Object.keys(plotInfo.lines);
    const currentRunsForMetric = Object.keys(plotDataForMetric).filter(runName => selectedRuns.includes(runName));

    // Hide lines for runs no longer selected for this metric
    existingRunsInPlotLines.forEach(runName => {
        if (!currentRunsForMetric.includes(runName)) {
            if (plotInfo.lines[runName]) {
                plotInfo.lines[runName].visible = false;
                 // Optional: Remove from wglp if line counts get very large and performance suffers
                 // try { plotInfo.wglp.removeLine(plotInfo.lines[runName]); } catch(e) {}
                 // delete plotInfo.lines[runName];
            }
        }
    });

    // Add or update lines for currently selected runs
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

         // --- Filter NaNs/Infs BEFORE creating/updating line ---
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
         // --- End Filter ---

         if (validPointCount === 0) {
             // If no valid points, ensure line is hidden
             if (line) line.visible = false;
             if (numPoints > 0) console.warn(`All data points for ${metricName}/${runName} were non-finite. Hiding line.`);
             return; // Skip line creation/update
         }

         // Use validPointCount for line creation/update
         const finalXYData = xyData.slice(0, validPointCount * 2);

         if (!line) {
             // Create new line with correct number of valid points
             line = new WebglLine(color, validPointCount);
             plotInfo.lines[runName] = line;
             wglp.addLine(line);
         } else if (line.numPoints !== validPointCount) {
             // If valid point count changes, recreate the line object
             // (WebglLine doesn't support changing numPoints after creation)
             console.log(`Valid point count changed for ${metricName}/${runName} (${line.numPoints} -> ${validPointCount}). Recreating line.`);
             // Remove the old line from WebGL context before creating new one
             try {
                 const lineIndex = wglp.linesData.indexOf(line);
                 if (lineIndex > -1) {
                     wglp.linesData.splice(lineIndex, 1);
                 }
             } catch (e) {
                 console.warn(`Could not remove old line for ${metricName}/${runName} during recreation:`, e);
             }

             line = new WebglLine(color, validPointCount); // Create new with correct size
             plotInfo.lines[runName] = line; // Update map
             wglp.addLine(line); // Add new one
         } else {
             // Num points is the same, just update color and data
             line.color = color; // Ensure color is up-to-date
         }

         // Update line data and ensure visible
         line.xy = finalXYData;
         line.visible = true;
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
    // Helper to get MAIN CANVAS dimensions, not the event target's
    const getMainCanvasRect = () => canvas.getBoundingClientRect();

    const ndcToPlotCoords = (ndcX, ndcY) => {
       const plotX = Math.abs(wglp.gScaleX) > 1e-9 ? (ndcX - wglp.gOffsetX) / wglp.gScaleX : 0;
       const plotY = Math.abs(wglp.gScaleY) > 1e-9 ? (ndcY - wglp.gOffsetY) / wglp.gScaleY : 0;
       return { x: plotX, y: plotY };
    };

    const screenToPlotCoords = (screenX, screenY) => {
       // Get the main canvas dimensions and position dynamically
       // This is important if the wrapper/grid shifts things
       const mainCanvasRect = getMainCanvasRect();
       if (!mainCanvasRect || mainCanvasRect.width <= 0 || mainCanvasRect.height <= 0) {
           console.warn("Main canvas rect invalid during screenToPlotCoords");
           return { x: NaN, y: NaN }; // Invalid coordinates
       }

       // Calculate offset relative to the main canvas, not the event target
       const offsetX = screenX - mainCanvasRect.left;
       const offsetY = screenY - mainCanvasRect.top;

       // Use main canvas width/height for NDC calculation
       const ndcX = (2 * (offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
       const ndcY = (-2 * (offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;
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
       // --- Use main canvas dimensions for NDC ---
       const mainCanvasRect = getMainCanvasRect();
       if (!mainCanvasRect) return;
       const offsetX = e.clientX - mainCanvasRect.left;
       const offsetY = e.clientY - mainCanvasRect.top;
       const currentNdcX = (2 * (offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
       const currentNdcY = (-2 * (offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;
       // --- End NDC calculation change ---

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
           dragStartX = e.clientX; // Use clientX/Y for panning delta calculation
           dragStartY = e.clientY;
           plotOffsetXOld = wglp.gOffsetX; plotOffsetYOld = wglp.gOffsetY;
           canvas.style.cursor = 'grabbing';
       }
    });

   canvas.addEventListener('mousemove', (e) => {
       if (!isDragging && !isZoomingRect) { canvas.style.cursor = 'grab'; return; }
       e.preventDefault();
        // --- Use main canvas dimensions for NDC ---
        const mainCanvasRect = getMainCanvasRect();
        if (!mainCanvasRect) return;
        const offsetX = e.clientX - mainCanvasRect.left;
        const offsetY = e.clientY - mainCanvasRect.top;
        const currentNdcX = (2 * (offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
        const currentNdcY = (-2 * (offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;
        // --- End NDC calculation change ---

       if (isDragging) {
           // Panning calculation based on clientX/Y delta is fine
           const dx = (e.clientX - dragStartX) * devicePixelRatio;
           const dy = (e.clientY - dragStartY) * devicePixelRatio;
           // Need main canvas width/height for correct offset delta scaling
           const deltaOffsetX = (Math.abs(wglp.gScaleX) > 1e-9 && canvas.width > 0) ? (dx / canvas.width) * 2 : 0;
           const deltaOffsetY = (Math.abs(wglp.gScaleY) > 1e-9 && canvas.height > 0) ? (-dy / canvas.height) * 2 : 0;
           wglp.gOffsetX = plotOffsetXOld + deltaOffsetX;
           wglp.gOffsetY = plotOffsetYOld + deltaOffsetY;
           canvas.style.cursor = 'grabbing';
       } else if (isZoomingRect) {
            try {
               const startPlot = ndcToPlotCoords(zoomRectStartXNDC, zoomRectStartYNDC);
               const currentPlot = ndcToPlotCoords(currentNdcX, currentNdcY); // Use current NDC
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
        // --- Use main canvas dimensions for NDC ---
        const mainCanvasRect = getMainCanvasRect();
        if (!mainCanvasRect) return;
        const offsetX = e.clientX - mainCanvasRect.left;
        const offsetY = e.clientY - mainCanvasRect.top;
        const endNdcX = (2 * (offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
        const endNdcY = (-2 * (offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;
        // --- End NDC calculation change ---

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
                        // Calculate new offsets based on the *center* of the zoom rectangle
                        const newOffsetX = -centerX * newScaleX;
                        const newOffsetY = -centerY * newScaleY;

                        wglp.gScaleX = newScaleX; wglp.gScaleY = newScaleY;
                        wglp.gOffsetX = newOffsetX; wglp.gOffsetY = newOffsetY;

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

           // --- Use main canvas dimensions for NDC ---
           const mainCanvasRect = getMainCanvasRect();
           if (!mainCanvasRect) return;
           const offsetX = e.clientX - mainCanvasRect.left;
           const offsetY = e.clientY - mainCanvasRect.top;
           const cursorNDC_X = (2 * (offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
           const cursorNDC_Y = (-2 * (offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;
           // --- End NDC calculation change ---

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

    // --- Touch Interactions (Similar NDC adjustments needed) ---
    let isPinching = false; let isTouchPanning = false;
    let touchStartX0 = 0, touchStartY0 = 0;
    let initialPinchDistance = 0;
    let touchPlotOffsetXOld = 0, touchPlotOffsetYOld = 0;
    let initialPinchCenterX = 0, initialPinchCenterY = 0; // In client coordinates

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
       // --- Get main canvas dimensions ---
       const mainCanvasRect = getMainCanvasRect();
       if (!mainCanvasRect) return;

       if (isTouchPanning && e.touches.length === 1) {
           const touch = e.touches[0]; const dx = (touch.clientX - touchStartX0) * devicePixelRatio; const dy = (touch.clientY - touchStartY0) * devicePixelRatio;
           // Use main canvas width/height for delta calculation
           const deltaOffsetX = (Math.abs(wglp.gScaleX) > 1e-9 && canvas.width > 0) ? (dx / canvas.width) * 2 : 0;
           const deltaOffsetY = (Math.abs(wglp.gScaleY) > 1e-9 && canvas.height > 0) ? (-dy / canvas.height) * 2 : 0;
           wglp.gOffsetX = touchPlotOffsetXOld + deltaOffsetX; wglp.gOffsetY = touchPlotOffsetYOld + deltaOffsetY;
       } else if (isPinching && e.touches.length === 2) {
           const t0 = e.touches[0]; const t1 = e.touches[1];
           const currentDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
           const currentCenterX = (t0.clientX + t1.clientX) / 2; const currentCenterY = (t0.clientY + t1.clientY) / 2;
           const scaleDelta = (initialPinchDistance > 1e-6) ? currentDist / initialPinchDistance : 1;

           // --- Convert pinch center to NDC using main canvas ---
           const centerOffsetX = currentCenterX - mainCanvasRect.left;
           const centerOffsetY = currentCenterY - mainCanvasRect.top;
           const centerNDC_X = (2 * (centerOffsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
           const centerNDC_Y = (-2 * (centerOffsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;
           // --- End NDC conversion ---

           const gScaleXOld = wglp.gScaleX; const gScaleYOld = wglp.gScaleY;
           let newScaleX = gScaleXOld * scaleDelta; let newScaleY = gScaleYOld * scaleDelta;
           newScaleX = Math.max(1e-6, Math.min(1e6, newScaleX)); newScaleY = Math.max(1e-6, Math.min(1e6, newScaleY));
           const actualScaleChangeX = (Math.abs(gScaleXOld) > 1e-9) ? newScaleX / gScaleXOld : 1;
           const actualScaleChangeY = (Math.abs(gScaleYOld) > 1e-9) ? newScaleY / gScaleYOld : 1;
           wglp.gOffsetX = centerNDC_X + (touchPlotOffsetXOld - centerNDC_X) * actualScaleChangeX;
           wglp.gOffsetY = centerNDC_Y + (touchPlotOffsetYOld - centerNDC_Y) * actualScaleChangeY;
           wglp.gScaleX = newScaleX; wglp.gScaleY = newScaleY;
           // Update state for next move - necessary for smooth pinch-zoom-pan
           initialPinchDistance = currentDist;
           touchPlotOffsetXOld = wglp.gOffsetX; // Store the *new* offset
           touchPlotOffsetYOld = wglp.gOffsetY;
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
            // 1. Update the WebGL plot itself
            plotInfo.wglp.update();

            // 2. Update the 2D Axes using the latest scale/offset from WebGL plot
            const { wglp, ctxX, ctxY, xAxisCanvas, yAxisCanvas } = plotInfo;
            if (ctxX && xAxisCanvas) {
                drawAxisX(ctxX, xAxisCanvas.width, xAxisCanvas.height, wglp.gScaleX, wglp.gOffsetX, AXIS_DIVISIONS);
            }
            if (ctxY && yAxisCanvas) {
                drawAxisY(ctxY, yAxisCanvas.width, yAxisCanvas.height, wglp.gScaleY, wglp.gOffsetY, AXIS_DIVISIONS);
            }
        }
    }
    animationFrameId = requestAnimationFrame(updateDashboard);
}
window.addEventListener('resize', () => {
    clearTimeout(window.resizeTimeout);
    window.resizeTimeout = setTimeout(() => {
        console.log("Resizing plots and axes...");
        const devicePixelRatio = window.devicePixelRatio || 1;

        for (const metricName in activePlots) {
            const plotInfo = activePlots[metricName];
            if (!plotInfo || !plotInfo.wglp || !plotInfo.canvas) continue;

            const wglp = plotInfo.wglp;
            const canvas = plotInfo.canvas; // Main WebGL canvas

            // --- Resize Main WebGL Canvas ---
            const newWidth = canvas.clientWidth;
            const newHeight = canvas.clientHeight;
            if (newWidth > 0 && newHeight > 0) {
                const targetWidth = Math.round(newWidth * devicePixelRatio);
                const targetHeight = Math.round(newHeight * devicePixelRatio);
                if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
                    canvas.width = targetWidth;
                    canvas.height = targetHeight;
                    wglp.viewport(0, 0, canvas.width, canvas.height);
                    console.log(`Resized main canvas for ${metricName} to ${targetWidth}x${targetHeight}`);
                }
            } else {
                console.warn(`Main canvas for ${metricName} client dimensions zero during resize.`);
            }

            // --- Resize Axis Canvases (calls initAxisCanvas internally) ---
             if (plotInfo.xAxisCanvas && plotInfo.yAxisCanvas) {
                 sizeAxisCanvases(plotInfo);
                 console.log(`Resized axis canvases for ${metricName}`);
             }

             // No need to redraw axes here, the animation loop will handle it immediately after resize
        }
         // Optional: A single redraw call might be slightly cleaner if needed immediately
         // updateDashboard(); // Call once manually if needed right away
    }, 250); // Keep debounce
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
