/* ============================================================
   COMPLEX MAPPING VISUALIZER — js/script.js
   
   Architecture:
   - math.js  : complex evaluation & parsing
   - MathQuill: equation input (LaTeX-based)
   - KaTeX    : live equation preview
   - Pointer Events API: unified mouse/touch drawing

   z-plane (left): freehand draw OR typed equations y=f(x) / z(t)
   w-plane (right): always shows w = f(z) mapping of z-plane content
   ============================================================ */
'use strict';

// ============================================================
// CONSTANTS & CONFIG
// ============================================================
const COLORS = [
  '#0371bb','#03dac6','#f9a825','#cf6679',
  '#81c784','#64b5f6','#ff8a65','#4dd0e1',
];
let _colorIdx = 0;
const nextColor = () => COLORS[_colorIdx++ % COLORS.length];

// ============================================================
// STATE
// ============================================================
const S = {
  // Mapping function (w-plane side)
  mappingLatex   : 'e^{z}',
  mappingExpr    : 'exp(z)',
  mappingCompiled: null,
  mappingVisible : true, // checked by default

  // z-plane equations list
  equations: [],     // [{id, type, latex, expr, tMin, tMax, color, visible, zPx, wPx, zCx}]
  eqCounter : 0,

  // Freehand strokes
  strokes    : [],   // [{zPx, zCx, wPx, color, width}]
  curStroke  : null,
  isDrawing  : false,

  // Grid
  gridOn   : false,
  gridLines: [],     // [{zPx, wPx, zCx, color}]
  gridN    : 10,

  // Coordinate ranges
  zRange: { xMin:-2, xMax:2, yMin:-2, yMax:2 },
  wRange: { xMin:-2, xMax:2, yMin:-2, yMax:2 },

  // Visual
  color      : '#0371bb',
  strokeW    : 3,
  bct        : 10,   // branch-cut threshold
  paramRes   : 500,  // parametric sample resolution

  // Undo
  undoStack: [],

  // Active MQ field id ('mapping' or equation id)
  activeField: 'mapping',

  // Canvas logical sizes (CSS pixels, not physical)
  cW: 400, cH: 400,
};

// ============================================================
// CANVAS SETUP
// ============================================================
let zCanvas, zCtx, wCanvas, wCtx;

function setupCanvas(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return ctx;
}

function computeCanvasSize() {
  // Dynamically compute canvas square size from available space
  const panel = document.getElementById('zCanvasPanel');
  const pw = panel ? panel.clientWidth  : 400;
  const ph = panel ? panel.clientHeight : 400;
  // Leave padding/label space
  const s = Math.max(200, Math.min(600, Math.min(pw - 28, ph - 60)));
  S.cW = s; S.cH = s;
}

function initCanvases() {
  zCanvas = document.getElementById('zCanvas');
  wCanvas = document.getElementById('wCanvas');

  computeCanvasSize();
  zCtx = setupCanvas(zCanvas, S.cW, S.cH);
  wCtx = setupCanvas(wCanvas, S.cW, S.cH);

  // Size the wrapper divs
  const zWrap = document.getElementById('zCanvasWrap');
  const wWrap = document.getElementById('wCanvasWrap');
  if (zWrap) { zWrap.style.width = S.cW+'px'; zWrap.style.height = S.cH+'px'; }
  if (wWrap) { wWrap.style.width = S.cW+'px'; wWrap.style.height = S.cH+'px'; }

  // Pointer events for freehand drawing on z-canvas
  zCanvas.addEventListener('pointerdown', onPtrDown,  { passive: false });
  zCanvas.addEventListener('pointermove', onPtrMove,  { passive: false });
  zCanvas.addEventListener('pointerup',   onPtrEnd);
  zCanvas.addEventListener('pointerleave',onPtrEnd);

  // Coordinate tooltips
  zCanvas.addEventListener('mousemove', onZMouseMove);
  wCanvas.addEventListener('mousemove', onWMouseMove);

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    if (e.key === 'Enter') {
      const inMQ = document.activeElement?.closest?.('.mq-editable-field');
      if (inMQ) applyMapping();
    }
  });

  // Resize
  window.addEventListener('resize', () => {
    computeCanvasSize();
    zCtx = setupCanvas(zCanvas, S.cW, S.cH);
    wCtx = setupCanvas(wCanvas, S.cW, S.cH);
    const zWrap2 = document.getElementById('zCanvasWrap');
    const wWrap2 = document.getElementById('wCanvasWrap');
    if (zWrap2) { zWrap2.style.width = S.cW+'px'; zWrap2.style.height = S.cH+'px'; }
    if (wWrap2) { wWrap2.style.width = S.cW+'px'; wWrap2.style.height = S.cH+'px'; }
    // Recompute all pixel positions since canvas size changed
    for (const eq of S.equations) recomputeEqPixels(eq);
    for (const st of S.strokes)   recomputeStrokePixels(st);
    if (S.gridOn) computeGrid();
    redraw();
  });
}

// ============================================================
// COORDINATE CONVERSION
// ============================================================
function cx2zPx(re, im) {
  // complex → z-canvas CSS pixel
  const r = S.zRange;
  return {
    x: ((re - r.xMin) / (r.xMax - r.xMin)) * S.cW,
    y: (1 - (im - r.yMin) / (r.yMax - r.yMin)) * S.cH,
  };
}
function cx2wPx(re, im) {
  // complex → w-canvas CSS pixel
  const r = S.wRange;
  return {
    x: ((re - r.xMin) / (r.xMax - r.xMin)) * S.cW,
    y: (1 - (im - r.yMin) / (r.yMax - r.yMin)) * S.cH,
  };
}
function zPx2cx(px, py) {
  // z-canvas CSS pixel → complex
  const r = S.zRange;
  return math.complex(
    r.xMin + (px / S.cW) * (r.xMax - r.xMin),
    r.yMin + (1 - py / S.cH) * (r.yMax - r.yMin),
  );
}
function canvasPos(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (S.cW / rect.width),
    y: (e.clientY - rect.top)  * (S.cH / rect.height),
  };
}

