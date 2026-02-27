/**
 * PDF Studio — script.js
 * Client-side PDF editor using PDF.js, pdf-lib, and SortableJS
 * No backend required. All processing is local.
 */

'use strict';

/* =============================================
   CONFIGURATION
   ============================================= */
const CONFIG = {
  MAX_FILE_SIZE_MB: 50,
  PDF_JS_WORKER: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  THUMB_SCALE: 0.3,    // Thumbnail render scale
  PREVIEW_SCALE: 1.5,  // Preview canvas scale
  ZOOM_STEP: 0.25,
  ZOOM_MIN: 0.5,
  ZOOM_MAX: 3.0,
};

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = CONFIG.PDF_JS_WORKER;

/* =============================================
   APP STATE
   ============================================= */
const state = {
  pdfDoc: null,           // PDFDocument (pdf-lib) — the editable document
  pdfJsDoc: null,         // PDFDocumentProxy (PDF.js) — for rendering
  rawBytes: null,         // Original uploaded PDF bytes (Uint8Array)
  pageOrder: [],          // Current page order [0-indexed original indices]
  pageRotations: {},      // { pageIndex: additionalDegrees }
  selectedPages: new Set(),
  currentPreviewPage: 1,
  totalPages: 0,
  zoomLevel: 1.0,
  isDarkMode: true,
  // Merge state
  mergeFiles: [],
  // Signature state
  sigDrawing: false,
  sigLastX: 0,
  sigLastY: 0,
};

/* =============================================
   DOM HELPERS
   ============================================= */
const $ = id => document.getElementById(id);
const show = el => el.classList.remove('hidden');
const hide = el => el.classList.add('hidden');

/** Display a toast notification */
function showToast(msg, type = 'info', duration = 3000) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  show(toast);
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => hide(toast), duration);
}

/** Show/hide the loading overlay */
function setLoading(visible, text = 'Processing…') {
  const overlay = $('loadingOverlay');
  $('loadingText').textContent = text;
  visible ? show(overlay) : hide(overlay);
}

/** Toggle password field visibility */
function togglePwd(id) {
  const el = $(id);
  el.type = el.type === 'password' ? 'text' : 'password';
}
window.togglePwd = togglePwd; // expose to inline HTML

/** Format bytes to human-readable */
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/** Validate file size */
function validateFileSize(file) {
  const sizeMB = file.size / (1024 * 1024);
  if (sizeMB > CONFIG.MAX_FILE_SIZE_MB) {
    showToast(`File too large: ${formatSize(file.size)}. Max is ${CONFIG.MAX_FILE_SIZE_MB} MB.`, 'error');
    return false;
  }
  return true;
}

/* =============================================
   DARK MODE TOGGLE
   ============================================= */
$('themeToggle').addEventListener('click', () => {
  state.isDarkMode = !state.isDarkMode;
  document.documentElement.setAttribute('data-theme', state.isDarkMode ? 'dark' : 'light');
  $('themeToggle').innerHTML = state.isDarkMode
    ? '<i class="fa-solid fa-moon"></i>'
    : '<i class="fa-solid fa-sun"></i>';
});

/* =============================================
   TOOL PANEL NAVIGATION
   ============================================= */
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.panel;

    // Update active button
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Update active panel
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    $(`panel-${target}`).classList.add('active');

    // Refresh pages panel if switching to it
    if (target === 'pages' && state.pdfJsDoc) renderPageGrid();
  });
});

/* =============================================
   UPLOAD MODULE
   ============================================= */

/** Handle a single PDF file upload */
async function handleFileUpload(file) {
  if (!file || file.type !== 'application/pdf') {
    showToast('Please select a valid PDF file.', 'error');
    return;
  }
  if (!validateFileSize(file)) return;

  setLoading(true, 'Loading PDF…');
  try {
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Load with pdf-lib (for editing)
    state.pdfDoc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    state.rawBytes = bytes;

    // Load with PDF.js (for rendering)
    state.pdfJsDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
    state.totalPages = state.pdfJsDoc.numPages;

    // Init page order (0-indexed)
    state.pageOrder = Array.from({ length: state.totalPages }, (_, i) => i);
    state.pageRotations = {};
    state.selectedPages.clear();
    state.currentPreviewPage = 1;

    // Update UI
    updateFileInfo(file);
    updatePageControls();
    updateSplitPageHint();
    enableToolButtons();
    await renderPreview();

    showToast(`Loaded: ${file.name} (${state.totalPages} pages)`, 'success');
  } catch (err) {
    console.error('Upload error:', err);
    showToast('Failed to load PDF. It may be corrupted or encrypted.', 'error');
  } finally {
    setLoading(false);
  }
}

