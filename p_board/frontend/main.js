// main.js
const { WebglPlot, WebglLine, ColorRGBA } = WebglPlotBundle;

// --- DOM Elements ---
const appContainer = document.getElementById('app-container');
const dashboardContainer = document.getElementById('dashboard-container');
const runSelectorContainer = document.getElementById('run-selector');
const loadingIndicator = document.getElementById('loading-indicator');
const errorMessageDiv = document.getElementById('error-message');
const sidebar = document.getElementById('sidebar');
const mainContent = document.getElementById('main-content');
const placeholderText = document.querySelector('#dashboard-container .placeholder-text');
const runBulkControls = document.getElementById('run-bulk-controls');
const selectAllBtn = document.getElementById('select-all-runs');
const deselectAllBtn = document.getElementById('deselect-all-runs');
const plotTooltip = document.getElementById('plot-tooltip'); // Tooltip Element
const metricSearchInput = document.getElementById('metric-search-input');
const hydraModal = document.getElementById('hydra-modal');
const hydraModalRunName = document.getElementById('hydra-modal-run-name');
const hydraModalContent = document.getElementById('hydra-modal-content');
const hydraModalCloseBtn = hydraModal ? hydraModal.querySelector('.modal-close-btn') : null;
const themeToggleBtn = document.getElementById('theme-toggle-btn'); // <-- NEW: Theme Toggle Button
const themeIconSun = document.getElementById('theme-icon-sun');     // <-- NEW: Sun Icon
const themeIconMoon = document.getElementById('theme-icon-moon');   // <-- NEW: Moon Icon

// --- Configuration ---
const API_BASE_URL = '';
const AXIS_DIVISIONS = 7; // Number of ticks/labels on axes
const TOOLTIP_CLOSENESS_THRESHOLD_PX_SQ = 15 * 15; // Squared pixel distance threshold for tooltip activation
const THEME_STORAGE_KEY = 'p-board-theme'; // <-- NEW: LocalStorage key

// --- Dynamic Axis Styling ---
let AXIS_TEXT_STYLE = {}; // Initialize empty

/** // <-- NEW: Function to update axis style based on current theme
 * Updates the global AXIS_TEXT_STYLE object based on computed CSS variables.
 */
function updateAxisTextStyle() {
    const computedStyle = getComputedStyle(document.documentElement);
    AXIS_TEXT_STYLE = {
        font: computedStyle.getPropertyValue('--axis-font').trim() || '11px sans-serif',
        fillStyle: computedStyle.getPropertyValue('--axis-text-color').trim() || '#b0b5bb',
        strokeStyle: computedStyle.getPropertyValue('--axis-text-color').trim() || '#b0b5bb', // Match fill for ticks
        tickSize: 6,
    };
    // console.log("Updated Axis Style:", AXIS_TEXT_STYLE); // For debugging
}

/**
 * Resizes the main canvas, WebGL viewport, and axis canvases for a given plot.
 * @param {object} plotInfo The plot info object.
 */
function resizePlot(plotInfo) {
    if (!plotInfo || !plotInfo.canvas || !plotInfo.wglp) {
        console.warn("resizePlot called with invalid plotInfo for:", plotInfo?.metricName);
        return;
    }

    const { canvas, wglp, xAxisCanvas, yAxisCanvas, metricName } = plotInfo;
    const devicePixelRatio = window.devicePixelRatio || 1;
    let resized = false;

    const mainClientWidth = canvas.clientWidth;
    const mainClientHeight = canvas.clientHeight;

    if (mainClientWidth <= 0 || mainClientHeight <= 0) {
        // Don't resize if not visible or has no dimensions
        return;
    }

    const newWidth = Math.round(mainClientWidth * devicePixelRatio);
    const newHeight = Math.round(mainClientHeight * devicePixelRatio);

    if (canvas.width !== newWidth || canvas.height !== newHeight) {
        canvas.width = newWidth;
        canvas.height = newHeight;
        wglp.viewport(0, 0, newWidth, newHeight);
        resized = true;
        // console.log(`Resized main canvas for ${metricName} to ${newWidth}x${newHeight}`);
    }

    const axesResized = sizeAxisCanvases(plotInfo); // This function now updates plotInfo.ctxX/Y

    // No explicit redraw needed here, updateDashboard handles it
}

/**
 * Initializes or resizes an axis canvas and returns its 2D context and resize status.
 * @param {HTMLCanvasElement} canvas
 * @returns {{ctx: CanvasRenderingContext2D | null, resized: boolean}}
 */
function initAxisCanvas(canvas) {
    if (!canvas) return { ctx: null, resized: false };
    let resized = false;
    try {
        const devicePixelRatio = window.devicePixelRatio || 1;
        const clientWidth = canvas.clientWidth;
        const clientHeight = canvas.clientHeight;
        const minWidth = 1 * devicePixelRatio;
        const minHeight = 1 * devicePixelRatio;

        // Ensure client dimensions are positive before calculating new size
        if (clientWidth <= 0 || clientHeight <= 0) {
            // console.warn(`Axis canvas ${canvas.id} has zero client dimensions. Skipping resize.`);
            // Return existing context if available, otherwise null
            return { ctx: canvas.getContext('2d'), resized: false };
        }

        let newWidth = Math.max(minWidth, Math.round(clientWidth * devicePixelRatio));
        let newHeight = Math.max(minHeight, Math.round(clientHeight * devicePixelRatio));

        if (canvas.width !== newWidth || canvas.height !== newHeight) {
            canvas.width = newWidth;
            canvas.height = newHeight;
            resized = true;
            // console.log(`Resized axis canvas ${canvas.id} to ${newWidth}x${newHeight}`);
        }

        const ctx = canvas.getContext('2d');
        if (ctx) {
            // Apply styles from the global object (which is updated on theme change)
            ctx.font = AXIS_TEXT_STYLE.font;
            ctx.fillStyle = AXIS_TEXT_STYLE.fillStyle;
            ctx.strokeStyle = AXIS_TEXT_STYLE.strokeStyle;
            ctx.lineWidth = 1;
        } else {
            console.error("Failed to get 2D context for axis canvas:", canvas.id);
        }
        return { ctx: ctx, resized: resized };
    } catch (e) {
        console.error("Error initializing/resizing axis canvas:", canvas.id, e);
        return { ctx: null, resized: false };
    }
}

/**
 * Resizes both axis canvases for a given plotInfo and updates their contexts in plotInfo.
 * Returns true if either axis canvas was resized.
 * @param {object} plotInfo The plot info object containing axis canvases.
 * @returns {boolean} True if resizing occurred for either axis.
 */
function sizeAxisCanvases(plotInfo) {
    let resizedX = false;
    let resizedY = false;

    if (plotInfo.xAxisCanvas) {
        const resultX = initAxisCanvas(plotInfo.xAxisCanvas);
        plotInfo.ctxX = resultX.ctx; // Update context in plotInfo
        resizedX = resultX.resized;
    }
     if (plotInfo.yAxisCanvas) {
         const resultY = initAxisCanvas(plotInfo.yAxisCanvas);
         plotInfo.ctxY = resultY.ctx; // Update context in plotInfo
         resizedY = resultY.resized;
     }
     return resizedX || resizedY;
}

// --- Search/Filter Logic (Keep as before) ---
function handleMetricSearch() {
    if (!metricSearchInput) return;
    const searchTerm = metricSearchInput.value.toLowerCase().trim();
    const allMetricGroups = dashboardContainer.querySelectorAll('.metric-group');
    let anyPlotVisibleOverall = false;
    const visiblePlotsToResize = [];

    allMetricGroups.forEach(groupContainer => {
        const groupPlotsContainer = groupContainer.querySelector('.metric-group-plots');
        const plotWrappers = groupPlotsContainer ? groupPlotsContainer.querySelectorAll('.plot-wrapper') : [];
        let groupHasVisiblePlots = false;

        plotWrappers.forEach(wrapper => {
            const metricName = wrapper.dataset.metricName;
            const metricNameLower = metricName?.toLowerCase();
            let isMatch = searchTerm === '' || (metricNameLower && metricNameLower.includes(searchTerm));

            const shouldDisplay = isMatch ? '' : 'none';
            if (wrapper.style.display !== shouldDisplay) {
                 wrapper.style.display = shouldDisplay;
            }

            if (isMatch && metricName && activePlots[metricName]) {
                groupHasVisiblePlots = true;
                anyPlotVisibleOverall = true;
                // Only add if the wrapper is actually visible in the DOM
                if (wrapper.offsetParent !== null) {
                    visiblePlotsToResize.push(activePlots[metricName]);
                }
            }
        });

        const showGroup = searchTerm === '' || groupHasVisiblePlots;
         if (groupContainer.style.display !== (showGroup ? '' : 'none')) {
            groupContainer.style.display = showGroup ? '' : 'none';
         }
    });

    // Use requestAnimationFrame to ensure layout is updated before resizing
    requestAnimationFrame(() => {
        visiblePlotsToResize.forEach(plotInfo => {
            // Double-check visibility before resizing
            const wrapper = document.getElementById(`plot-wrapper-${plotInfo.metricName.replace(/[^a-zA-Z0-9]/g, '-')}`);
            if (wrapper && wrapper.offsetParent !== null) { // Check if rendered and visible
                resizePlot(plotInfo);
            }
        });
        updatePlaceholderVisibility(anyPlotVisibleOverall); // Update placeholder based on filter results
    });
}
// --- Global Resize Handler (Keep as before) ---
let resizeDebounceTimer = null;
function handleGlobalResize() {
    clearTimeout(resizeDebounceTimer);
    resizeDebounceTimer = setTimeout(() => {
        console.log("Window resized, updating visible plots...");
        isResizing = true; // Set flag
        for (const metricName in activePlots) {
            const plotInfo = activePlots[metricName];
            const wrapper = document.getElementById(`plot-wrapper-${metricName.replace(/[^a-zA-Z0-9]/g, '-')}`);
            // Check if plot exists and its wrapper is visible in the DOM
            if (plotInfo && wrapper && wrapper.offsetParent !== null) {
                 resizePlot(plotInfo);
            }
        }
        isResizing = false; // Clear flag
        // No need to call updateDashboard explicitly, animation frame handles drawing
    }, 150); // Debounce resize events
}

