'use strict';

const $ = s => document.querySelector(s);
const MAX_SRC = 3000;     // longest side of the photo we work on
const MAX_OUT = 2400;     // longest side of a scanned page
const pages = [];         // {blob, w, h, thumb}

let srcCanvas = null;     // the photo being edited
let corners = [];         // tl, tr, br, bl in srcCanvas pixels
let base = null;          // warped page, before enhancement (rotation applied here)
let view = null;          // what the result screen shows
let mode = 'color';

// ---------- OpenCV readiness ----------
const cvReady = new Promise(resolve => {
  const t = setInterval(() => {
    if (window.cv && cv.Mat) { clearInterval(t); resolve(); }
    else if (window.cv && !cv.__hooked) {
      cv.__hooked = true;
      cv.onRuntimeInitialized = () => { clearInterval(t); resolve(); };
    }
  }, 100);
});
cvReady.then(() => { $('#engine').textContent = ''; });

// ---------- UI helpers ----------
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === id));
}
async function busy(text, fn) {
  $('#busy').textContent = text;
  $('#busy').classList.add('on');
  await new Promise(r => setTimeout(r, 30));   // let the overlay paint
  try { return await fn(); } finally { $('#busy').classList.remove('on'); }
}
function showError(msg) { $('#err').textContent = msg || ''; }

// ---------- Loading a photo ----------
async function loadPhoto(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bmp = await new Promise((ok, no) => {
    const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = URL.createObjectURL(file);
  }); }
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, MAX_SRC / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return c;
}

// ---------- Page detection ----------
function orderCorners(pts) {
  const sum = p => p.x + p.y, diff = p => p.y - p.x;
  const tl = pts.reduce((a, b) => sum(b) < sum(a) ? b : a);
  const br = pts.reduce((a, b) => sum(b) > sum(a) ? b : a);
  const tr = pts.reduce((a, b) => diff(b) < diff(a) ? b : a);
  const bl = pts.reduce((a, b) => diff(b) > diff(a) ? b : a);
  return [tl, tr, br, bl];
}

// Largest convex outline in a binary image that looks like a page.
// Tries to fit 4 points with growing tolerance (curled paper); optionally falls back to a rotated rectangle.
function pageQuad(bin, minArea, maxArea, allowRect) {
  const contours = new cv.MatVector(), hier = new cv.Mat();
  let best = null, bestArea = 0;
  try {
    cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i), hull = new cv.Mat();
      try {
        cv.convexHull(c, hull);
        const area = cv.contourArea(hull);
        if (area < minArea || area > maxArea || area <= bestArea) continue;
        let pts = null;
        const peri = cv.arcLength(hull, true);
        for (const eps of [0.02, 0.03, 0.045, 0.065]) {
          const ap = new cv.Mat();
          cv.approxPolyDP(hull, ap, eps * peri, true);
          if (ap.rows === 4) {
            pts = [];
            for (let j = 0; j < 4; j++) pts.push({ x: ap.data32S[j * 2], y: ap.data32S[j * 2 + 1] });
          }
          ap.delete();
          if (pts) break;
        }
        if (!pts && allowRect) pts = cv.RotatedRect.points(cv.minAreaRect(hull)).map(p => ({ x: p.x, y: p.y }));
        if (pts) { best = pts; bestArea = area; }
      } finally { c.delete(); hull.delete(); }
    }
  } finally { contours.delete(); hier.delete(); }
  return best;
}