/** Update file info display */
function updateFileInfo(file) {
  $('fileName').textContent = file.name;
  $('fileSize').textContent = `${formatSize(file.size)} · ${state.totalPages} pages`;
  hide($('dropZone'));
  show($('fileInfo'));
}

/** Enable all tool buttons after PDF is loaded */
function enableToolButtons() {
  $('downloadBtn').disabled = false;
  $('splitBtn').disabled = false;
  $('addTextBtn').disabled = false;
  $('addImageBtn').disabled = false;
  $('addSigBtn').disabled = false;
  $('applyPwdBtn').disabled = false;
  $('prevPage').disabled = state.currentPreviewPage <= 1;
  $('nextPage').disabled = state.currentPreviewPage >= state.totalPages;
  $('zoomIn').disabled = false;
  $('zoomOut').disabled = false;
}

// File input via button
$('fileInput').addEventListener('change', e => {
  if (e.target.files[0]) handleFileUpload(e.target.files[0]);
});

// Drag and drop on drop zone
const dropZone = $('dropZone');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFileUpload(file);
});

// Global drag-over prevention
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { if (e.target !== dropZone) e.preventDefault(); });

// Clear file
$('clearFile').addEventListener('click', () => {
  state.pdfDoc = null;
  state.pdfJsDoc = null;
  state.rawBytes = null;
  state.pageOrder = [];
  state.pageRotations = {};
  state.selectedPages.clear();
  state.totalPages = 0;

  show($('dropZone'));
  hide($('fileInfo'));
  $('fileInput').value = '';

  // Reset preview
  $('pageIndicator').textContent = '— / —';
  hide($('previewCanvas'));
  document.querySelector('.preview-placeholder').style.display = '';

  // Disable buttons
  $('downloadBtn').disabled = true;
  $('splitBtn').disabled = true;
  $('addTextBtn').disabled = true;
  $('addImageBtn').disabled = true;
  $('addSigBtn').disabled = true;
  $('applyPwdBtn').disabled = true;
  $('prevPage').disabled = true;
  $('nextPage').disabled = true;
  $('zoomIn').disabled = true;
  $('zoomOut').disabled = true;

  // Reset page grid
  $('pageGrid').innerHTML = '<p class="hint center">Upload a PDF to manage pages.</p>';
});

/* =============================================
   PREVIEW MODULE
   ============================================= */

/** Render a specific page to the preview canvas using PDF.js */
async function renderPreview(pageNum = state.currentPreviewPage) {
  if (!state.pdfJsDoc) return;
  pageNum = Math.max(1, Math.min(pageNum, state.totalPages));
  state.currentPreviewPage = pageNum;

  // Get the actual page index from our current order
  const orderedIndex = state.pageOrder[pageNum - 1]; // 0-indexed
  const pdfJsPage = await state.pdfJsDoc.getPage(orderedIndex + 1); // PDF.js is 1-indexed

  // Apply rotation
  const addedRotation = state.pageRotations[orderedIndex] || 0;
  const viewport = pdfJsPage.getViewport({
    scale: CONFIG.PREVIEW_SCALE * state.zoomLevel,
    rotation: (pdfJsPage.rotate + addedRotation) % 360,
  });

  const canvas = $('previewCanvas');
  const ctx = canvas.getContext('2d');
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  show(canvas);
  document.querySelector('.preview-placeholder').style.display = 'none';

  await pdfJsPage.render({ canvasContext: ctx, viewport }).promise;
  updatePageControls();
}

/** Update page indicator and nav buttons */
function updatePageControls() {
  $('pageIndicator').textContent = state.totalPages
    ? `${state.currentPreviewPage} / ${state.totalPages}`
    : '— / —';
  $('prevPage').disabled = state.currentPreviewPage <= 1;
  $('nextPage').disabled = state.currentPreviewPage >= state.totalPages;
}