/**
 * Formats a number for axis display or tooltip.
 * Avoids overly long decimals or exponentials for typical ranges.
 * @param {number} value The number to format.
 * @param {number} range The approximate range (max-min) of the axis.
 * @returns {string} Formatted string label.
 */
// --- Formatting & Drawing (Keep as before) ---
function formatAxisValue(value, range) {
    if (!isFinite(value)) return "N/A";
    if (Math.abs(value) < 1e-9 && Math.abs(value) !== 0) return "0";
    const absVal = Math.abs(value); const absRange = Math.abs(range);
    if (absRange > 1e6 || absRange < 1e-3 || absVal > 1e7 || (absVal < 1e-4 && absVal !== 0) ) { return value.toExponential(2); }
    let decimals = 0;
    if (absRange < 1) decimals = 4; else if (absRange < 10) decimals = 3; else if (absRange < 100) decimals = 2; else decimals = 1;
    if (absVal > 0 && absVal < 1) { decimals = Math.max(decimals, Math.min(4, Math.ceil(-Math.log10(absVal)) + 1)); }
    else if (absVal === 0) { decimals = 0; }
    return value.toFixed(decimals);
}
function drawAxisX(ctx2d, width, height, scale, offset, divs) {
    if (!ctx2d || width <= 0 || height <= 0 || !isFinite(scale) || !isFinite(offset)) return;
    ctx2d.clearRect(0, 0, width, height); ctx2d.textAlign = "center"; ctx2d.textBaseline = "top";
    const axisRange = (Math.abs(scale) > 1e-9) ? 2 / scale : 0;
    for (let i = 0; i <= divs; i++) {
        const normX = (i / divs) * 2 - 1; const dataX = (Math.abs(scale) > 1e-9) ? (normX - offset) / scale : 0; const canvasX = (i / divs) * width;
        const label = formatAxisValue(dataX, axisRange).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
        ctx2d.fillText(label, canvasX, AXIS_TEXT_STYLE.tickSize + 2);
        ctx2d.beginPath(); ctx2d.moveTo(canvasX, 0); ctx2d.lineTo(canvasX, AXIS_TEXT_STYLE.tickSize); ctx2d.stroke();
    }
}
function drawAxisY(ctx2d, width, height, scale, offset, divs) {
    if (!ctx2d || width <= 0 || height <= 0 || !isFinite(scale) || !isFinite(offset)) return;
    ctx2d.clearRect(0, 0, width, height); ctx2d.textAlign = "right"; ctx2d.textBaseline = "middle";
    const axisRange = (Math.abs(scale) > 1e-9) ? 2 / scale : 0;
    for (let i = 0; i <= divs; i++) {
        const normY = 1 - (i / divs) * 2; const dataY = (Math.abs(scale) > 1e-9) ? (normY - offset) / scale : 0; const canvasY = (i / divs) * height;
        const label = formatAxisValue(dataY, axisRange).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
        ctx2d.fillText(label, width - AXIS_TEXT_STYLE.tickSize - 4, canvasY);
        ctx2d.beginPath(); ctx2d.moveTo(width - AXIS_TEXT_STYLE.tickSize, canvasY); ctx2d.lineTo(width, canvasY); ctx2d.stroke();
    }
}

// --- State ---
let availableRuns = []; // Will store just the names: ['run1', 'run2']
let runInfoMap = {}; // Stores { runName: { has_overrides: boolean } }
let selectedRuns = [];
let activePlots = {}; // Structure: { metric_name: { wglp, ..., lines: { run_name: line }, ... } }
let debounceTimer = null;
// Modified Cache Structure: Reflects backend change
let frontendDataCache = {}; // Structure: { run_name: { scalars: { metric_name: { steps, values, wall_times } }, hydra_overrides: '...' | null } }
let isResizing = false;

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
    updatePlaceholderVisibility();
    try {
        const response = await fetch(`${API_BASE_URL}/api/runs`);
        if (!response.ok) throw new Error(`Failed to fetch runs: ${response.status} ${response.statusText}`);
        const runsData = await response.json(); // Expecting [{name: 'run1', has_overrides: true}, ...]

        // Process the received data
        availableRuns = runsData.map(run => run.name);
        runInfoMap = runsData.reduce((map, run) => {
            map[run.name] = { has_overrides: run.has_overrides };
            return map;
        }, {});

        console.log(`Fetched ${availableRuns.length} runs. Override info available for ${runsData.filter(r => r.has_overrides).length} runs.`);

        populateRunSelector();

        if (availableRuns.length > 0) {
             runBulkControls.style.display = 'flex';
        } else {
             runBulkControls.style.display = 'none';
        }
    } catch (error) {
        displayError(error.message || 'Could not connect to backend.');
        runSelectorContainer.innerHTML = '<p style="color: var(--error-color);">Could not load runs.</p>'; // Use CSS var
        runBulkControls.style.display = 'none';
    }
}

async function fetchDataForSelectedRuns() {
    clearError();
    updatePlaceholderVisibility();

    if (placeholderText) {
        placeholderText.style.display = selectedRuns.length === 0 ? 'block' : 'none';
    }

    if (selectedRuns.length === 0) {
        console.log("No runs selected, clearing plots.");
        updatePlots({}); // Clear plots
        handleMetricSearch();
        return;
    }

    // --- Determine which runs need scalar data fetched ---
    // Note: We don't fetch overrides here, that's done on demand.
    // We only check if scalar data for the run is already cached.
    const runsToFetchScalars = selectedRuns.filter(runName => !frontendDataCache[runName]?.scalars); // Check specifically for scalars
    const cachedRuns = selectedRuns.filter(runName => frontendDataCache[runName]?.scalars);

    console.log(`Scalar Cache - Cached: ${cachedRuns.join(', ') || 'None'}`);
    console.log(`Scalar Cache - Need to fetch: ${runsToFetchScalars.join(', ') || 'None'}`);

    let fetchedScalarData = null; // Will hold data from /api/data

    if (runsToFetchScalars.length > 0) {
        loadingIndicator.style.display = 'block';
        errorMessageDiv.style.display = 'none';
        try {
            const runsParam = runsToFetchScalars.join(',');
            console.log(`Fetching scalar data for: ${runsParam}`);
            // Fetch only scalar data
            const response = await fetch(`${API_BASE_URL}/api/data?runs=${encodeURIComponent(runsParam)}`);
            if (!response.ok) {
                let errorMsg = `Failed to fetch scalar data for ${runsParam}: ${response.status} ${response.statusText}`;
                try { const errorData = await response.json(); if (errorData && errorData.error) { errorMsg += ` - ${errorData.error}`; } } catch(e) {}
                throw new Error(errorMsg);
            }
            fetchedScalarData = await response.json();
            console.log(`Received scalar data for ${Object.keys(fetchedScalarData || {}).length} metrics for newly fetched runs.`);

            // --- Update frontend cache with fetched SCALAR data ---
            // Ensure the cache structure is initialized correctly
            for (const runName of runsToFetchScalars) {
                 if (!frontendDataCache[runName]) {
                     frontendDataCache[runName] = {}; // Initialize as an empty object first
                 }
                 frontendDataCache[runName].scalars = {};
            }
            // Populate the scalars
            for (const metricName in fetchedScalarData) {
                for (const runName in fetchedScalarData[metricName]) {
                    if (runsToFetchScalars.includes(runName)) { // Ensure we only cache what we asked for
                        // We already ensured frontendDataCache[runName].scalars exists
                        frontendDataCache[runName].scalars[metricName] = fetchedScalarData[metricName][runName];
                    }
                }
            }
            console.log(`Frontend scalar cache updated for runs: ${runsToFetchScalars.join(', ')}`);

        } catch (error) {
            displayError(error.message || `Could not fetch scalar data for runs: ${runsToFetchScalars.join(', ')}`);
            // Don't proceed to plot update if fetch failed? Or plot only cached data?
            // Let's plot what we have (cached data).
        } finally {
            loadingIndicator.style.display = 'none';
        }
    } else {
        console.log("All selected runs' scalar data are already cached. Skipping fetch.");
        loadingIndicator.style.display = 'none';
    }

    // --- Prepare SCALAR data for plot update ---
    // Based *only* on currently selected runs and available SCALAR cache
    const metricsDataForUpdate = {};
    for (const runName of selectedRuns) {
        const runScalars = frontendDataCache[runName]?.scalars; // Safely access scalars
        if (runScalars) {
            for (const metricName in runScalars) {
                if (!metricsDataForUpdate[metricName]) {
                    metricsDataForUpdate[metricName] = {};
                }
                // Ensure the run is actually selected *and* scalar data exists for this metric
                if (runScalars[metricName]) {
                    metricsDataForUpdate[metricName][runName] = runScalars[metricName];
                }
            }
        }
    }
    console.log(`Updating plots with scalar data for ${Object.keys(metricsDataForUpdate).length} metrics covering runs: ${selectedRuns.join(', ')}`);
    updatePlots(metricsDataForUpdate); // This function will call handleMetricSearch at the end
}


