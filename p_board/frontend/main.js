// main.js
const { WebglPlot, WebglLine, ColorRGBA } = WebglPlotBundle;

// --- DOM Elements ---
const appContainer = document.getElementById('app-container');
const dashboardContainer = document.getElementById('dashboard-container');
const runSelectorContainer = document.getElementById('run-selector');
const loadingIndicator = document.getElementById('loading-indicator');
const errorMessageDiv = document.getElementById('error-message');
const sidebar = document.getElementById('sidebar');
const resizer = document.getElementById('resizer');
const mainContent = document.getElementById('main-content');
const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
const sidebarReopenBtn = document.getElementById('sidebar-reopen-btn');
const placeholderText = document.querySelector('#dashboard-container .placeholder-text');
const runBulkControls = document.getElementById('run-bulk-controls');
const selectAllBtn = document.getElementById('select-all-runs');
const deselectAllBtn = document.getElementById('deselect-all-runs');
const plotTooltip = document.getElementById('plot-tooltip'); // Tooltip Element

// --- Configuration ---
const API_BASE_URL = ''; // <-- NEW: Requests will go to the same origin
const AXIS_DIVISIONS = 8; // Number of ticks/labels on axes
const AXIS_TEXT_STYLE = {
    font: getComputedStyle(document.documentElement).getPropertyValue('--axis-font') || '10px sans-serif',
    fillStyle: getComputedStyle(document.documentElement).getPropertyValue('--axis-text-color') || '#9a9fa6',
    strokeStyle: getComputedStyle(document.documentElement).getPropertyValue('--axis-text-color') || '#9a9fa6',
    tickSize: 5,
};
const TOOLTIP_CLOSENESS_THRESHOLD_PX_SQ = 15 * 15; // Squared pixel distance threshold for tooltip activation

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
 * Formats a number for axis display or tooltip.
 * Avoids overly long decimals or exponentials for typical ranges.
 * @param {number} value The number to format.
 * @param {number} range The approximate range (max-min) of the axis.
 * @returns {string} Formatted string label.
 */