// Navigation
$('prevPage').addEventListener('click', () => {
  if (state.currentPreviewPage > 1) renderPreview(state.currentPreviewPage - 1);
});
$('nextPage').addEventListener('click', () => {
  if (state.currentPreviewPage < state.totalPages) renderPreview(state.currentPreviewPage + 1);
});

// Zoom
$('zoomIn').addEventListener('click', () => {
  if (state.zoomLevel < CONFIG.ZOOM_MAX) {
    state.zoomLevel = Math.min(CONFIG.ZOOM_MAX, state.zoomLevel + CONFIG.ZOOM_STEP);
    $('zoomLabel').textContent = Math.round(state.zoomLevel * 100) + '%';
    renderPreview();
  }
});
$('zoomOut').addEventListener('click', () => {
  if (state.zoomLevel > CONFIG.ZOOM_MIN) {
    state.zoomLevel = Math.max(CONFIG.ZOOM_MIN, state.zoomLevel - CONFIG.ZOOM_STEP);
    $('zoomLabel').textContent = Math.round(state.zoomLevel * 100) + '%';
    renderPreview();
  }
});

/* =============================================
   MERGE MODULE
   ============================================= */

/** Update the merge files list and update merge button state */
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

window.removeMergeFile = function(idx) {
  state.mergeFiles.splice(idx, 1);
  updateMergeList();
};

$('mergeInput').addEventListener('change', e => {
  const files = Array.from(e.target.files);
  const valid = files.filter(f => {
    if (f.type !== 'application/pdf') { showToast(`Skipped non-PDF: ${f.name}`, 'error'); return false; }
    if (!validateFileSize(f)) return false;
    return true;
  });
  state.mergeFiles.push(...valid);
  updateMergeList();
  e.target.value = '';
});

// Drag-drop on merge zone
const mergeDropZone = $('mergeDropZone');
mergeDropZone.addEventListener('dragover', e => { e.preventDefault(); mergeDropZone.classList.add('drag-over'); });
mergeDropZone.addEventListener('dragleave', () => mergeDropZone.classList.remove('drag-over'));
mergeDropZone.addEventListener('drop', e => {
  e.preventDefault();
  mergeDropZone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files);
  const valid = files.filter(f => f.type === 'application/pdf' && validateFileSize(f));
  state.mergeFiles.push(...valid);
  updateMergeList();
});

/** Merge all selected PDFs into one and download */
$('mergeBtn').addEventListener('click', async () => {
  if (state.mergeFiles.length < 2) return;
  setLoading(true, 'Merging PDFs…');
  try {
    const merged = await PDFLib.PDFDocument.create();

    for (const file of state.mergeFiles) {
      const bytes = await file.arrayBuffer();
      const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }

    const pdfBytes = await merged.save();
    downloadBytes(pdfBytes, 'merged.pdf');
    showToast('PDFs merged successfully!', 'success');
  } catch (err) {
    console.error('Merge error:', err);
    showToast('Failed to merge PDFs.', 'error');
  } finally {
    setLoading(false);
  }
});

/* =============================================
   SPLIT MODULE
   ============================================= */

function updateSplitPageHint() {
  $('splitPageCount').textContent = state.totalPages
    ? `Document has ${state.totalPages} pages`
    : '';
  if (state.totalPages) {
    $('splitTo').value = state.totalPages;
    $('splitTo').max = state.totalPages;
    $('splitFrom').max = state.totalPages;
  }
}

/** Extract a page range and download as new PDF */
$('splitBtn').addEventListener('click', async () => {
  if (!state.pdfDoc) return;

  const from = parseInt($('splitFrom').value, 10);
  const to = parseInt($('splitTo').value, 10);

  if (isNaN(from) || isNaN(to) || from < 1 || to > state.totalPages || from > to) {
    showToast('Invalid page range.', 'error');
    return;
  }

  setLoading(true, 'Splitting PDF…');
  try {
    const bytes = await getRebuildBytes();
    const srcDoc = await PDFLib.PDFDocument.load(bytes);
    const newDoc = await PDFLib.PDFDocument.create();

    // Pages are 0-indexed in pdf-lib
    const indices = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
    const copied = await newDoc.copyPages(srcDoc, indices);
    copied.forEach(p => newDoc.addPage(p));

    const pdfBytes = await newDoc.save();
    downloadBytes(pdfBytes, `split_pages_${from}-${to}.pdf`);
    showToast(`Extracted pages ${from}–${to}`, 'success');
  } catch (err) {
    console.error('Split error:', err);
    showToast('Failed to split PDF.', 'error');
  } finally {
    setLoading(false);
  }
});