// --- UI Update ---
function populateRunSelector() {
    runSelectorContainer.innerHTML = '';
    if (availableRuns.length === 0) {
        runSelectorContainer.innerHTML = '<p>No runs found.</p>';
        return;
    }

    // Sort available runs alphabetically for display
    const sortedRunNames = [...availableRuns].sort((a, b) => a.localeCompare(b));

    sortedRunNames.forEach(runName => {
        const runInfo = runInfoMap[runName] || { has_overrides: false }; // Default if somehow missing

        const div = document.createElement('div');
        div.className = 'run-checkbox-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `run-${runName}`;
        checkbox.value = runName;
        checkbox.checked = selectedRuns.includes(runName);
        checkbox.addEventListener('change', handleRunSelectionChange);

        const label = document.createElement('label');
        label.htmlFor = `run-${runName}`;
        label.title = runName; // Tooltip for long names

        const swatch = document.createElement('span');
        swatch.className = 'color-swatch';
        swatch.style.backgroundColor = getRunColor(runName).toString();

        // Add swatch and run name text to label
        label.append(swatch, ` ${runName}`);

        // Create Hydra button
        const hydraBtn = document.createElement('button');
        hydraBtn.className = 'hydra-overrides-btn';
        hydraBtn.dataset.runName = runName; // Store run name for the handler
        hydraBtn.title = 'View Hydra Overrides';
        // Simple 'H' icon or use SVG like in index.html example
        hydraBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h11A1.5 1.5 0 0 1 15 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 13.5v-11zM2.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-11z"/><path d="M8 8.971h-.535a.5.5 0 0 1-.497-.462l-.6-3.6A.5.5 0 0 1 7 4.462h2a.5.5 0 0 1 .497.447l-.6 3.6a.5.5 0 0 1-.497.462H8zm-1.618-4.4L6 8.129h.535L7 5.597h2l.465 2.532h.535l-.382-3.558A1.5 1.5 0 0 0 8.997 3H7.003a1.5 1.5 0 0 0-1.498 1.36l-.62 3.21zM8 10.5a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-1 0v-1a.5.5 0 0 1 .5-.5z"/></svg>`; // Example SVG Icon

        if (runInfo.has_overrides) {
            hydraBtn.style.display = 'flex'; // Show button if overrides exist
            hydraBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent triggering label click/checkbox toggle
                handleViewOverridesClick(runName);
            });
        } else {
            hydraBtn.style.display = 'none'; // Hide button
        }

        div.appendChild(checkbox);
        div.appendChild(label);
        div.appendChild(hydraBtn); // Add button to the item div
        runSelectorContainer.appendChild(div);
    });
}

// --- Run Selection & Bulk Actions (Keep as before) ---
function handleRunSelectionChange(event, fromBulkAction = false) {
    selectedRuns = Array.from(runSelectorContainer.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
    updatePlaceholderVisibility();
    clearTimeout(debounceTimer);
    if (fromBulkAction) { fetchDataAndResetView(); }
    else { debounceTimer = setTimeout(fetchDataAndResetView, 300); }
}
async function fetchDataAndResetView() {
    await fetchDataForSelectedRuns(); // Fetches scalar data if needed
    for (const metricName in activePlots) { // Reset view for existing plots
        const plotInfo = activePlots[metricName];
        if (plotInfo && isFinite(plotInfo.minStep) && isFinite(plotInfo.maxStep) && isFinite(plotInfo.minY) && isFinite(plotInfo.maxY)) {
            setPlotAxes(plotInfo.wglp, plotInfo.minStep, plotInfo.maxStep, plotInfo.minY, plotInfo.maxY);
        }
    }
}
function setupBulkActions() {
    selectAllBtn.addEventListener('click', () => { runSelectorContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = true; }); handleRunSelectionChange(null, true); });
    deselectAllBtn.addEventListener('click', () => { runSelectorContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; }); handleRunSelectionChange(null, true); });
}

// --- Hydra Modal Logic ---
async function handleViewOverridesClick(runName) {
    if (!hydraModal || !hydraModalRunName || !hydraModalContent) {
        console.error("Hydra modal elements not found.");
        displayError("Cannot display overrides: Modal elements missing.");
        return;
    }

    console.log(`Requesting overrides for: ${runName}`);
    hydraModalRunName.textContent = runName; // Show run name immediately
    hydraModalContent.textContent = 'Loading...'; // Show loading state
    hydraModalContent.style.color = 'var(--text-secondary)'; // Use secondary color for loading text
    hydraModal.style.display = 'flex'; // Show the modal (using flex as defined in CSS)

    try {
        // Check frontend cache first (though backend stores it, this is a fallback/future optimization)
        let overridesText = frontendDataCache[runName]?.hydra_overrides;

        if (overridesText === undefined) {
            const response = await fetch(`${API_BASE_URL}/api/overrides?run=${encodeURIComponent(runName)}`);
            if (!response.ok) {
                let errorMsg = `Failed to fetch overrides: ${response.status} ${response.statusText}`;
                 if (response.status === 404) {
                     errorMsg = `No Hydra overrides found for run '${runName}'.`;
                     if (!frontendDataCache[runName]) {
                         frontendDataCache[runName] = {};
                     }
                     frontendDataCache[runName].hydra_overrides = null; // Use null to indicate "checked, none found"
                 } else {
                     try { const errorData = await response.json(); if (errorData && errorData.error) { errorMsg += ` - ${errorData.error}`; } } catch(e) {}
                 }
                throw new Error(errorMsg);
            }
            overridesText = await response.text();

            if (!frontendDataCache[runName]) {
                 frontendDataCache[runName] = {}; // Initialize run entry if needed
            }
            // Store fetched text, DON'T initialize scalars here
            frontendDataCache[runName].hydra_overrides = overridesText;

        } else if (overridesText === null) {
             // This means we previously checked and found no overrides
             throw new Error(`No Hydra overrides found for run '${runName}'.`);
        }
        // If overridesText is already a string, we use the cached version directly

        // Display the overrides
        hydraModalContent.textContent = overridesText;
        hydraModalContent.style.color = 'var(--text-primary)'; // Reset color

    } catch (error) {
        console.error(`Error fetching/displaying overrides for ${runName}:`, error);
        hydraModalContent.textContent = `Error: ${error.message || 'Could not load overrides.'}`;
        hydraModalContent.style.color = 'var(--error-color)'; // Use error color
    }
}

function setupModalCloseHandlers() {
    if (!hydraModal || !hydraModalCloseBtn) return;

    // Close when clicking the 'x' button
    hydraModalCloseBtn.addEventListener('click', () => {
        hydraModal.style.display = 'none';
    });

    // Close when clicking outside the modal content area
    hydraModal.addEventListener('click', (event) => {
        // Check if the click target is the modal background itself
        if (event.target === hydraModal) {
            hydraModal.style.display = 'none';
        }
    });

    // Close with the Escape key
    window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && hydraModal.style.display !== 'none') {
            hydraModal.style.display = 'none';
        }
    });
}

