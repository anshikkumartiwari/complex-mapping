// Remove any canvas declarations at the top and use the ones from script.js

// Math scope for function evaluation
const mathScope = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    exp: Math.exp,
    log: Math.log,
    pi: Math.PI,
    e: Math.E,
    i: Complex.I
};

function plotParametric() {
    const funcStr = document.getElementById('plotFunction').value;
    const points = generatePoints(funcStr);
    if (points && points.length > 0) {
        drawPoints(points);
    }
}

// Add drawGrid function if it's not defined elsewhere
function drawGrid(ctx, canvas) {
    const width = canvas.width;
    const height = canvas.height;
    
    ctx.beginPath();
    ctx.strokeStyle = "#CCCCCC";
    
    // Draw vertical lines
    for (let x = 0; x <= width; x += width/20) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
    }
    
    // Draw horizontal lines
    for (let y = 0; y <= height; y += height/20) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
    }
    
    ctx.stroke();
    
    // Draw axes
    ctx.beginPath();
    ctx.strokeStyle = "#000000";
    
    // x-axis
    ctx.moveTo(0, height/2);
    ctx.lineTo(width, height/2);
    
    // y-axis
    ctx.moveTo(width/2, 0);
    ctx.lineTo(width/2, height);
    
    ctx.stroke();
}

// Add scope definition outside of generatePoints for reuse
const mathScope = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    exp: Math.exp,
    log: Math.log,
    pi: Math.PI,
    e: Math.E,
    i: Complex.I
};

function plotParametric() {
    // Ensure canvases are initialized
    if (!zCtx || !wCtx) {
        console.error('Canvas contexts not initialized');
        return;
    }

    const funcStr = document.getElementById('plotFunction').value;
    const points = generatePoints(funcStr);
    if (points.length > 0) {
        drawPoints(points);
    }
}

function generatePoints(funcStr) {
    const points = [];
    // Generate 1000 points for smooth plotting
    for (let t = -10; t <= 10; t += 0.02) {
        try {
            // Create a safe evaluation context
            const scope = { ...mathScope, t: t };
            
            // Replace i with Complex.I for complex number support
            const modifiedFunc = funcStr
                .replace(/\bi\b/g, 'Complex.I')
                .replace('t', 'this.t');

            // Evaluate the function string
            const result = new Function('return ' + modifiedFunc)
                .call(scope);
            
            // Convert to complex number if needed
            const point = typeof result === 'number' ? 
                new Complex(result, 0) : 
                result instanceof Complex ? result :
                new Complex(result.re || 0, result.im || 0);
                
            points.push(point);
        } catch (e) {
            console.error('Error evaluating function:', e);
            return [];
        }
    }
    return points;
}

function drawPoints(points) {
    // Clear existing drawing
    zCtx.clearRect(0, 0, zCanvas.width, zCanvas.height);
    drawGrid(zCtx, zCanvas);
    
    // Draw the points
    zCtx.beginPath();
    zCtx.strokeStyle = currentColor || '#FF0000'; // Fallback to red if currentColor not set
    zCtx.lineWidth = 2;
    
    let first = true;
    points.forEach(point => {
        const coords = toScreenCoordinates(point, zCanvas, 
            parseFloat(document.getElementById('ZMINX').value),
            parseFloat(document.getElementById('ZMAXX').value),
            parseFloat(document.getElementById('ZMINY').value),
            parseFloat(document.getElementById('ZMAXY').value)
        );
        
        if (first) {
            zCtx.moveTo(coords.x, coords.y);
            first = false;
        } else {
            zCtx.lineTo(coords.x, coords.y);
        }
    });
    
    zCtx.stroke();
    
    // Map the points to w-plane
    mapPoints(points);
}

function mapPoints(points) {
    // Clear w-plane
    wCtx.clearRect(0, 0, wCanvas.width, wCanvas.height);
    drawGrid(wCtx, wCanvas);
    
    // Map and draw points
    wCtx.beginPath();
    wCtx.strokeStyle = currentColor || '#FF0000';
    wCtx.lineWidth = 2;
    
    let first = true;
    points.forEach(point => {
        const mapped = evaluateFunction(point);
        const coords = toScreenCoordinates(mapped, wCanvas,
            parseFloat(document.getElementById('WMINX').value),
            parseFloat(document.getElementById('WMAXX').value),
            parseFloat(document.getElementById('WMINY').value),
            parseFloat(document.getElementById('WMAXY').value)
        );
        
        if (first) {
            wCtx.moveTo(coords.x, coords.y);
            first = false;
        } else {
            wCtx.lineTo(coords.x, coords.y);
        }
    });
    
    wCtx.stroke();
}
function plotZFunctionOnChange() {
    var input = document.getElementById("plotZFunction").value;
    // If the field is empty, just clear the canvas.
    if (input.trim() === "") {
        clearCanvas();
        return;
    }
    
    // Try parsing the function (using the same Complex.parseFunction you use for mapping).
    var func;
    try {
        func = Complex.parseFunction(input, ['z']);
    } catch (err) {
        // If parsing fails, you might want to notify the user (or simply do nothing).
        // Here we simply return.
        return;
    }
    
    // Clear the current drawing so the function plot appears by itself.
    clearCanvas();
    
    // Decide on a number of sample points. Here we sample once per pixel in width.
    var numPoints = zCanvas.width;
    
    // Sample along the real axis in the z-plane.
    for (var i = 0; i <= numPoints; i++) {
        // t ranges from Z_MIN_X to Z_MAX_X.
        var t = Z_MIN_X + (i / numPoints) * (Z_MAX_X - Z_MIN_X);
        
        // Use t as the real part and 0 as the imaginary part.
        var zVal = Complex(t, 0);
        
        // Evaluate the user-defined function.
        var result = func(zVal);
        
        // Interpret the result’s real and imaginary parts as a point in the z-plane.
        // (This means the plotted curve is the image of the real axis under the function.)
        var realPart = result.real();
        var imagPart = result.imag();
        
        // Convert the complex coordinates to canvas coordinates.
        var canvasX = ((realPart - Z_MIN_X) / (Z_MAX_X - Z_MIN_X)) * zCanvas.width;
        var canvasY = (1 - ((imagPart - Z_MIN_Y) / (Z_MAX_Y - Z_MIN_Y))) * zCanvas.height;
        
        // Add the point to the drawing arrays.
        // For the first point, dragging is false; then true for subsequent points.
        addClick(canvasX, canvasY, i > 0);
    }
    
    // Redraw the zCanvas (and the corresponding wPlane mapping will update automatically).
    redraw();
}