function formatAxisValue(value, range) {
    if (!isFinite(value)) return "N/A"; // Handle non-finite for tooltips too
    if (Math.abs(value) < 1e-9 && Math.abs(value) !== 0) return "0"; // Handle very small non-zeros

    const absVal = Math.abs(value);
    const absRange = Math.abs(range);

    // Use exponential if value is very large or very small compared to range, or range itself is tiny/huge
    if (absRange > 1e6 || absRange < 1e-3 || absVal > 1e7 || (absVal < 1e-4 && absVal !== 0) ) {
        return value.toExponential(2); // Increased precision for exponential
    }

    // Determine number of decimal places based on range
    let decimals = 0;
    if (absRange < 1) decimals = 4; // More decimals for small ranges
    else if (absRange < 10) decimals = 3;
    else if (absRange < 100) decimals = 2;
    else decimals = 1; // Default for larger ranges

     // Adjust decimals if the value itself is small
     if (absVal > 0 && absVal < 1) {
         // Use enough decimals to show significant digits, up to a max
         decimals = Math.max(decimals, Math.min(4, Math.ceil(-Math.log10(absVal)) + 1));
     } else if (absVal === 0) {
         decimals = 0; // No decimals needed for zero
     }


    // Use toFixed for reasonable ranges
    // Trim unnecessary trailing zeros AFTER the decimal point, but keep integer zeros
    // let formatted = value.toFixed(decimals);
    // return formatted.includes('.') ? formatted.replace(/0+$/, '').replace(/\.$/, '') : formatted;
     return value.toFixed(decimals); // Keep toFixed for consistency, maybe trim later if needed
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

        // Use standard formatting, trim trailing zeros for axes
        const label = formatAxisValue(dataX, axisRange).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
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

        // Use standard formatting, trim trailing zeros for axes
        const label = formatAxisValue(dataY, axisRange).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
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
let activePlots = {}; // Structure: { metric_name: { wglp, zoomRectLine, lines: { run_name: line }, minStep, maxStep, minY, maxY, isInitialLoad, metricName, canvas, yAxisCanvas, xAxisCanvas, ctxX, ctxY } }
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

            // Update frontend cache only with successfully fetched data
            for (const metricName in fetchedData) {
                for (const runName in fetchedData[metricName]) {
                    if (runsToFetch.includes(runName)) { // Ensure we only cache what we asked for
                        if (!frontendDataCache[runName]) {
                            frontendDataCache[runName] = {};
                        }
                        frontendDataCache[runName][metricName] = fetchedData[metricName][runName];
                    }
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

    // Prepare data for plot update based *only* on currently selected runs and available cache
    const metricsDataForUpdate = {};
    for (const runName of selectedRuns) {
        if (frontendDataCache[runName]) {
            for (const metricName in frontendDataCache[runName]) {
                if (!metricsDataForUpdate[metricName]) {
                    metricsDataForUpdate[metricName] = {};
                }
                // Ensure the run is actually selected *and* data exists for this metric
                if (frontendDataCache[runName][metricName]) {
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
function updatePlots(metricsData) {
    console.log("Updating plots...");
    const currentMetricNames = Object.keys(metricsData);
    const existingMetricNames = Object.keys(activePlots);

    // Hide placeholder if we have metrics to plot or runs selected
    if (placeholderText) {
        placeholderText.style.display = currentMetricNames.length === 0 && selectedRuns.length === 0 ? 'block' : 'none';
    }

    // Remove plots for metrics entirely gone from the latest data
    existingMetricNames.forEach(metricName => {
        if (!currentMetricNames.includes(metricName)) {
            removePlot(metricName);
        }
    });

    // Group metrics by prefix
    const metricGroups = {};
    const defaultGroupName = 'General'; // Name for metrics without a '/' prefix
    currentMetricNames.forEach(metricName => {
        let groupName;
        const slashIndex = metricName.indexOf('/'); // Find the first slash
        if (slashIndex !== -1) {
            groupName = metricName.substring(0, slashIndex);
        } else {
            groupName = defaultGroupName;
        }
        if (!metricGroups[groupName]) {
            metricGroups[groupName] = [];
        }
        metricGroups[groupName].push(metricName);
    });

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

    // Create or update tabs for each metric group, sorting alphabetically
    const sortedGroupNames = Object.keys(metricGroups).sort((a, b) => {
         if (a === defaultGroupName) return 1; // Push default group towards the end
         if (b === defaultGroupName) return -1;
         return a.localeCompare(b); // Alphabetical sort for others
    });

    sortedGroupNames.forEach(groupName => {
        createOrUpdateMetricGroupTab(groupName, metricGroups[groupName], metricsData, metricGroups); // Pass all groups for cleanup check
    });

    console.log("Plot update finished.");
}

function createOrUpdateMetricGroupTab(groupName, metricNames, metricsData, allMetricGroups) { // Receive allMetricGroups
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
        if (headerH3) headerH3.title = groupName; // Update title if needed
    }

    // Create or update plots for each metric *currently* in the group
    metricNames.forEach(metricName => {
        const plotDataForMetric = metricsData[metricName];
        createOrUpdatePlot(metricName, plotDataForMetric, plotsContainer);
    });

    // --- Clean up plots no longer in this specific group ---
    const currentPlotWrappersInGroup = Array.from(plotsContainer.children);
    currentPlotWrappersInGroup.forEach(wrapperElement => {
        const existingMetricNameInGroup = wrapperElement.dataset.metricName;
        if (existingMetricNameInGroup) {
            // If the metric name from the wrapper is NOT in the list for this group anymore...
            if (!metricNames.includes(existingMetricNameInGroup)) {
                console.log(`Removing plot ${existingMetricNameInGroup} from group ${groupName} as it no longer belongs.`);
                try {
                    plotsContainer.removeChild(wrapperElement); // Remove from this group's DOM

                    // Check if this metric still exists in *any* other group before deleting its state
                    const stillExistsInAnyGroup = Object.values(allMetricGroups).flat().includes(existingMetricNameInGroup);
                    if (!stillExistsInAnyGroup && activePlots[existingMetricNameInGroup]) {
                        // If it doesn't exist anywhere, fully remove its state
                        delete activePlots[existingMetricNameInGroup];
                        console.log(`Deleted ${existingMetricNameInGroup} from activePlots as it was removed from its last group.`);
                    }
                } catch (e) {
                    console.warn(`Error removing plot wrapper ${wrapperElement.id} from group ${groupName}:`, e);
                }
            }
        } else {
             // Handle cases where a child element somehow lost its data attribute
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

        // Remove DOM element if found and attached
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

    // Guard against null/undefined plotDataForMetric early
    if (!plotDataForMetric) {
         console.warn(`No plot data provided for metric ${metricName}.`);
         if (plotInfo) removePlot(metricName); // Clean up if state exists
         else { // Also remove potential orphaned DOM element
             const existingWrapper = document.getElementById(plotContainerId);
             if (existingWrapper && existingWrapper.parentNode) {
                 console.warn(`Removing orphaned plot wrapper ${plotContainerId} (no data).`);
                 existingWrapper.parentNode.removeChild(existingWrapper);
             }
         }
         return; // Cannot proceed
    }

    // --- Calculate Overall Data Range ---
    let overallMinStep = Infinity, overallMaxStep = -Infinity;
    let overallMinY = Infinity, overallMaxY = -Infinity;
    let hasValidData = false;

    const runsInMetric = Object.keys(plotDataForMetric);

    runsInMetric.forEach(runName => {
        // Only include runs that are currently selected
        if (!selectedRuns.includes(runName)) return;

        const runData = plotDataForMetric[runName];
        if (runData && runData.steps && runData.steps.length > 0 && runData.steps.length === runData.values.length) {
            // Filter finite values before calculating min/max
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

    // If no valid data points found across all selected runs for this metric, remove the plot
    if (!hasValidData) {
        console.log(`No valid finite data points for metric ${metricName} among selected runs. Removing plot.`);
        if (plotInfo) {
            removePlot(metricName);
        } else {
            // Remove potential orphaned DOM element
            const existingWrapper = document.getElementById(plotContainerId);
            if (existingWrapper && existingWrapper.parentNode) {
                existingWrapper.parentNode.removeChild(existingWrapper);
            }
        }
        return; // Stop processing this metric
    }

    // Handle cases where min/max are still Infinity (e.g., single point) or equal
    if (!isFinite(overallMinStep)) overallMinStep = 0;
    if (!isFinite(overallMaxStep)) overallMaxStep = (overallMinStep !== 0) ? overallMinStep : 1; // Prevent 0-range if only 1 point at 0
    if (!isFinite(overallMinY)) overallMinY = 0;
    if (!isFinite(overallMaxY)) overallMaxY = (overallMinY !== 0) ? overallMinY : 1; // Prevent 0-range if only 1 point at 0

    if (overallMaxStep - overallMinStep < 1e-9) { // Add padding if range is too small
         const padding = Math.abs(overallMaxStep * 0.1) || 0.5; // Relative or absolute padding
         overallMinStep -= padding; overallMaxStep += padding;
    }
    if (overallMaxY - overallMinY < 1e-9) { // Add padding if range is too small
         const padding = Math.abs(overallMaxY * 0.1) || 0.1; // Relative or absolute padding
         overallMinY -= padding; overallMaxY += padding;
    }


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
                // Force recreation of children below
             } else {
                 // Structure seems ok, proceed with init
             }
        } else {
            wrapper = document.createElement('div');
            wrapper.className = 'plot-wrapper'; // This now defines the grid container
            wrapper.id = plotContainerId;
            // *** Store the original metric name on the wrapper ***
            wrapper.dataset.metricName = metricName;
            parentElement.appendChild(wrapper); // Append to the correct group plot container
        }

        // --- Always ensure grid children exist if initializing or rebuilding ---
        // Check if the essential children count is less than expected (title + 4 containers)
        if (needsInitialization || wrapper.children.length < 5) {
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
        const initialWidth = canvas.clientWidth || 400; // Provide default fallback
        const initialHeight = canvas.clientHeight || 300;
        canvas.width = Math.max(1, Math.round(initialWidth * devicePixelRatio)); // Ensure > 0
        canvas.height = Math.max(1, Math.round(initialHeight * devicePixelRatio)); // Ensure > 0

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
            lines: {}, // { run_name: WebglLine instance }
            isInitialLoad: true,
            canvas,        // Main canvas HTML element
            yAxisCanvas,   // Y axis canvas element
            xAxisCanvas,   // X axis canvas element
            ctxX,          // X axis 2D context
            ctxY,          // Y axis 2D context
            // Store calculated overall range data (needed for reset view and maybe tooltips)
            minStep: overallMinStep, maxStep: overallMaxStep,
            minY: overallMinY, maxY: overallMaxY,
            metricName: metricName // Store the metric name here
        };
        activePlots[metricName] = plotInfo;

        // Size axis canvases based on initial client rects AFTER appending to DOM
        sizeAxisCanvases(plotInfo);

        // *** Pass tooltip element and metricName to setupInteractions ***
        setupInteractions(canvas, wglp, zoomRectLine, plotInfo, plotTooltip, metricName);

        // Set viewport after canvas is sized and wglp is initialized
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
        // *** Ensure metricName is stored on the wrapper's dataset ***
        if (wrapper.dataset.metricName !== metricName) {
            console.warn(`Updating dataset.metricName for wrapper ${plotContainerId}`);
            wrapper.dataset.metricName = metricName;
        }
        // Check if canvases or contexts are missing (e.g., after error or structure change)
        if (!canvas || !yAxisCanvas || !xAxisCanvas || !plotInfo.ctxX || !plotInfo.ctxY || !wglp) {
            console.error(`Plot state for ${metricName} is incomplete (missing canvas/context/wglp). Re-initializing.`);
            // Clear existing potentially bad state
            delete activePlots[metricName];
            // Remove the old wrapper fully before recreating
            if (wrapper.parentNode) parentElement.removeChild(wrapper);
             // Recurse to rebuild fully
             createOrUpdatePlot(metricName, plotDataForMetric, parentElement);
             return; // Stop current execution
        }
        // Ensure metricName is stored in plotInfo if somehow missing
        if (!plotInfo.metricName) plotInfo.metricName = metricName;
    }

    // --- Update stored range and potentially reset view ---
    plotInfo.minStep = overallMinStep; plotInfo.maxStep = overallMaxStep;
    plotInfo.minY = overallMinY; plotInfo.maxY = overallMaxY;

    // Set axes only on initial load or if forced by re-initialization
    if (plotInfo.isInitialLoad || needsInitialization) {
        setPlotAxes(wglp, overallMinStep, overallMaxStep, overallMinY, overallMaxY);
        plotInfo.isInitialLoad = false; // Mark initial load as done
    }

    // Ensure wrapper is visible if it was hidden (e.g., due to no data previously)
    if (wrapper && wrapper.style.display === 'none') { wrapper.style.display = ''; }

    // --- Update Lines ---
    const existingRunsInPlotLines = Object.keys(plotInfo.lines);
    const currentRunsForMetric = Object.keys(plotDataForMetric).filter(runName => selectedRuns.includes(runName));

    // Hide or remove lines for runs no longer selected OR no longer present in data
    existingRunsInPlotLines.forEach(runName => {
        if (!currentRunsForMetric.includes(runName)) {
            if (plotInfo.lines[runName]) {
                plotInfo.lines[runName].visible = false;
                // Optional: Completely remove line if performance becomes an issue
                // try { plotInfo.wglp.removeLine(plotInfo.lines[runName]); } catch(e) { console.warn("Error removing line:", e); }
                // delete plotInfo.lines[runName];
            }
        }
    });

    // Add or update lines for currently selected runs that have data
    currentRunsForMetric.forEach(runName => {
        const runData = plotDataForMetric[runName];

        // Basic check for valid data structure
        if (!runData || !runData.steps || runData.steps.length === 0 || !runData.values || runData.steps.length !== runData.values.length) {
            // If data is invalid/missing, hide the line if it exists
            if (plotInfo.lines[runName]) { plotInfo.lines[runName].visible = false; }
            if (runData && runData.steps && runData.values && runData.steps.length !== runData.values.length) {
                 console.warn(`Step/value length mismatch for ${metricName}/${runName}. Hiding line.`);
            }
            return; // Skip this run
         }

         let line = plotInfo.lines[runName];
         const numPoints = runData.steps.length;
         const color = getRunColor(runName);

         // --- Filter NaNs/Infs BEFORE creating/updating line ---
         // Pre-allocate maximum possible size
         const xyData = new Float32Array(numPoints * 2);
         let validPointCount = 0;
         for (let i = 0; i < numPoints; i++) {
             const step = runData.steps[i];
             const value = runData.values[i];
             // Check if BOTH step and value are finite numbers
             if (isFinite(step) && isFinite(value)) {
                 xyData[validPointCount * 2] = step;
                 xyData[validPointCount * 2 + 1] = value;
                 validPointCount++;
             }
         }
         // --- End Filter ---

         // If NO valid points after filtering, hide the line and skip update
         if (validPointCount === 0) {
             if (line) line.visible = false;
             if (numPoints > 0) console.warn(`All data points for ${metricName}/${runName} were non-finite. Hiding line.`);
             return; // Skip line creation/update
         }

         // Use only the valid part of the data buffer
         const finalXYData = xyData.slice(0, validPointCount * 2);

         if (!line) {
             // Create new line with the correct number of *valid* points
             line = new WebglLine(color, validPointCount);
             plotInfo.lines[runName] = line;
             wglp.addLine(line);
             console.log(`Added line for ${metricName}/${runName} with ${validPointCount} points.`);
         } else if (line.numPoints !== validPointCount) {
             // If valid point count changes, need to recreate the line object
             // (WebglLine doesn't support changing numPoints after creation easily)
             console.log(`Valid point count changed for ${metricName}/${runName} (${line.numPoints} -> ${validPointCount}). Recreating line.`);

             // Find and remove the old line from WebGL plot's internal list
             try {
                 const lineIndex = wglp.linesData.indexOf(line);
                 if (lineIndex > -1) {
                     wglp.linesData.splice(lineIndex, 1);
                 } else {
                      console.warn(`Could not find old line object for ${metricName}/${runName} in wglp.linesData during recreation.`);
                 }
             } catch (e) {
                 console.warn(`Could not remove old line for ${metricName}/${runName} during recreation:`, e);
             }

             line = new WebglLine(color, validPointCount); // Create new with correct size
             plotInfo.lines[runName] = line; // Update the map in plotInfo state
             wglp.addLine(line); // Add the new line to the WebGL context
         } else {
             // Num points is the same, just update color and data
             line.color = color; // Ensure color is up-to-date (e.g., if palette logic changes)
         }

         // Update line data with the filtered points and ensure visible
         line.xy = finalXYData;
         line.visible = true;
     });
}

function setPlotAxes(wglp, minX, maxX, minY, maxY) {
    // Add padding to axes ranges
    let rangeX = maxX - minX; let rangeY = maxY - minY;

    // Handle zero range cases more robustly
    if (rangeX <= 1e-9) rangeX = Math.abs(maxX * 0.2) || 1; // Use 20% of value or 1 if value is 0
    if (rangeY <= 1e-9) rangeY = Math.abs(maxY * 0.2) || 0.2; // Use 20% of value or 0.2 if value is 0

    const paddingX = rangeX * 0.05; const paddingY = rangeY * 0.05;

    // Calculate final bounds with padding
    const finalMinX = minX - paddingX; const finalMaxX = maxX + paddingX;
    const finalMinY = minY - paddingY; const finalMaxY = maxY + paddingY;

    // Calculate scale and offset based on final padded range
    const finalRangeX = finalMaxX - finalMinX; const finalRangeY = finalMaxY - finalMinY;

    // Ensure scale is valid even if range is somehow still zero
    wglp.gScaleX = (finalRangeX > 1e-9) ? (2 / finalRangeX) : 1;
    wglp.gOffsetX = -1 - finalMinX * wglp.gScaleX;

    wglp.gScaleY = (finalRangeY > 1e-9) ? (2 / finalRangeY) : 1;
    wglp.gOffsetY = -1 - finalMinY * wglp.gScaleY;

    // Clamp scale factors to prevent extreme zooming issues
    wglp.gScaleX = Math.max(1e-7, Math.min(1e7, wglp.gScaleX)); // Wider range?
    wglp.gScaleY = Math.max(1e-7, Math.min(1e7, wglp.gScaleY));
}

/**
 * Finds the index of the element in a sorted array closest to the target value.
 * Assumes `arr` contains the X-coordinates (steps) and is sorted ascending.
 * @param {number[] | Float32Array} arr Sorted array of numbers (e.g., steps).
 * @param {number} target Target value (e.g., cursor's plot X).
 * @returns {number} Index of the closest element, or -1 if array is empty.
 */
function findClosestIndex(arr, target) {
    if (!arr || arr.length === 0) return -1;

    let low = 0;
    let high = arr.length - 1;
    let mid;
    let closestIndex = 0;

    // Handle edge cases where target is outside the array range
    if (target <= arr[0]) return 0;
    if (target >= arr[high]) return high;

    // Binary search
    while (low <= high) {
        mid = Math.floor((low + high) / 2);
        const midVal = arr[mid];

        // Update closestIndex found so far
        if (Math.abs(midVal - target) < Math.abs(arr[closestIndex] - target)) {
            closestIndex = mid;
        }

        if (midVal < target) {
            low = mid + 1;
        } else if (midVal > target) {
            high = mid - 1;
        } else {
            return mid; // Exact match found
        }
    }

    // After loop, low > high. The closest index is either `high`, `low`, or the `closestIndex` found during search.
    // Check `low` and `high` (which are now adjacent or equal to the final closestIndex)
    if (low < arr.length && Math.abs(arr[low] - target) < Math.abs(arr[closestIndex] - target)) {
         closestIndex = low;
    }
     if (high >= 0 && Math.abs(arr[high] - target) < Math.abs(arr[closestIndex] - target)) {
         closestIndex = high;
     }


    return closestIndex;
}


// --- Plot Interactions (Panning, Zooming, Tooltip) ---
function setupInteractions(canvas, wglp, zoomRectLine, plotInfo, tooltipElement, metricName) {
     let isDragging = false; // For panning (right mouse button)
     let isZoomingRect = false; // For zoom rectangle (left mouse button)
     let dragStartX = 0, dragStartY = 0; // Screen coords for panning start
     let plotOffsetXOld = 0, plotOffsetYOld = 0; // Plot offset state at pan start
     let zoomRectStartXNDC = 0, zoomRectStartYNDC = 0; // NDC coords for zoom rect start
     const devicePixelRatio = window.devicePixelRatio || 1;

     // Helper to get MAIN CANVAS dimensions, not the event target's
     const getMainCanvasRect = () => canvas.getBoundingClientRect();

     // Helper to convert Normalized Device Coordinates [-1, 1] to Plot Data Coordinates
     const ndcToPlotCoords = (ndcX, ndcY) => {
        const plotX = Math.abs(wglp.gScaleX) > 1e-9 ? (ndcX - wglp.gOffsetX) / wglp.gScaleX : 0;
        const plotY = Math.abs(wglp.gScaleY) > 1e-9 ? (ndcY - wglp.gOffsetY) / wglp.gScaleY : 0;
        return { x: plotX, y: plotY };
     };

     // Helper to convert Screen Coordinates (e.g., from mouse event) to Plot Data Coordinates
     const screenToPlotCoords = (screenX, screenY) => {
        const mainCanvasRect = getMainCanvasRect();
        if (!mainCanvasRect || mainCanvasRect.width <= 0 || mainCanvasRect.height <= 0) {
            console.warn("Main canvas rect invalid during screenToPlotCoords");
            return { x: NaN, y: NaN }; // Invalid coordinates
        }
        // Calculate offset relative to the main canvas
        const offsetX = screenX - mainCanvasRect.left;
        const offsetY = screenY - mainCanvasRect.top;
        // Convert canvas offset to NDC, using actual canvas buffer dimensions
        const ndcX = (2 * offsetX / mainCanvasRect.width - 1) * (canvas.width / (mainCanvasRect.width * devicePixelRatio)); // Account for CSS vs buffer size
        const ndcY = (1 - 2 * offsetY / mainCanvasRect.height) * (canvas.height / (mainCanvasRect.height * devicePixelRatio)); // Y is inverted

        // Simplified NDC calculation (assuming CSS size matches client size)
        // const ndcX = (2 * (offsetX * devicePixelRatio) / canvas.width) - 1;
        // const ndcY = 1 - (2 * (offsetY * devicePixelRatio) / canvas.height);

        // Correct NDC Calculation using client coords relative to canvas & canvas buffer size
         const ndcX_corrected = (2 * (offsetX * devicePixelRatio) - canvas.width) / canvas.width;
         const ndcY_corrected = (canvas.height - 2 * (offsetY * devicePixelRatio)) / canvas.height; // Inverted Y


        return ndcToPlotCoords(ndcX_corrected, ndcY_corrected);
     };

     // Prevent default context menu on right-click
     canvas.addEventListener('contextmenu', (e) => e.preventDefault());

     // Double-click to reset zoom/pan
     canvas.addEventListener('dblclick', (e) => {
        e.preventDefault();
        if (plotInfo && isFinite(plotInfo.minStep) && isFinite(plotInfo.maxStep) && isFinite(plotInfo.minY) && isFinite(plotInfo.maxY)) {
            setPlotAxes(wglp, plotInfo.minStep, plotInfo.maxStep, plotInfo.minY, plotInfo.maxY);
        } else {
            console.warn("Cannot reset plot axes: Stored range data missing or invalid.", plotInfo);
        }
        zoomRectLine.visible = false; // Hide zoom rectangle
        tooltipElement.style.display = 'none'; // Hide tooltip
     });

     // Mouse Down: Start panning or zoom rectangle
     canvas.addEventListener('mousedown', (e) => {
        e.preventDefault(); canvas.focus(); // Set focus for keyboard events if needed
        tooltipElement.style.display = 'none'; // Hide tooltip on any click/drag start

        const mainCanvasRect = getMainCanvasRect();
        if (!mainCanvasRect) return; // Needed for coordinate conversion
        const offsetX = e.clientX - mainCanvasRect.left;
        const offsetY = e.clientY - mainCanvasRect.top;

        // Convert click position to NDC
        const currentNdcX = (2 * (offsetX * devicePixelRatio) - canvas.width) / canvas.width;
        const currentNdcY = (canvas.height - 2 * (offsetY * devicePixelRatio)) / canvas.height; // Inverted Y

        if (e.button === 0) { // Left Click: Start Zoom Rectangle
            isZoomingRect = true; isDragging = false;
            zoomRectStartXNDC = currentNdcX; zoomRectStartYNDC = currentNdcY;
            try {
                const startPlotCoords = ndcToPlotCoords(zoomRectStartXNDC, zoomRectStartYNDC);
                if (!isFinite(startPlotCoords.x) || !isFinite(startPlotCoords.y)) throw new Error("Invalid start plot coords for zoom");
                // Initialize zoom rectangle line at the starting point
                zoomRectLine.xy = new Float32Array([ startPlotCoords.x, startPlotCoords.y, startPlotCoords.x, startPlotCoords.y, startPlotCoords.x, startPlotCoords.y, startPlotCoords.x, startPlotCoords.y, ]);
                zoomRectLine.visible = true;
                canvas.style.cursor = 'crosshair';
            } catch (convErr) {
                console.error("Error starting zoom rect:", convErr);
                isZoomingRect = false; zoomRectLine.visible = false; canvas.style.cursor = 'grab';
            }
        } else if (e.button === 2) { // Right Click: Start Panning
            isDragging = true; isZoomingRect = false; zoomRectLine.visible = false;
            dragStartX = e.clientX; // Use clientX/Y for panning delta calculation
            dragStartY = e.clientY;
            plotOffsetXOld = wglp.gOffsetX; // Store current offset
            plotOffsetYOld = wglp.gOffsetY;
            canvas.style.cursor = 'grabbing';
        }
     });

    // Mouse Move: Handle panning, zoom rect drawing, or tooltip update
    canvas.addEventListener('mousemove', (e) => {
        // --- Handle Dragging (Pan) or Zooming Rect ---
        if (isDragging || isZoomingRect) {
             tooltipElement.style.display = 'none'; // Ensure tooltip is hidden during active interactions
             e.preventDefault();

             const mainCanvasRect = getMainCanvasRect(); if (!mainCanvasRect) return;
             const offsetX = e.clientX - mainCanvasRect.left;
             const offsetY = e.clientY - mainCanvasRect.top;
             // Convert current mouse position to NDC
             const currentNdcX = (2 * (offsetX * devicePixelRatio) - canvas.width) / canvas.width;
             const currentNdcY = (canvas.height - 2 * (offsetY * devicePixelRatio)) / canvas.height; // Inverted Y

             if (isDragging) { // Update pan based on mouse movement delta
                 const dxScreen = (e.clientX - dragStartX) * devicePixelRatio; // Delta in screen pixels (scaled by DPR)
                 const dyScreen = (e.clientY - dragStartY) * devicePixelRatio;
                 // Convert screen delta to NDC delta (note the sign change for Y)
                 const deltaOffsetX = (canvas.width > 0) ? (dxScreen / canvas.width) * 2 : 0;
                 const deltaOffsetY = (canvas.height > 0) ? (-dyScreen / canvas.height) * 2 : 0;
                 // Apply delta to the offset captured at the start of the drag
                 wglp.gOffsetX = plotOffsetXOld + deltaOffsetX;
                 wglp.gOffsetY = plotOffsetYOld + deltaOffsetY;
                 canvas.style.cursor = 'grabbing';
             } else if (isZoomingRect) { // Update zoom rectangle visual
                 try {
                    const startPlot = ndcToPlotCoords(zoomRectStartXNDC, zoomRectStartYNDC);
                    const currentPlot = ndcToPlotCoords(currentNdcX, currentNdcY); // Use current NDC
                    if (!isFinite(startPlot.x) || !isFinite(startPlot.y) || !isFinite(currentPlot.x) || !isFinite(currentPlot.y)) {
                        throw new Error("Invalid plot coords during zoom rect move");
                    }
                    // Update the 4 corners of the rectangle line
                    zoomRectLine.xy = new Float32Array([
                        startPlot.x, startPlot.y,     // Start corner
                        currentPlot.x, startPlot.y,   // Top/Bottom edge
                        currentPlot.x, currentPlot.y, // Diagonal corner
                        startPlot.x, currentPlot.y    // Left/Right edge
                    ]);
                    zoomRectLine.visible = true;
                } catch (convErr) {
                    console.error("Error updating zoom rect:", convErr);
                    // Optionally hide rect if error occurs: zoomRectLine.visible = false;
                }
                canvas.style.cursor = 'crosshair';
             }
             return; // Stop here if dragging or zooming
         }

         // --- Tooltip Logic (only when not dragging/zooming) ---
         canvas.style.cursor = 'grab'; // Default cursor when hovering

         const mainCanvasRect = getMainCanvasRect();
         if (!mainCanvasRect) { tooltipElement.style.display = 'none'; return; } // Need canvas bounds

         // Get cursor position relative to viewport
         const cursorScreenX = e.clientX;
         const cursorScreenY = e.clientY;

         // Calculate cursor position relative to the canvas element's top-left corner
         const cursorCanvasX = cursorScreenX - mainCanvasRect.left;
         const cursorCanvasY = cursorScreenY - mainCanvasRect.top;

         // Convert cursor's screen position to plot data coordinates
         const plotCoords = screenToPlotCoords(cursorScreenX, cursorScreenY);

         // If conversion failed (e.g., canvas size 0), hide tooltip and exit
         if (!isFinite(plotCoords.x) || !isFinite(plotCoords.y)) {
             tooltipElement.style.display = 'none';
             return;
         }

         let minScreenDistanceSq = TOOLTIP_CLOSENESS_THRESHOLD_PX_SQ;
         let closestPointInfo = null; // Stores { runName, step, value, color }

         // Iterate through all visible lines associated with this plot
         for (const runName in plotInfo.lines) {
             const line = plotInfo.lines[runName];
             // Skip if line doesn't exist, isn't visible, or has no points
             if (!line || !line.visible || line.numPoints === 0) continue;

             // Access the original, full step/value data from the cache for this run/metric
             // This is necessary because the WebglLine only stores the flattened xy array
             const runData = frontendDataCache[runName]?.[metricName]; // Use optional chaining
             if (!runData || !runData.steps || runData.steps.length === 0 || !runData.values || runData.values.length !== runData.steps.length) {
                  // Data missing or inconsistent in cache for this line, skip it
                  // console.warn(`Tooltip: Missing/invalid cache data for ${metricName}/${runName}.`);
                  continue;
             }

             // Find the index of the step in the original data that is closest to the cursor's plot X coordinate
             // Assumes runData.steps is sorted (which it should be from the server)
             const closestIndex = findClosestIndex(runData.steps, plotCoords.x);
             if (closestIndex === -1) continue; // Should not happen if steps exist, but check anyway

             const pointStep = runData.steps[closestIndex];
             const pointValue = runData.values[closestIndex];

             // Skip if the value at the closest step is not finite
             if (!isFinite(pointValue)) continue;

             // Convert this data point (step, value) back into Normalized Device Coordinates
             const pointNdcX = pointStep * wglp.gScaleX + wglp.gOffsetX;
             const pointNdcY = pointValue * wglp.gScaleY + wglp.gOffsetY;

             // Convert the data point's NDC back to canvas pixel coordinates (relative to canvas top-left)
             // NDC range is [-1, 1], canvas coord [0, width/height]. Remember Y inversion.
             const pointCanvasX = ((pointNdcX + 1) / 2) * canvas.width / devicePixelRatio;
             const pointCanvasY = ((1 - pointNdcY) / 2) * canvas.height / devicePixelRatio; // Y is inverted NDC->screen

             // Calculate the squared distance in *screen pixels* between the cursor and the data point
             const dx = cursorCanvasX - pointCanvasX;
             const dy = cursorCanvasY - pointCanvasY;
             const screenDistSq = dx * dx + dy * dy;

             // Check if this point is the closest one found so far *and* within the threshold
             if (screenDistSq < minScreenDistanceSq) {
                 minScreenDistanceSq = screenDistSq; // Update minimum distance
                 closestPointInfo = { // Store info about this closest point
                     runName: runName,
                     step: pointStep,
                     value: pointValue,
                     color: line.color.toString(), // Get the color string (e.g., "rgba(...)")
                 };
             }
         } // End loop through lines

         // --- Update and Position Tooltip ---
         if (closestPointInfo) {
              // Format the values for display (use the same formatter as axes but maybe with more precision)
              const formattedValue = formatAxisValue(closestPointInfo.value, plotInfo.maxY - plotInfo.minY);
              // Format step as integer if it is one, otherwise use formatter
              const formattedStep = Number.isInteger(closestPointInfo.step)
                                     ? closestPointInfo.step.toString()
                                     : formatAxisValue(closestPointInfo.step, plotInfo.maxStep - plotInfo.minStep);

              // Build the HTML content for the tooltip
              tooltipElement.innerHTML = `
                   <span style="display: inline-block; width: 10px; height: 10px; background-color: ${closestPointInfo.color}; margin-right: 5px; vertical-align: middle; border: 1px solid rgba(255,255,255,0.3); border-radius: 2px;"></span>
                   <strong style="color: #eee;">${closestPointInfo.runName}</strong><br>
                   <span style="font-size: 0.9em; color: var(--text-secondary);">Step:</span> ${formattedStep}<br>
                   <span style="font-size: 0.9em; color: var(--text-secondary);">Value:</span> ${formattedValue}
               `;

              // Position the tooltip near the cursor (e.g., slightly below and to the right)
              let tooltipX = cursorScreenX + 15; // Offset from cursor X
              let tooltipY = cursorScreenY + 10; // Offset from cursor Y

              // Basic check to prevent tooltip going off-screen
              // Get tooltip dimensions *after* setting innerHTML
              const tooltipRect = tooltipElement.getBoundingClientRect();
              const viewportWidth = window.innerWidth;
              const viewportHeight = window.innerHeight;

              // If tooltip goes off right edge, flip it to the left of the cursor
              if (tooltipX + tooltipRect.width > viewportWidth - 10) { // 10px buffer
                  tooltipX = cursorScreenX - tooltipRect.width - 15;
              }
              // If tooltip goes off bottom edge, flip it above the cursor
              if (tooltipY + tooltipRect.height > viewportHeight - 10) { // 10px buffer
                  tooltipY = cursorScreenY - tooltipRect.height - 10;
              }
              // Prevent tooltip going off top/left edges
              if (tooltipX < 10) tooltipX = 10;
              if (tooltipY < 10) tooltipY = 10;

              // Apply position and make visible
              tooltipElement.style.left = `${tooltipX}px`;
              tooltipElement.style.top = `${tooltipY}px`;
              tooltipElement.style.display = 'block';
         } else {
             // If no close point found within the threshold, hide the tooltip
             tooltipElement.style.display = 'none';
         }
    }); // End mousemove listener


    // Mouse Up: Finalize panning or zooming action
    canvas.addEventListener('mouseup', (e) => {
         if (!isDragging && !isZoomingRect) return; // Only act if an interaction was in progress
         e.preventDefault();

         const mainCanvasRect = getMainCanvasRect();
         if (!mainCanvasRect) return; // Should exist if interaction started

         // Calculate NDC coords at mouse up position
         const offsetX = e.clientX - mainCanvasRect.left;
         const offsetY = e.clientY - mainCanvasRect.top;
         const endNdcX = (2 * (offsetX * devicePixelRatio) - canvas.width) / canvas.width;
         const endNdcY = (canvas.height - 2 * (offsetY * devicePixelRatio)) / canvas.height; // Inverted Y

         if (isDragging) { // Finalize Pan
             isDragging = false;
             canvas.style.cursor = 'grab'; // Reset cursor
             // The offset was already updated during mousemove
         }
         else if (isZoomingRect) { // Finalize Zoom Rectangle
             isZoomingRect = false;
             zoomRectLine.visible = false; // Hide the rectangle
             canvas.style.cursor = 'grab'; // Reset cursor

             // Check if the zoom rectangle is reasonably large (prevent tiny accidental zooms)
             const minDragThresholdNDC = 0.02; // Minimum size in NDC units
             if (Math.abs(endNdcX - zoomRectStartXNDC) > minDragThresholdNDC || Math.abs(endNdcY - zoomRectStartYNDC) > minDragThresholdNDC) {
                 try {
                     // Convert start and end NDC of the rect to plot coordinates
                     const startPlot = ndcToPlotCoords(zoomRectStartXNDC, zoomRectStartYNDC);
                     const endPlot = ndcToPlotCoords(endNdcX, endNdcY);

                     if (!isFinite(startPlot.x) || !isFinite(startPlot.y) || !isFinite(endPlot.x) || !isFinite(endPlot.y)) {
                         throw new Error("Invalid plot coords for zoom calculation");
                     }

                     // Determine the min/max plot coordinates of the zoom area
                     const minPlotX = Math.min(startPlot.x, endPlot.x);
                     const maxPlotX = Math.max(startPlot.x, endPlot.x);
                     const minPlotY = Math.min(startPlot.y, endPlot.y);
                     const maxPlotY = Math.max(startPlot.y, endPlot.y);

                     // Calculate the new center and range of the zoomed area
                     const centerX = (minPlotX + maxPlotX) / 2;
                     const centerY = (minPlotY + maxPlotY) / 2;
                     const rangeX = maxPlotX - minPlotX;
                     const rangeY = maxPlotY - minPlotY;

                     // Apply zoom only if the range is valid (greater than zero)
                     if (rangeX > 1e-9 && rangeY > 1e-9) {
                         // Calculate new scale factors based on the zoom range
                         let newScaleX = 2 / rangeX;
                         let newScaleY = 2 / rangeY;

                         // Clamp scale factors to prevent extreme zoom
                         newScaleX = Math.max(1e-7, Math.min(1e7, newScaleX));
                         newScaleY = Math.max(1e-7, Math.min(1e7, newScaleY));

                         // Calculate new offsets based on the *center* of the zoom rectangle and new scale
                         // Offset = -center * scale (derived from NDC = plot * scale + offset -> -1 = min * scale + offset)
                         // Simplified: Center should map to NDC (0, 0) after zoom (approximately)
                         // So, 0 = centerX * newScaleX + newOffsetX => newOffsetX = -centerX * newScaleX
                         const newOffsetX = -centerX * newScaleX;
                         const newOffsetY = -centerY * newScaleY;

                         // Update WebGL plot's scale and offset
                         wglp.gScaleX = newScaleX;
                         wglp.gScaleY = newScaleY;
                         wglp.gOffsetX = newOffsetX;
                         wglp.gOffsetY = newOffsetY;

                     } else {
                         console.warn("Zoom range too small or invalid, zoom cancelled.");
                     }
                 } catch (convErr) {
                     console.error("Error performing zoom:", convErr);
                     // Optionally reset axes on error?
                     // setPlotAxes(wglp, plotInfo.minStep, plotInfo.maxStep, plotInfo.minY, plotInfo.maxY);
                 }
             } else {
                  // console.log("Zoom rectangle too small, zoom cancelled.");
             }
         }
    }); // End mouseup listener

    // Mouse Leave: Stop interactions and hide tooltip
    canvas.addEventListener('mouseleave', (e) => {
       if (isDragging) { isDragging = false; canvas.style.cursor = 'grab'; }
       if (isZoomingRect) { isZoomingRect = false; zoomRectLine.visible = false; canvas.style.cursor = 'grab'; }
       tooltipElement.style.display = 'none'; // Hide tooltip when mouse leaves canvas
    }); // End mouseleave listener

    // Mouse Wheel: Zoom in/out (Shift key modifier)
    canvas.addEventListener('wheel', (e) => {
       // Only zoom if Shift key is pressed
       if (e.shiftKey) {
           e.preventDefault(); // Prevent page scrolling
           tooltipElement.style.display = 'none'; // Hide tooltip during scroll-zoom

           const zoomFactor = 1.1; // How much to zoom per wheel step
           const scaleDelta = e.deltaY < 0 ? zoomFactor : 1 / zoomFactor; // Zoom in or out

           const mainCanvasRect = getMainCanvasRect();
           if (!mainCanvasRect) return; // Needed for cursor position

           // Get cursor position relative to canvas
           const offsetX = e.clientX - mainCanvasRect.left;
           const offsetY = e.clientY - mainCanvasRect.top;

           // Convert cursor position to NDC
           const cursorNDC_X = (2 * (offsetX * devicePixelRatio) - canvas.width) / canvas.width;
           const cursorNDC_Y = (canvas.height - 2 * (offsetY * devicePixelRatio)) / canvas.height; // Inverted Y

           // Store old scale and calculate new scale
           const gScaleXOld = wglp.gScaleX; const gScaleYOld = wglp.gScaleY;
           let newScaleX = gScaleXOld * scaleDelta; let newScaleY = gScaleYOld * scaleDelta;

           // Clamp new scale factors
           newScaleX = Math.max(1e-7, Math.min(1e7, newScaleX));
           newScaleY = Math.max(1e-7, Math.min(1e7, newScaleY));

           // Calculate the actual change factor (might be clamped)
           const actualScaleChangeX = (Math.abs(gScaleXOld) > 1e-9) ? newScaleX / gScaleXOld : 1;
           const actualScaleChangeY = (Math.abs(gScaleYOld) > 1e-9) ? newScaleY / gScaleYOld : 1;

           // Adjust offset to keep the point under the cursor stationary
           // Formula: new_offset = cursor_ndc + (old_offset - cursor_ndc) * scale_change
           wglp.gOffsetX = cursorNDC_X + (wglp.gOffsetX - cursorNDC_X) * actualScaleChangeX;
           wglp.gOffsetY = cursorNDC_Y + (wglp.gOffsetY - cursorNDC_Y) * actualScaleChangeY;

           // Apply the new scale
           wglp.gScaleX = newScaleX;
           wglp.gScaleY = newScaleY;
       }
       // If shift is not pressed, allow default scroll behavior (e.g., page scroll)
    }, { passive: false }); // Need passive: false for preventDefault inside wheel


    // --- Touch Interactions (Basic Pan/Pinch Zoom) ---
    let isPinching = false; let isTouchPanning = false;
    let touchStartX0 = 0, touchStartY0 = 0; // Start coords for 1-finger pan
    let initialPinchDistance = 0; // Distance between fingers at pinch start
    let touchPlotOffsetXOld = 0, touchPlotOffsetYOld = 0; // Plot offset at touch start
    let initialPinchCenterX = 0, initialPinchCenterY = 0; // Center point at pinch start (client coords)

    canvas.addEventListener('touchstart', (e) => {
       e.preventDefault(); // Prevent default touch actions like scroll/zoom
       zoomRectLine.visible = false; // Hide zoom rect on touch
       tooltipElement.style.display = 'none'; // Hide tooltip on touch start

       if (e.touches.length === 1) { // --- Start 1-Finger Pan ---
           isTouchPanning = true; isPinching = false;
           const touch = e.touches[0];
           touchStartX0 = touch.clientX; touchStartY0 = touch.clientY; // Record starting client coords
           touchPlotOffsetXOld = wglp.gOffsetX; touchPlotOffsetYOld = wglp.gOffsetY; // Store current offset
       } else if (e.touches.length === 2) { // --- Start 2-Finger Pinch Zoom ---
           isPinching = true; isTouchPanning = false;
           const t0 = e.touches[0]; const t1 = e.touches[1];
            // Record starting center point (client coords)
            initialPinchCenterX = (t0.clientX + t1.clientX) / 2;
            initialPinchCenterY = (t0.clientY + t1.clientY) / 2;
            // Record starting distance between fingers
            initialPinchDistance = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
           // Store current offset and scale
           touchPlotOffsetXOld = wglp.gOffsetX;
           touchPlotOffsetYOld = wglp.gOffsetY;
           // Store initial scale? Might not be needed if calculating delta from offset
       } else { // More than 2 touches, ignore for now
           isTouchPanning = false; isPinching = false;
       }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault(); // Prevent scrolling during touch move on canvas
        tooltipElement.style.display = 'none'; // Keep tooltip hidden

        const mainCanvasRect = getMainCanvasRect(); if (!mainCanvasRect) return;

        if (isTouchPanning && e.touches.length === 1) { // --- 1-Finger Pan Move ---
            const touch = e.touches[0];
            // Calculate delta in screen pixels (scaled by DPR)
            const dxScreen = (touch.clientX - touchStartX0) * devicePixelRatio;
            const dyScreen = (touch.clientY - touchStartY0) * devicePixelRatio;
            // Convert screen delta to NDC delta
            const deltaOffsetX = (canvas.width > 0) ? (dxScreen / canvas.width) * 2 : 0;
            const deltaOffsetY = (canvas.height > 0) ? (-dyScreen / canvas.height) * 2 : 0; // Y-inverted
            // Apply delta to the offset captured at touch start
            wglp.gOffsetX = touchPlotOffsetXOld + deltaOffsetX;
            wglp.gOffsetY = touchPlotOffsetYOld + deltaOffsetY;

        } else if (isPinching && e.touches.length === 2) { // --- 2-Finger Pinch Zoom Move ---
            const t0 = e.touches[0]; const t1 = e.touches[1];
            // Calculate current distance and center point
            const currentDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
            const currentCenterX = (t0.clientX + t1.clientX) / 2;
            const currentCenterY = (t0.clientY + t1.clientY) / 2;

            // Calculate scale delta based on distance change
            const scaleDelta = (initialPinchDistance > 1e-6) ? currentDist / initialPinchDistance : 1;

            // Convert the *current* pinch center to NDC coordinates relative to the canvas
            const centerOffsetX = currentCenterX - mainCanvasRect.left;
            const centerOffsetY = currentCenterY - mainCanvasRect.top;
            const centerNDC_X = (2 * (centerOffsetX * devicePixelRatio) - canvas.width) / canvas.width;
            const centerNDC_Y = (canvas.height - 2 * (centerOffsetY * devicePixelRatio)) / canvas.height; // Inverted Y

            // Store old scale and calculate new scale
            const gScaleXOld = wglp.gScaleX; const gScaleYOld = wglp.gScaleY;
            let newScaleX = gScaleXOld * scaleDelta; let newScaleY = gScaleYOld * scaleDelta;

            // Clamp new scale
            newScaleX = Math.max(1e-7, Math.min(1e7, newScaleX));
            newScaleY = Math.max(1e-7, Math.min(1e7, newScaleY));

            // Calculate actual scale change after clamping
            const actualScaleChangeX = (Math.abs(gScaleXOld) > 1e-9) ? newScaleX / gScaleXOld : 1;
            const actualScaleChangeY = (Math.abs(gScaleYOld) > 1e-9) ? newScaleY / gScaleYOld : 1;

            // Adjust offset to keep the pinch center stationary (similar to wheel zoom)
            // Use the offset captured at the *start* of the pinch (touchPlotOffsetXOld)
            wglp.gOffsetX = centerNDC_X + (touchPlotOffsetXOld - centerNDC_X) * actualScaleChangeX;
            wglp.gOffsetY = centerNDC_Y + (touchPlotOffsetYOld - centerNDC_Y) * actualScaleChangeY;

            // Apply the new scale
            wglp.gScaleX = newScaleX;
            wglp.gScaleY = newScaleY;

            // --- Update state for the *next* move event during the same pinch ---
            // This makes pinch-zoom feel smoother as it doesn't reset to the initial state each time
            initialPinchDistance = currentDist; // Update the distance base
            touchPlotOffsetXOld = wglp.gOffsetX; // Update the offset base for the next delta calculation
            touchPlotOffsetYOld = wglp.gOffsetY;
            // No need to update touchStartX0/Y0 here as they relate to the initial touch, not center point
        }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
         e.preventDefault();
         // If less than 2 fingers remain, stop pinching
         if (e.touches.length < 2) { isPinching = false; }
         // If no fingers remain, stop panning
         if (e.touches.length < 1) { isTouchPanning = false; }
         // If interactions stop, could potentially show tooltip again based on last position,
         // but usually better to wait for next move event.
    }, { passive: false });
} // End setupInteractions


// --- Global Animation & Resize ---
let animationFrameId = null;
function updateDashboard() {
    // Update all active WebGL plots and their corresponding 2D axes
    for (const metricName in activePlots) {
        const plotInfo = activePlots[metricName];
        // Check if plotInfo and necessary components exist
        if (plotInfo && plotInfo.wglp) {
            // 1. Update the WebGL plot (redraws lines based on current scale/offset)
            plotInfo.wglp.update();

            // 2. Update the 2D Axes using the *latest* scale/offset from the WebGL plot
            const { wglp, ctxX, ctxY, xAxisCanvas, yAxisCanvas } = plotInfo;
            if (ctxX && xAxisCanvas && xAxisCanvas.width > 0 && xAxisCanvas.height > 0) {
                drawAxisX(ctxX, xAxisCanvas.width, xAxisCanvas.height, wglp.gScaleX, wglp.gOffsetX, AXIS_DIVISIONS);
            }
            if (ctxY && yAxisCanvas && yAxisCanvas.width > 0 && yAxisCanvas.height > 0) {
                drawAxisY(ctxY, yAxisCanvas.width, yAxisCanvas.height, wglp.gScaleY, wglp.gOffsetY, AXIS_DIVISIONS);
            }
        }
    }
    // Request the next frame
    animationFrameId = requestAnimationFrame(updateDashboard);
}

// Debounced resize handler
window.addEventListener('resize', () => {
    // Clear any pending timeout to avoid multiple resize calls
    clearTimeout(window.resizeTimeout);
    // Set a new timeout
    window.resizeTimeout = setTimeout(() => {
        console.log("Resizing plots and axes due to window/container resize...");
        const devicePixelRatio = window.devicePixelRatio || 1;

        // Iterate through all active plots
        for (const metricName in activePlots) {
            const plotInfo = activePlots[metricName];
            if (!plotInfo || !plotInfo.wglp || !plotInfo.canvas) continue; // Skip if plot is not fully initialized

            const wglp = plotInfo.wglp;
            const canvas = plotInfo.canvas; // Main WebGL canvas

            // --- Resize Main WebGL Canvas ---
            // Read the current CSS dimensions of the canvas element
            const newWidth = canvas.clientWidth;
            const newHeight = canvas.clientHeight;

            // Proceed only if dimensions are valid
            if (newWidth > 0 && newHeight > 0) {
                // Calculate the required buffer size based on DPR
                const targetWidth = Math.round(newWidth * devicePixelRatio);
                const targetHeight = Math.round(newHeight * devicePixelRatio);

                // Only resize if the buffer size actually needs to change
                if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
                    canvas.width = targetWidth;
                    canvas.height = targetHeight;
                    // IMPORTANT: Update the WebGL viewport to match the new buffer size
                    wglp.viewport(0, 0, canvas.width, canvas.height);
                    // console.log(`Resized main canvas for ${metricName} to ${targetWidth}x${targetHeight}`);
                }
            } else {
                console.warn(`Main canvas for ${metricName} client dimensions are zero during resize. Skipping resize.`);
            }

            // --- Resize Axis Canvases ---
            // The sizeAxisCanvases function reads client dimensions and sets buffer size
             if (plotInfo.xAxisCanvas && plotInfo.yAxisCanvas) {
                 sizeAxisCanvases(plotInfo); // This handles DPR internally
                 // console.log(`Resized axis canvases for ${metricName}`);
             }

             // No need to call setPlotAxes here - the existing scale/offset are usually preserved.
             // The animation loop (updateDashboard) will redraw the axes correctly on the next frame.
        }
         // Optional: A single redraw call might be slightly cleaner if needed immediately after resize logic completes
         // updateDashboard(); // Call once manually if needed right away (usually not necessary due to requestAnimationFrame)
    }, 250); // Debounce timeout (e.g., 250ms)
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

    // Important: Trigger resize after CSS transition completes to allow plots to adjust
    setTimeout(() => {
        // console.log("Triggering resize after sidebar toggle");
        window.dispatchEvent(new Event('resize'));
    }, 300); // Match CSS transition duration + small buffer
}

function setupSidebarToggle() {
    // Attach the *same* toggle function to both buttons
    sidebarToggleBtn.addEventListener('click', toggleSidebar);
    sidebarReopenBtn.addEventListener('click', toggleSidebar); // Reopen button triggers same action

    // Initial ARIA state (assuming sidebar starts expanded)
    sidebarToggleBtn.setAttribute('aria-expanded', 'true');
    sidebarReopenBtn.setAttribute('aria-expanded', 'false'); // Reopen button starts hidden
}

function setupResizer() {
    // Get min/max width from CSS variables
    const minSidebarWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-min-width'), 10) || 150;
    const maxSidebarWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-max-width'), 10) || 800;

    // Mouse move handler during resize
    const doDrag = (e) => {
        if (!isResizing) return;
        e.preventDefault(); // Prevent text selection during drag

        // Calculate new width based on mouse X position, respecting bounds
        let newSidebarWidth = e.clientX;
        newSidebarWidth = Math.max(minSidebarWidth, newSidebarWidth); // Apply minimum
        newSidebarWidth = Math.min(maxSidebarWidth, newSidebarWidth); // Apply maximum

        // Update the CSS variable - the grid layout depends on this variable
        appContainer.style.setProperty('--sidebar-width', `${newSidebarWidth}px`);

        // Note: Plot resizing happens via the 'resize' event dispatched in stopDrag
    };

    // Mouse up handler to stop resizing
    const stopDrag = (e) => {
        if (isResizing) {
            isResizing = false;
            // Remove global listeners
            document.removeEventListener('mousemove', doDrag, false);
            document.removeEventListener('mouseup', stopDrag, false);
            document.body.style.cursor = ''; // Reset global cursor

             // Trigger a window resize event AFTER the drag stops
             // This allows plots in the main content area to adjust to the new layout
             window.dispatchEvent(new Event('resize'));
        }
    };

    // Mouse down handler on the resizer element
    resizer.addEventListener('mousedown', (e) => {
        // Ignore drag attempts if the sidebar is collapsed (resizer might be hidden/zero-width)
        if (appContainer.classList.contains('sidebar-collapsed')) {
             return;
        }
        e.preventDefault(); // Prevent default drag behaviors
        isResizing = true;
        document.body.style.cursor = 'col-resize'; // Change cursor globally

        // Attach listeners to the document to capture mouse moves anywhere on the page
        document.addEventListener('mousemove', doDrag, false);
        document.addEventListener('mouseup', stopDrag, false);
    });
}


// --- Initialization ---
async function initialize() {
    // Ensure tooltip element exists before proceeding
    if (!plotTooltip) {
        console.error("FATAL: Tooltip element #plot-tooltip not found in the DOM!");
        displayError("Initialization failed: Tooltip element missing.");
        return; // Stop initialization if tooltip is missing
    }

    console.log("Initializing p-board...");
    setupSidebarToggle(); // Setup BOTH collapse/reopen button listeners
    setupResizer();       // Setup sidebar drag-to-resize
    setupBulkActions();   // Setup "Select All" / "Deselect All" buttons
    await fetchRuns();    // Fetch the list of available runs from the backend

    // Set initial state of the placeholder text
    if (placeholderText) {
        placeholderText.style.display = selectedRuns.length === 0 ? 'block' : 'none';
    }

    // Start the main animation loop
    requestAnimationFrame(updateDashboard);
    console.log("Initialization complete. Starting animation loop.");
}

// Run the initialization function when the script loads
initialize();