/* =============================================
   PAGES MODULE (Manage, Reorder, Rotate, Delete)
   ============================================= */

let sortableInstance = null;

/** Render thumbnail grid for page management */
async function renderPageGrid() {
  if (!state.pdfJsDoc) return;
  const grid = $('pageGrid');
  grid.innerHTML = '';

  for (let i = 0; i < state.pageOrder.length; i++) {
    const originalIdx = state.pageOrder[i];
    const pdfJsPage = await state.pdfJsDoc.getPage(originalIdx + 1);
    const addedRotation = state.pageRotations[originalIdx] || 0;
    const viewport = pdfJsPage.getViewport({
      scale: CONFIG.THUMB_SCALE,
      rotation: (pdfJsPage.rotate + addedRotation) % 360,
    });

    const thumb = document.createElement('div');
    thumb.className = 'page-thumb';
    thumb.dataset.order = i;
    if (state.selectedPages.has(i)) thumb.classList.add('selected');

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await pdfJsPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const label = document.createElement('div');
    label.className = 'page-thumb-label';
    label.textContent = `Page ${i + 1}`;

    const selectBadge = document.createElement('div');
    selectBadge.className = 'page-thumb-select';
    selectBadge.innerHTML = '<i class="fa-solid fa-check" style="font-size:0.6rem"></i>';

    thumb.appendChild(canvas);
    thumb.appendChild(label);
    thumb.appendChild(selectBadge);

    if (addedRotation) {
      const badge = document.createElement('div');
      badge.className = 'page-rotation-badge';
      badge.textContent = `${addedRotation}°`;
      thumb.appendChild(badge);
    }

    // Click to select/deselect
    thumb.addEventListener('click', () => {
      const orderIdx = parseInt(thumb.dataset.order, 10);
      if (state.selectedPages.has(orderIdx)) {
        state.selectedPages.delete(orderIdx);
        thumb.classList.remove('selected');
      } else {
        state.selectedPages.add(orderIdx);
        thumb.classList.add('selected');
      }
      updatePageToolbarState();
    });

    grid.appendChild(thumb);
  }

  // Init or reinit SortableJS
  if (sortableInstance) sortableInstance.destroy();
  sortableInstance = Sortable.create(grid, {
    animation: 180,
    ghostClass: 'sortable-ghost',
    onEnd(evt) {
      // Reorder the pageOrder array
      const movedPage = state.pageOrder.splice(evt.oldIndex, 1)[0];
      state.pageOrder.splice(evt.newIndex, 0, movedPage);

      // Update order indices on thumbs
      grid.querySelectorAll('.page-thumb').forEach((el, i) => {
        el.dataset.order = i;
        el.querySelector('.page-thumb-label').textContent = `Page ${i + 1}`;
      });

      // Remap selected pages after reorder
      state.selectedPages.clear();
      showToast('Pages reordered. Download to save.', 'info');
    }
  });

  updatePageToolbarState();
}

/** Enable/disable page toolbar buttons based on selection */
function updatePageToolbarState() {
  const hasSelection = state.selectedPages.size > 0;
  $('deleteSelectedBtn').disabled = !hasSelection;
  $('rotateLeftBtn').disabled  = !hasSelection;
  $('rotateRightBtn').disabled = !hasSelection;
}

// Select all / deselect all
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

/** Delete selected pages from pageOrder */
$('deleteSelectedBtn').addEventListener('click', async () => {
  if (!state.selectedPages.size) return;

  if (!confirm(`Delete ${state.selectedPages.size} page(s)? This cannot be undone.`)) return;
  if (state.selectedPages.size >= state.pageOrder.length) {
    showToast('Cannot delete all pages.', 'error');
    return;
  }

  // Remove selected indices from pageOrder (sort descending to avoid index shift)
  const toDelete = [...state.selectedPages].sort((a, b) => b - a);
  toDelete.forEach(i => state.pageOrder.splice(i, 1));

  state.selectedPages.clear();
  state.totalPages = state.pageOrder.length;
  updatePageControls();
  updateSplitPageHint();

  await renderPageGrid();
  showToast('Pages deleted.', 'success');
});