// --- Plotting Update & Grouping (Keep as before) ---
function updatePlots(metricsData) {
    // console.log("Updating plots with scalar data...");
    const currentMetricNames = Object.keys(metricsData);
    const existingMetricNames = Object.keys(activePlots);

    existingMetricNames.forEach(metricName => { if (!currentMetricNames.includes(metricName)) { removePlot(metricName); } });

    const metricGroups = {}; const defaultGroupName = 'General';
    currentMetricNames.forEach(metricName => {
        let groupName = defaultGroupName; const slashIndex = metricName.indexOf('/');
        if (slashIndex !== -1) { groupName = metricName.substring(0, slashIndex); }
        if (!metricGroups[groupName]) { metricGroups[groupName] = []; }
        metricGroups[groupName].push(metricName);
    });

    const currentGroupContainerIds = Array.from(dashboardContainer.querySelectorAll('.metric-group')).map(el => el.id);
    currentGroupContainerIds.forEach(groupId => {
        const groupNameFromId = groupId.replace('metric-group-', '');
        if (!(groupNameFromId in metricGroups)) { const groupContainerToRemove = document.getElementById(groupId); if (groupContainerToRemove) { dashboardContainer.removeChild(groupContainerToRemove); } }
    });

    const sortedGroupNames = Object.keys(metricGroups).sort((a, b) => { if (a === defaultGroupName) return 1; if (b === defaultGroupName) return -1; return a.localeCompare(b); });
    sortedGroupNames.forEach(groupName => { createOrUpdateMetricGroupTab(groupName, metricGroups[groupName], metricsData, metricGroups); });

    handleMetricSearch(); // Apply filter after DOM updates
    // console.log("Plot update finished and search filter reapplied.");
}
function createOrUpdateMetricGroupTab(groupName, metricNames, metricsData, allMetricGroups) {
    const groupContainerId = `metric-group-${groupName}`; let groupContainer = document.getElementById(groupContainerId); let plotsContainer;
    if (!groupContainer) {
        groupContainer = document.createElement('div'); groupContainer.id = groupContainerId; groupContainer.className = 'metric-group';
        const header = document.createElement('div'); header.className = 'metric-group-header';
        // Use SVG for toggle button
        header.innerHTML = `<h3 title="${groupName}">${groupName}</h3><button class="toggle-button" aria-expanded="true" aria-controls="plots-${groupName}"><svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"></path></svg></button>`;
        header.addEventListener('click', () => { const isCollapsed = groupContainer.classList.toggle('collapsed'); header.querySelector('button').setAttribute('aria-expanded', !isCollapsed); });
        plotsContainer = document.createElement('div'); plotsContainer.className = 'metric-group-plots'; plotsContainer.id = `plots-${groupName}`;
        groupContainer.appendChild(header); groupContainer.appendChild(plotsContainer); dashboardContainer.appendChild(groupContainer);
    } else {
        plotsContainer = groupContainer.querySelector('.metric-group-plots');
        if (!plotsContainer) { plotsContainer = document.createElement('div'); plotsContainer.className = 'metric-group-plots'; plotsContainer.id = `plots-${groupName}`; groupContainer.appendChild(plotsContainer); }
        const headerH3 = groupContainer.querySelector('.metric-group-header h3'); if (headerH3) headerH3.title = groupName;
    }
    metricNames.forEach(metricName => { const plotDataForMetric = metricsData[metricName]; createOrUpdatePlot(metricName, plotDataForMetric, plotsContainer); });
    const currentPlotWrappersInGroup = Array.from(plotsContainer.children);
    currentPlotWrappersInGroup.forEach(wrapperElement => {
        const existingMetricNameInGroup = wrapperElement.dataset.metricName;
        if (existingMetricNameInGroup) {
            if (!metricNames.includes(existingMetricNameInGroup)) {
                try { plotsContainer.removeChild(wrapperElement); } catch (e) { console.warn(`Error removing plot wrapper ${wrapperElement.id} from group ${groupName}:`, e); }
                const stillExistsInAnyGroup = Object.values(allMetricGroups).flat().includes(existingMetricNameInGroup);
                if (!stillExistsInAnyGroup && activePlots[existingMetricNameInGroup]) { delete activePlots[existingMetricNameInGroup]; /* console.log(`Deleted ${existingMetricNameInGroup} from activePlots.`); */ }
            }
        } else { try { plotsContainer.removeChild(wrapperElement); } catch (e) { console.warn(`Error removing orphaned plot wrapper ${wrapperElement.id} from group ${groupName}:`, e); } }
    });
}
function removePlot(metricName) {
    const plotInfo = activePlots[metricName];
    if (plotInfo) {
        const plotContainerId = `plot-wrapper-${metricName.replace(/[^a-zA-Z0-9]/g, '-')}`; const plotWrapper = document.getElementById(plotContainerId);
        if (plotWrapper && plotWrapper.parentNode) { try { plotWrapper.parentNode.removeChild(plotWrapper); } catch (e) { console.warn(`Error removing plot wrapper DOM for ${metricName}:`, e); } }
        // TODO: Add WebGL resource cleanup if available: if (plotInfo.wglp?.dispose) plotInfo.wglp.dispose();
        delete activePlots[metricName];
        // console.log(`Removed plot state for: ${metricName}`);
    }
}