function detectCorners(canvas) {
  const k = Math.min(1, 700 / Math.max(canvas.width, canvas.height));
  const small = document.createElement('canvas');
  small.width = Math.round(canvas.width * k); small.height = Math.round(canvas.height * k);
  small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);

  const m = cv.imread(small), g = new cv.Mat(), e = new cv.Mat(), t = new cv.Mat();
  const kern = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  const total = small.width * small.height, minArea = total * 0.15, maxArea = total * 0.97;
  let best = null;
  try {
    cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(g, g, new cv.Size(5, 5), 0);
    // 1) edges
    cv.Canny(g, e, 50, 150);
    cv.dilate(e, e, kern);
    best = pageQuad(e, minArea, maxArea, false);
    // 2) bright paper against a darker background
    if (!best) {
      cv.threshold(g, t, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.morphologyEx(t, t, cv.MORPH_OPEN, kern);
      cv.morphologyEx(t, t, cv.MORPH_CLOSE, cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15)));
      best = pageQuad(t, minArea, maxArea, true);
    }
    // 3) last resort: rotated rectangle around the edges
    if (!best) best = pageQuad(e, minArea, maxArea, true);
  } finally {
    m.delete(); g.delete(); e.delete(); t.delete(); kern.delete();
  }
  if (best) return orderCorners(best.map(p => ({ x: p.x / k, y: p.y / k })));
  const mx = canvas.width * 0.06, my = canvas.height * 0.06;     // nothing found: inset rectangle
  return [{ x: mx, y: my }, { x: canvas.width - mx, y: my },
          { x: canvas.width - mx, y: canvas.height - my }, { x: mx, y: canvas.height - my }];
}

// ---------- Corner editor ----------
const ec = $('#ec');
let dispScale = 1, dpr = 1, dragging = -1;

function layoutEditor() {
  const stage = $('#stage');
  dpr = window.devicePixelRatio || 1;
  const availW = stage.clientWidth - 16, availH = stage.clientHeight - 16;
  dispScale = Math.min(availW / srcCanvas.width, availH / srcCanvas.height);
  ec.style.width = Math.round(srcCanvas.width * dispScale) + 'px';
  ec.style.height = Math.round(srcCanvas.height * dispScale) + 'px';
  ec.width = Math.round(srcCanvas.width * dispScale * dpr);
  ec.height = Math.round(srcCanvas.height * dispScale * dpr);
  drawEditor();
}

function drawEditor() {
  const ctx = ec.getContext('2d'), s = dispScale * dpr;
  ctx.clearRect(0, 0, ec.width, ec.height);
  ctx.drawImage(srcCanvas, 0, 0, ec.width, ec.height);
  ctx.beginPath();
  corners.forEach((p, i) => i ? ctx.lineTo(p.x * s, p.y * s) : ctx.moveTo(p.x * s, p.y * s));
  ctx.closePath();
  ctx.fillStyle = 'rgba(30,94,255,.18)'; ctx.fill();
  ctx.lineWidth = 3 * dpr; ctx.strokeStyle = '#1e5eff'; ctx.stroke();
  corners.forEach(p => {
    ctx.beginPath(); ctx.arc(p.x * s, p.y * s, 13 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fill();
    ctx.lineWidth = 3 * dpr; ctx.strokeStyle = '#1e5eff'; ctx.stroke();
  });
}

function pointerPos(ev) {
  const r = ec.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / dispScale, y: (ev.clientY - r.top) / dispScale };
}
ec.addEventListener('pointerdown', ev => {
  const p = pointerPos(ev);
  let bestI = -1, bestD = 50 / dispScale;      // grab radius: 50 css px
  corners.forEach((c, i) => { const d = Math.hypot(c.x - p.x, c.y - p.y); if (d < bestD) { bestD = d; bestI = i; } });
  if (bestI >= 0) { dragging = bestI; ec.setPointerCapture(ev.pointerId); ev.preventDefault(); }
});
ec.addEventListener('pointermove', ev => {
  if (dragging < 0) return;
  const p = pointerPos(ev);
  corners[dragging] = {
    x: Math.max(0, Math.min(srcCanvas.width, p.x)),
    y: Math.max(0, Math.min(srcCanvas.height, p.y)),
  };
  drawEditor();
});
const endDrag = () => { dragging = -1; };
ec.addEventListener('pointerup', endDrag);
ec.addEventListener('pointercancel', endDrag);