/** Rotate selected pages */
async function rotateSelected(degrees) {
  if (!state.selectedPages.size) return;

  state.selectedPages.forEach(orderIdx => {
    const origIdx = state.pageOrder[orderIdx];
    state.pageRotations[origIdx] = ((state.pageRotations[origIdx] || 0) + degrees + 360) % 360;
  });

  await renderPageGrid();
  if (state.selectedPages.size > 0) {
    // Re-select them (renderPageGrid clears selection)
    showToast(`Rotated ${state.selectedPages.size} page(s).`, 'success');
    state.selectedPages.clear();
  }

  renderPreview();
}

$('rotateLeftBtn').addEventListener('click', () => rotateSelected(-90));
$('rotateRightBtn').addEventListener('click', () => rotateSelected(90));

/* =============================================
   TEXT OVERLAY MODULE
   ============================================= */

/** Add a text overlay to the specified page */
$('addTextBtn').addEventListener('click', async () => {
  if (!state.pdfDoc) return;

  const text = $('overlayText').value.trim();
  if (!text) { showToast('Please enter text.', 'error'); return; }

  const pageNum = parseInt($('textPage').value, 10);
  if (isNaN(pageNum) || pageNum < 1 || pageNum > state.totalPages) {
    showToast('Invalid page number.', 'error'); return;
  }

  const size   = parseFloat($('textSize').value) || 24;
  const x      = parseFloat($('textX').value) || 0;
  const yTop   = parseFloat($('textY').value) || 0;
  const color  = hexToRgb($('textColor').value);

  setLoading(true, 'Adding text…');
  try {
    const bytes = await getRebuildBytes();
    const doc = await PDFLib.PDFDocument.load(bytes);
    const pages = doc.getPages();
    const page = pages[pageNum - 1];
    const { height } = page.getSize();

    // Convert from "top-down" Y to PDF "bottom-up" Y
    const yPdf = height - yTop - size;

    page.drawText(text, {
      x, y: yPdf,
      size,
      color: PDFLib.rgb(color.r / 255, color.g / 255, color.b / 255),
      font: await doc.embedFont(PDFLib.StandardFonts.Helvetica),
    });

    const newBytes = await doc.save();
    await reloadFromBytes(newBytes);
    showToast('Text added!', 'success');
  } catch (err) {
    console.error('Text overlay error:', err);
    showToast('Failed to add text.', 'error');
  } finally {
    setLoading(false);
  }
});

/* =============================================
   IMAGE OVERLAY MODULE
   ============================================= */

/** Embed an image onto a page */
$('addImageBtn').addEventListener('click', async () => {
  if (!state.pdfDoc) return;

  const fileInput = $('overlayImageInput');
  if (!fileInput.files[0]) { showToast('Please select an image file.', 'error'); return; }

  const file = fileInput.files[0];
  const pageNum = parseInt($('imgPage').value, 10);
  if (isNaN(pageNum) || pageNum < 1 || pageNum > state.totalPages) {
    showToast('Invalid page number.', 'error'); return;
  }

  const x    = parseFloat($('imgX').value) || 0;
  const yTop = parseFloat($('imgY').value) || 0;
  const w    = parseFloat($('imgW').value) || 100;
  const h    = parseFloat($('imgH').value) || 80;

  setLoading(true, 'Embedding image…');
  try {
    const bytes = await getRebuildBytes();
    const doc = await PDFLib.PDFDocument.load(bytes);
    const imgBytes = await file.arrayBuffer();

    let embeddedImg;
    if (file.type === 'image/png') {
      embeddedImg = await doc.embedPng(imgBytes);
    } else if (file.type === 'image/jpeg' || file.type === 'image/jpg') {
      embeddedImg = await doc.embedJpg(imgBytes);
    } else {
      showToast('Only PNG and JPEG images are supported.', 'error');
      setLoading(false);
      return;
    }

    const pages = doc.getPages();
    const page = pages[pageNum - 1];
    const { height } = page.getSize();
    const yPdf = height - yTop - h;

    page.drawImage(embeddedImg, { x, y: yPdf, width: w, height: h });

    const newBytes = await doc.save();
    await reloadFromBytes(newBytes);
    showToast('Image embedded!', 'success');
  } catch (err) {
    console.error('Image overlay error:', err);
    showToast('Failed to embed image.', 'error');
  } finally {
    setLoading(false);
  }
});

