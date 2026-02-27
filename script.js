/**
 * PDF Studio — script.js  (v2 — fully fixed)
 * Client-side PDF editor: PDF.js + pdf-lib + SortableJS
 * All processing is local — nothing is uploaded anywhere.
 */

'use strict';

/* =============================================
   CONFIGURATION
   ============================================= */
const CONFIG = {
  MAX_FILE_SIZE_MB: 50,
  PDF_JS_WORKER: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  THUMB_SCALE: 0.28,
  PREVIEW_SCALE: 1.4,
  ZOOM_STEP: 0.25,
  ZOOM_MIN: 0.5,
  ZOOM_MAX: 3.0,
};

pdfjsLib.GlobalWorkerOptions.workerSrc = CONFIG.PDF_JS_WORKER;

/* =============================================
   STATE
   ============================================= */
const state = {
  pdfJsDoc: null,         // PDF.js doc — for rendering
  rawBytes: null,         // Uint8Array — always the LATEST edited bytes
  pageOrder: [],          // [originalIndex, ...] in current display order
  pageRotations: {},      // { originalIndex: extraDegrees }
  selectedPages: new Set(),
  currentPreviewPage: 1,
  totalPages: 0,
  zoomLevel: 1.0,
  isDarkMode: true,
  mergeFiles: [],
  sigDrawing: false,
  placementMode: null,    // null | 'text' | 'image' | 'signature'
};

/* =============================================
   DOM HELPERS
   ============================================= */
const $ = id => document.getElementById(id);
const show = el => el && el.classList.remove('hidden');
const hide = el => el && el.classList.add('hidden');

function showToast(msg, type = 'info', duration = 4000) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  show(t);
  clearTimeout(t._t);
  t._t = setTimeout(() => hide(t), duration);
}

function setLoading(visible, text = 'Processing…') {
  $('loadingText').textContent = text;
  visible ? show($('loadingOverlay')) : hide($('loadingOverlay'));
}

function togglePwd(id) {
  const el = $(id);
  el.type = el.type === 'password' ? 'text' : 'password';
}
window.togglePwd = togglePwd;

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

function validateFileSize(file) {
  if (file.size / 1048576 > CONFIG.MAX_FILE_SIZE_MB) {
    showToast(`File too large (${formatSize(file.size)}). Max ${CONFIG.MAX_FILE_SIZE_MB} MB.`, 'error');
    return false;
  }
  return true;
}

function validPage(n) {
  if (isNaN(n) || n < 1 || n > state.totalPages) {
    showToast(`Invalid page number. Must be 1–${state.totalPages}.`, 'error');
    return false;
  }
  return true;
}

/* =============================================
   DARK MODE
   ============================================= */
$('themeToggle').addEventListener('click', () => {
  state.isDarkMode = !state.isDarkMode;
  document.documentElement.setAttribute('data-theme', state.isDarkMode ? 'dark' : 'light');
  $('themeToggle').innerHTML = state.isDarkMode
    ? '<i class="fa-solid fa-moon"></i>'
    : '<i class="fa-solid fa-sun"></i>';
});

/* =============================================
   PANEL NAVIGATION
   ============================================= */
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    $(`panel-${btn.dataset.panel}`).classList.add('active');
    if (btn.dataset.panel === 'pages' && state.pdfJsDoc) renderPageGrid();
  });
});

/* =============================================
   UPLOAD
   ============================================= */

/**
 * Core loader — given Uint8Array bytes, sets up both
 * PDF.js (for rendering) and tracks rawBytes (for editing).
 * isNewFile=true resets page order; false preserves it after edits.
 */
async function loadBytesIntoState(bytes, isNewFile = true) {
  state.rawBytes = bytes;
  // PDF.js needs its own copy of the buffer
  state.pdfJsDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  state.totalPages = state.pdfJsDoc.numPages;

  if (isNewFile) {
    state.pageOrder = Array.from({ length: state.totalPages }, (_, i) => i);
    state.pageRotations = {};
    state.selectedPages.clear();
    state.currentPreviewPage = 1;
  }
}