// ---------- Perspective warp ----------
function warp() {
  const [tl, tr, br, bl] = corners;
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let w = Math.max(d(tl, tr), d(bl, br)), h = Math.max(d(tl, bl), d(tr, br));
  const k = Math.min(1, MAX_OUT / Math.max(w, h));
  w = Math.max(50, Math.round(w * k)); h = Math.max(50, Math.round(h * k));

  const src = cv.imread(srcCanvas), dst = new cv.Mat();
  const sp = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const dp = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
  const M = cv.getPerspectiveTransform(sp, dp);
  const out = document.createElement('canvas');
  try {
    cv.warpPerspective(src, dst, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    cv.imshow(out, dst);
  } finally { src.delete(); dst.delete(); sp.delete(); dp.delete(); M.delete(); }
  return out;
}

// ---------- Enhancement ----------
// Divide by an estimate of the paper background: removes shadows and uneven light.
function background(rgb) {
  const f = Math.max(1, Math.round(Math.max(rgb.cols, rgb.rows) / 600));
  const small = new cv.Mat(), bg = new cv.Mat();
  const kern = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
  try {
    cv.resize(rgb, small, new cv.Size(Math.round(rgb.cols / f), Math.round(rgb.rows / f)), 0, 0, cv.INTER_AREA);
    cv.dilate(small, small, kern);          // drop dark text from the estimate
    cv.medianBlur(small, small, 21);
    cv.resize(small, bg, new cv.Size(rgb.cols, rgb.rows), 0, 0, cv.INTER_LINEAR);
  } finally { small.delete(); kern.delete(); }
  return bg;
}

// Unsharp mask: out = 1.8 * out - 0.8 * blurred
function sharpen(mat) {
  const blur = new cv.Mat();
  try {
    cv.GaussianBlur(mat, blur, new cv.Size(0, 0), 1.6);
    cv.addWeighted(mat, 1.8, blur, -0.8, 0, mat);
  } finally { blur.delete(); }
}

function enhance(canvas, m) {
  if (m === 'orig') return canvas;
  const src = cv.imread(canvas), rgb = new cv.Mat(), norm = new cv.Mat(), out = new cv.Mat();
  const res = document.createElement('canvas');
  let bg;
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    bg = background(rgb);
    cv.divide(rgb, bg, norm, 255, -1);
    if (m === 'color') {
      cv.convertScaleAbs(norm, out, 1.1, -4);
      sharpen(out);
    } else {
      const g = new cv.Mat();
      cv.cvtColor(norm, g, cv.COLOR_RGB2GRAY);
      if (m === 'bw') cv.adaptiveThreshold(g, out, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 41, 14);
      else { cv.convertScaleAbs(g, out, 1.1, -4); sharpen(out); }
      g.delete();
    }
    cv.imshow(res, out);
  } finally {
    src.delete(); rgb.delete(); norm.delete(); out.delete(); if (bg) bg.delete();
  }
  return res;
}

function rotated(c) {
  const r = document.createElement('canvas');
  r.width = c.height; r.height = c.width;
  const x = r.getContext('2d');
  x.translate(r.width, 0); x.rotate(Math.PI / 2); x.drawImage(c, 0, 0);
  return r;
}

function renderResult() {
  view = enhance(base, mode);
  const holder = $('#res');
  holder.replaceChildren(view);
  document.querySelectorAll('#modes [data-m]').forEach(b => b.classList.toggle('sel', b.dataset.m === mode));
}

// ---------- Pages list ----------
function blobOf(canvas, q = 0.9) {
  return new Promise(r => canvas.toBlob(r, 'image/jpeg', q));
}
const EMPTY_DEFAULT = 'עוד אין עמודים. לחץ "צלם עמוד" כדי להתחיל.';
let emptyMsg = EMPTY_DEFAULT;
function renderGrid() {
  const grid = $('#grid');
  grid.replaceChildren();
  if (!pages.length) {
    const e = document.createElement('div');
    e.className = 'empty'; e.textContent = emptyMsg;
    grid.append(e);
  }
  pages.forEach((p, i) => {
    const d = document.createElement('div'); d.className = 'page';
    const img = document.createElement('img'); img.src = p.thumb;
    const n = document.createElement('span'); n.className = 'n'; n.textContent = i + 1;
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'מחק');
    x.onclick = () => { URL.revokeObjectURL(p.thumb); pages.splice(i, 1); renderGrid(); };
    d.append(img, n, x); grid.append(d);
  });
  $('#share').disabled = !pages.length;
}