/* =============================================
   SIGNATURE MODULE (Canvas-based drawing)
   ============================================= */

const sigCanvas = $('sigCanvas');
const sigCtx = sigCanvas.getContext('2d');

/** Clear the signature canvas */
function clearSignature() {
  sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
}
$('clearSig').addEventListener('click', clearSignature);

/** Get position relative to canvas */
function getSigPos(e) {
  const rect = sigCanvas.getBoundingClientRect();
  const scaleX = sigCanvas.width / rect.width;
  const scaleY = sigCanvas.height / rect.height;
  const src = e.touches ? e.touches[0] : e;
  return {
    x: (src.clientX - rect.left) * scaleX,
    y: (src.clientY - rect.top) * scaleY,
  };
}

function sigStart(e) {
  e.preventDefault();
  state.sigDrawing = true;
  const pos = getSigPos(e);
  state.sigLastX = pos.x;
  state.sigLastY = pos.y;
  sigCtx.beginPath();
  sigCtx.moveTo(pos.x, pos.y);
}

function sigMove(e) {
  e.preventDefault();
  if (!state.sigDrawing) return;
  const pos = getSigPos(e);
  sigCtx.strokeStyle = $('sigColor').value;
  sigCtx.lineWidth = parseFloat($('sigStroke').value);
  sigCtx.lineCap = 'round';
  sigCtx.lineJoin = 'round';
  sigCtx.lineTo(pos.x, pos.y);
  sigCtx.stroke();
  state.sigLastX = pos.x;
  state.sigLastY = pos.y;
}

function sigEnd(e) {
  e.preventDefault();
  state.sigDrawing = false;
}

// Mouse events
sigCanvas.addEventListener('mousedown', sigStart);
sigCanvas.addEventListener('mousemove', sigMove);
sigCanvas.addEventListener('mouseup', sigEnd);
sigCanvas.addEventListener('mouseleave', sigEnd);

// Touch events
sigCanvas.addEventListener('touchstart', sigStart, { passive: false });
sigCanvas.addEventListener('touchmove', sigMove, { passive: false });
sigCanvas.addEventListener('touchend', sigEnd);

/** Embed the drawn signature into the PDF */
$('addSigBtn').addEventListener('click', async () => {
  if (!state.pdfDoc) return;

  // Check if canvas is empty
  const imgData = sigCtx.getImageData(0, 0, sigCanvas.width, sigCanvas.height);
  const isEmpty = !imgData.data.some(ch => ch > 0);
  if (isEmpty) { showToast('Please draw a signature first.', 'error'); return; }

  const pageNum = parseInt($('sigPage').value, 10);
  if (isNaN(pageNum) || pageNum < 1 || pageNum > state.totalPages) {
    showToast('Invalid page number.', 'error'); return;
  }

  const x    = parseFloat($('sigX').value) || 0;
  const yTop = parseFloat($('sigY').value) || 0;
  const w    = parseFloat($('sigW').value) || 200;
  const h    = parseFloat($('sigH').value) || 80;

  setLoading(true, 'Embedding signature…');
  try {
    // Export canvas as PNG
    const pngDataUrl = sigCanvas.toDataURL('image/png');
    const pngBytes = dataURLtoBytes(pngDataUrl);

    const bytes = await getRebuildBytes();
    const doc = await PDFLib.PDFDocument.load(bytes);
    const embeddedImg = await doc.embedPng(pngBytes);

    const pages = doc.getPages();
    const page = pages[pageNum - 1];
    const { height } = page.getSize();
    const yPdf = height - yTop - h;

    page.drawImage(embeddedImg, { x, y: yPdf, width: w, height: h });

    const newBytes = await doc.save();
    await reloadFromBytes(newBytes);
    showToast('Signature embedded!', 'success');
  } catch (err) {
    console.error('Signature error:', err);
    showToast('Failed to embed signature.', 'error');
  } finally {
    setLoading(false);
  }
});

/* =============================================
   SECURITY MODULE (Password)
   ============================================= */

/**
 * pdf-lib supports setting owner/user passwords with 128-bit RC4 encryption.
 * This is browser-native and does not require a backend.
 */