async function handleFileUpload(file) {
  if (!file || file.type !== 'application/pdf') {
    showToast('Please select a valid PDF file.', 'error'); return;
  }
  if (!validateFileSize(file)) return;

  setLoading(true, 'Loading PDF…');
  try {
    const buf = await file.arrayBuffer();
    await loadBytesIntoState(new Uint8Array(buf), true);

    $('fileName').textContent = file.name;
    $('fileSize').textContent = `${formatSize(file.size)} · ${state.totalPages} pages`;
    hide($('dropZone'));
    show($('fileInfo'));
    enableButtons(true);
    updateSplitHint();
    await renderPreview(1);
    showToast(`Loaded: ${file.name} (${state.totalPages} pages)`, 'success');
  } catch (err) {
    console.error('Upload error:', err);
    showToast(`Failed to load: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

function enableButtons(on) {
  ['downloadBtn','splitBtn','addTextBtn','addImageBtn','addSigBtn','applyPwdBtn','zoomIn','zoomOut']
    .forEach(id => { const el = $(id); if (el) el.disabled = !on; });
  updatePageControls();
}

$('fileInput').addEventListener('change', e => {
  if (e.target.files[0]) handleFileUpload(e.target.files[0]);
});

const dropZone = $('dropZone');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleFileUpload(e.dataTransfer.files[0]);
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { if (e.target !== dropZone) e.preventDefault(); });

$('clearFile').addEventListener('click', () => {
  Object.assign(state, {
    pdfJsDoc: null, rawBytes: null,
    pageOrder: [], pageRotations: {},
    totalPages: 0, currentPreviewPage: 1,
  });
  state.selectedPages.clear();
  show($('dropZone')); hide($('fileInfo'));
  $('fileInput').value = '';
  $('pageIndicator').textContent = '— / —';
  hide($('previewCanvas'));
  show($('previewPlaceholder'));
  $('pageGrid').innerHTML = '<p class="hint center">Upload a PDF to manage pages.</p>';
  const po = $('placementOverlay');
  if (po) po.getContext('2d').clearRect(0, 0, po.width, po.height);
  enableButtons(false);
});

/* =============================================
   PREVIEW
   ============================================= */
async function renderPreview(pageNum) {
  if (!state.pdfJsDoc) return;
  pageNum = Math.max(1, Math.min(pageNum ?? state.currentPreviewPage, state.totalPages));
  state.currentPreviewPage = pageNum;

  const origIdx = state.pageOrder[pageNum - 1];
  const pdfPage = await state.pdfJsDoc.getPage(origIdx + 1);
  const addRot  = state.pageRotations[origIdx] || 0;

  const viewport = pdfPage.getViewport({
    scale: CONFIG.PREVIEW_SCALE * state.zoomLevel,
    rotation: (pdfPage.rotate + addRot) % 360,
  });

  const canvas = $('previewCanvas');
  canvas.width  = viewport.width;
  canvas.height = viewport.height;
  show(canvas);
  hide($('previewPlaceholder'));

  await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  updatePageControls();

  // Keep placement overlay in sync with canvas size
  const overlay = $('placementOverlay');
  if (overlay) { overlay.width = canvas.width; overlay.height = canvas.height; }
}

function updatePageControls() {
  $('pageIndicator').textContent = state.totalPages
    ? `${state.currentPreviewPage} / ${state.totalPages}` : '— / —';
  $('prevPage').disabled = !state.totalPages || state.currentPreviewPage <= 1;
  $('nextPage').disabled = !state.totalPages || state.currentPreviewPage >= state.totalPages;
}

$('prevPage').addEventListener('click', () => renderPreview(state.currentPreviewPage - 1));
$('nextPage').addEventListener('click', () => renderPreview(state.currentPreviewPage + 1));

$('zoomIn').addEventListener('click', () => {
  state.zoomLevel = Math.min(CONFIG.ZOOM_MAX, +(state.zoomLevel + CONFIG.ZOOM_STEP).toFixed(2));
  $('zoomLabel').textContent = Math.round(state.zoomLevel * 100) + '%';
  renderPreview();
});
$('zoomOut').addEventListener('click', () => {
  state.zoomLevel = Math.max(CONFIG.ZOOM_MIN, +(state.zoomLevel - CONFIG.ZOOM_STEP).toFixed(2));
  $('zoomLabel').textContent = Math.round(state.zoomLevel * 100) + '%';
  renderPreview();
});

/* =============================================
   PLACEMENT OVERLAY
   Click on the preview canvas to pick X/Y position
   for text, image, or signature overlays.
   ============================================= */
function initPlacementOverlay() {
  const overlay = $('placementOverlay');
  if (!overlay) return;

  overlay.addEventListener('click', e => {
    if (!state.placementMode || !state.pdfJsDoc) return;

    const rect = overlay.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (overlay.width  / rect.width);
    const cy = (e.clientY - rect.top)  * (overlay.height / rect.height);

    // Convert from canvas pixels → PDF points (origin top-left, same as our input fields)
    const scale = CONFIG.PREVIEW_SCALE * state.zoomLevel;
    const pdfX  = Math.round(cx / scale);
    const pdfY  = Math.round(cy / scale);

    if (state.placementMode === 'text') {
      $('textX').value = pdfX; $('textY').value = pdfY;
    } else if (state.placementMode === 'image') {
      $('imgX').value = pdfX; $('imgY').value = pdfY;
    } else if (state.placementMode === 'signature') {
      $('sigX').value = pdfX; $('sigY').value = pdfY;
    }

    showToast(`Position set: X=${pdfX}, Y=${pdfY} (measured from top-left)`, 'success');

    // Draw crosshair marker
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.strokeStyle = '#4f8ef7';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(overlay.width, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, overlay.height); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#4f8ef7';
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();

    // Draw small label
    ctx.fillStyle = '#4f8ef7';
    ctx.font = '12px monospace';
    ctx.fillText(`(${pdfX}, ${pdfY})`, cx + 10, cy - 6);
  });
}
initPlacementOverlay();

function setPlacementMode(mode, btnId) {
  // Turn off current mode
  if (state.placementMode) {
    const prevBtn = $(`${state.placementMode}PickBtn`);
    if (prevBtn) {
      prevBtn.classList.remove('active-pick');
      prevBtn.innerHTML = '<i class="fa-solid fa-crosshairs"></i> Pick on Page';
    }
    const overlay = $('placementOverlay');
    if (overlay) {
      overlay.style.pointerEvents = 'none';
      overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
    }
    $('previewWrap').classList.remove('placement-active');
  }

  if (mode && mode !== state.placementMode) {
    state.placementMode = mode;
    const overlay = $('placementOverlay');
    overlay.style.pointerEvents = 'all';
    $('previewWrap').classList.add('placement-active');
    if (btnId) {
      const btn = $(btnId);
      btn.classList.add('active-pick');
      btn.innerHTML = '<i class="fa-solid fa-xmark"></i> Cancel Pick';
    }
    showToast('Click anywhere on the preview to set the position.', 'info', 5000);
  } else {
    state.placementMode = null;
  }
}

/* =============================================
   MERGE
   ============================================= */
function updateMergeList() {
  const list = $('mergeList');
  list.innerHTML = '';
  state.mergeFiles.forEach((f, i) => {
    const li = document.createElement('li');
    li.className = 'merge-item';
    li.innerHTML = `
      <i class="fa-solid fa-file-pdf"></i>
      <span title="${f.name}">${f.name}</span>
      <small style="color:var(--text-dim);font-family:var(--font-mono)">${formatSize(f.size)}</small>
      <button class="icon-btn danger" title="Remove" onclick="removeMergeFile(${i})">
        <i class="fa-solid fa-xmark"></i>
      </button>`;
    list.appendChild(li);
  });
  $('mergeBtn').disabled = state.mergeFiles.length < 2;
}

window.removeMergeFile = i => { state.mergeFiles.splice(i, 1); updateMergeList(); };

$('mergeInput').addEventListener('change', e => {
  Array.from(e.target.files).forEach(f => {
    if (f.type !== 'application/pdf') { showToast(`Skipped non-PDF: ${f.name}`, 'error'); return; }
    if (!validateFileSize(f)) return;
    state.mergeFiles.push(f);
  });
  updateMergeList(); e.target.value = '';
});

const mergeDropZone = $('mergeDropZone');
mergeDropZone.addEventListener('dragover', e => { e.preventDefault(); mergeDropZone.classList.add('drag-over'); });
mergeDropZone.addEventListener('dragleave', () => mergeDropZone.classList.remove('drag-over'));
mergeDropZone.addEventListener('drop', e => {
  e.preventDefault(); mergeDropZone.classList.remove('drag-over');
  Array.from(e.dataTransfer.files).forEach(f => {
    if (f.type === 'application/pdf' && validateFileSize(f)) state.mergeFiles.push(f);
  });
  updateMergeList();
});

$('mergeBtn').addEventListener('click', async () => {
  if (state.mergeFiles.length < 2) return;
  setLoading(true, `Merging ${state.mergeFiles.length} PDFs…`);
  try {
    const merged = await PDFLib.PDFDocument.create();
    for (const file of state.mergeFiles) {
      const buf  = await file.arrayBuffer();
      const doc  = await PDFLib.PDFDocument.load(buf, { ignoreEncryption: true });
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }
    downloadBytes(await merged.save(), 'merged.pdf');
    showToast(`Merged ${state.mergeFiles.length} PDFs successfully!`, 'success');
  } catch (err) {
    console.error('Merge error:', err);
    showToast(`Merge failed: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
});

/* =============================================
   SPLIT
   ============================================= */
function updateSplitHint() {
  $('splitPageCount').textContent = state.totalPages ? `Document has ${state.totalPages} pages` : '';
  if (state.totalPages) {
    $('splitTo').value = state.totalPages;
    $('splitFrom').max = $('splitTo').max = state.totalPages;
  }
}

$('splitBtn').addEventListener('click', async () => {
  if (!state.rawBytes) return;
  const from = parseInt($('splitFrom').value, 10);
  const to   = parseInt($('splitTo').value,   10);
  if (isNaN(from) || isNaN(to) || from < 1 || to > state.totalPages || from > to) {
    showToast('Invalid page range.', 'error'); return;
  }
  setLoading(true, 'Extracting pages…');
  try {
    // Load DIRECTLY from rawBytes — no rebuild needed for split
    const src  = await PDFLib.PDFDocument.load(state.rawBytes, { ignoreEncryption: true });
    const dest = await PDFLib.PDFDocument.create();
    const idxs = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
    const pages = await dest.copyPages(src, idxs);
    pages.forEach(p => dest.addPage(p));
    downloadBytes(await dest.save(), `pages_${from}-${to}.pdf`);
    showToast(`Extracted pages ${from}–${to}`, 'success');
  } catch (err) {
    console.error('Split error:', err);
    showToast(`Split failed: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
});

/* =============================================
   PAGES — Manage / Reorder / Delete / Rotate
   ============================================= */
let sortableInstance = null;

async function renderPageGrid() {
  if (!state.pdfJsDoc) return;
  const grid = $('pageGrid');
  grid.innerHTML = '';
  setLoading(true, 'Rendering page thumbnails…');
  try {
    for (let i = 0; i < state.pageOrder.length; i++) {
      const origIdx = state.pageOrder[i];
      const page    = await state.pdfJsDoc.getPage(origIdx + 1);
      const addRot  = state.pageRotations[origIdx] || 0;
      const vp      = page.getViewport({
        scale: CONFIG.THUMB_SCALE,
        rotation: (page.rotate + addRot) % 360,
      });

      const thumb = document.createElement('div');
      thumb.className = 'page-thumb';
      thumb.dataset.order = i;
      if (state.selectedPages.has(i)) thumb.classList.add('selected');

      const canvas = document.createElement('canvas');
      canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

      const label = document.createElement('div');
      label.className = 'page-thumb-label';
      label.textContent = `Page ${i + 1}`;

      const badge = document.createElement('div');
      badge.className = 'page-thumb-select';
      badge.innerHTML = '<i class="fa-solid fa-check" style="font-size:0.6rem"></i>';

      thumb.append(canvas, label, badge);

      if (addRot) {
        const rb = document.createElement('div');
        rb.className = 'page-rotation-badge';
        rb.textContent = `${addRot}°`;
        thumb.appendChild(rb);
      }

      thumb.addEventListener('click', () => {
        const idx = parseInt(thumb.dataset.order, 10);
        if (state.selectedPages.has(idx)) {
          state.selectedPages.delete(idx); thumb.classList.remove('selected');
        } else {
          state.selectedPages.add(idx); thumb.classList.add('selected');
        }
        updatePageToolbarState();
      });

      grid.appendChild(thumb);
    }

    if (sortableInstance) sortableInstance.destroy();
    sortableInstance = Sortable.create(grid, {
      animation: 180,
      ghostClass: 'sortable-ghost',
      onEnd(evt) {
        const moved = state.pageOrder.splice(evt.oldIndex, 1)[0];
        state.pageOrder.splice(evt.newIndex, 0, moved);
        grid.querySelectorAll('.page-thumb').forEach((el, i) => {
          el.dataset.order = i;
          el.querySelector('.page-thumb-label').textContent = `Page ${i + 1}`;
        });
        state.selectedPages.clear();
        showToast('Pages reordered. Download to save changes.', 'info');
      },
    });
  } finally {
    setLoading(false);
  }
  updatePageToolbarState();
}

function updatePageToolbarState() {
  const has = state.selectedPages.size > 0;
  $('deleteSelectedBtn').disabled = !has;
  $('rotateLeftBtn').disabled  = !has;
  $('rotateRightBtn').disabled = !has;
}

$('selectAllBtn').addEventListener('click', () => {
  for (let i = 0; i < state.pageOrder.length; i++) state.selectedPages.add(i);
  document.querySelectorAll('.page-thumb').forEach(t => t.classList.add('selected'));
  updatePageToolbarState();
});
$('deselectAllBtn').addEventListener('click', () => {
  state.selectedPages.clear();
  document.querySelectorAll('.page-thumb').forEach(t => t.classList.remove('selected'));
  updatePageToolbarState();
});

$('deleteSelectedBtn').addEventListener('click', async () => {
  if (!state.selectedPages.size) return;
  if (state.selectedPages.size >= state.pageOrder.length) {
    showToast('Cannot delete all pages.', 'error'); return;
  }
  if (!confirm(`Delete ${state.selectedPages.size} page(s)? This cannot be undone.`)) return;

  [...state.selectedPages].sort((a, b) => b - a).forEach(i => state.pageOrder.splice(i, 1));
  state.selectedPages.clear();
  state.totalPages = state.pageOrder.length;
  state.currentPreviewPage = Math.min(state.currentPreviewPage, state.totalPages);
  updatePageControls();
  updateSplitHint();
  await renderPageGrid();
  renderPreview(state.currentPreviewPage);
  showToast('Pages deleted.', 'success');
});

async function rotateSelected(deg) {
  if (!state.selectedPages.size) return;
  const count = state.selectedPages.size;
  state.selectedPages.forEach(orderIdx => {
    const origIdx = state.pageOrder[orderIdx];
    state.pageRotations[origIdx] = ((state.pageRotations[origIdx] || 0) + deg + 360) % 360;
  });
  state.selectedPages.clear();
  await renderPageGrid();
  renderPreview(state.currentPreviewPage);
  showToast(`Rotated ${count} page(s).`, 'success');
}
$('rotateLeftBtn').addEventListener('click',  () => rotateSelected(-90));
$('rotateRightBtn').addEventListener('click', () => rotateSelected(90));

/* =============================================
   CORE: getRebuildBytes
   Applies current pageOrder + rotations to rawBytes.
   Returns a new Uint8Array representing the full edited PDF.
   ============================================= */
async function getRebuildBytes() {
  if (!state.rawBytes) throw new Error('No PDF loaded');
  const src    = await PDFLib.PDFDocument.load(state.rawBytes, { ignoreEncryption: true });
  const newDoc = await PDFLib.PDFDocument.create();
  // Copy pages in current display order
  const pages  = await newDoc.copyPages(src, state.pageOrder);
  pages.forEach((page, i) => {
    const origIdx = state.pageOrder[i];
    const addRot  = state.pageRotations[origIdx] || 0;
    if (addRot) {
      page.setRotation(PDFLib.degrees((page.getRotation().angle + addRot) % 360));
    }
    newDoc.addPage(page);
  });
  return newDoc.save();
}

/**
 * After any edit that changes page content (text/image/sig),
 * persist the result so future edits chain correctly.
 * After save, rawBytes represent a linear 1-N page doc, so reset order.
 */
async function applyNewBytes(bytes) {
  const prevPage = state.currentPreviewPage;
  // After getRebuildBytes + edit, the resulting doc has pages in order 0..N-1
  state.rawBytes = bytes;
  state.pdfJsDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  state.totalPages = state.pdfJsDoc.numPages;
  state.pageOrder = Array.from({ length: state.totalPages }, (_, i) => i);
  state.pageRotations = {};
  state.currentPreviewPage = Math.min(prevPage, state.totalPages);
  updatePageControls();
  updateSplitHint();
  await renderPreview(state.currentPreviewPage);
}

/* =============================================
   TEXT OVERLAY
   ============================================= */
$('textPickBtn').addEventListener('click', () => {
  setPlacementMode(state.placementMode === 'text' ? null : 'text', 'textPickBtn');
});

$('addTextBtn').addEventListener('click', async () => {
  if (!state.rawBytes) return;
  const text = $('overlayText').value.trim();
  if (!text) { showToast('Please enter some text.', 'error'); return; }
  const pageNum = parseInt($('textPage').value, 10);
  if (!validPage(pageNum)) return;
  const size  = Math.max(1, parseFloat($('textSize').value) || 24);
  const x     = parseFloat($('textX').value)     || 0;
  const yTop  = parseFloat($('textY').value)     || 0;
  const color = hexToRgb($('textColor').value);

  setLoading(true, 'Adding text…');
  try {
    // Build with page order/rotations baked in first
    const base = await getRebuildBytes();
    const doc  = await PDFLib.PDFDocument.load(base, { ignoreEncryption: true });
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const page = doc.getPages()[pageNum - 1];
    const { height } = page.getSize();
    // Input Y is from top; PDF origin is bottom-left, so invert
    page.drawText(text, {
      x, y: height - yTop - size, size, font,
      color: PDFLib.rgb(color.r / 255, color.g / 255, color.b / 255),
    });
    await applyNewBytes(await doc.save());
    setPlacementMode(null);
    showToast('Text added! Preview updated.', 'success');
  } catch (err) {
    console.error('Text error:', err);
    showToast(`Failed to add text: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
});

/* =============================================
   IMAGE OVERLAY
   ============================================= */
$('imgPickBtn').addEventListener('click', () => {
  setPlacementMode(state.placementMode === 'image' ? null : 'image', 'imgPickBtn');
});

$('addImageBtn').addEventListener('click', async () => {
  if (!state.rawBytes) return;
  const fileEl = $('overlayImageInput');
  if (!fileEl.files[0]) { showToast('Please select an image file.', 'error'); return; }
  const file    = fileEl.files[0];
  const pageNum = parseInt($('imgPage').value, 10);
  if (!validPage(pageNum)) return;
  const x    = parseFloat($('imgX').value) || 0;
  const yTop = parseFloat($('imgY').value) || 0;
  const w    = parseFloat($('imgW').value) || 150;
  const h    = parseFloat($('imgH').value) || 100;

  setLoading(true, 'Embedding image…');
  try {
    const base   = await getRebuildBytes();
    const doc    = await PDFLib.PDFDocument.load(base, { ignoreEncryption: true });
    const imgBuf = await file.arrayBuffer();
    let img;
    if      (file.type === 'image/png')  img = await doc.embedPng(imgBuf);
    else if (file.type === 'image/jpeg' || file.type === 'image/jpg') img = await doc.embedJpg(imgBuf);
    else { showToast('Only PNG and JPEG images supported.', 'error'); setLoading(false); return; }
    const page = doc.getPages()[pageNum - 1];
    page.drawImage(img, { x, y: page.getSize().height - yTop - h, width: w, height: h });
    await applyNewBytes(await doc.save());
    setPlacementMode(null);
    showToast('Image embedded! Preview updated.', 'success');
  } catch (err) {
    console.error('Image error:', err);
    showToast(`Failed to embed image: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
});

/* =============================================
   SIGNATURE
   ============================================= */
const sigCanvas = $('sigCanvas');
const sigCtx    = sigCanvas.getContext('2d');

$('clearSig').addEventListener('click', () => {
  sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
});

function getSigPos(e) {
  const rect = sigCanvas.getBoundingClientRect();
  const src  = e.touches ? e.touches[0] : e;
  return {
    x: (src.clientX - rect.left) * (sigCanvas.width  / rect.width),
    y: (src.clientY - rect.top)  * (sigCanvas.height / rect.height),
  };
}

// Mouse
sigCanvas.addEventListener('mousedown', e => {
  e.preventDefault(); state.sigDrawing = true;
  const p = getSigPos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x, p.y);
});
sigCanvas.addEventListener('mousemove', e => {
  e.preventDefault(); if (!state.sigDrawing) return;
  const p = getSigPos(e);
  sigCtx.strokeStyle = $('sigColor').value;
  sigCtx.lineWidth   = +$('sigStroke').value;
  sigCtx.lineCap = 'round'; sigCtx.lineJoin = 'round';
  sigCtx.lineTo(p.x, p.y); sigCtx.stroke();
});
sigCanvas.addEventListener('mouseup',    () => { state.sigDrawing = false; });
sigCanvas.addEventListener('mouseleave', () => { state.sigDrawing = false; });

// Touch
sigCanvas.addEventListener('touchstart', e => {
  e.preventDefault(); state.sigDrawing = true;
  const p = getSigPos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x, p.y);
}, { passive: false });
sigCanvas.addEventListener('touchmove', e => {
  e.preventDefault(); if (!state.sigDrawing) return;
  const p = getSigPos(e);
  sigCtx.strokeStyle = $('sigColor').value;
  sigCtx.lineWidth   = +$('sigStroke').value;
  sigCtx.lineCap = 'round'; sigCtx.lineJoin = 'round';
  sigCtx.lineTo(p.x, p.y); sigCtx.stroke();
}, { passive: false });
sigCanvas.addEventListener('touchend', () => { state.sigDrawing = false; });

$('sigPickBtn').addEventListener('click', () => {
  setPlacementMode(state.placementMode === 'signature' ? null : 'signature', 'sigPickBtn');
});

$('addSigBtn').addEventListener('click', async () => {
  if (!state.rawBytes) return;
  const data = sigCtx.getImageData(0, 0, sigCanvas.width, sigCanvas.height);
  if (!data.data.some(v => v > 0)) { showToast('Please draw a signature first.', 'error'); return; }
  const pageNum = parseInt($('sigPage').value, 10);
  if (!validPage(pageNum)) return;
  const x    = parseFloat($('sigX').value) || 50;
  const yTop = parseFloat($('sigY').value) || 50;
  const w    = parseFloat($('sigW').value) || 200;
  const h    = parseFloat($('sigH').value) || 80;

  setLoading(true, 'Embedding signature…');
  try {
    const pngBytes = dataURLtoBytes(sigCanvas.toDataURL('image/png'));
    const base = await getRebuildBytes();
    const doc  = await PDFLib.PDFDocument.load(base, { ignoreEncryption: true });
    const img  = await doc.embedPng(pngBytes);
    const page = doc.getPages()[pageNum - 1];
    page.drawImage(img, { x, y: page.getSize().height - yTop - h, width: w, height: h });
    await applyNewBytes(await doc.save());
    setPlacementMode(null);
    showToast('Signature embedded! Preview updated.', 'success');
  } catch (err) {
    console.error('Signature error:', err);
    showToast(`Failed to embed signature: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
});

/* =============================================
   SECURITY
   ============================================= */
$('applyPwdBtn').addEventListener('click', async () => {
  if (!state.rawBytes) return;
  const userPwd = $('userPassword').value;
  if (!userPwd) { showToast('Please enter a user password.', 'error'); return; }
  setLoading(true, 'Preparing PDF for download…');
  try {
    // pdf-lib 1.x does not support writing encrypted PDFs — save as-is
    const bytes = await getRebuildBytes();
    downloadBytes(bytes, 'document.pdf');
    showToast(
      'PDF saved without encryption (pdf-lib limitation). ' +
      'Run: qpdf --encrypt ' + userPwd + ' ' + ($('ownerPassword').value || userPwd) + ' 256 -- doc.pdf out.pdf',
      'info', 8000
    );
  } catch (err) {
    console.error('Security error:', err);
    showToast(`Failed: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
});

/* =============================================
   DOWNLOAD
   ============================================= */
$('downloadBtn').addEventListener('click', async () => {
  if (!state.rawBytes) return;
  setLoading(true, 'Building final PDF…');
  try {
    const bytes = await getRebuildBytes();
    downloadBytes(bytes, 'edited.pdf');
    showToast('PDF downloaded!', 'success');
  } catch (err) {
    console.error('Download error:', err);
    showToast(`Download failed: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
});

/* =============================================
   UTILITIES
   ============================================= */
function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16) } : { r:0,g:0,b:0 };
}

function dataURLtoBytes(dataURL) {
  const b64 = dataURL.split(',')[1];
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

/* =============================================
   INIT
   ============================================= */
enableButtons(false);
console.log('%c PDF Studio v2 ', 'background:#4f8ef7;color:white;font-size:1.2rem;padding:4px 12px;border-radius:4px;');
console.log('All processing is 100% local. Nothing leaves your browser.');