// ---------- PDF ----------
// Adds a white strip above the page with the note in red, so the invoice itself stays untouched.
async function withNote(p, note) {
  const bmp = await createImageBitmap(p.blob);
  const size = Math.round(p.w * 0.06), pad = Math.round(size * 0.5), maxW = p.w - 2 * pad;
  const FONT = `${size}px GutmannYadBrush, system-ui, Arial, sans-serif`;
  await document.fonts.load(FONT, note).catch(() => {});
  const c = document.createElement('canvas'), x = c.getContext('2d');
  c.width = p.w;
  x.font = FONT;
  const lines = [];
  let line = '';
  for (const word of note.split(/\s+/).filter(Boolean)) {
    const t = line ? line + ' ' + word : word;
    if (line && x.measureText(t).width > maxW) { lines.push(line); line = word; } else line = t;
  }
  if (line) lines.push(line);
  const strip = Math.round(pad * 2 + lines.length * size * 1.3);
  c.height = p.h + strip;
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(bmp, 0, strip);
  if (bmp.close) bmp.close();
  x.font = FONT;
  x.direction = 'rtl'; x.textAlign = 'center'; x.textBaseline = 'top'; x.fillStyle = '#d00000';
  lines.forEach((l, i) => x.fillText(l, p.w / 2,pad + i * size * 1.3));
  return { blob: await blobOf(c), w: c.width, h: c.height };
}

async function buildPdf() {
  const { jsPDF } = window.jspdf;
  const W = 210;                                       // mm; each page keeps the photographed aspect ratio
  const note = $('#note').value.trim();
  let pdf = null;
  for (const [i, src] of pages.entries()) {
    const p = i === 0 && note ? await withNote(src, note) : src;
    const H = W * p.h / p.w;
    if (!pdf) pdf = new jsPDF({ unit: 'mm', format: [W, H], orientation: H >= W ? 'p' : 'l' });
    else pdf.addPage([W, H], H >= W ? 'p' : 'l');
    const bytes = new Uint8Array(await p.blob.arrayBuffer());
    pdf.addImage(bytes, 'JPEG', 0, 0, W, H, undefined, 'FAST');
  }
  return pdf.output('blob');
}

function fileName() {
  const d = new Date(), z = n => String(n).padStart(2, '0');
  return `invoice_${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}.pdf`;
}

// Resolves true when the file was handed over (shared or downloaded), false when the user cancelled.
async function shareFile(file) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return true;
}

async function sharePdf() {
  const blob = await busy('יוצר PDF…', buildPdf);
  const file = new File([blob], fileName(), { type: 'application/pdf' });
  if (!await shareFile(file)) return;
  try {
    await archive(file, blob);
  } catch (e) { console.error(e); showError('הקובץ נשלח, אבל לא נשמר בהיסטוריה: ' + e.message); return; }
  pages.forEach(p => URL.revokeObjectURL(p.thumb));
  pages.length = 0;
  $('#note').value = '';
  emptyMsg = 'נשלח ✓ המסמך נשמר בהיסטוריה.';
  renderGrid();
}

