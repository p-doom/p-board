// NO import statements for webgl-plot

// Access classes via the WebglPlotBundle global object
// const WebglPlot = WebglPlotBundle.WebglPlot; // You could do this, or just use the full name
// const WebglLine = WebglPlotBundle.WebglLine;
// const ColorRGBA = WebglPlotBundle.ColorRGBA;

const dashboardContainer = document.getElementById('dashboard-container');

// --- Configuration for our plots (Use WebglPlotBundle.ColorRGBA) ---
const MAX_POINTS = 1000;
const PLOT_CONFIGS = [
    {
        id: 'loss-plot',
        title: 'Training Loss',
        metrics: [
            { name: 'train_loss', color: new WebglPlotBundle.ColorRGBA(1, 0.3, 0.3, 1), type: 'decreasing' },
            { name: 'val_loss', color: new WebglPlotBundle.ColorRGBA(1, 0.6, 0.6, 1), type: 'decreasing_noisy' },
        ]
    },
    {
        id: 'accuracy-plot',
        title: 'Accuracy',
        metrics: [
            { name: 'train_acc', color: new WebglPlotBundle.ColorRGBA(0.3, 1, 0.3, 1), type: 'increasing' },
            { name: 'val_acc', color: new WebglPlotBundle.ColorRGBA(0.6, 1, 0.6, 1), type: 'increasing_noisy' },
        ]
    },
    {
        id: 'learning-rate-plot',
        title: 'Learning Rate',
        metrics: [
            { name: 'lr', color: new WebglPlotBundle.ColorRGBA(0.5, 0.5, 1, 1), type: 'step_decay' },
        ]
    },
    {
        id: 'custom-metric-plot',
        title: 'Some Custom Metric',
        metrics: [
            { name: 'metric_a', color: new WebglPlotBundle.ColorRGBA(1, 1, 0.3, 1), type: 'sine_wave' },
            { name: 'metric_b', color: new WebglPlotBundle.ColorRGBA(0.3, 1, 1, 1), type: 'random_walk' },
        ]
    }
];

// --- Store plot instances and lines ---
const plots = {}; // { plotId: { wglp: WebglPlot, lines: { metricName: WebglLine } } }

// --- Dummy Data Generation ---
let step = 0; // Simulate training steps

function generateDummyData(line, type, metricName) {
    const numPoints = line.numPoints;

    // Shift old data to the left
    for (let i = 0; i < numPoints - 1; i++) {
        line.setY(i, line.getY(i + 1));
    }

    // Generate new data point
    let newValue = 0;
    const progress = step / (MAX_POINTS * 2);

    switch (type) {
        case 'decreasing':
            newValue = 0.8 * Math.exp(-progress * 5) + 0.1;
            break;
        case 'decreasing_noisy':
            newValue = 0.8 * Math.exp(-progress * 4) + 0.15 + (Math.random() - 0.5) * 0.1;
            break;
        case 'increasing':
            newValue = 0.9 * (1 - Math.exp(-progress * 5)) + 0.05;
            break;
        case 'increasing_noisy':
            newValue = 0.85 * (1 - Math.exp(-progress * 4)) + 0.1 + (Math.random() - 0.5) * 0.1;
            break;
        case 'step_decay':
            if (step < 500) newValue = 0.001;
            else if (step < 1000) newValue = 0.0005;
            else newValue = 0.0001;
            break;
        case 'sine_wave':
            newValue = 0.5 + 0.3 * Math.sin(step * 0.05);
            break;
        case 'random_walk':
            const prevValue = (step > 0 && line.getY(numPoints - 2)) ? line.getY(numPoints - 2) : 0.5;
            newValue = prevValue + (Math.random() - 0.5) * 0.05;
            newValue = Math.max(0, Math.min(1, newValue));
            break;
        default:
            newValue = Math.random();
    }

    newValue += (Math.random() - 0.5) * 0.01;
    newValue = Math.max(-0.1, Math.min(1.1, newValue));

    line.setY(numPoints - 1, newValue);
}

// --- Initialization (Use WebglPlotBundle.*) ---
function initializePlots() {
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
                return;
            }

            // Use WebglPlotBundle.WebglPlot
            const wglp = new WebglPlotBundle.WebglPlot(canvas);
            plots[config.id] = { wglp: wglp, lines: {} };

            config.metrics.forEach(metric => {
                // Use WebglPlotBundle.WebglLine
                const line = new WebglPlotBundle.WebglLine(metric.color, MAX_POINTS);
                line.arrangeX();

                for (let i = 0; i < line.numPoints; i++) {
                    line.setY(i, 0.1 + Math.random() * 0.05);
                }

                wglp.addLine(line);
                plots[config.id].lines[metric.name] = { line: line, type: metric.type };
            });
        });
    });
}

// --- Animation Loop ---
function updateDashboard() {
    step++;
    for (const plotId in plots) {
        const plotData = plots[plotId];
        if (!plotData || !plotData.wglp) continue;
        for (const metricName in plotData.lines) {
            const lineData = plotData.lines[metricName];
            generateDummyData(lineData.line, lineData.type, metricName);
        }
        plotData.wglp.update();
    }
    requestAnimationFrame(updateDashboard);
}

// --- Start ---
initializePlots();
setTimeout(() => {
    requestAnimationFrame(updateDashboard);
}, 100); // Delay slightly for canvases to get dimensions

// Optional: Handle window resize
window.addEventListener('resize', () => {
    clearTimeout(window.resizeTimeout);
    window.resizeTimeout = setTimeout(() => {
        console.log("Resizing plots...");
        for (const plotId in plots) {
             const plotData = plots[plotId];
             if (!plotData || !plotData.wglp) continue;
             const canvas = plotData.wglp.canvas;
             const devicePixelRatio = window.devicePixelRatio || 1;
             const newWidth = canvas.clientWidth;
             const newHeight = canvas.clientHeight;
             if(newWidth > 0 && newHeight > 0) {
                canvas.width = newWidth * devicePixelRatio;
                canvas.height = newHeight * devicePixelRatio;
                plotData.wglp.viewport(0, 0, canvas.width, canvas.height);
                plotData.wglp.update();
             } else {
                 console.warn(`Canvas ${plotId} client dimensions are zero during resize.`);
             }
        }
    }, 250);
});
