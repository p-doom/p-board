// Access classes via the WebglPlotBundle global object
const { WebglPlot, WebglLine, ColorRGBA } = WebglPlotBundle;

const dashboardContainer = document.getElementById('dashboard-container');

// --- Configuration for plots and static data ---
const NUM_POINTS_STATIC = 5000;

const PLOT_CONFIGS = [
    {
        id: 'loss-plot',
        title: 'Training Loss (Static)',
        metrics: [
            { name: 'train_loss', color: new ColorRGBA(1, 0.3, 0.3, 1), type: 'decreasing' },
            { name: 'val_loss', color: new ColorRGBA(1, 0.6, 0.6, 1), type: 'decreasing_noisy' },
        ]
    },
    {
        id: 'accuracy-plot',
        title: 'Accuracy (Static)',
        metrics: [
            { name: 'train_acc', color: new ColorRGBA(0.3, 1, 0.3, 1), type: 'increasing' },
            { name: 'val_acc', color: new ColorRGBA(0.6, 1, 0.6, 1), type: 'increasing_noisy' },
        ]
    },
    {
        id: 'learning-rate-plot',
        title: 'Learning Rate (Static)',
        metrics: [
            { name: 'lr', color: new ColorRGBA(0.5, 0.5, 1, 1), type: 'step_decay' },
        ]
    },
    {
        id: 'custom-metric-plot',
        title: 'Some Custom Metric (Static)',
        metrics: [
            { name: 'metric_a', color: new ColorRGBA(1, 1, 0.3, 1), type: 'sine_wave' },
            { name: 'metric_b', color: new ColorRGBA(0.3, 1, 1, 1), type: 'random_walk' },
        ]
    }
];

// --- Store plot instances AND their associated zoom rectangle lines ---
// Now stores objects like: { plotId: { wglp: WebglPlot, zoomRectLine: WebglLine } }
const plots = {};

// --- Static Data Generation Function ---
// ... (generateStaticData function remains the same)
function generateStaticData(type, numPoints) {
    const data = new Float32Array(numPoints);
    let currentVal = 0.5;
    for (let i = 0; i < numPoints; i++) {
        let newValue = 0;
        const progress = i / (numPoints * 1.0); // Adjusted denominator for full range
        const step = i;
        switch (type) {
             case 'decreasing':
                newValue = 0.8 * Math.exp(-progress * 5) + 0.1;
                break;
            case 'decreasing_noisy':
                newValue = 0.8 * Math.exp(-progress * 4) + 0.15 + (Math.random() - 0.5) * 0.05; // Reduced noise
                break;
            case 'increasing':
                newValue = 0.9 * (1 - Math.exp(-progress * 5)) + 0.05;
                break;
            case 'increasing_noisy':
                newValue = 0.85 * (1 - Math.exp(-progress * 4)) + 0.1 + (Math.random() - 0.5) * 0.05; // Reduced noise
                break;
            case 'step_decay':
                const step1 = Math.floor(numPoints * 0.4); // Adjusted steps
                const step2 = Math.floor(numPoints * 0.7);
                if (step < step1) newValue = 0.001;
                else if (step < step2) newValue = 0.0005;
                else newValue = 0.0001;
                break;
            case 'sine_wave':
                newValue = 0.5 + 0.3 * Math.sin(step * Math.PI * 2 / (numPoints / 10)); // Adjusted frequency
                break;
            case 'random_walk':
                newValue = currentVal + (Math.random() - 0.5) * 0.02; // Reduced step
                currentVal = newValue;
                break;
            default:
                newValue = Math.random();
        }
        // Clamp values to prevent going too far out of typical view
        data[i] = Math.max(0, Math.min(1, newValue));
    }
    // Simple smoothing
    const smoothedData = new Float32Array(numPoints);
    smoothedData[0] = data[0];
    smoothedData[numPoints-1] = data[numPoints-1];
     for (let i = 1; i < numPoints - 1; i++) {
        if (type.includes('noisy') || type === 'random_walk') {
             smoothedData[i] = (data[i-1] + data[i] + data[i+1]) / 3;
        } else {
             smoothedData[i] = data[i]; // No smoothing for clean lines
        }
    }

    // Return smoothedData instead of data for noisy/walk types
    if (type.includes('noisy') || type === 'random_walk') {
        return smoothedData;
    } else {
        return data;
    }
}