// ---------- History of sent documents (IndexedDB, stays on this phone) ----------
const HISTORY_MAX = 30;
const db = new Promise((ok, no) => {
  const r = indexedDB.open('scanner', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('sent', { keyPath: 'id' });
  r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
});
async function sent(mode, fn) {
  const d = await db;
  return new Promise((ok, no) => {
    const tx = d.transaction('sent', mode), rq = fn(tx.objectStore('sent'));
    tx.oncomplete = () => ok(rq && rq.result); tx.onerror = () => no(tx.error);
  });
}
async function archive(file, blob) {
  await sent('readwrite', s => s.put({ id: Date.now(), name: file.name, count: pages.length, pdf: blob, thumb: pages[0].thumbBlob }));
  const keys = (await sent('readonly', s => s.getAllKeys())).sort((a, b) => b - a);
  for (const k of keys.slice(HISTORY_MAX)) await sent('readwrite', s => s.delete(k));
}
async function renderHistory() {
  const list = $('#hlist'), items = (await sent('readonly', s => s.getAll())).sort((a, b) => b.id - a.id);
  list.replaceChildren();
  if (!items.length) {
    const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'עוד לא נשלחו מסמכים.'; list.append(e);
  }
  for (const it of items) {
    const row = document.createElement('div'); row.className = 'hrow';
    const img = document.createElement('img'); img.src = URL.createObjectURL(it.thumb); img.onload = () => URL.revokeObjectURL(img.src);
    const t = document.createElement('div'); t.className = 'ht';
    t.textContent = new Date(it.id).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) + ' · ' + it.count + ' עמ׳';
    const again = document.createElement('button'); again.textContent = 'שלח שוב';
    again.onclick = () => shareFile(new File([it.pdf], it.name, { type: 'application/pdf' })).catch(e => showError(e.message));
    const del = document.createElement('button'); del.textContent = 'מחק';
    del.onclick = async () => { await sent('readwrite', s => s.delete(it.id)); renderHistory(); };
    row.append(img, t, again, del); list.append(row);
  }
}
$('#hist').onclick = () => { show('history'); renderHistory().catch(e => showError(e.message)); };
$('#histBack').onclick = () => show('home');

// ---------- Wiring ----------
async function onPhoto(file) {
  if (!file) return;
  showError('');
  try {
    await busy('מזהה את הדף…', async () => {
      srcCanvas = await loadPhoto(file);
      await cvReady;
      corners = detectCorners(srcCanvas);
    });
    show('edit');
    layoutEditor();
  } catch (e) { console.error(e); showError('לא הצלחתי לפתוח את התמונה: ' + e.message); show('home'); }
}
for (const id of ['cam', 'gal']) {
  $('#' + id).addEventListener('change', ev => { const f = ev.target.files[0]; ev.target.value = ''; onPhoto(f); });
}
$('#shoot').onclick = () => $('#cam').click();
$('#pick').onclick = () => $('#gal').click();
$('#share').onclick = () => sharePdf().catch(e => showError('שגיאה ביצירת PDF: ' + e.message));

$('#editCancel').onclick = () => show('home');
$('#editOk').onclick = async () => {
  try {
    await busy('מיישר…', async () => { base = warp(); mode = 'color'; });
    show('result');
    await busy('משפר…', async () => renderResult());
  } catch (e) { console.error(e); showError('שגיאה בעיבוד: ' + e.message); show('home'); }
};
window.addEventListener('resize', () => { if ($('#edit').classList.contains('on')) layoutEditor(); });

document.querySelectorAll('#modes [data-m]').forEach(b => b.onclick = async () => {
  mode = b.dataset.m; await busy('משפר…', async () => renderResult());
});
$('#rot').onclick = async () => { base = rotated(base); await busy('מסובב…', async () => renderResult()); };
$('#resBack').onclick = () => show('edit');
$('#resOk').onclick = async () => {
  const blob = await blobOf(view);
  const t = document.createElement('canvas'); t.width = 260; t.height = Math.round(260 * view.height / view.width);
  t.getContext('2d').drawImage(view, 0, 0, t.width, t.height);
  const thumbBlob = await blobOf(t, 0.8);
  pages.push({ blob, w: view.width, h: view.height, thumb: URL.createObjectURL(thumbBlob), thumbBlob });
  emptyMsg = EMPTY_DEFAULT;
  renderGrid(); show('home');
};

renderGrid();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