// --- Plotting Logic (Adjust Cache Access) ---
function createOrUpdatePlot(metricName, plotDataForMetric, parentElement) {
     let plotInfo = activePlots[metricName];
     let wglp, zoomRectLine;
     const safeMetricName = metricName.replace(/[^a-zA-Z0-9]/g, '-');
     const plotContainerId = `plot-wrapper-${safeMetricName}`;

     if (!plotDataForMetric) {
          console.warn(`No plot data provided for metric ${metricName}.`);
          if (plotInfo) removePlot(metricName);
          else {
              const existingWrapper = document.getElementById(plotContainerId);
              if (existingWrapper && existingWrapper.parentNode) {
                  console.warn(`Removing orphaned plot wrapper ${plotContainerId} (no data).`);
                  existingWrapper.parentNode.removeChild(existingWrapper);
              }
          }
          return;
     }

     let overallMinStep = Infinity, overallMaxStep = -Infinity;
     let overallMinY = Infinity, overallMaxY = -Infinity;
     let hasValidData = false;
     const runsInMetric = Object.keys(plotDataForMetric);

     runsInMetric.forEach(runName => {
         if (!selectedRuns.includes(runName)) return;
         const runData = plotDataForMetric[runName]; // This is {steps, values, ...}
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
         console.log(`No valid finite data points for metric ${metricName} among selected runs. Removing plot.`);
         if (plotInfo) removePlot(metricName);
         else {
             const existingWrapper = document.getElementById(plotContainerId);
             if (existingWrapper && existingWrapper.parentNode) {
                 existingWrapper.parentNode.removeChild(existingWrapper);
             }
         }
         return;
     }

     // Handle range padding (keep as before)
     if (!isFinite(overallMinStep)) overallMinStep = 0;
     if (!isFinite(overallMaxStep)) overallMaxStep = (overallMinStep !== 0) ? overallMinStep : 1;
     if (!isFinite(overallMinY)) overallMinY = 0;
     if (!isFinite(overallMaxY)) overallMaxY = (overallMinY !== 0) ? overallMinY : 1;
     if (overallMaxStep - overallMinStep < 1e-9) { const padding = Math.abs(overallMaxStep * 0.1) || 0.5; overallMinStep -= padding; overallMaxStep += padding; }
     if (overallMaxY - overallMinY < 1e-9) { const padding = Math.abs(overallMaxY * 0.1) || 0.1; overallMinY -= padding; overallMaxY += padding; }


     let wrapper = document.getElementById(plotContainerId);
     let canvas, yAxisCanvas, xAxisCanvas;
     let needsInitialization = false;

     if (!plotInfo) {
         needsInitialization = true;
         if (wrapper) {
             console.warn(`Plot wrapper ${plotContainerId} exists but no state. Reusing element, initializing state.`);
              if (wrapper.parentNode !== parentElement) { parentElement.appendChild(wrapper); }
              yAxisCanvas = wrapper.querySelector('.plot-yaxis');
              canvas = wrapper.querySelector('.plot-canvas');
              xAxisCanvas = wrapper.querySelector('.plot-xaxis');
              if (!yAxisCanvas || !canvas || !xAxisCanvas) {
                 console.error(`Plot wrapper ${plotContainerId} structure missing. Rebuilding.`);
                 wrapper.innerHTML = ''; // Clear if structure is bad
                 // Force full rebuild below
              } else {
                  // Structure seems okay, just need to init state
              }
         } else {
             wrapper = document.createElement('div');
             wrapper.className = 'plot-wrapper';
             wrapper.id = plotContainerId;
             wrapper.dataset.metricName = metricName;
             parentElement.appendChild(wrapper);
             // Force full rebuild below
         }

         // Rebuild inner structure if needed (new wrapper or bad structure)
         if (needsInitialization || wrapper.children.length < 5) {
              wrapper.innerHTML = ''; // Clear previous content if rebuilding
              const title = document.createElement('h3'); title.textContent = metricName; title.title = metricName; wrapper.appendChild(title);
              const yAxisContainer = document.createElement('div'); yAxisContainer.className = 'plot-yaxis-container'; yAxisCanvas = document.createElement('canvas'); yAxisCanvas.className = 'plot-yaxis'; yAxisCanvas.id = `plot-yaxis-${safeMetricName}`; yAxisContainer.appendChild(yAxisCanvas); wrapper.appendChild(yAxisContainer);
              const canvasContainer = document.createElement('div'); canvasContainer.className = 'plot-canvas-container'; canvas = document.createElement('canvas'); canvas.className = 'plot-canvas'; canvas.id = `plot-canvas-${safeMetricName}`; canvasContainer.appendChild(canvas); wrapper.appendChild(canvasContainer);
              const cornerDiv = document.createElement('div'); cornerDiv.className = 'plot-corner'; wrapper.appendChild(cornerDiv);
              const xAxisContainer = document.createElement('div'); xAxisContainer.className = 'plot-xaxis-container'; xAxisCanvas = document.createElement('canvas'); xAxisCanvas.className = 'plot-xaxis'; xAxisCanvas.id = `plot-xaxis-${safeMetricName}`; xAxisContainer.appendChild(xAxisCanvas); wrapper.appendChild(xAxisContainer);
         } else {
              // Elements already exist from previous check
              yAxisCanvas = wrapper.querySelector('.plot-yaxis');
              canvas = wrapper.querySelector('.plot-canvas');
              xAxisCanvas = wrapper.querySelector('.plot-xaxis');
         }

         if (!canvas) { console.error("Main plot canvas could not be found/created for", metricName); if(wrapper && wrapper.parentNode) parentElement.removeChild(wrapper); return; }

         const devicePixelRatio = window.devicePixelRatio || 1;
         const initialWidth = canvas.clientWidth || 400; const initialHeight = canvas.clientHeight || 300;
         canvas.width = Math.max(1, Math.round(initialWidth * devicePixelRatio)); canvas.height = Math.max(1, Math.round(initialHeight * devicePixelRatio));

         wglp = new WebglPlot(canvas);
         zoomRectLine = new WebglLine(new ColorRGBA(0.9, 0.9, 0.9, 0.7), 4); zoomRectLine.loop = true; zoomRectLine.xy = new Float32Array(8).fill(0); zoomRectLine.visible = false; wglp.addLine(zoomRectLine);

         // Initialize axis contexts *after* elements are created/found
         const { ctx: ctxX } = initAxisCanvas(xAxisCanvas);
         const { ctx: ctxY } = initAxisCanvas(yAxisCanvas);

         plotInfo = {
             wglp, zoomRectLine, lines: {}, isInitialLoad: true, canvas, yAxisCanvas, xAxisCanvas, ctxX, ctxY, // Store contexts directly
             minStep: overallMinStep, maxStep: overallMaxStep, minY: overallMinY, maxY: overallMaxY, metricName: metricName
         };
         activePlots[metricName] = plotInfo;
         sizeAxisCanvases(plotInfo); // Resize axes based on client rects
         setupInteractions(canvas, wglp, zoomRectLine, plotInfo, plotTooltip, metricName);
         if (canvas.width > 0 && canvas.height > 0) { wglp.viewport(0, 0, canvas.width, canvas.height); }
         else { console.error(`Main canvas ${metricName} has zero dimensions AFTER setup.`); }

     } else { // Plot state exists
         wglp = plotInfo.wglp; zoomRectLine = plotInfo.zoomRectLine; canvas = plotInfo.canvas; yAxisCanvas = plotInfo.yAxisCanvas; xAxisCanvas = plotInfo.xAxisCanvas;
         if (!wrapper) { console.error(`Plot state exists for ${metricName} but wrapper element not found.`); removePlot(metricName); return; }
         if (wrapper.parentNode !== parentElement) { parentElement.appendChild(wrapper); }
         if (wrapper.dataset.metricName !== metricName) { wrapper.dataset.metricName = metricName; }
         if (!canvas || !yAxisCanvas || !xAxisCanvas || !plotInfo.ctxX || !plotInfo.ctxY || !wglp) {
             console.error(`Plot state for ${metricName} is incomplete. Re-initializing.`);
             delete activePlots[metricName]; if (wrapper.parentNode) parentElement.removeChild(wrapper);
             createOrUpdatePlot(metricName, plotDataForMetric, parentElement); return;
         }
         if (!plotInfo.metricName) plotInfo.metricName = metricName;
         // Ensure axis contexts are valid (might be lost)
         if (!plotInfo.ctxX) plotInfo.ctxX = initAxisCanvas(xAxisCanvas).ctx;
         if (!plotInfo.ctxY) plotInfo.ctxY = initAxisCanvas(yAxisCanvas).ctx;
     }

     plotInfo.minStep = overallMinStep; plotInfo.maxStep = overallMaxStep; plotInfo.minY = overallMinY; plotInfo.maxY = overallMaxY;
     if (plotInfo.isInitialLoad || needsInitialization) { setPlotAxes(wglp, overallMinStep, overallMaxStep, overallMinY, overallMaxY); plotInfo.isInitialLoad = false; }
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
         const runData = plotDataForMetric[runName]; // This is {steps, values, ...}
         if (!runData || !runData.steps || runData.steps.length === 0 || !runData.values || runData.steps.length !== runData.values.length) {
             if (plotInfo.lines[runName]) { plotInfo.lines[runName].visible = false; }
             if (runData && runData.steps && runData.values && runData.steps.length !== runData.values.length) { console.warn(`Step/value length mismatch for ${metricName}/${runName}. Hiding line.`); }
             return;
          }

          let line = plotInfo.lines[runName];
          const numPoints = runData.steps.length;
          const color = getRunColor(runName);
          const xyData = new Float32Array(numPoints * 2);
          let validPointCount = 0;
          for (let i = 0; i < numPoints; i++) {
              const step = runData.steps[i]; const value = runData.values[i];
              if (isFinite(step) && isFinite(value)) { xyData[validPointCount * 2] = step; xyData[validPointCount * 2 + 1] = value; validPointCount++; }
          }

          if (validPointCount === 0) { if (line) line.visible = false; if (numPoints > 0) console.warn(`All data points for ${metricName}/${runName} were non-finite.`); return; }
          const finalXYData = xyData.slice(0, validPointCount * 2);

          if (!line) {
              line = new WebglLine(color, validPointCount); plotInfo.lines[runName] = line; wglp.addLine(line);
              // console.log(`Added line for ${metricName}/${runName} with ${validPointCount} points.`);
          } else if (line.numPoints !== validPointCount) {
              // console.log(`Valid point count changed for ${metricName}/${runName} (${line.numPoints} -> ${validPointCount}). Recreating line.`);
              try { const lineIndex = wglp.linesData.indexOf(line); if (lineIndex > -1) { wglp.linesData.splice(lineIndex, 1); } } catch (e) { console.warn(`Could not remove old line for ${metricName}/${runName}:`, e); }
              line = new WebglLine(color, validPointCount); plotInfo.lines[runName] = line; wglp.addLine(line);
          } else { line.color = color; } // Update color if needed

          line.xy = finalXYData; line.visible = true;
      });
}

// --- setPlotAxes (Keep as before) ---
function setPlotAxes(wglp, minX, maxX, minY, maxY) {
    let rangeX = maxX - minX; let rangeY = maxY - minY;
    if (rangeX <= 1e-9) rangeX = Math.abs(maxX * 0.2) || 1; if (rangeY <= 1e-9) rangeY = Math.abs(maxY * 0.2) || 0.2;
    const paddingX = rangeX * 0.05; const paddingY = rangeY * 0.05;
    const finalMinX = minX - paddingX; const finalMaxX = maxX + paddingX; const finalMinY = minY - paddingY; const finalMaxY = maxY + paddingY;
    const finalRangeX = finalMaxX - finalMinX; const finalRangeY = finalMaxY - finalMinY;
    wglp.gScaleX = (finalRangeX > 1e-9) ? (2 / finalRangeX) : 1; wglp.gOffsetX = -1 - finalMinX * wglp.gScaleX;
    wglp.gScaleY = (finalRangeY > 1e-9) ? (2 / finalRangeY) : 1; wglp.gOffsetY = -1 - finalMinY * wglp.gScaleY;
    wglp.gScaleX = Math.max(1e-7, Math.min(1e7, wglp.gScaleX)); wglp.gScaleY = Math.max(1e-7, Math.min(1e7, wglp.gScaleY));
}