// ============================================================
// LATEX → MATH.JS EXPRESSION TRANSLATOR
// ============================================================
function latexToExpr(latex) {
  let s = latex.trim();

  // Strip leading assignment prefixes (e.g. w =, f(z) =, y =, z(t) =) both plain and LaTeX
  s = s.replace(/^(?:w|f\s*\(\s*z\s*\)|y|f\s*\(\s*x\s*\)|z\s*\(\s*t\s*\))\s*=\s*/i, '');
  s = s.replace(/^(?:f\\left\(\s*z\s*\\right\)|f\\left\(\s*x\s*\\right\)|z\\left\(\s*t\s*\\right\))\s*=\s*/i, '');

  // MathQuill delimiters
  s = s.replace(/\\left\s*\(/g,'(').replace(/\\right\s*\)/g,')');
  s = s.replace(/\\left\s*\[/g,'(').replace(/\\right\s*\]/g,')');
  s = s.replace(/\\left\s*\|/g,'abs(').replace(/\\right\s*\|/g,')');
  s = s.replace(/\\left\s*\\{/g,'(').replace(/\\right\s*\\}/g,')');
  s = s.replace(/\\left\s*\./g,'').replace(/\\right\s*\./g,'');

  // Fractions before anything else
  s = convertFracs(s);

  // \sqrt{...} → sqrt(...)
  s = s.replace(/\\sqrt\{([^}]+)\}/g, (_,x) => `sqrt(${x})`);
  s = s.replace(/\\sqrt\s*([a-zA-Z0-9])/g, (_,x) => `sqrt(${x})`);

  // e^{...} → exp(...) before general superscript
  s = s.replace(/e\^\{([^}]*)\}/g, (_,x) => `exp(${latexToExpr(x)})`);
  s = s.replace(/e\^([a-zA-Z0-9])/g, (_,x) => `exp(${x})`);

  // Superscripts: ^{n} → ^(n)
  s = s.replace(/\^\{([^}]*)\}/g, (_,x) => `^(${x})`);

  // Subscripts: remove
  s = s.replace(/_{[^}]*}/g,'').replace(/_[a-zA-Z0-9]/g,'');

  // Greek letters / constants
  s = s.replace(/\\pi\b/g,'pi');
  s = s.replace(/\\theta\b/g,'theta');
  s = s.replace(/\\alpha\b/g,'alpha');
  s = s.replace(/\\beta\b/g,'beta');
  s = s.replace(/\\infty\b/g,'Infinity');

  // Named functions (longer names first to avoid partial match)
  [
    ['\\arcsin','asin'],['\\arccos','acos'],['\\arctan','atan'],
    ['\\sinh','sinh'],['\\cosh','cosh'],['\\tanh','tanh'],
    ['\\coth','coth'],['\\csch','csch'],['\\sech','sech'],
    ['\\sin','sin'],['\\cos','cos'],['\\tan','tan'],
    ['\\cot','cot'],['\\sec','sec'],['\\csc','csc'],
    ['\\exp','exp'],['\\ln','log'],['\\log','log'],
    ['\\sqrt','sqrt'],['\\abs','abs'],['\\arg','arg'],
    ['\\Re','re'],['\\Im','im'],
    ['\\Gamma','gamma'],['\\erf','erf'],
  ].forEach(([k,v]) => {
    // Only replace if followed by ( or space or letter (not inside another word)
    s = s.replace(new RegExp(escRx(k)+'(?=[\\s(a-zA-Z0-9]|$)','g'), v);
  });

  // Conjugate notations
  s = s.replace(/\\bar\{([^}]+)\}/g, (_,x) => `conj(${x})`);
  s = s.replace(/\\overline\{([^}]+)\}/g, (_,x) => `conj(${x})`);

  // Operators
  s = s.replace(/\\cdot/g,'*').replace(/\\times/g,'*').replace(/\\div/g,'/');

  // Remove unknown LaTeX commands
  s = s.replace(/\\[a-zA-Z]+/g,'');

  // Remaining braces
  s = s.replace(/\{/g,'(').replace(/\}/g,')');

  // Implicit multiplication: 2z → 2*z, 2i → 2*i, iz → i*z
  s = s.replace(/(\d+(?:\.\d*)?)\s*([a-df-wyzA-Z])/g, '$1*$2'); // 2z, 2pi, 2t
  s = s.replace(/\bi\s*([a-hj-z])/g, 'i*$1');                   // iz → i*z, it → i*t
  s = s.replace(/([a-hj-z])\s*i\b/g, '$1*i');                   // zi → z*i

  return s.replace(/\s+/g,' ').trim();
}

function escRx(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}

function convertFracs(s) {
  // Replace \frac{num}{den} with (num)/(den) recursively
  let result = '', i = 0;
  while (i < s.length) {
    const fi = s.indexOf('\\frac', i);
    if (fi === -1) { result += s.slice(i); break; }
    result += s.slice(i, fi);
    let j = fi + 5;
    while (j < s.length && s[j] === ' ') j++;
    if (j >= s.length || s[j] !== '{') { result += s.slice(fi, j); i = j; continue; }
    const [num, j2] = extractBrace(s, j);
    let k = j2;
    while (k < s.length && s[k] === ' ') k++;
    if (k >= s.length || s[k] !== '{') { result += `(${convertFracs(num)})/`; i = j2; continue; }
    const [den, k2] = extractBrace(s, k);
    result += `(${convertFracs(num)})/(${convertFracs(den)})`;
    i = k2;
  }
  return result;
}

function extractBrace(s, start) {
  // start points to '{'. Returns [content, indexAfterClosingBrace].
  let depth = 0, content = '', i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === '{') { depth++; if (depth > 1) content += c; }
    else if (c === '}') { depth--; if (depth === 0) return [content, i+1]; content += c; }
    else content += c;
    i++;
  }
  return [content, i];
}

// ============================================================
// MATH EVALUATION (using math.js)
// ============================================================
const BASE_SCOPE = () => ({
  i  : math.complex(0,1),
  pi : Math.PI,
  e  : Math.E,
});

function compileExpr(expr) {
  try {
    const c = math.compile(expr);
    // Validate by doing a test evaluation
    c.evaluate({ ...BASE_SCOPE(), z: math.complex(1,1), t: 0, x: 0 });
    return c;
  } catch { return null; }
}

function evalMapping(zc) {
  if (!S.mappingCompiled) return zc;
  try {
    const r = S.mappingCompiled.evaluate({ ...BASE_SCOPE(), z: zc });
    return toComplex(r);
  } catch { return null; }
}

function toComplex(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return math.complex(v, 0);
  if (v.type === 'Complex' || (typeof v.re === 'number')) return math.complex(v.re, v.im);
  try { return math.complex(math.number(v), 0); } catch { return null; }
}

function isOk(c) {
  return c && isFinite(c.re) && isFinite(c.im);
}

// ============================================================
// DRAWING UTILITIES
// ============================================================
function clearCtx(ctx) {
  ctx.clearRect(0, 0, S.cW, S.cH);
}

function getThemeColors() {
  const isDark = document.body.classList.contains('dark-theme');
  return {
    axis: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.15)',
    tick: isDark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.08)',
    text: isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.5)',
    grid: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.12)',
  };
}

function drawAxes(ctx, ranges) {
  const { xMin, xMax, yMin, yMax } = ranges;
  const W = S.cW, H = S.cH;
  const tc = getThemeColors();

  ctx.save();
  ctx.strokeStyle = tc.axis;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);

  // Horizontal axis
  const yZ = (1 - (0 - yMin)/(yMax - yMin)) * H;
  if (yZ >= 0 && yZ <= H) {
    ctx.beginPath(); ctx.moveTo(0, yZ); ctx.lineTo(W, yZ); ctx.stroke();
  }
  // Vertical axis
  const xZ = ((0 - xMin)/(xMax - xMin)) * W;
  if (xZ >= 0 && xZ <= W) {
    ctx.beginPath(); ctx.moveTo(xZ, 0); ctx.lineTo(xZ, H); ctx.stroke();
  }

  // Tick marks + labels
  ctx.strokeStyle = tc.tick;
  ctx.fillStyle   = tc.text;
  ctx.font = '9px Fira Code, monospace';

  const xStep = tickStep(xMax - xMin);
  ctx.textAlign = 'center';
  for (let v = Math.ceil(xMin/xStep)*xStep; v <= xMax + 1e-9; v += xStep) {
    if (Math.abs(v) < xStep*0.01) continue;
    const px = ((v - xMin)/(xMax - xMin))*W;
    const py = Math.min(Math.max(yZ, 4), H - 12);
    ctx.beginPath(); ctx.moveTo(px, py-3); ctx.lineTo(px, py+3); ctx.stroke();
    ctx.fillText(fmtTick(v), px, py+11);
  }

  const yStep = tickStep(yMax - yMin);
  ctx.textAlign = 'right';
  for (let v = Math.ceil(yMin/yStep)*yStep; v <= yMax + 1e-9; v += yStep) {
    if (Math.abs(v) < yStep*0.01) continue;
    const py = (1 - (v - yMin)/(yMax - yMin))*H;
    const px = Math.min(Math.max(xZ, 4), W - 4);
    ctx.beginPath(); ctx.moveTo(px-3, py); ctx.lineTo(px+3, py); ctx.stroke();
    ctx.fillText(fmtTick(v)+'i', px-5, py+3);
  }

  ctx.restore();
}

