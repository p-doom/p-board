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

// --- Store plot instances ---
const plots = {}; // { plotId: WebglPlot }

// --- Static Data Generation Function ---
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
        // ... (wrapper, title, canvas creation remains the same) ...
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

        // Use requestAnimationFrame to ensure dimensions are available
        requestAnimationFrame(() => {
            canvas.width = canvas.clientWidth * devicePixelRatio;
            canvas.height = canvas.clientHeight * devicePixelRatio;

            if (canvas.width === 0 || canvas.height === 0) {
                console.warn(`Canvas ${config.id} has zero dimensions. Plotting might fail.`);
                 plotsInitializedCount++; // Increment even on failure to avoid hang
                if (plotsInitializedCount === PLOT_CONFIGS.length) {
                    startAnimationLoopIfReady();
                }
                return;
            }

            const wglp = new WebglPlot(canvas);
            plots[config.id] = wglp; // Store the plot instance

            let plotMinY = Infinity; // Initialize min Y for this plot
            let plotMaxY = -Infinity; // Initialize max Y for this plot

            config.metrics.forEach(metric => {
                const staticYData = generateStaticData(metric.type, NUM_POINTS_STATIC);
                const line = new WebglLine(metric.color, NUM_POINTS_STATIC);
                line.arrangeX(); // X values are -1 to 1
                for (let i = 0; i < NUM_POINTS_STATIC; i++) {
                    const y = staticYData[i]; // Get y value
                    line.setY(i, y);
                    // Track min/max across all lines in this plot
                    if (isFinite(y)) { // Ensure we only consider valid numbers
                        plotMinY = Math.min(plotMinY, y);
                        plotMaxY = Math.max(plotMaxY, y);
                    }
                }
                wglp.addLine(line);
            });

            // --- Calculate and set Y-axis scale and offset ---
            // Check if we found valid min/max values
            if (isFinite(plotMinY) && isFinite(plotMaxY)) {
                 const dataRangeY = plotMaxY - plotMinY;
                 const padding = dataRangeY === 0 ? 0.1 : dataRangeY * 0.1; // Add 10% padding, handle constant data

                 const finalMinY = plotMinY - padding;
                 const finalMaxY = plotMaxY + padding;
                 const finalRangeY = finalMaxY - finalMinY;

                 if (finalRangeY > 1e-9) { // Avoid division by zero or extremely small range
                     // Calculate scale: map final data range [finalMinY, finalMaxY] to WebGL range [-1, 1]
                     // WebGL_Y = Data_Y * gScaleY + gOffsetY
                     // 1 = finalMaxY * gScaleY + gOffsetY
                     // -1 = finalMinY * gScaleY + gOffsetY
                     // Subtracting: 2 = (finalMaxY - finalMinY) * gScaleY  => gScaleY = 2 / finalRangeY
                     wglp.gScaleY = 2 / finalRangeY;
                     // Calculate offset: gOffsetY = -1 - finalMinY * gScaleY
                     wglp.gOffsetY = -1 - finalMinY * wglp.gScaleY;
                 } else {
                     // Handle constant data or very small range: Center the value
                     wglp.gScaleY = 1; // Use a default scale
                     wglp.gOffsetY = -plotMinY; // Center the constant value (approx)
                 }
            } else {
                 // Default if no valid data found (e.g., all NaN or +/-Infinity)
                 wglp.gScaleY = 1.0;
                 wglp.gOffsetY = 0.0;
            }

            // Set initial X scale to show all data (-1 to 1 maps to viewport width)
            wglp.gScaleX = 1.0;
            wglp.gOffsetX = 0.0;

            // --- Interaction Logic for *this* canvas/wglp ---
            // (Keep the previously added interaction listeners here)
            // ... existing listeners for dblclick, mousedown, mousemove, etc. ...
            let isDragging = false;
            let isZoomingRect = false;
            let dragStartX = 0;
            let dragStartY = 0;
            let plotOffsetXOld = 0;
            let plotOffsetYOld = 0;
            let zoomRectStartX = 0;
            let zoomRectStartY = 0;
            let currentScale = 1; // Reset for each plot

            // Prevent default context menu
            canvas.addEventListener('contextmenu', (e) => e.preventDefault());

            // Double Click: Reset View (Reset scale/offset to calculated initial values)
            canvas.addEventListener('dblclick', (e) => {
                e.preventDefault();

                // Recalculate initial Y scale/offset based on data
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
                // Reset X scale/offset
                wglp.gScaleX = 1.0;
                wglp.gOffsetX = 0.0;

                // Reset internal scale tracker if you use it elsewhere
                currentScale = 1.0;
            });

            // Mouse Down: Start Pan or Zoom Rect
            canvas.addEventListener('mousedown', (e) => {
                e.preventDefault();
                 // Need to store the scale *before* the zoom operation starts
                const plotScaleXOld = wglp.gScaleX;
                const plotScaleYOld = wglp.gScaleY;

                if (e.button === 0) { // Left click (intended for zoom rect)
                    isZoomingRect = true;
                    isDragging = false;
                    zoomRectStartX = (2 * (e.offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
                    zoomRectStartY = (-2 * (e.offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;
                    canvas.style.cursor = 'crosshair';
                } else if (e.button === 2) { // Right click: Pan Start
                    isDragging = true;
                    isZoomingRect = false;
                    dragStartX = e.clientX * devicePixelRatio;
                    dragStartY = e.clientY * devicePixelRatio;
                    plotOffsetXOld = wglp.gOffsetX;
                    plotOffsetYOld = wglp.gOffsetY;
                    canvas.style.cursor = 'grabbing';
                }
            });

             // Mouse Move: Handle Dragging or Zoom Rect Update
            canvas.addEventListener('mousemove', (e) => {
                e.preventDefault();
                if (isDragging) {
                    const moveX = e.clientX * devicePixelRatio - dragStartX;
                    const moveY = e.clientY * devicePixelRatio - dragStartY;
                    const deltaX = (moveX / canvas.width) * 2 / wglp.gScaleX;
                    const deltaY = (-moveY / canvas.height) * 2 / wglp.gScaleY;
                    wglp.gOffsetX = plotOffsetXOld + deltaX;
                    wglp.gOffsetY = plotOffsetYOld + deltaY;
                } else if (isZoomingRect) {
                    canvas.style.cursor = 'crosshair';
                    // Can add visual rectangle drawing here later if needed
                } else {
                     canvas.style.cursor = 'grab';
                }
            });

            // Mouse Up: End Pan or Execute Zoom Rect
            canvas.addEventListener('mouseup', (e) => {
                e.preventDefault();
                if (isDragging) {
                    isDragging = false;
                    canvas.style.cursor = 'grab';
                } else if (isZoomingRect) {
                    isZoomingRect = false;
                    canvas.style.cursor = 'grab';

                    const zoomRectEndX = (2 * (e.offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
                    const zoomRectEndY = (-2 * (e.offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;

                     // Get scale *before* zoom changes, stored on mousedown
                    // Note: We need plotScaleXOld and plotScaleYOld from mousedown scope
                    // This requires restructuring or passing these values.
                    // Simpler approach: access wglp.gScaleX/Y *before* modification below.
                    const scaleXBeforeZoom = wglp.gScaleX;
                    const scaleYBeforeZoom = wglp.gScaleY;


                    // Convert NDC rect coordinates to the plot's internal coordinate system
                    const startPlotX = (zoomRectStartX - wglp.gOffsetX) / scaleXBeforeZoom;
                    const endPlotX = (zoomRectEndX - wglp.gOffsetX) / scaleXBeforeZoom;
                    const startPlotY = (zoomRectStartY - wglp.gOffsetY) / scaleYBeforeZoom;
                    const endPlotY = (zoomRectEndY - wglp.gOffsetY) / scaleYBeforeZoom;


                    const minPlotX = Math.min(startPlotX, endPlotX);
                    const maxPlotX = Math.max(startPlotX, endPlotX);
                    const minPlotY = Math.min(startPlotY, endPlotY);
                    const maxPlotY = Math.max(startPlotY, endPlotY);

                    const centerX = (minPlotX + maxPlotX) / 2;
                    const centerY = (minPlotY + maxPlotY) / 2;
                    const rangeX = Math.abs(maxPlotX - minPlotX); // Use abs just in case
                    const rangeY = Math.abs(maxPlotY - minPlotY);

                    if (rangeX > 1e-9 && rangeY > 1e-9) {
                        // New scale maps the selected range (rangeX/Y) to the full view (2)
                        wglp.gScaleX = 2 / rangeX;
                        wglp.gScaleY = 2 / rangeY;

                        // New offset centers the selected area (centerX/Y) in the view
                        wglp.gOffsetX = -centerX * wglp.gScaleX;
                        wglp.gOffsetY = -centerY * wglp.gScaleY;

                        // Update internal scale tracker based on X zoom approx
                        currentScale *= (wglp.gScaleX / scaleXBeforeZoom);
                        currentScale = Math.max(0.1, currentScale); // Clamp minimum scale
                    }
                     // Prevent accidental tiny zooms from locking up view
                    wglp.gScaleX = Math.max(0.01, wglp.gScaleX);
                    wglp.gScaleY = Math.max(0.01, wglp.gScaleY);
                }
            });

             // Mouse Leave: Ensure dragging/zooming stops if mouse leaves canvas
            canvas.addEventListener('mouseleave', (e) => {
                 if (isDragging || isZoomingRect) {
                     isDragging = false;
                     isZoomingRect = false;
                     canvas.style.cursor = 'grab';
                 }
            });

            // Wheel: Zoom in/out (centered on cursor)
            canvas.addEventListener('wheel', (e) => {
                e.preventDefault();
                const zoomFactor = 1.1;
                const scaleDelta = e.deltaY < 0 ? zoomFactor : 1 / zoomFactor;
                const cursorNDC_X = (2 * (e.offsetX * devicePixelRatio - canvas.width / 2)) / canvas.width;
                const cursorNDC_Y = (-2 * (e.offsetY * devicePixelRatio - canvas.height / 2)) / canvas.height;
                const gScaleXOld = wglp.gScaleX;
                const gScaleYOld = wglp.gScaleY;

                wglp.gScaleX *= scaleDelta;
                wglp.gScaleY *= scaleDelta;
                wglp.gScaleX = Math.max(0.01, wglp.gScaleX); // Prevent excessive zoom out/in
                wglp.gScaleY = Math.max(0.01, wglp.gScaleY);

                wglp.gOffsetX = cursorNDC_X + (wglp.gOffsetX - cursorNDC_X) * (wglp.gScaleX / gScaleXOld);
                wglp.gOffsetY = cursorNDC_Y + (wglp.gOffsetY - cursorNDC_Y) * (wglp.gScaleY / gScaleYOld);

                currentScale *= scaleDelta;
                currentScale = Math.max(0.1, currentScale);
            });

            // --- Touch Events ---
             // (Touch event listeners remain the same as previous correction)
             // ... touchstart, touchmove, touchend ...
             let touchStartX0 = 0, touchStartY0 = 0;
             let touchStartX1 = 0, touchStartY1 = 0;
             let initialTouchDistance = 0;
             let isPinching = false;
             let isTouchPannning = false;
             let touchPanStartX = 0, touchPanStartY = 0;
             // Important: Need to store offset state for touch panning correctly
             let touchPlotOffsetXOld = 0;
             let touchPlotOffsetYOld = 0;

             canvas.addEventListener('touchstart', (e) => {
                 e.preventDefault();
                 if (e.touches.length === 1) { // Start Pan
                      isTouchPannning = true;
                      isPinching = false;
                      const touch = e.touches[0];
                      touchPanStartX = touch.clientX * devicePixelRatio;
                      touchPanStartY = touch.clientY * devicePixelRatio;
                      // Store offset at the START of touch pan
                      touchPlotOffsetXOld = wglp.gOffsetX;
                      touchPlotOffsetYOld = wglp.gOffsetY;
                 } else if (e.touches.length === 2) { // Start Pinch
                      isPinching = true;
                      isTouchPannning = false;
                      const touch0 = e.touches[0];
                      const touch1 = e.touches[1];
                      touchStartX0 = touch0.clientX * devicePixelRatio;
                      touchStartY0 = touch0.clientY * devicePixelRatio;
                      touchStartX1 = touch1.clientX * devicePixelRatio;
                      touchStartY1 = touch1.clientY * devicePixelRatio;
                      initialTouchDistance = Math.hypot(touchStartX1 - touchStartX0, touchStartY1 - touchStartY0);
                      // Store offset at the START of pinch
                      touchPlotOffsetXOld = wglp.gOffsetX;
                      touchPlotOffsetYOld = wglp.gOffsetY;
                 }
             }, { passive: false });

             canvas.addEventListener('touchmove', (e) => {
                 e.preventDefault();
                 if (isTouchPannning && e.touches.length === 1) { // Pan Move
                     const touch = e.touches[0];
                     const moveX = touch.clientX * devicePixelRatio - touchPanStartX;
                     const moveY = touch.clientY * devicePixelRatio - touchPanStartY;
                     // Calculate delta relative to current scale
                     const deltaX = (moveX / canvas.width) * 2 / wglp.gScaleX;
                     const deltaY = (-moveY / canvas.height) * 2 / wglp.gScaleY;
                     // Apply delta to the offset stored at the beginning of the pan
                     wglp.gOffsetX = touchPlotOffsetXOld + deltaX;
                     wglp.gOffsetY = touchPlotOffsetYOld + deltaY;

                 } else if (isPinching && e.touches.length === 2) { // Pinch Move
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

                           // Calculate new scale based on the STARTING scale * delta
                           let newScaleX = gScaleXOld * scaleDelta;
                           let newScaleY = gScaleYOld * scaleDelta;
                           newScaleX = Math.max(0.01, newScaleX); // Clamp
                           newScaleY = Math.max(0.01, newScaleY); // Clamp

                           // Adjust offset based on the offset at START of pinch
                           wglp.gOffsetX = centerNDC_X + (touchPlotOffsetXOld - centerNDC_X) * (newScaleX / gScaleXOld);
                           wglp.gOffsetY = centerNDC_Y + (touchPlotOffsetYOld - centerNDC_Y) * (newScaleY / gScaleYOld);

                           // Apply the new scale *after* calculating offset
                           wglp.gScaleX = newScaleX;
                           wglp.gScaleY = newScaleY;

                           // Update distance for next move calculation (relative change)
                           initialTouchDistance = currentTouchDistance;
                           // Update reference STARTING offset based on current state for next move delta calculation
                           touchPlotOffsetXOld = wglp.gOffsetX;
                           touchPlotOffsetYOld = wglp.gOffsetY;

                      }
                 }
             }, { passive: false });

             canvas.addEventListener('touchend', (e) => {
                  e.preventDefault();
                  if (e.touches.length < 2) {
                      isPinching = false;
                  }
                  if (e.touches.length < 1) {
                      isTouchPannning = false;
                  }
             }, { passive: false });


            // Increment counter and check if all plots are done
            plotsInitializedCount++;
            if (plotsInitializedCount === PLOT_CONFIGS.length) {
                startAnimationLoopIfReady();
            }
        });
    });
}

let animationFrameId = null; // To store the request ID

// --- Function to start the animation loop ---
function startAnimationLoopIfReady() {
     // Check if loop is already running and if all plots are potentially initialized
    if (animationFrameId === null && Object.keys(plots).length > 0) {
         console.log("All plots initialized (or failed), starting animation loop.");
         animationFrameId = requestAnimationFrame(updateDashboard);
    } else if (Object.keys(plots).length === 0 && plotsInitializedCount === PLOT_CONFIGS.length){
         console.warn("No plots were successfully initialized.");
    }
}

// --- Animation Loop (Updates plot transformations) ---
function updateDashboard() {
    for (const plotId in plots) {
        const wglp = plots[plotId];
        if (wglp) {
            wglp.update(); // Apply zoom/pan and redraw
        }
    }
    animationFrameId = requestAnimationFrame(updateDashboard); // Continue the loop
}

// --- Resize Handling (Seems mostly correct) ---
window.addEventListener('resize', () => {
    clearTimeout(window.resizeTimeout);
    window.resizeTimeout = setTimeout(() => {
        console.log("Resizing plots...");
        const devicePixelRatio = window.devicePixelRatio || 1; // Get it once

        for (const plotId in plots) {
            const wglp = plots[plotId];
            if (!wglp) continue;
            const canvas = wglp.canvas; // Get canvas from wglp instance
            if (!canvas) continue;

            const newWidth = canvas.clientWidth;
            const newHeight = canvas.clientHeight;

            if (newWidth > 0 && newHeight > 0) {
                const targetWidth = Math.round(newWidth * devicePixelRatio);
                const targetHeight = Math.round(newHeight * devicePixelRatio);

                // Only resize if needed to avoid unnecessary texture reallocations
                if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
                    canvas.width = targetWidth;
                    canvas.height = targetHeight;
                    // Update the WebGL viewport to match the new canvas dimensions
                    wglp.viewport(0, 0, canvas.width, canvas.height);
                    console.log(`Resized ${plotId} to ${canvas.width}x${canvas.height}`);
                }
            } else {
                console.warn(`Canvas ${plotId} client dimensions are zero during resize.`);
            }
        }
        // No explicit wglp.update() needed here, animation loop handles it.
    }, 250); // Debounce resize event
});

// --- Start Initialization ---
initializePlots();