// --- findClosestIndex (Keep as before) ---
function findClosestIndex(arr, target) {
    if (!arr || arr.length === 0) return -1; let low = 0; let high = arr.length - 1; let mid; let closestIndex = 0;
    if (target <= arr[0]) return 0; if (target >= arr[high]) return high;
    while (low <= high) { mid = Math.floor((low + high) / 2); const midVal = arr[mid]; if (Math.abs(midVal - target) < Math.abs(arr[closestIndex] - target)) { closestIndex = mid; } if (midVal < target) { low = mid + 1; } else if (midVal > target) { high = mid - 1; } else { return mid; } }
    if (low < arr.length && Math.abs(arr[low] - target) < Math.abs(arr[closestIndex] - target)) { closestIndex = low; } if (high >= 0 && Math.abs(arr[high] - target) < Math.abs(arr[closestIndex] - target)) { closestIndex = high; }
    return closestIndex;
}

// --- Plot Interactions (Keep as before, ensure tooltip cache access is correct) ---
function setupInteractions(canvas, wglp, zoomRectLine, plotInfo, tooltipElement, metricName) {
     let isDragging = false, isZoomingRect = false, dragStartX = 0, dragStartY = 0, plotOffsetXOld = 0, plotOffsetYOld = 0, zoomRectStartXNDC = 0, zoomRectStartYNDC = 0;
     const devicePixelRatio = window.devicePixelRatio || 1;
     const getMainCanvasRect = () => canvas.getBoundingClientRect();
     const ndcToPlotCoords = (ndcX, ndcY) => ({ x: Math.abs(wglp.gScaleX) > 1e-9 ? (ndcX - wglp.gOffsetX) / wglp.gScaleX : 0, y: Math.abs(wglp.gScaleY) > 1e-9 ? (ndcY - wglp.gOffsetY) / wglp.gScaleY : 0 });
     const screenToPlotCoords = (screenX, screenY) => {
         const mainCanvasRect = getMainCanvasRect(); if (!mainCanvasRect || mainCanvasRect.width <= 0 || mainCanvasRect.height <= 0) return { x: NaN, y: NaN };
         const offsetX = screenX - mainCanvasRect.left; const offsetY = screenY - mainCanvasRect.top;
         // Correct calculation using canvas dimensions
         const ndcX_corrected = (2 * (offsetX * devicePixelRatio) / canvas.width) - 1;
         const ndcY_corrected = 1 - (2 * (offsetY * devicePixelRatio) / canvas.height);
         return ndcToPlotCoords(ndcX_corrected, ndcY_corrected);
     };

     canvas.addEventListener('contextmenu', (e) => e.preventDefault());
     canvas.addEventListener('dblclick', (e) => {
         e.preventDefault();
         if (plotInfo && isFinite(plotInfo.minStep) && isFinite(plotInfo.maxStep) && isFinite(plotInfo.minY) && isFinite(plotInfo.maxY)) { setPlotAxes(wglp, plotInfo.minStep, plotInfo.maxStep, plotInfo.minY, plotInfo.maxY); }
         zoomRectLine.visible = false; tooltipElement.style.display = 'none';
     });
     canvas.addEventListener('mousedown', (e) => {
         e.preventDefault(); canvas.focus(); tooltipElement.style.display = 'none';
         const mainCanvasRect = getMainCanvasRect(); if (!mainCanvasRect) return;
         const offsetX = e.clientX - mainCanvasRect.left; const offsetY = e.clientY - mainCanvasRect.top;
         const currentNdcX = (2 * (offsetX * devicePixelRatio) / canvas.width) - 1;
         const currentNdcY = 1 - (2 * (offsetY * devicePixelRatio) / canvas.height);
         if (e.button === 0) { // Left Click: Zoom Rect
             isZoomingRect = true; isDragging = false; zoomRectStartXNDC = currentNdcX; zoomRectStartYNDC = currentNdcY;
             try { const startPlotCoords = ndcToPlotCoords(zoomRectStartXNDC, zoomRectStartYNDC); if (!isFinite(startPlotCoords.x) || !isFinite(startPlotCoords.y)) throw new Error("Invalid start coords"); zoomRectLine.xy = new Float32Array([ startPlotCoords.x, startPlotCoords.y, startPlotCoords.x, startPlotCoords.y, startPlotCoords.x, startPlotCoords.y, startPlotCoords.x, startPlotCoords.y, ]); zoomRectLine.visible = true; canvas.style.cursor = 'crosshair'; }
             catch (convErr) { isZoomingRect = false; zoomRectLine.visible = false; canvas.style.cursor = 'grab'; }
         } else if (e.button === 2) { // Right Click: Pan
             isDragging = true; isZoomingRect = false; zoomRectLine.visible = false; dragStartX = e.clientX; dragStartY = e.clientY; plotOffsetXOld = wglp.gOffsetX; plotOffsetYOld = wglp.gOffsetY; canvas.style.cursor = 'grabbing';
         }
     });
     canvas.addEventListener('mousemove', (e) => {
         if (isDragging || isZoomingRect) {
              tooltipElement.style.display = 'none'; e.preventDefault();
              const mainCanvasRect = getMainCanvasRect(); if (!mainCanvasRect) return;
              const offsetX = e.clientX - mainCanvasRect.left; const offsetY = e.clientY - mainCanvasRect.top;
              const currentNdcX = (2 * (offsetX * devicePixelRatio) / canvas.width) - 1;
              const currentNdcY = 1 - (2 * (offsetY * devicePixelRatio) / canvas.height);
              if (isDragging) {
                  const dxScreen = (e.clientX - dragStartX) * devicePixelRatio; const dyScreen = (e.clientY - dragStartY) * devicePixelRatio;
                  const deltaOffsetX = (canvas.width > 0) ? (dxScreen / canvas.width) * 2 : 0; const deltaOffsetY = (canvas.height > 0) ? (-dyScreen / canvas.height) * 2 : 0;
                  wglp.gOffsetX = plotOffsetXOld + deltaOffsetX; wglp.gOffsetY = plotOffsetYOld + deltaOffsetY; canvas.style.cursor = 'grabbing';
              } else if (isZoomingRect) {
                  try { const startPlot = ndcToPlotCoords(zoomRectStartXNDC, zoomRectStartYNDC); const currentPlot = ndcToPlotCoords(currentNdcX, currentNdcY); if (!isFinite(startPlot.x) || !isFinite(startPlot.y) || !isFinite(currentPlot.x) || !isFinite(currentPlot.y)) throw new Error("Invalid plot coords"); zoomRectLine.xy = new Float32Array([ startPlot.x, startPlot.y, currentPlot.x, startPlot.y, currentPlot.x, currentPlot.y, startPlot.x, currentPlot.y ]); zoomRectLine.visible = true; }
                  catch (convErr) { /* Handle error */ } canvas.style.cursor = 'crosshair';
              } return;
          }
          // --- Tooltip Logic ---
          canvas.style.cursor = 'grab'; const mainCanvasRect = getMainCanvasRect(); if (!mainCanvasRect) { tooltipElement.style.display = 'none'; return; }
          const cursorScreenX = e.clientX; const cursorScreenY = e.clientY; const cursorCanvasX = cursorScreenX - mainCanvasRect.left; const cursorCanvasY = cursorScreenY - mainCanvasRect.top;
          const plotCoords = screenToPlotCoords(cursorScreenX, cursorScreenY); if (!isFinite(plotCoords.x) || !isFinite(plotCoords.y)) { tooltipElement.style.display = 'none'; return; }
          let minScreenDistanceSq = TOOLTIP_CLOSENESS_THRESHOLD_PX_SQ; let closestPointInfo = null;
          for (const runName in plotInfo.lines) {
              const line = plotInfo.lines[runName]; if (!line || !line.visible || line.numPoints === 0) continue;
              // *** Corrected Cache Access for Tooltip ***
              const runScalars = frontendDataCache[runName]?.scalars;
              const runMetricData = runScalars?.[metricName]; // Access specific metric data
              if (!runMetricData || !runMetricData.steps || runMetricData.steps.length === 0 || !runMetricData.values || runMetricData.values.length !== runMetricData.steps.length) { continue; }
              const closestIndex = findClosestIndex(runMetricData.steps, plotCoords.x); if (closestIndex === -1) continue;
              const pointStep = runMetricData.steps[closestIndex]; const pointValue = runMetricData.values[closestIndex]; if (!isFinite(pointValue)) continue;
              const pointNdcX = pointStep * wglp.gScaleX + wglp.gOffsetX; const pointNdcY = pointValue * wglp.gScaleY + wglp.gOffsetY;
              const pointCanvasX = ((pointNdcX + 1) / 2) * canvas.width / devicePixelRatio; const pointCanvasY = ((1 - pointNdcY) / 2) * canvas.height / devicePixelRatio;
              const dx = cursorCanvasX - pointCanvasX; const dy = cursorCanvasY - pointCanvasY; const screenDistSq = dx * dx + dy * dy;
              if (screenDistSq < minScreenDistanceSq) { minScreenDistanceSq = screenDistSq; closestPointInfo = { runName: runName, step: pointStep, value: pointValue, color: line.color.toString(), }; }
          }
          if (closestPointInfo) {
               const formattedValue = formatAxisValue(closestPointInfo.value, plotInfo.maxY - plotInfo.minY); const formattedStep = Number.isInteger(closestPointInfo.step) ? closestPointInfo.step.toString() : formatAxisValue(closestPointInfo.step, plotInfo.maxStep - plotInfo.minStep);
               // Use CSS variables for tooltip text colors
               tooltipElement.innerHTML = `<span style="display: inline-block; width: 10px; height: 10px; background-color: ${closestPointInfo.color}; margin-right: 5px; vertical-align: middle; border: 1px solid rgba(128,128,128,0.3); border-radius: 2px;"></span><strong style="color: var(--text-primary);">${closestPointInfo.runName}</strong><br><span style="font-size: 0.9em; color: var(--text-secondary);">Step:</span> ${formattedStep}<br><span style="font-size: 0.9em; color: var(--text-secondary);">Value:</span> ${formattedValue}`;
               let tooltipX = cursorScreenX + 15; let tooltipY = cursorScreenY + 10; const tooltipRect = tooltipElement.getBoundingClientRect(); const viewportWidth = window.innerWidth; const viewportHeight = window.innerHeight;
               if (tooltipX + tooltipRect.width > viewportWidth - 10) { tooltipX = cursorScreenX - tooltipRect.width - 15; } if (tooltipY + tooltipRect.height > viewportHeight - 10) { tooltipY = cursorScreenY - tooltipRect.height - 10; }
               if (tooltipX < 10) tooltipX = 10; if (tooltipY < 10) tooltipY = 10;
               tooltipElement.style.left = `${tooltipX}px`; tooltipElement.style.top = `${tooltipY}px`; tooltipElement.style.display = 'block';
          } else { tooltipElement.style.display = 'none'; }
     }); // End mousemove
     canvas.addEventListener('mouseup', (e) => {
          if (!isDragging && !isZoomingRect) return; e.preventDefault(); const mainCanvasRect = getMainCanvasRect(); if (!mainCanvasRect) return;
          const offsetX = e.clientX - mainCanvasRect.left; const offsetY = e.clientY - mainCanvasRect.top;
          const endNdcX = (2 * (offsetX * devicePixelRatio) / canvas.width) - 1;
          const endNdcY = 1 - (2 * (offsetY * devicePixelRatio) / canvas.height);
          if (isDragging) { isDragging = false; canvas.style.cursor = 'grab'; }
          else if (isZoomingRect) {
              isZoomingRect = false; zoomRectLine.visible = false; canvas.style.cursor = 'grab';
              const minDragThresholdNDC = 0.02;
              if (Math.abs(endNdcX - zoomRectStartXNDC) > minDragThresholdNDC || Math.abs(endNdcY - zoomRectStartYNDC) > minDragThresholdNDC) {
                  try { const startPlot = ndcToPlotCoords(zoomRectStartXNDC, zoomRectStartYNDC); const endPlot = ndcToPlotCoords(endNdcX, endNdcY); if (!isFinite(startPlot.x) || !isFinite(startPlot.y) || !isFinite(endPlot.x) || !isFinite(endPlot.y)) throw new Error("Invalid plot coords"); const minPlotX = Math.min(startPlot.x, endPlot.x); const maxPlotX = Math.max(startPlot.x, endPlot.x); const minPlotY = Math.min(startPlot.y, endPlot.y); const maxPlotY = Math.max(startPlot.y, endPlot.y); const centerX = (minPlotX + maxPlotX) / 2; const centerY = (minPlotY + maxPlotY) / 2; const rangeX = maxPlotX - minPlotX; const rangeY = maxPlotY - minPlotY;
                      if (rangeX > 1e-9 && rangeY > 1e-9) { let newScaleX = 2 / rangeX; let newScaleY = 2 / rangeY; newScaleX = Math.max(1e-7, Math.min(1e7, newScaleX)); newScaleY = Math.max(1e-7, Math.min(1e7, newScaleY)); const newOffsetX = -centerX * newScaleX; const newOffsetY = -centerY * newScaleY; wglp.gScaleX = newScaleX; wglp.gScaleY = newScaleY; wglp.gOffsetX = newOffsetX; wglp.gOffsetY = newOffsetY; }
                  } catch (convErr) { console.error("Error performing zoom:", convErr); }
              }
          }
     }); // End mouseup
     canvas.addEventListener('mouseleave', (e) => { if (isDragging) { isDragging = false; canvas.style.cursor = 'grab'; } if (isZoomingRect) { isZoomingRect = false; zoomRectLine.visible = false; canvas.style.cursor = 'grab'; } tooltipElement.style.display = 'none'; }); // End mouseleave
     canvas.addEventListener('wheel', (e) => {
        if (e.shiftKey) {
            e.preventDefault(); tooltipElement.style.display = 'none'; const zoomFactor = 1.1; const scaleDelta = e.deltaY < 0 ? zoomFactor : 1 / zoomFactor; const mainCanvasRect = getMainCanvasRect(); if (!mainCanvasRect) return; const offsetX = e.clientX - mainCanvasRect.left; const offsetY = e.clientY - mainCanvasRect.top;
            const cursorNDC_X = (2 * (offsetX * devicePixelRatio) / canvas.width) - 1;
            const cursorNDC_Y = 1 - (2 * (offsetY * devicePixelRatio) / canvas.height);
            const gScaleXOld = wglp.gScaleX; const gScaleYOld = wglp.gScaleY; let newScaleX = gScaleXOld * scaleDelta; let newScaleY = gScaleYOld * scaleDelta; newScaleX = Math.max(1e-7, Math.min(1e7, newScaleX)); newScaleY = Math.max(1e-7, Math.min(1e7, newScaleY)); const actualScaleChangeX = (Math.abs(gScaleXOld) > 1e-9) ? newScaleX / gScaleXOld : 1; const actualScaleChangeY = (Math.abs(gScaleYOld) > 1e-9) ? newScaleY / gScaleYOld : 1; wglp.gOffsetX = cursorNDC_X + (wglp.gOffsetX - cursorNDC_X) * actualScaleChangeX; wglp.gOffsetY = cursorNDC_Y + (wglp.gOffsetY - cursorNDC_Y) * actualScaleChangeY; wglp.gScaleX = newScaleX; wglp.gScaleY = newScaleY;
        }
     }, { passive: false });
     // --- Touch Interactions (Keep as before) ---
     let isPinching = false; let isTouchPanning = false; let touchStartX0 = 0, touchStartY0 = 0; let initialPinchDistance = 0; let touchPlotOffsetXOld = 0, touchPlotOffsetYOld = 0; let initialPinchCenterX = 0, initialPinchCenterY = 0;
     canvas.addEventListener('touchstart', (e) => { e.preventDefault(); zoomRectLine.visible = false; tooltipElement.style.display = 'none'; if (e.touches.length === 1) { isTouchPanning = true; isPinching = false; const touch = e.touches[0]; touchStartX0 = touch.clientX; touchStartY0 = touch.clientY; touchPlotOffsetXOld = wglp.gOffsetX; touchPlotOffsetYOld = wglp.gOffsetY; } else if (e.touches.length === 2) { isPinching = true; isTouchPanning = false; const t0 = e.touches[0]; const t1 = e.touches[1]; initialPinchCenterX = (t0.clientX + t1.clientX) / 2; initialPinchCenterY = (t0.clientY + t1.clientY) / 2; initialPinchDistance = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY); touchPlotOffsetXOld = wglp.gOffsetX; touchPlotOffsetYOld = wglp.gOffsetY; } else { isTouchPanning = false; isPinching = false; } }, { passive: false });
     canvas.addEventListener('touchmove', (e) => { e.preventDefault(); tooltipElement.style.display = 'none'; const mainCanvasRect = getMainCanvasRect(); if (!mainCanvasRect) return; if (isTouchPanning && e.touches.length === 1) { const touch = e.touches[0]; const dxScreen = (touch.clientX - touchStartX0) * devicePixelRatio; const dyScreen = (touch.clientY - touchStartY0) * devicePixelRatio; const deltaOffsetX = (canvas.width > 0) ? (dxScreen / canvas.width) * 2 : 0; const deltaOffsetY = (canvas.height > 0) ? (-dyScreen / canvas.height) * 2 : 0; wglp.gOffsetX = touchPlotOffsetXOld + deltaOffsetX; wglp.gOffsetY = touchPlotOffsetYOld + deltaOffsetY; } else if (isPinching && e.touches.length === 2) { const t0 = e.touches[0]; const t1 = e.touches[1]; const currentDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY); const currentCenterX = (t0.clientX + t1.clientX) / 2; const currentCenterY = (t0.clientY + t1.clientY) / 2; const scaleDelta = (initialPinchDistance > 1e-6) ? currentDist / initialPinchDistance : 1; const centerOffsetX = currentCenterX - mainCanvasRect.left; const centerOffsetY = currentCenterY - mainCanvasRect.top;
     const centerNDC_X = (2 * (centerOffsetX * devicePixelRatio) / canvas.width) - 1;
     const centerNDC_Y = 1 - (2 * (centerOffsetY * devicePixelRatio) / canvas.height);
     const gScaleXOld = wglp.gScaleX; const gScaleYOld = wglp.gScaleY; let newScaleX = gScaleXOld * scaleDelta; let newScaleY = gScaleYOld * scaleDelta; newScaleX = Math.max(1e-7, Math.min(1e7, newScaleX)); newScaleY = Math.max(1e-7, Math.min(1e7, newScaleY)); const actualScaleChangeX = (Math.abs(gScaleXOld) > 1e-9) ? newScaleX / gScaleXOld : 1; const actualScaleChangeY = (Math.abs(gScaleYOld) > 1e-9) ? newScaleY / gScaleYOld : 1; wglp.gOffsetX = centerNDC_X + (touchPlotOffsetXOld - centerNDC_X) * actualScaleChangeX; wglp.gOffsetY = centerNDC_Y + (touchPlotOffsetYOld - centerNDC_Y) * actualScaleChangeY; wglp.gScaleX = newScaleX; wglp.gScaleY = newScaleY; initialPinchDistance = currentDist; touchPlotOffsetXOld = wglp.gOffsetX; touchPlotOffsetYOld = wglp.gOffsetY; } }, { passive: false });
     canvas.addEventListener('touchend', (e) => { e.preventDefault(); if (e.touches.length < 2) { isPinching = false; } if (e.touches.length < 1) { isTouchPanning = false; } }, { passive: false });
} // End setupInteractions