function tickStep(range) {
  const r = range / 6;
  const m = Math.pow(10, Math.floor(Math.log10(r)));
  const n = r / m;
  if (n < 1.5) return m;
  if (n < 3.5) return 2*m;
  if (n < 7.5) return 5*m;
  return 10*m;
}

function fmtTick(v) {
  if (Math.abs(v) < 1e-10) return '0';
  if (Math.abs(v) >= 100 || Number.isInteger(v*10)) return parseFloat(v.toPrecision(3)).toString();
  return parseFloat(v.toPrecision(2)).toString();
}

/**
 * Draw a curve (array of {x,y} or null for gaps) on a canvas context.
 */
function drawCurve(ctx, pts, color, width) {
  if (!pts || pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = width;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  ctx.beginPath();
  let started = false;
  for (const p of pts) {
    if (!p || !isFinite(p.x) || !isFinite(p.y)) { started = false; continue; }
    if (!started) { ctx.moveTo(p.x, p.y); started = true; }
    else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw mapped curve on w-canvas with branch cut detection.
 */
function drawMappedCurve(ctx, zPts, wPts, color, width) {
  if (!wPts || wPts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = width;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < wPts.length; i++) {
    const wp = wPts[i];
    const zp = zPts[i];
    if (!wp || !isFinite(wp.x) || !isFinite(wp.y)) { started = false; continue; }
    if (!started) { ctx.moveTo(wp.x, wp.y); started = true; continue; }
    const prevWp = wPts[i-1];
    const prevZp = zPts[i-1];
    if (prevWp && prevZp && zp) {
      const wDist = Math.hypot(wp.x - prevWp.x, wp.y - prevWp.y);
      const zDist = Math.hypot(zp.x - prevZp.x, zp.y - prevZp.y);
      if (zDist > 0.001 && wDist / zDist > S.bct) {
        ctx.moveTo(wp.x, wp.y); // branch cut — lift pen
        continue;
      }
    }
    ctx.lineTo(wp.x, wp.y);
  }
  ctx.stroke();
  ctx.restore();
}

// ============================================================
// EQUATION POINT COMPUTATION
// ============================================================
function computeEqPoints(eq) {
  eq.zPx = []; eq.wPx = []; eq.zCx = [];
  if (!eq.visible || !eq.expr) return;

  let compiled;
  try { compiled = math.compile(eq.expr); } catch { return; }

  const scope  = BASE_SCOPE();
  const r      = S.zRange;
  const res    = S.paramRes;

  if (eq.type === 'real') {
    // y = f(x): sample x, compute y as real part
    for (let n = 0; n <= res; n++) {
      const x = r.xMin + (n/res)*(r.xMax - r.xMin);
      try {
        const v = compiled.evaluate({ ...scope, x });
        const y = typeof v === 'number' ? v : (v && typeof v.re === 'number' ? v.re : NaN);
        if (!isFinite(y)) { eq.zPx.push(null); eq.zCx.push(null); eq.wPx.push(null); continue; }
        const zc = math.complex(x, y);
        const zp = cx2zPx(x, y);
        const wc = evalMapping(zc);
        eq.zCx.push(zc);
        eq.zPx.push(zp);
        eq.wPx.push((wc && isOk(wc)) ? cx2wPx(wc.re, wc.im) : null);
      } catch { eq.zPx.push(null); eq.zCx.push(null); eq.wPx.push(null); }
    }
  } else {
    // z(t): complex parametric
    const tMin = eq.tMin ?? 0;
    const tMax = eq.tMax ?? Math.PI*2;
    for (let n = 0; n <= res; n++) {
      const t = tMin + (n/res)*(tMax - tMin);
      try {
        const v  = compiled.evaluate({ ...scope, t });
        const zc = toComplex(v);
        if (!zc || !isOk(zc)) { eq.zPx.push(null); eq.zCx.push(null); eq.wPx.push(null); continue; }
        const zp = cx2zPx(zc.re, zc.im);
        const wc = evalMapping(zc);
        eq.zCx.push(zc);
        eq.zPx.push(zp);
        eq.wPx.push((wc && isOk(wc)) ? cx2wPx(wc.re, wc.im) : null);
      } catch { eq.zPx.push(null); eq.zCx.push(null); eq.wPx.push(null); }
    }
  }
}

function recomputeEqPixels(eq) {
  // Recompute ONLY pixel coords from stored zCx (after canvas resize or range change)
  if (!eq.zCx) return;
  eq.zPx = eq.zCx.map(zc => zc ? cx2zPx(zc.re, zc.im) : null);
  eq.wPx = eq.zCx.map(zc => {
    if (!zc) return null;
    const wc = evalMapping(zc);
    return (wc && isOk(wc)) ? cx2wPx(wc.re, wc.im) : null;
  });
}

function remapAllEqs() {
  for (const eq of S.equations) {
    if (!eq.zCx) continue;
    eq.wPx = eq.zCx.map(zc => {
      if (!zc) return null;
      const wc = evalMapping(zc);
      return (wc && isOk(wc)) ? cx2wPx(wc.re, wc.im) : null;
    });
  }
}

function recomputeStrokePixels(st) {
  st.zPx = st.zCx.map(zc => zc ? cx2zPx(zc.re, zc.im) : null);
  st.wPx = st.zCx.map(zc => {
    if (!zc) return null;
    const wc = evalMapping(zc);
    return (wc && isOk(wc)) ? cx2wPx(wc.re, wc.im) : null;
  });
}

function remapAllStrokes() {
  for (const st of S.strokes) {
    st.wPx = st.zCx.map(zc => {
      if (!zc) return null;
      const wc = evalMapping(zc);
      return (wc && isOk(wc)) ? cx2wPx(wc.re, wc.im) : null;
    });
  }
}

// ============================================================
// GRID
// ============================================================
function computeGrid() {
  S.gridLines = [];
  const r   = S.zRange;
  const N   = S.gridN;
  const res = Math.max(S.paramRes, 300);
  const col = getThemeColors().grid;

  const makeLine = (pts) => {
    const zCx = pts;
    const zPx = zCx.map(zc => zc ? cx2zPx(zc.re, zc.im) : null);
    const wPx = zCx.map(zc => {
      if (!zc) return null;
      const wc = evalMapping(zc);
      return (wc && isOk(wc)) ? cx2wPx(wc.re, wc.im) : null;
    });
    S.gridLines.push({ zCx, zPx, wPx, color: col });
  };

  // Horizontal lines (const imaginary part)
  for (let j = 0; j <= N; j++) {
    const im = r.yMin + (j/N)*(r.yMax - r.yMin);
    const pts = [];
    for (let k = 0; k <= res; k++) {
      pts.push(math.complex(r.xMin + (k/res)*(r.xMax - r.xMin), im));
    }
    makeLine(pts);
  }
  // Vertical lines (const real part)
  for (let j = 0; j <= N; j++) {
    const re = r.xMin + (j/N)*(r.xMax - r.xMin);
    const pts = [];
    for (let k = 0; k <= res; k++) {
      pts.push(math.complex(re, r.yMin + (k/res)*(r.yMax - r.yMin)));
    }
    makeLine(pts);
  }
}

function remapGrid() {
  for (const gl of S.gridLines) {
    gl.wPx = gl.zCx.map(zc => {
      if (!zc) return null;
      const wc = evalMapping(zc);
      return (wc && isOk(wc)) ? cx2wPx(wc.re, wc.im) : null;
    });
  }
}

function toggleGrid() {
  S.gridOn = !S.gridOn;
  const btn = document.getElementById('drawGridBtn');
  if (S.gridOn) {
    btn.classList.add('btn-accent');
    computeGrid();
  } else {
    btn.classList.remove('btn-accent');
    S.gridLines = [];
  }
  redraw();
}

// ============================================================
// FULL REDRAW
// ============================================================
function redraw() {
  clearCtx(zCtx); clearCtx(wCtx);
  drawAxes(zCtx, S.zRange);
  drawAxes(wCtx, S.wRange);

  const sw = S.strokeW;

  // Grid
  for (const gl of S.gridLines) {
    drawCurve(zCtx, gl.zPx, gl.color, 0.75);
    if (S.mappingVisible) {
      drawMappedCurve(wCtx, gl.zPx, gl.wPx, gl.color, 0.75);
    }
  }
  // Equations
  for (const eq of S.equations) {
    if (!eq.visible) continue;
    drawCurve(zCtx, eq.zPx, eq.color, sw);
    if (S.mappingVisible) {
      drawMappedCurve(wCtx, eq.zPx, eq.wPx, eq.color, sw);
    }
  }
  // Freehand strokes
  for (const st of S.strokes) {
    drawCurve(zCtx, st.zPx, st.color, st.width);
    if (S.mappingVisible) {
      drawMappedCurve(wCtx, st.zPx, st.wPx, st.color, st.width);
    }
  }
  // In-progress stroke
  if (S.curStroke) {
    drawCurve(zCtx, S.curStroke.zPx, S.curStroke.color, S.curStroke.width);
    if (S.mappingVisible) {
      drawMappedCurve(wCtx, S.curStroke.zPx, S.curStroke.wPx, S.curStroke.color, S.curStroke.width);
    }
  }
}

// ============================================================
// FREEHAND DRAWING (Pointer Events)
// ============================================================
function onPtrDown(e) {
  e.preventDefault();
  zCanvas.setPointerCapture(e.pointerId);
  S.isDrawing = true;
  saveUndo();

  const pos = canvasPos(zCanvas, e);
  const zc  = zPx2cx(pos.x, pos.y);
  const wc  = evalMapping(zc);
  S.curStroke = {
    zPx: [pos], zCx: [zc],
    wPx: [(wc && isOk(wc)) ? cx2wPx(wc.re, wc.im) : null],
    color: S.color, width: S.strokeW,
  };
  document.getElementById('zCanvasWrap').classList.add('is-drawing');
  redraw();
}

function onPtrMove(e) {
  if (!S.isDrawing || !S.curStroke) return;
  e.preventDefault();
  const pos = canvasPos(zCanvas, e);
  const zc  = zPx2cx(pos.x, pos.y);
  const wc  = evalMapping(zc);
  S.curStroke.zPx.push(pos);
  S.curStroke.zCx.push(zc);
  S.curStroke.wPx.push((wc && isOk(wc)) ? cx2wPx(wc.re, wc.im) : null);
  redraw();
}

function onPtrEnd() {
  if (!S.isDrawing) return;
  S.isDrawing = false;
  if (S.curStroke && S.curStroke.zPx.length > 1) {
    S.strokes.push(S.curStroke);
  }
  S.curStroke = null;
  document.getElementById('zCanvasWrap').classList.remove('is-drawing');
  redraw();
}

// ============================================================
// COORDINATE TOOLTIPS
// ============================================================
function onZMouseMove(e) {
  const pos = canvasPos(zCanvas, e);
  const zc  = zPx2cx(pos.x, pos.y);
  document.getElementById('zCoordTip').textContent =
    `z = ${fmt(zc.re)} ${zc.im >= 0 ? '+' : '−'} ${fmt(Math.abs(zc.im))}i`;
}
function onWMouseMove(e) {
  const rect = wCanvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (S.cW / rect.width);
  const py = (e.clientY - rect.top)  * (S.cH / rect.height);
  const r  = S.wRange;
  const re = r.xMin + (px/S.cW)*(r.xMax - r.xMin);
  const im = r.yMin + (1 - py/S.cH)*(r.yMax - r.yMin);
  document.getElementById('wCoordTip').textContent =
    `w = ${fmt(re)} ${im >= 0 ? '+' : '−'} ${fmt(Math.abs(im))}i`;
}
function fmt(v) { return parseFloat(v.toFixed(3)).toString(); }

// ============================================================
// MAPPING FUNCTION
// ============================================================
let mqInstances = {};
let MQ;

function initMQ() {
  MQ = MathQuill.getInterface(2);
  const mqEl = document.getElementById('mqMapping');
  const mqObj = MQ.MathField(mqEl, {
    spaceBehavesLikeTab: false,
    supSubsRequireOperand: false,
    autoCommands: 'pi theta sqrt',
    autoOperatorNames: 'arg conj Re Im gamma erf abs',
    handlers: {
      edit: () => {
        updateMappingPreview(mqObj.latex());
        S.activeField = 'mapping';
      },
      enter: () => applyMapping(),
    },
  });
  mqInstances['mapping'] = mqObj;
  mqObj.latex('e^{z}');
  updateMappingPreview('e^{z}');

  // Programmatic click focus helpers for MathQuill fields
  $(document).on('click', '.mq-wrapper', function() {
    const mq = mqInstances['mapping'];
    if (mq) mq.focus();
  });
  $(document).on('click', '.w-equation-wrap', function() {
    const mq = mqInstances['mapping'];
    if (mq) mq.focus();
  });
  $(document).on('click', '.eq-field-wrap', function() {
    const id = $(this).closest('.eq-row').data('id');
    if (id) {
      const mq = mqInstances[id];
      if (mq) mq.focus();
    }
  });
}

function updateMappingPreview(latex) {
  const el = document.getElementById('kMappingPreview');
  try { katex.render(latex, el, { throwOnError: false }); }
  catch { el.textContent = latex; }
}

function applyMapping() {
  const mqObj = mqInstances['mapping'];
  if (!mqObj) return;
  const latex = mqObj.latex();
  const expr  = latexToExpr(latex);
  const comp  = compileExpr(expr);

  if (!comp) {
    showToast('Invalid mapping function — reverting to f(z) = z', 'error');
    mqObj.latex('z');
    S.mappingLatex = 'z'; S.mappingExpr = 'z';
    S.mappingCompiled = math.compile('z');
    updateMappingPreview('z');
  } else {
    S.mappingLatex = latex; S.mappingExpr = expr;
    S.mappingCompiled = comp;
  }

  // Recompute w-plane for everything
  remapAllEqs();
  remapAllStrokes();
  if (S.gridOn) remapGrid();
  redraw();
}

function toggleMappingVisibility() {
  const cb = document.getElementById('mappingVisibleCheckbox');
  S.mappingVisible = cb ? cb.checked : false;
  redraw();
}

function toggleTheme() {
  const isDark = document.body.classList.toggle('dark-theme');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  
  const sunIcon = document.querySelector('.sun-icon');
  const moonIcon = document.querySelector('.moon-icon');
  if (sunIcon && moonIcon) {
    sunIcon.style.display = isDark ? 'block' : 'none';
    moonIcon.style.display = isDark ? 'none' : 'block';
  }
  
  if (S.gridOn) computeGrid();
  redraw();
}

// ============================================================
// EQUATION MANAGEMENT
// ============================================================
function addEquation(type) {
  const color = nextColor();
  const id    = ++S.eqCounter;
  const eq    = {
    id, type, color, visible: true,
    latex: '', expr: '',
    tMin: 0, tMax: Math.PI * 2,
    zPx: [], wPx: [], zCx: [],
  };
  S.equations.push(eq);
  renderEqRow(eq);
  return eq;
}

function removeEquation(id) {
  const idx = S.equations.findIndex(e => e.id === id);
  if (idx !== -1) S.equations.splice(idx, 1);
  delete mqInstances[id];
  const row = document.querySelector(`.eq-row[data-id="${id}"]`);
  if (row) row.remove();
  redraw();
}

function toggleEqVisibility(id) {
  const eq = S.equations.find(e => e.id === id);
  if (eq) { eq.visible = !eq.visible; redraw(); }
}

function updateEqExpr(id, latex) {
  const eq = S.equations.find(e => e.id === id);
  if (!eq) return;
  eq.latex = latex;
  eq.expr  = latexToExpr(latex);
  // Update KaTeX preview in row
  const row = document.querySelector(`.eq-row[data-id="${id}"]`);
  if (row) {
    const pre = row.querySelector('.eq-preview');
    if (pre) {
      try { katex.render(latex, pre, { throwOnError: false }); }
      catch { pre.textContent = latex; }
    }
  }
  computeEqPoints(eq);
  redraw();
}

function updateTRange(id) {
  const eq  = S.equations.find(e => e.id === id);
  if (!eq || eq.type !== 'parametric') return;
  const row = document.querySelector(`.eq-row[data-id="${id}"]`);
  if (!row) return;
  const tMinEl = row.querySelector('.eq-tmin');
  const tMaxEl = row.querySelector('.eq-tmax');
  eq.tMin = parseFloat(tMinEl?.value) || 0;
  eq.tMax = parseFloat(tMaxEl?.value) || Math.PI*2;
  computeEqPoints(eq);
  redraw();
}

function pickEqColor(id) {
  const eq = S.equations.find(e => e.id === id);
  if (!eq) return;
  const inp = document.createElement('input');
  inp.type = 'color';
  inp.value = eq.color;
  inp.addEventListener('input', ev => {
    eq.color = ev.target.value;
    const btn = document.querySelector(`.eq-row[data-id="${id}"] .eq-color-btn`);
    if (btn) btn.style.background = eq.color;
    computeEqPoints(eq);
    redraw();
  });
  inp.click();
}

function renderEqRow(eq) {
  const list = document.getElementById('equationList');
  const row  = document.createElement('div');
  row.className = 'eq-row';
  row.setAttribute('data-id', eq.id);

  const badge = eq.type === 'real' ? 'y=f(x)' : 'z(t)';
  const tRangeHtml = eq.type === 'parametric' ? `
    <div class="eq-trange">
      <span>t ∈ [</span>
      <input class="eq-tmin" type="number" value="0" step="0.1" title="t minimum"
             onchange="updateTRange(${eq.id})">
      <span>,</span>
      <input class="eq-tmax" type="number" value="${(Math.PI*2).toFixed(4)}" step="0.1" title="t maximum"
             onchange="updateTRange(${eq.id})">
      <span>]</span>
    </div>` : '';

  row.innerHTML = `
    <div class="eq-row-top">
      <label class="eq-toggle" title="Show/hide equation">
        <input type="checkbox" checked onchange="toggleEqVisibility(${eq.id})">
      </label>
      <span class="eq-type-badge">${badge}</span>
      <div class="eq-field-wrap">
        <span class="mq-eq-span"></span>
      </div>
      <button class="eq-color-btn" style="background:${eq.color}"
              onclick="pickEqColor(${eq.id})" title="Change color" aria-label="Change color"></button>
      <button class="eq-delete-btn" onclick="removeEquation(${eq.id})"
              title="Delete equation" aria-label="Delete equation">✕</button>
    </div>
    ${tRangeHtml}
    <div class="eq-preview"></div>
  `;

  list.appendChild(row);

  // Init MathQuill in this row
  const span = row.querySelector('.mq-eq-span');
  const mqObj = MQ.MathField(span, {
    spaceBehavesLikeTab: false,
    autoCommands: 'pi theta sqrt',
    autoOperatorNames: 'arg conj Re Im gamma erf abs',
    handlers: {
      edit: () => {
        updateEqExpr(eq.id, mqObj.latex());
        S.activeField = eq.id;
        document.querySelectorAll('.eq-row').forEach(r => r.classList.remove('active-eq'));
        row.classList.add('active-eq');
      },
    },
  });
  mqInstances[eq.id] = mqObj;
  setTimeout(() => mqObj.focus(), 60);
}

// ============================================================
// UNDO
// ============================================================
function saveUndo() {
  S.undoStack.push(S.strokes.map(st => ({
    ...st,
    zPx: [...st.zPx],
    zCx: [...st.zCx],
    wPx: [...st.wPx],
  })));
  if (S.undoStack.length > 60) S.undoStack.shift();
}

function undo() {
  if (!S.undoStack.length) { showToast('Nothing to undo', 'info'); return; }
  S.strokes = S.undoStack.pop();
  redraw();
}

// ============================================================
// TOOLBAR ACTIONS
// ============================================================
function clearStrokes() {
  saveUndo();
  S.strokes = [];
  redraw();
}

function updateDrawColor(color) {
  S.color = color;
  document.getElementById('colorSwatch').style.background = color;
}

function updateStrokeWidth(v) { S.strokeW = parseFloat(v); }

// ============================================================
// SETTINGS
// ============================================================
function openSettings() {
  document.getElementById('settingsPanel').classList.add('open');
  document.getElementById('settingsOverlay').classList.add('open');
}
function closeSettings() {
  document.getElementById('settingsPanel').classList.remove('open');
  document.getElementById('settingsOverlay').classList.remove('open');
}

function applyRange() {
  const p = (id, def) => { const v = parseFloat(document.getElementById(id).value); return isNaN(v) ? def : v; };
  S.zRange = { xMin: p('ZMINX',-2), xMax: p('ZMAXX',2), yMin: p('ZMINY',-2), yMax: p('ZMAXY',2) };
  S.wRange = { xMin: p('WMINX',-2), xMax: p('WMAXX',2), yMin: p('WMINY',-2), yMax: p('WMAXY',2) };
  for (const eq of S.equations) computeEqPoints(eq);
  for (const st of S.strokes)   recomputeStrokePixels(st);
  if (S.gridOn) computeGrid();
  redraw();
  showToast('Range updated', 'success');
  closeSettings();
}

function resetRange() {
  ['ZMINX','ZMAXX','ZMINY','ZMAXY','WMINX','WMAXX','WMINY','WMAXY'].forEach((id,i) => {
    document.getElementById(id).value = i%2===0 ? -2 : 2;
  });
  applyRange();
}

function updateBCT(v) {
  S.bct = parseFloat(v);
  document.getElementById('bctVal').textContent = v;
  redraw();
}
function resetBCT() {
  S.bct = 10;
  document.getElementById('bctSlider').value = 10;
  document.getElementById('bctVal').textContent = '10';
  redraw();
}
function updateGridN(v) {
  S.gridN = parseInt(v);
  document.getElementById('gridNVal').textContent = v;
  if (S.gridOn) { computeGrid(); redraw(); }
}
function updateParamRes(v) {
  S.paramRes = parseInt(v);
  document.getElementById('paramResVal').textContent = v;
  for (const eq of S.equations) computeEqPoints(eq);
  redraw();
}

// ============================================================
// FUNCTION REFERENCE PANEL
// ============================================================
const FUNC_LIB = {
  mapping: {
    'Powers': [
      { l:'z^{2}',                desc:'Square' },
      { l:'z^{3}',                desc:'Cube' },
      { l:'\\frac{1}{z}',         desc:'Inversion' },
      { l:'z^{\\frac{1}{2}}',     desc:'Square root' },
      { l:'\\bar{z}',             desc:'Conjugate' },
      { l:'z^{2}+c',             desc:'Quadratic+c' },
    ],
    'Exp': [
      { l:'e^{z}',               desc:'Exponential' },
      { l:'e^{iz}',              desc:'Rotation' },
      { l:'z^{z}',               desc:'zᶻ' },
    ],
    'Trig': [
      { l:'\\sin(z)',             desc:'Sine' },
      { l:'\\cos(z)',             desc:'Cosine' },
      { l:'\\tan(z)',             desc:'Tangent' },
      { l:'\\sec(z)',             desc:'Secant' },
      { l:'\\csc(z)',             desc:'Cosecant' },
      { l:'\\cot(z)',             desc:'Cotangent' },
    ],
    'Hyp': [
      { l:'\\sinh(z)',            desc:'sinh' },
      { l:'\\cosh(z)',            desc:'cosh' },
      { l:'\\tanh(z)',            desc:'tanh' },
    ],
    'Log': [
      { l:'\\log(z)',             desc:'Natural log' },
      { l:'\\log(z^{2})',        desc:'log(z²)' },
    ],
    'Special': [
      { l:'\\Gamma(z)',           desc:'Gamma' },
      { l:'\\sqrt{z}',           desc:'√z' },
    ],
    'Classic': [
      { l:'z+\\frac{1}{z}',      desc:'Joukowski' },
      { l:'\\frac{z-1}{z+1}',   desc:'Möbius' },
      { l:'\\frac{z-i}{z+i}',   desc:'Cayley' },
      { l:'e^{z}+z',            desc:'Mixed' },
    ],
  },
  zplane: {
    'Circles': [
      { l:'e^{it}',              desc:'Unit circle', tMax: Math.PI*2 },
      { l:'2e^{it}',             desc:'Circle r=2',  tMax: Math.PI*2 },
      { l:'(1+0.5\\cos(5t))e^{it}', desc:'Rose',    tMax: Math.PI*2 },
    ],
    'Lines': [
      { l:'t',                   desc:'Real axis' },
      { l:'ti',                  desc:'Imag axis' },
      { l:'t+ti',                desc:'Diagonal' },
      { l:'t+2i',                desc:'y = 2 line' },
    ],
    'Curves': [
      { l:'t+it^{2}',            desc:'Parabola' },
      { l:'\\cos(t)+i\\sin(2t)', desc:'Lissajous',   tMax: Math.PI*2 },
      { l:'e^{t}e^{it}',         desc:'Spiral',      tMax: Math.PI*2 },
      { l:'t^{3}-3t+it^{2}',     desc:'Cubic' },
    ],
  },
};

function buildFuncPanel() {
  buildTab('funcTabMapping', FUNC_LIB.mapping, 'mapping');
  buildTab('funcTabZplane',  FUNC_LIB.zplane,  'zplane');
}

function buildTab(containerId, cats, tabType) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  for (const [catName, items] of Object.entries(cats)) {
    const catEl = document.createElement('div');
    catEl.className = 'func-category';

    const nameEl = document.createElement('div');
    nameEl.className = 'func-cat-name';
    nameEl.textContent = catName;
    catEl.appendChild(nameEl);

    const chipsEl = document.createElement('div');
    chipsEl.className = 'func-chips';

    for (const fn of items) {
      const chip = document.createElement('button');
      chip.className = 'func-chip';
      chip.title = fn.desc;

      const mathSpan = document.createElement('span');
      try { katex.render(fn.l, mathSpan, { throwOnError: false }); }
      catch { mathSpan.textContent = fn.l; }

      const descSpan = document.createElement('span');
      descSpan.className = 'func-chip-desc';
      descSpan.textContent = fn.desc;

      chip.appendChild(mathSpan);
      chip.appendChild(descSpan);
      chip.addEventListener('click', () => insertFunc(fn, tabType));
      chipsEl.appendChild(chip);
    }
    catEl.appendChild(chipsEl);
    el.appendChild(catEl);
  }
}

function insertFunc(fn, tabType) {
  if (tabType === 'mapping') {
    const mq = mqInstances['mapping'];
    if (mq) { mq.latex(fn.l); updateMappingPreview(fn.l); applyMapping(); }
  } else {
    // Insert into the last focused equation field, or create new parametric
    const id = S.activeField;
    const mq = mqInstances[id];
    if (mq && id !== 'mapping') {
      mq.latex(fn.l);
      updateEqExpr(id, fn.l);
    } else {
      // Create a new parametric equation
      const eq = addEquation('parametric');
      if (fn.tMax !== undefined) eq.tMax = fn.tMax;
      setTimeout(() => {
        const m = mqInstances[eq.id];
        if (m) { m.latex(fn.l); updateEqExpr(eq.id, fn.l); }
      }, 80);
    }
  }
}

function toggleFuncPanel(forceVal) {
  const panel = document.getElementById('funcPanel');
  const btn   = document.getElementById('funcPanelToggleBtn');
  const open  = typeof forceVal === 'boolean' ? panel.classList.toggle('open', forceVal) : panel.classList.toggle('open');
  panel.setAttribute('aria-hidden', String(!open));
  btn.setAttribute('aria-expanded', String(open));
  btn.classList.toggle('btn-accent', open);
}

function switchFuncTab(tabName) {
  document.querySelectorAll('.func-tab').forEach(t => {
    const active = t.dataset.tab === tabName;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
    t.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.func-tab-content').forEach(c => {
    c.classList.toggle('active', c.id === (tabName === 'mapping' ? 'funcTabMapping' : 'funcTabZplane'));
  });
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================
function showToast(msg, type = 'info') {
  const container = document.getElementById('toastWrap');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  const icon = type === 'error' ? '⚠' : type === 'success' ? '✓' : 'ℹ';
  t.innerHTML = `<span aria-hidden="true">${icon}</span><span>${msg}</span>`;
  container.appendChild(t);
  setTimeout(() => {
    t.classList.add('removing');
    setTimeout(() => t.remove(), 280);
  }, 3200);
}

// ============================================================
// INITIALIZATION
// ============================================================
function init() {
  // Canvas
  initCanvases();

  // Math.js default mapping
  S.mappingCompiled = math.compile('exp(z)');

  // MathQuill
  initMQ();

  // Function reference panel
  buildFuncPanel();

  // Color swatch init
  document.getElementById('colorSwatch').style.background = S.color;

  // Sync mapping checkbox
  const cb = document.getElementById('mappingVisibleCheckbox');
  if (cb) cb.checked = S.mappingVisible;

  // Initialize theme icons
  const isDark = document.body.classList.contains('dark-theme');
  const sunIcon = document.querySelector('.sun-icon');
  const moonIcon = document.querySelector('.moon-icon');
  if (sunIcon && moonIcon) {
    sunIcon.style.display = isDark ? 'block' : 'none';
    moonIcon.style.display = isDark ? 'none' : 'block';
  }

  // Start with default equation y = x^2 - 1
  const eq = addEquation('real');
  eq.latex = 'x^{2}-1';
  eq.expr = 'x^2-1';

  setTimeout(() => {
    const mapMq = mqInstances['mapping'];
    if (mapMq) {
      mapMq.latex('e^{z}');
      applyMapping();
    }
    const m = mqInstances[eq.id];
    if (m) {
      m.latex('x^{2}-1');
      updateEqExpr(eq.id, 'x^{2}-1');
    }
    // Delayed call to let MathQuill render and size elements
    setTimeout(initWelcomeTooltip, 200);
  }, 100);

  // Initial draw
  redraw();
}

// Boot
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  // Delay slightly to let browser complete layout so canvas size is correct
  requestAnimationFrame(() => setTimeout(init, 50));
}

// ============================================================
// ONBOARDING WELCOME TOOLTIP
// ============================================================
function initWelcomeTooltip() {
  if (localStorage.getItem('complexmap_onboarding_dismissed') === 'true') {
    // If onboarding is dismissed but function guide tooltip is not, load the second tooltip directly
    if (localStorage.getItem('complexmap_func_tooltip_dismissed') !== 'true') {
      initFuncTooltip();
    }
    return;
  }

  const overlay = document.getElementById('welcomeTooltipOverlay');
  if (!overlay) return;

  overlay.style.display = 'block';
  // Allow browser to display before fading in
  requestAnimationFrame(() => {
    setTimeout(() => {
      overlay.classList.add('visible');
      positionWelcomeTooltip();
    }, 50);
  });

  window.addEventListener('resize', positionWelcomeTooltip);
}

function positionWelcomeTooltip() {
  const tooltip = document.getElementById('welcome-tooltip');
  const overlay = document.getElementById('welcomeTooltipOverlay');
  if (!tooltip || !overlay || !overlay.classList.contains('visible')) return;

  const wRow = document.querySelector('.w-eq-row');
  const zEqList = document.getElementById('equationList');
  const zCanvas = document.getElementById('zCanvas');
  const svg = document.getElementById('tooltipSvgOverlay');

  if (!wRow || !zEqList || !zCanvas || !svg) return;

  // Responsiveness: hide SVG connectors on small screens
  const isDesktop = window.innerWidth > 840;
  if (!isDesktop) {
    svg.style.display = 'none';
    return;
  }
  
  svg.style.display = 'block';

  const wRect = wRow.getBoundingClientRect();
  const zEqRect = zEqList.getBoundingClientRect();
  const zCanvasRect = zCanvas.getBoundingClientRect();

  // Position tooltip relative to layout:
  // Horizontally: right next to sidebar (wRect.right) plus some spacing.
  // Vertically: aligned near the middle between mapping row and equation list
  const tooltipX = wRect.right + 45;
  const tooltipY = (wRect.bottom + zEqRect.top) / 2 - 20;

  tooltip.style.left = `${tooltipX}px`;
  tooltip.style.top = `${tooltipY}px`;

  const tRect = tooltip.getBoundingClientRect();

  // Connector Endpoints:
  // 1. To W mapping function equation row input field
  const pW_start = { x: tRect.left + 5, y: tRect.top + 35 };
  const pW_end = { x: wRect.right - 10, y: wRect.top + wRect.height / 2 };

  // 2. To Z equation list area
  const pZ_start = { x: tRect.left + 5, y: tRect.bottom - 35 };
  const pZ_end = { x: zEqRect.right - 10, y: zEqRect.top + 25 };

  // 3. To Z canvas drawing area (pointing at lower half of z canvas)
  const pC_start = { x: tRect.right - 5, y: tRect.top + tRect.height / 2 };
  const pC_end = { 
    x: zCanvasRect.left + zCanvasRect.width * 0.45, 
    y: zCanvasRect.top + zCanvasRect.height * 0.65 
  };

  // Draw smooth curves
  setPathCurve('path-w', pW_start, pW_end, 'left');
  setPathCurve('path-z', pZ_start, pZ_end, 'left');
  setPathCurve('path-c', pC_start, pC_end, 'right');

  // Move indicator circles
  setCirclePos('circle-w', pW_end);
  setCirclePos('circle-z', pZ_end);
  setCirclePos('circle-c', pC_end);
}

function setPathCurve(pathId, start, end, side) {
  const path = document.getElementById(pathId);
  if (!path) return;

  const dx = Math.abs(end.x - start.x);

  // Elegant cubic Bezier paths
  let cp1x, cp1y, cp2x, cp2y;
  if (side === 'left') {
    cp1x = start.x - dx * 0.45;
    cp1y = start.y;
    cp2x = end.x + dx * 0.45;
    cp2y = end.y;
  } else {
    cp1x = start.x + dx * 0.55;
    cp1y = start.y;
    cp2x = end.x - dx * 0.55;
    cp2y = end.y;
  }

  path.setAttribute('d', `M ${start.x} ${start.y} C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${end.x} ${end.y}`);
}

function setCirclePos(circleId, pos) {
  const circle = document.getElementById(circleId);
  if (!circle) return;
  circle.setAttribute('transform', `translate(${pos.x}, ${pos.y})`);
}

function dismissWelcomeTooltip() {
  const overlay = document.getElementById('welcomeTooltipOverlay');
  if (overlay) {
    overlay.classList.remove('visible');
    window.removeEventListener('resize', positionWelcomeTooltip);
    setTimeout(() => {
      overlay.style.display = 'none';
      overlay.remove();
      // Trigger the second tooltip immediately after dismissing the first
      initFuncTooltip();
    }, 450);
  }
  localStorage.setItem('complexmap_onboarding_dismissed', 'true');
}

// Bind to window for global inline accessibility access
window.dismissWelcomeTooltip = dismissWelcomeTooltip;

// ============================================================
// SECOND ONBOARDING TOOLTIP & SLIDESHOW
// ============================================================
let funcSlideshowTimer = null;
let funcSlideshowIndex = 0;
const slideshowCombinations = [
  {
    mappingLatex: 'z^{2}',
    curveLatex: '\\sin(3t) + i \\cdot \\sin(4t)', // Lissajous 3:4
    curveType: 'parametric',
    tMin: 0,
    tMax: 6.28
  },
  {
    mappingLatex: '\\frac{1}{z}',
    curveLatex: '\\sin(3t) + i \\cdot \\sin(4t)', // Lissajous 3:4
    curveType: 'parametric',
    tMin: 0,
    tMax: 6.28
  },
  {
    mappingLatex: '\\sqrt{z}',
    curveLatex: '\\sin(3t) + i \\cdot \\sin(4t)', // Lissajous 3:4
    curveType: 'parametric',
    tMin: 0,
    tMax: 6.28
  },
  {
    mappingLatex: 'z^{3}-z',
    curveLatex: '\\sin(2t) + i \\cdot \\sin(3t)', // Lissajous 2:3
    curveType: 'parametric',
    tMin: 0,
    tMax: 6.28
  }
];

function initFuncTooltip() {
  if (localStorage.getItem('complexmap_func_tooltip_dismissed') === 'true') {
    return;
  }

  const overlay = document.getElementById('funcTooltipOverlay');
  if (!overlay) return;

  overlay.style.display = 'block';
  requestAnimationFrame(() => {
    setTimeout(() => {
      overlay.classList.add('visible');
      positionFuncTooltip();
    }, 50);
  });

  window.addEventListener('resize', positionFuncTooltip);
  
  // Start cycling Lissajous curves in teal
  startFuncSlideshow();
}

function positionFuncTooltip() {
  const tooltip = document.getElementById('func-tooltip');
  const overlay = document.getElementById('funcTooltipOverlay');
  if (!tooltip || !overlay || !overlay.classList.contains('visible')) return;

  const btn = document.getElementById('funcPanelToggleBtn');
  const svg = document.getElementById('funcTooltipSvgOverlay');
  if (!btn || !svg) return;

  const btnRect = btn.getBoundingClientRect();
  const isDesktop = window.innerWidth > 840;

  // Responsive styling: center at bottom on small viewports
  if (!isDesktop) {
    svg.style.display = 'none';
    tooltip.style.position = 'fixed';
    tooltip.style.bottom = '80px';
    tooltip.style.left = '50%';
    tooltip.style.transform = 'translateX(-50%)';
    tooltip.style.top = 'auto';
    return;
  }

  svg.style.display = 'block';
  tooltip.style.position = 'absolute';

  const tWidth = 280;
  const tHeight = 90;

  // Position tooltip centered above the button
  const tooltipX = btnRect.left + btnRect.width / 2 - tWidth / 2;
  const tooltipY = btnRect.top - tHeight - 40;

  tooltip.style.left = `${tooltipX}px`;
  tooltip.style.top = `${tooltipY}px`;

  const tRect = tooltip.getBoundingClientRect();

  // Connector Endpoint (from bottom center of tooltip to top center of button)
  const pStart = { x: tRect.left + tRect.width / 2, y: tRect.bottom - 5 };
  const pEnd = { x: btnRect.left + btnRect.width / 2, y: btnRect.top - 5 };

  const path = document.getElementById('path-f');
  if (path) {
    path.setAttribute('d', `M ${pStart.x} ${pStart.y} Q ${(pStart.x + pEnd.x)/2} ${(pStart.y + pEnd.y)/2 - 12} ${pEnd.x} ${pEnd.y}`);
  }

  const circle = document.getElementById('circle-f');
  if (circle) {
    circle.setAttribute('transform', `translate(${pEnd.x}, ${pEnd.y})`);
  }
}

function startFuncSlideshow() {
  if (funcSlideshowTimer) {
    clearInterval(funcSlideshowTimer);
  }
  funcSlideshowIndex = 0;
  
  applySlideshowCombination(slideshowCombinations[0]);
  
  funcSlideshowTimer = setInterval(() => {
    funcSlideshowIndex = (funcSlideshowIndex + 1) % slideshowCombinations.length;
    applySlideshowCombination(slideshowCombinations[funcSlideshowIndex]);
  }, 3200);
}

function applySlideshowCombination(combo) {
  // 1. Set mapping LaTeX
  const mapMq = mqInstances['mapping'];
  if (mapMq) {
    mapMq.latex(combo.mappingLatex);
    const expr = latexToExpr(combo.mappingLatex);
    const comp = compileExpr(expr);
    if (comp) {
      S.mappingLatex = combo.mappingLatex;
      S.mappingExpr = expr;
      S.mappingCompiled = comp;
      updateMappingPreview(combo.mappingLatex);
    }
  }

  // 2. Clear existing curves and add slide curve in teal #03dac6
  S.equations = [];
  for (const id in mqInstances) {
    if (id !== 'mapping') delete mqInstances[id];
  }

  const eqList = document.getElementById('equationList');
  if (eqList) eqList.innerHTML = '';
  S.eqCounter = 0;

  const eq = addEquation(combo.curveType);
  eq.color = '#03dac6'; // Plot in teal color
  eq.latex = combo.curveLatex;
  eq.expr = latexToExpr(combo.curveLatex);
  eq.visible = true;
  eq.tMin = combo.tMin;
  eq.tMax = combo.tMax;

  setTimeout(() => {
    const m = mqInstances[eq.id];
    if (m) {
      m.latex(combo.curveLatex);
      updateEqExpr(eq.id, combo.curveLatex);
    }
    remapAllEqs();
    redraw();
  }, 60);
}

function stopSlideshowAndReset() {
  if (funcSlideshowTimer) {
    clearInterval(funcSlideshowTimer);
    funcSlideshowTimer = null;
  }

  // Reset mapping to default exp(z)
  const mapMq = mqInstances['mapping'];
  if (mapMq) {
    mapMq.latex('e^{z}');
    S.mappingLatex = 'e^{z}'; S.mappingExpr = 'exp(z)';
    S.mappingCompiled = math.compile('exp(z)');
    updateMappingPreview('e^{z}');
  }

  // Reset equations to default y = x^2 - 1
  S.equations = [];
  for (const id in mqInstances) {
    if (id !== 'mapping') delete mqInstances[id];
  }
  const eqList = document.getElementById('equationList');
  if (eqList) eqList.innerHTML = '';
  S.eqCounter = 0;

  const eq = addEquation('real');
  eq.latex = 'x^{2}-1';
  eq.expr = 'x^2-1';
  eq.visible = true;

  setTimeout(() => {
    const m = mqInstances[eq.id];
    if (m) {
      m.latex('x^{2}-1');
      updateEqExpr(eq.id, 'x^{2}-1');
    }
    remapAllEqs();
    redraw();
  }, 60);
}

function dismissFuncTooltip() {
  const overlay = document.getElementById('funcTooltipOverlay');
  if (overlay) {
    overlay.classList.remove('visible');
    window.removeEventListener('resize', positionFuncTooltip);
    setTimeout(() => {
      overlay.style.display = 'none';
      overlay.remove();
    }, 450);
  }
  localStorage.setItem('complexmap_func_tooltip_dismissed', 'true');
  stopSlideshowAndReset();
}

window.dismissFuncTooltip = dismissFuncTooltip;
window.initFuncTooltip = initFuncTooltip;