// --- Initialization ---
function initializePlots() {
    let plotsInitializedCount = 0; // Counter

    PLOT_CONFIGS.forEach(config => {
        const wrapper = document.createElement('div');
        wrapper.className = 'plot-wrapper';
        const title = document.createElement('h3');
        title.textContent = config.title;
        const canvas = document.createElement('canvas');
        canvas.id = config.id;
        canvas.className = 'plot-canvas';
        wrapper.appendChild(title);
        wrapper.appendChild(canvas);
        dashboardContainer.appendChild(wrapper);

        const devicePixelRatio = window.devicePixelRatio || 1;

        requestAnimationFrame(() => {
            canvas.width = canvas.clientWidth * devicePixelRatio;
            canvas.height = canvas.clientHeight * devicePixelRatio;

            if (canvas.width === 0 || canvas.height === 0) {
                console.warn(`Canvas ${config.id} has zero dimensions. Plotting might fail.`);
                plotsInitializedCount++;
                if (plotsInitializedCount === PLOT_CONFIGS.length) {
                    startAnimationLoopIfReady();
                }
                return;
            }

            const wglp = new WebglPlot(canvas);

            // --- Create the Zoom Rectangle Line ---
            const zoomRectLine = new WebglLine(new ColorRGBA(0.9, 0.9, 0.9, 0.7), 4); // Semi-transparent white
            zoomRectLine.loop = true; // Make it a closed loop
            zoomRectLine.xy = new Float32Array(8).fill(0); // Initialize with zeros (8 values for 4 xy pairs)
            zoomRectLine.visible = false; // Start hidden
            wglp.addLine(zoomRectLine); // Add it to the plot

            // --- Store instances ---
            plots[config.id] = { wglp, zoomRectLine }; // Store both

            let plotMinY = Infinity;
            let plotMaxY = -Infinity;

            config.metrics.forEach(metric => {
                const staticYData = generateStaticData(metric.type, NUM_POINTS_STATIC);
                const line = new WebglLine(metric.color, NUM_POINTS_STATIC);
                line.arrangeX();
                for (let i = 0; i < NUM_POINTS_STATIC; i++) {
                    const y = staticYData[i];
                    line.setY(i, y);
                    if (isFinite(y)) {
                        plotMinY = Math.min(plotMinY, y);
                        plotMaxY = Math.max(plotMaxY, y);
                    }
                }
                wglp.addLine(line);
            });

            // Calculate and set initial Y-axis scale/offset
            // ... (calculation code remains the same as previous version)
            if (isFinite(plotMinY) && isFinite(plotMaxY)) {
                 const dataRangeY = plotMaxY - plotMinY;
                 const padding = dataRangeY === 0 ? 0.1 : dataRangeY * 0.1;
                 const finalMinY = plotMinY - padding;
                 const finalMaxY = plotMaxY + padding;
                 const finalRangeY = finalMaxY - finalMinY;
                 if (finalRangeY > 1e-9) {
                     wglp.gScaleY = 2 / finalRangeY;
                     wglp.gOffsetY = -1 - finalMinY * wglp.gScaleY;
                 } else {
                     wglp.gScaleY = 1;
                     wglp.gOffsetY = -plotMinY;
                 }
            } else {
                 wglp.gScaleY = 1.0;
                 wglp.gOffsetY = 0.0;
            }
            wglp.gScaleX = 1.0;
            wglp.gOffsetX = 0.0;

            // --- Interaction Logic for *this* canvas/wglp ---
            let isDragging = false;
            let isZoomingRect = false;
            let dragStartX = 0;
            let dragStartY = 0;
            let plotOffsetXOld = 0;
            let plotOffsetYOld = 0;
            let zoomRectStartX = 0; // In NDC coords
            let zoomRectStartY = 0; // In NDC coords

            // --- Helper: Convert NDC to Plot Coordinates ---
            // (Reverses the transformation applied by webgl-plot)
            const ndcToPlotCoords = (ndcX, ndcY) => {
                // Avoid division by zero if scale is somehow zero
                const plotX = wglp.gScaleX === 0 ? 0 : (ndcX - wglp.gOffsetX) / wglp.gScaleX;
                const plotY = wglp.gScaleY === 0 ? 0 : (ndcY - wglp.gOffsetY) / wglp.gScaleY;
                return { x: plotX, y: plotY };
            };

            // Prevent default context menu
            canvas.addEventListener('contextmenu', (e) => e.preventDefault());

            // Double Click: Reset View
             canvas.addEventListener('dblclick', (e) => {
                e.preventDefault();
                // Reset Y scale/offset
                if (isFinite(plotMinY) && isFinite(plotMaxY)) {
                   // ... (same Y reset logic as before)
                    const dataRangeY = plotMaxY - plotMinY;
                    const padding = dataRangeY === 0 ? 0.1 : dataRangeY * 0.1;
                    const finalMinY = plotMinY - padding;
                    const finalMaxY = plotMaxY + padding;
                    const finalRangeY = finalMaxY - finalMinY;
                    if (finalRangeY > 1e-9) {
                        wglp.gScaleY = 2 / finalRangeY;
                        wglp.gOffsetY = -1 - finalMinY * wglp.gScaleY;
                    } else {
                        wglp.gScaleY = 1;
                        wglp.gOffsetY = -plotMinY;
                    }
                } else {
                    wglp.gScaleY = 1.0;
                    wglp.gOffsetY = 0.0;
                }
                // Reset X scale/offset
                wglp.gScaleX = 1.0;
                wglp.gOffsetX = 0.0;
                // Hide zoom rectangle if it was somehow visible
                zoomRectLine.visible = false;
            });

            // Mouse Down: Start Pan or Zoom Rect
            canvas.addEventListener('mousedown', (e) => {
                e.preventDefault();
                if (e.button === 0) { // Left click: Start Zoom Rect
                    isZoomingRect = true;
                    isDragging = false;
                    // Store start NDC coordinates
                    zoomRectStartX = (2 * (e.offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
                    zoomRectStartY = (-2 * (e.offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height; // Y is inverted

                    // Convert start NDC to plot coords for the rectangle line
                    const startPlotCoords = ndcToPlotCoords(zoomRectStartX, zoomRectStartY);

                    // Initialize rectangle to a single point at the start
                    zoomRectLine.xy = new Float32Array([
                        startPlotCoords.x, startPlotCoords.y,
                        startPlotCoords.x, startPlotCoords.y,
                        startPlotCoords.x, startPlotCoords.y,
                        startPlotCoords.x, startPlotCoords.y,
                    ]);
                    zoomRectLine.visible = true; // Make it visible
                    canvas.style.cursor = 'crosshair';

                } else if (e.button === 2) { // Right click: Pan Start
                    isDragging = true;
                    isZoomingRect = false; // Ensure zoom rect stops if right click interrupts
                    zoomRectLine.visible = false; // Hide rect if panning starts
                    dragStartX = e.clientX * devicePixelRatio;
                    dragStartY = e.clientY * devicePixelRatio;
                    plotOffsetXOld = wglp.gOffsetX;
                    plotOffsetYOld = wglp.gOffsetY;
                    canvas.style.cursor = 'grabbing';
                }
            });

            // Mouse Move: Handle Dragging or Update Zoom Rect
            canvas.addEventListener('mousemove', (e) => {
                e.preventDefault();
                if (isDragging) {
                    // ... (panning logic remains the same)
                    const moveX = e.clientX * devicePixelRatio - dragStartX;
                    const moveY = e.clientY * devicePixelRatio - dragStartY;
                    const deltaX = (moveX / canvas.width) * 2 / wglp.gScaleX;
                    const deltaY = (-moveY / canvas.height) * 2 / wglp.gScaleY;
                    wglp.gOffsetX = plotOffsetXOld + deltaX;
                    wglp.gOffsetY = plotOffsetYOld + deltaY;

                } else if (isZoomingRect) {
                    // Get current NDC coordinates
                    const currentNdcX = (2 * (e.offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
                    const currentNdcY = (-2 * (e.offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;

                    // Convert start and current NDC to Plot Coordinates
                    const startPlot = ndcToPlotCoords(zoomRectStartX, zoomRectStartY);
                    const currentPlot = ndcToPlotCoords(currentNdcX, currentNdcY);

                    // Update the zoom rectangle line's vertices
                    // Order: Bottom-Left -> Bottom-Right -> Top-Right -> Top-Left (relative to screen)
                    zoomRectLine.xy = new Float32Array([
                        startPlot.x, startPlot.y,   // Corner 1 (start point)
                        currentPlot.x, startPlot.y, // Corner 2
                        currentPlot.x, currentPlot.y, // Corner 3 (current point)
                        startPlot.x, currentPlot.y    // Corner 4
                    ]);
                    canvas.style.cursor = 'crosshair'; // Keep cursor
                } else {
                     canvas.style.cursor = 'grab'; // Default cursor
                }
            });

            // Mouse Up: End Pan or Execute Zoom Rect
            canvas.addEventListener('mouseup', (e) => {
                e.preventDefault();
                 zoomRectLine.visible = false; // Always hide rect on mouseup

                if (isDragging) {
                    isDragging = false;
                    canvas.style.cursor = 'grab';
                } else if (isZoomingRect) {
                    isZoomingRect = false;
                    canvas.style.cursor = 'grab';

                    const zoomRectEndX = (2 * (e.offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
                    const zoomRectEndY = (-2 * (e.offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;

                    // Use the STARTING NDC coords (zoomRectStartX/Y) and ENDING NDC coords (zoomRectEndX/Y)
                    // Get scale *before* zoom changes
                    const scaleXBeforeZoom = wglp.gScaleX;
                    const scaleYBeforeZoom = wglp.gScaleY;

                    // Convert NDC rect corners to the plot's internal coordinate system
                    const startPlotX = (zoomRectStartX - wglp.gOffsetX) / scaleXBeforeZoom;
                    const endPlotX = (zoomRectEndX - wglp.gOffsetX) / scaleXBeforeZoom;
                    const startPlotY = (zoomRectStartY - wglp.gOffsetY) / scaleYBeforeZoom;
                    const endPlotY = (zoomRectEndY - wglp.gOffsetY) / scaleYBeforeZoom;

                    // --- Zoom Calculation (remains the same) ---
                    const minPlotX = Math.min(startPlotX, endPlotX);
                    const maxPlotX = Math.max(startPlotX, endPlotX);
                    const minPlotY = Math.min(startPlotY, endPlotY);
                    const maxPlotY = Math.max(startPlotY, endPlotY);

                    const centerX = (minPlotX + maxPlotX) / 2;
                    const centerY = (minPlotY + maxPlotY) / 2;
                    const rangeX = Math.abs(maxPlotX - minPlotX);
                    const rangeY = Math.abs(maxPlotY - minPlotY);

                    // Check for minimal drag distance to prevent tiny zooms
                    const minDragThresholdNDC = 0.02; // Adjust as needed (NDC units)
                    if (Math.abs(zoomRectEndX - zoomRectStartX) > minDragThresholdNDC ||
                        Math.abs(zoomRectEndY - zoomRectStartY) > minDragThresholdNDC)
                    {
                        if (rangeX > 1e-9 && rangeY > 1e-9) {
                            wglp.gScaleX = 2 / rangeX;
                            wglp.gScaleY = 2 / rangeY;
                            wglp.gOffsetX = -centerX * wglp.gScaleX;
                            wglp.gOffsetY = -centerY * wglp.gScaleY;
                        }
                    }
                    // Clamp scale regardless
                    wglp.gScaleX = Math.max(0.01, wglp.gScaleX);
                    wglp.gScaleY = Math.max(0.01, wglp.gScaleY);
                }
            });

             // Mouse Leave: Ensure dragging/zooming stops and hide rectangle
            canvas.addEventListener('mouseleave', (e) => {
                 if (isDragging || isZoomingRect) {
                     isDragging = false;
                     isZoomingRect = false;
                     zoomRectLine.visible = false; // Hide rect on leave
                     canvas.style.cursor = 'grab';
                 }
            });

            // Wheel: Zoom in/out
            canvas.addEventListener('wheel', (e) => {
                // ... (wheel logic remains the same)
                e.preventDefault();
                const zoomFactor = 1.1;
                const scaleDelta = e.deltaY < 0 ? zoomFactor : 1 / zoomFactor;
                const cursorNDC_X = (2 * (e.offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
                const cursorNDC_Y = (-2 * (e.offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;
                const gScaleXOld = wglp.gScaleX;
                const gScaleYOld = wglp.gScaleY;

                wglp.gScaleX *= scaleDelta;
                wglp.gScaleY *= scaleDelta;
                wglp.gScaleX = Math.max(0.01, wglp.gScaleX);
                wglp.gScaleY = Math.max(0.01, wglp.gScaleY);

                wglp.gOffsetX = cursorNDC_X + (wglp.gOffsetX - cursorNDC_X) * (wglp.gScaleX / gScaleXOld);
                wglp.gOffsetY = cursorNDC_Y + (wglp.gOffsetY - cursorNDC_Y) * (wglp.gScaleY / gScaleYOld);
            });

            // --- Touch Events ---
            // ... (Touch logic remains the same, ensure zoomRectLine.visible = false in touchstart/touchend if needed)
            let touchStartX0 = 0, touchStartY0 = 0;
            let touchStartX1 = 0, touchStartY1 = 0;
            let initialTouchDistance = 0;
            let isPinching = false;
            let isTouchPannning = false;
            let touchPanStartX = 0, touchPanStartY = 0;
            let touchPlotOffsetXOld = 0;
            let touchPlotOffsetYOld = 0;

             canvas.addEventListener('touchstart', (e) => {
                 e.preventDefault();
                 zoomRectLine.visible = false; // Hide rect if touch starts
                 if (e.touches.length === 1) {
                      isTouchPannning = true;
                      isPinching = false;
                      const touch = e.touches[0];
                      touchPanStartX = touch.clientX * devicePixelRatio;
                      touchPanStartY = touch.clientY * devicePixelRatio;
                      touchPlotOffsetXOld = wglp.gOffsetX;
                      touchPlotOffsetYOld = wglp.gOffsetY;
                 } else if (e.touches.length === 2) {
                      isPinching = true;
                      isTouchPannning = false;
                      const touch0 = e.touches[0];
                      const touch1 = e.touches[1];
                      touchStartX0 = touch0.clientX * devicePixelRatio;
                      touchStartY0 = touch0.clientY * devicePixelRatio;
                      touchStartX1 = touch1.clientX * devicePixelRatio;
                      touchStartY1 = touch1.clientY * devicePixelRatio;
                      initialTouchDistance = Math.hypot(touchStartX1 - touchStartX0, touchStartY1 - touchStartY0);
                      touchPlotOffsetXOld = wglp.gOffsetX;
                      touchPlotOffsetYOld = wglp.gOffsetY;
                 }
             }, { passive: false });

             canvas.addEventListener('touchmove', (e) => {
                 e.preventDefault();
                 if (isTouchPannning && e.touches.length === 1) {
                     // ... pan move logic ...
                    const touch = e.touches[0];
                    const moveX = touch.clientX * devicePixelRatio - touchPanStartX;
                    const moveY = touch.clientY * devicePixelRatio - touchPanStartY;
                    const deltaX = (moveX / canvas.width) * 2 / wglp.gScaleX;
                    const deltaY = (-moveY / canvas.height) * 2 / wglp.gScaleY;
                    wglp.gOffsetX = touchPlotOffsetXOld + deltaX;
                    wglp.gOffsetY = touchPlotOffsetYOld + deltaY;
                 } else if (isPinching && e.touches.length === 2) {
                     // ... pinch move logic ...
                    const touch0 = e.touches[0];
                    const touch1 = e.touches[1];
                    const currentX0 = touch0.clientX * devicePixelRatio;
                    const currentY0 = touch0.clientY * devicePixelRatio;
                    const currentX1 = touch1.clientX * devicePixelRatio;
                    const currentY1 = touch1.clientY * devicePixelRatio;
                    const currentTouchDistance = Math.hypot(currentX1 - currentX0, currentY1 - currentY0);
                    const currentCenterX = (currentX0 + currentX1) / 2;
                    const currentCenterY = (currentY0 + currentY1) / 2;

                    if (initialTouchDistance > 1e-6) {
                        const scaleDelta = currentTouchDistance / initialTouchDistance;
                        const centerNDC_X = (2 * (currentCenterX - canvas.width / 2)) / canvas.width;
                        const centerNDC_Y = (-2 * (currentCenterY - canvas.height / 2)) / canvas.height;
                        const gScaleXOld = wglp.gScaleX;
                        const gScaleYOld = wglp.gScaleY;
                        let newScaleX = gScaleXOld * scaleDelta;
                        let newScaleY = gScaleYOld * scaleDelta;
                        newScaleX = Math.max(0.01, newScaleX);
                        newScaleY = Math.max(0.01, newScaleY);

                        // Adjust offset based on STARTING offset
                        wglp.gOffsetX = centerNDC_X + (touchPlotOffsetXOld - centerNDC_X) * (newScaleX / gScaleXOld);
                        wglp.gOffsetY = centerNDC_Y + (touchPlotOffsetYOld - centerNDC_Y) * (newScaleY / gScaleYOld);
                        wglp.gScaleX = newScaleX;
                        wglp.gScaleY = newScaleY;

                        initialTouchDistance = currentTouchDistance;
                        touchPlotOffsetXOld = wglp.gOffsetX; // Update reference offset for next move delta
                        touchPlotOffsetYOld = wglp.gOffsetY;
                    }
                 }
             }, { passive: false });

             canvas.addEventListener('touchend', (e) => {
                  e.preventDefault();
                   zoomRectLine.visible = false; // Ensure hidden
                  if (e.touches.length < 2) { isPinching = false; }
                  if (e.touches.length < 1) { isTouchPannning = false; }
             }, { passive: false });


            // Increment counter
            plotsInitializedCount++;
            if (plotsInitializedCount === PLOT_CONFIGS.length) {
                startAnimationLoopIfReady();
            }
        });
    });
}

let animationFrameId = null;

// --- Function to start the animation loop ---
function startAnimationLoopIfReady() {
    if (animationFrameId === null && (Object.keys(plots).length > 0 || plotsInitializedCount === PLOT_CONFIGS.length) ) {
         console.log("Initialization complete or attempted, starting animation loop.");
         animationFrameId = requestAnimationFrame(updateDashboard);
    } else if (Object.keys(plots).length === 0 && plotsInitializedCount === PLOT_CONFIGS.length){
         console.warn("No plots were successfully initialized.");
    }
}

// --- Animation Loop ---
function updateDashboard() {
    // Loop through all initialized plots and call update
    for (const plotId in plots) {
        const plotData = plots[plotId];
        if (plotData && plotData.wglp) { // Check if plot instance exists
             plotData.wglp.update(); // This now also draws the zoomRectLine if visible
        }
    }
    animationFrameId = requestAnimationFrame(updateDashboard); // Continue the loop
}

// --- Resize Handling ---
window.addEventListener('resize', () => {
    // ... (resize logic remains the same)
    clearTimeout(window.resizeTimeout);
    window.resizeTimeout = setTimeout(() => {
        console.log("Resizing plots...");
        const devicePixelRatio = window.devicePixelRatio || 1;

        for (const plotId in plots) {
            const plotData = plots[plotId];
            if (!plotData || !plotData.wglp) continue;

            const wglp = plotData.wglp;
            const canvas = wglp.canvas;
            if (!canvas) continue;

            const newWidth = canvas.clientWidth;
            const newHeight = canvas.clientHeight;

            if (newWidth > 0 && newHeight > 0) {
                const targetWidth = Math.round(newWidth * devicePixelRatio);
                const targetHeight = Math.round(newHeight * devicePixelRatio);

                if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
                    canvas.width = targetWidth;
                    canvas.height = targetHeight;
                    wglp.viewport(0, 0, canvas.width, canvas.height);
                    console.log(`Resized ${plotId} to ${canvas.width}x${canvas.height}`);
                }
            } else {
                console.warn(`Canvas ${plotId} client dimensions are zero during resize.`);
            }
        }
    }, 250);
});


// --- Start Initialization ---
initializePlots();