// --- Global Animation & Resize --- // <-- MODIFIED
let animationFrameId = null;
function updateDashboard() {
    // Only redraw if not currently resizing via JS
    if (!isResizing) {
        for (const metricName in activePlots) {
            const plotInfo = activePlots[metricName];
            // Check if plot exists and its wrapper is visible
            const wrapper = document.getElementById(`plot-wrapper-${metricName.replace(/[^a-zA-Z0-9]/g, '-')}`);
            if (plotInfo && plotInfo.wglp && wrapper && wrapper.offsetParent !== null) {
                plotInfo.wglp.update(); // Update WebGL plot

                const { wglp, ctxX, ctxY, xAxisCanvas, yAxisCanvas } = plotInfo;

                // Update 2D Axes only if context and canvas are valid and have dimensions
                if (ctxX && xAxisCanvas && xAxisCanvas.width > 0 && xAxisCanvas.height > 0) {
                    // Re-apply styles before drawing, in case theme changed
                    ctxX.font = AXIS_TEXT_STYLE.font;
                    ctxX.fillStyle = AXIS_TEXT_STYLE.fillStyle;
                    ctxX.strokeStyle = AXIS_TEXT_STYLE.strokeStyle;
                    drawAxisX(ctxX, xAxisCanvas.width, xAxisCanvas.height, wglp.gScaleX, wglp.gOffsetX, AXIS_DIVISIONS);
                }
                if (ctxY && yAxisCanvas && yAxisCanvas.width > 0 && yAxisCanvas.height > 0) {
                    // Re-apply styles before drawing
                    ctxY.font = AXIS_TEXT_STYLE.font;
                    ctxY.fillStyle = AXIS_TEXT_STYLE.fillStyle;
                    ctxY.strokeStyle = AXIS_TEXT_STYLE.strokeStyle;
                    drawAxisY(ctxY, yAxisCanvas.width, yAxisCanvas.height, wglp.gScaleY, wglp.gOffsetY, AXIS_DIVISIONS);
                }
            }
        }
    }
    animationFrameId = requestAnimationFrame(updateDashboard);
}