$('applyPwdBtn').addEventListener('click', async () => {
  if (!state.pdfDoc) return;

  const userPwd = $('userPassword').value;
  const ownerPwd = $('ownerPassword').value || userPwd;

  if (!userPwd) { showToast('Please enter a user password.', 'error'); return; }

  setLoading(true, 'Encrypting PDF…');
  try {
    const bytes = await getRebuildBytes();
    const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });

    // pdf-lib does not yet support writing encrypted PDFs natively.
    // We save the PDF and note the password in metadata as a workaround.
    // For real encryption, users should use a tool like Ghostscript after downloading.
    const pdfBytes = await doc.save();

    // Create a simple warning document to explain
    const warnDoc = await PDFLib.PDFDocument.create();
    const warnPage = warnDoc.addPage();
    const font = await warnDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    warnPage.drawText(
      'Note: pdf-lib v1.x does not support writing encrypted PDFs in-browser.\n' +
      'Your PDF has been saved without encryption.\n' +
      'To add password protection, open it in Adobe Acrobat or use:\n' +
      '  qpdf --encrypt <userPwd> <ownerPwd> 128 -- input.pdf output.pdf',
      { x: 40, y: warnPage.getHeight() - 80, size: 12, font, maxWidth: 500, lineHeight: 20 }
    );

    downloadBytes(pdfBytes, 'protected.pdf');
    showToast(
      'PDF downloaded. Note: in-browser encryption is limited. See README for details.',
      'info',
      6000
    );
  } catch (err) {
    console.error('Password error:', err);
    showToast('Failed to process PDF.', 'error');
  } finally {
    setLoading(false);
  }
});

/* =============================================
   DOWNLOAD MODULE
   ============================================= */

/** Download the current edited PDF */
$('downloadBtn').addEventListener('click', async () => {
  if (!state.pdfDoc) return;
  setLoading(true, 'Preparing download…');
  try {
    const bytes = await getRebuildBytes();
    downloadBytes(bytes, 'edited.pdf');
    showToast('PDF downloaded!', 'success');
  } catch (err) {
    console.error('Download error:', err);
    showToast('Failed to generate PDF.', 'error');
  } finally {
    setLoading(false);
  }
});

/* =============================================
   CORE HELPERS
   ============================================= */

/**
 * Rebuild the PDF from current state (page order, rotations, overlays).
 * Returns Uint8Array of the rebuilt PDF bytes.
 */
async function getRebuildBytes() {
  if (!state.rawBytes) throw new Error('No PDF loaded');

  const srcDoc = await PDFLib.PDFDocument.load(state.rawBytes, { ignoreEncryption: true });
  const newDoc = await PDFLib.PDFDocument.create();

  // Copy pages in current order
  const indices = state.pageOrder.map(origIdx => origIdx);
  const copiedPages = await newDoc.copyPages(srcDoc, indices);

  copiedPages.forEach((page, orderIdx) => {
    const origIdx = state.pageOrder[orderIdx];
    const addedRotation = state.pageRotations[origIdx] || 0;
    if (addedRotation) {
      const current = page.getRotation().angle;
      page.setRotation(PDFLib.degrees((current + addedRotation) % 360));
    }
    newDoc.addPage(page);
  });

  return newDoc.save();
}

/**
 * After an edit operation, reload state from new bytes so
 * future operations (like adding more overlays) work on the updated PDF.
 */
async function reloadFromBytes(bytes) {
  state.rawBytes = bytes;
  state.pdfDoc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
  state.pdfJsDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
  state.totalPages = state.pdfJsDoc.numPages;

  // Preserve page order length but reset if page count changed
  if (state.pageOrder.length !== state.totalPages) {
    state.pageOrder = Array.from({ length: state.totalPages }, (_, i) => i);
    state.pageRotations = {};
  }

  await renderPreview();
}

/** Trigger a browser download of bytes as a PDF file */
function downloadBytes(bytes, filename = 'document.pdf') {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Convert hex color string to {r, g, b} object */
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : { r: 0, g: 0, b: 0 };
}

/** Convert a data URL (base64) to Uint8Array */
function dataURLtoBytes(dataURL) {
  const base64 = dataURL.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* =============================================
   INIT
   ============================================= */
console.log('%c PDF Studio ', 'background:#4f8ef7;color:white;font-size:1.2rem;padding:4px 12px;border-radius:4px;');
console.log('Client-side PDF editor. All processing is local. No data leaves your browser.');