// --- Placeholder Visibility (Keep as before) ---
function updatePlaceholderVisibility(anyPlotVisible = true) {
    if (!placeholderText) return;
    const noRunsSelected = selectedRuns.length === 0;
    const searchTerm = metricSearchInput ? metricSearchInput.value.trim() : '';
    const isFiltering = searchTerm !== '';
    let hasVisiblePlots = false;
    if (!noRunsSelected) {
        // Check if any plot wrappers are actually displayed
        const visibleWrappers = dashboardContainer.querySelectorAll('.plot-wrapper:not([style*="display: none"])');
        hasVisiblePlots = visibleWrappers.length > 0;
    }

    if (noRunsSelected) {
        placeholderText.textContent = "Select runs from the sidebar to view plots.";
        placeholderText.style.display = 'block';
    } else if (isFiltering && !hasVisiblePlots) {
        placeholderText.textContent = `No metrics found matching "${searchTerm}".`;
        placeholderText.style.display = 'block';
    } else if (!isFiltering && !hasVisiblePlots && !noRunsSelected) {
        // This case needs refinement - could be no data OR all groups collapsed
        // Let's assume for now it means no data if not filtering
        placeholderText.textContent = "No plot data available for the selected runs, or all groups are collapsed.";
        placeholderText.style.display = 'block';
    }
    else {
        placeholderText.style.display = 'none';
    }
}

// --- Search Setup (Keep as before) ---
function setupSearchFilter() {
    if (!metricSearchInput) { console.warn("Metric search input element not found."); return; }
    metricSearchInput.addEventListener('input', handleMetricSearch);
    // console.log("Metric search filter initialized.");
}

// --- Theme Toggling --- //

/**
 * Sets the theme based on the provided value ('light' or 'dark').
 * Updates the data-theme attribute, button icon, and saves preference.
 * @param {string} theme - The desired theme ('light' or 'dark').
 */
function setTheme(theme) {
    const isLight = theme === 'light';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);

    if (themeIconSun && themeIconMoon) {
        themeIconSun.style.display = isLight ? 'none' : 'inline';
        themeIconMoon.style.display = isLight ? 'inline' : 'none';
    }
    if (themeToggleBtn) {
        themeToggleBtn.setAttribute('aria-label', `Switch to ${isLight ? 'Dark' : 'Light'} Theme`);
        themeToggleBtn.setAttribute('title', `Switch to ${isLight ? 'Dark' : 'Light'} Theme`);
    }

    // Update axis styles immediately after setting theme attribute
    updateAxisTextStyle();

    // Trigger a resize/redraw of axes for existing plots
    // We can force a resize which implicitly redraws axes in the next frame
    handleGlobalResize(); // Use the existing debounced resize handler

    console.log(`Theme set to: ${theme}`);
}

/**
 * Handles clicks on the theme toggle button.
 */
function handleThemeToggle() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
}

/**
 * Loads the preferred theme from localStorage or system preference.
 */
function loadInitialTheme() {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initialTheme = savedTheme || (prefersDark ? 'dark' : 'light');
    setTheme(initialTheme); // Apply the theme

    // Add listener for system theme changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => {
        // Only change if no theme is explicitly saved by the user
        if (!localStorage.getItem(THEME_STORAGE_KEY)) {
            setTheme(event.matches ? 'dark' : 'light');
        }
    });
}

// --- Initialization --- //
async function initialize() {
    if (!plotTooltip) { console.error("FATAL: Tooltip element #plot-tooltip not found!"); displayError("Initialization failed: Tooltip element missing."); return; }
    if (!hydraModal) { console.warn("Hydra modal element #hydra-modal not found. Override viewing disabled."); /* Continue without modal */ }
    if (!themeToggleBtn || !themeIconSun || !themeIconMoon) { console.warn("Theme toggle elements not found. Theme switching disabled."); }

    console.log("Initializing p-board...");

    loadInitialTheme();
    updateAxisTextStyle();

    setupBulkActions();
    setupSearchFilter();
    if (hydraModal) {
        setupModalCloseHandlers();
    }
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', handleThemeToggle);
    }

    await fetchRuns(); // Fetch runs (includes override status)

    window.addEventListener('resize', handleGlobalResize);
    requestAnimationFrame(updateDashboard); // Start animation loop
    console.log("Initialization complete. Starting animation loop.");
}

// Run initialization
initialize();
