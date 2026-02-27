/**
 * PDF Studio — script.js v3
 * Root causes of all failures fixed:
 *   1. page.getRotation() returns undefined on un-rotated pages — guard it
 *   2. PDFLib.degrees / PDFLib.StandardFonts / PDFLib.rgb — verified correct UMD names
 *   3. getRebuildBytes was losing edits — fixed chain
 *   4. Merge preview added
 */

'use strict';

/* ─── CONFIG ─────────────────────────────────────── */
const CFG = {
  MAX_MB:        50,
  WORKER:        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  THUMB_SCALE:   0.28,
  PREVIEW_SCALE: 1.4,
  ZOOM_STEP:     0.25,
  ZOOM_MIN:      0.5,
  ZOOM_MAX:      3.0,
};

pdfjsLib.GlobalWorkerOptions.workerSrc = CFG.WORKER;

/* ─── DESTRUCTURE pdf-lib ─────────────────────────
   The UMD bundle exposes everything on window.PDFLib.
   Destructure once here so we always use the right refs.
   This is the fix for "expected instance of e" errors —
   calling PDFLib.degrees(undefined) because getRotation()
   returned undefined on pages with no explicit rotation.
───────────────────────────────────────────────────── */
const {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  PageSizes,
} = PDFLib;

/* Safe wrapper — some pages have no explicit rotation; default to 0 */
function getPageRotationAngle(page) {
  try {
    const r = page.getRotation();
    return (r && typeof r.angle === 'number') ? r.angle : 0;
  } catch (_) { return 0; }
}

/* ─── STATE ───────────────────────────────────────── */
const S = {
  /* Main loaded PDF */
  pdfJsDoc:    null,   // PDF.js doc for rendering
  rawBytes:    null,   // Uint8Array — latest edited bytes
  pageOrder:   [],     // display order of original page indices
  pageRots:    {},     // { origIdx: extraDegrees }
  selectedPgs: new Set(),
  curPage:     1,
  totalPages:  0,
  zoom:        1.0,
  isDark:      true,

  /* Merge */
  mergeFiles:  [],     // File[]
  mergeJsDocs: [],     // pdfjsLib docs for merge preview
  mergeCurDoc: 0,      // which merge doc is previewed
  mergeCurPg:  1,

  /* Misc */
  sigDrawing:  false,
  placeMode:   null,   // null | 'text' | 'image' | 'signature'
};

/* ─── DOM ─────────────────────────────────────────── */
const $  = id => document.getElementById(id);
const show = el => el && el.classList.remove('hidden');
const hide = el => el && el.classList.add('hidden');

function toast(msg, type = 'info', ms = 4500) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  show(t);
  clearTimeout(t._t);
  t._t = setTimeout(() => hide(t), ms);
}

function loading(on, txt = 'Processing…') {
  $('loadingText').textContent = txt;
  on ? show($('loadingOverlay')) : hide($('loadingOverlay'));
}

function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(2) + ' MB';
}

function okSize(f) {
  if (f.size / 1048576 > CFG.MAX_MB) {
    toast(`File too large (${fmtSize(f.size)}). Max ${CFG.MAX_MB} MB.`, 'error');
    return false;
  }
  return true;
}

function okPage(n) {
  if (!Number.isFinite(n) || n < 1 || n > S.totalPages) {
    toast(`Page must be between 1 and ${S.totalPages}.`, 'error');
    return false;
  }
  return true;
}

window.togglePwd = id => {
  const el = $(id);
  el.type = el.type === 'password' ? 'text' : 'password';
};

/* ─── THEME ───────────────────────────────────────── */
$('themeToggle').addEventListener('click', () => {
  S.isDark = !S.isDark;
  document.documentElement.setAttribute('data-theme', S.isDark ? 'dark' : 'light');
  $('themeToggle').innerHTML = S.isDark
    ? '<i class="fa-solid fa-moon"></i>'
    : '<i class="fa-solid fa-sun"></i>';
});

/* ─── PANEL NAV ───────────────────────────────────── */
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    $(`panel-${btn.dataset.panel}`).classList.add('active');
    if (btn.dataset.panel === 'pages' && S.pdfJsDoc) renderGrid();
    if (btn.dataset.panel === 'merge') renderMergePreview();
  });
});

/* ─── UPLOAD ──────────────────────────────────────── */
async function loadFile(file) {
  if (!file || file.type !== 'application/pdf') {
    toast('Please select a valid PDF file.', 'error'); return;
  }
  if (!okSize(file)) return;
  loading(true, 'Loading PDF…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await ingestBytes(bytes, true);
    $('fileName').textContent = file.name;
    $('fileSize').textContent  = `${fmtSize(file.size)} · ${S.totalPages} pages`;
    hide($('dropZone')); show($('fileInfo'));
    enableBtns(true);
    updateSplitHint();
    await previewMain(1);
    toast(`Loaded: ${file.name} (${S.totalPages} pages)`, 'success');
  } catch (e) {
    console.error(e);
    toast(`Load failed: ${e.message}`, 'error');
  } finally {
    loading(false);
  }
}

/**
 * Ingest new bytes into state.
 * isNew=true  → full reset (new file upload)
 * isNew=false → preserve display state (after edit)
 */
async function ingestBytes(bytes, isNew = false) {
  S.rawBytes  = bytes;
  S.pdfJsDoc  = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  S.totalPages = S.pdfJsDoc.numPages;
  if (isNew) {
    S.pageOrder  = Array.from({ length: S.totalPages }, (_, i) => i);
    S.pageRots   = {};
    S.selectedPgs.clear();
    S.curPage = 1;
  }
}

function enableBtns(on) {
  ['downloadBtn','splitBtn','addTextBtn','addImageBtn','addSigBtn','applyPwdBtn','zoomIn','zoomOut']
    .forEach(id => { const el = $(id); if (el) el.disabled = !on; });
  updateNav();
}

/* File input */
$('fileInput').addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); });

/* Drop zone */
const dz = $('dropZone');
dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag-over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
dz.addEventListener('drop', e => {
  e.preventDefault(); dz.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop',     e => { if (e.target !== dz) e.preventDefault(); });

/* Clear */
$('clearFile').addEventListener('click', () => {
  Object.assign(S, { pdfJsDoc:null, rawBytes:null, pageOrder:[], pageRots:{}, totalPages:0, curPage:1 });
  S.selectedPgs.clear();
  show($('dropZone')); hide($('fileInfo'));
  $('fileInput').value = '';
  $('pageIndicator').textContent = '— / —';
  hide($('previewCanvas')); show($('previewPlaceholder'));
  $('pageGrid').innerHTML = '<p class="hint center">Upload a PDF to manage pages.</p>';
  clearPlacementOverlay();
  enableBtns(false);
});

/* ─── MAIN PREVIEW ────────────────────────────────── */
async function previewMain(pg) {
  if (!S.pdfJsDoc) return;
  pg = Math.max(1, Math.min(pg ?? S.curPage, S.totalPages));
  S.curPage = pg;

  const origIdx = S.pageOrder[pg - 1];
  const pdfPg   = await S.pdfJsDoc.getPage(origIdx + 1);
  const addRot  = S.pageRots[origIdx] || 0;
  const vp      = pdfPg.getViewport({ scale: CFG.PREVIEW_SCALE * S.zoom, rotation: (pdfPg.rotate + addRot) % 360 });

  const cv = $('previewCanvas');
  cv.width = vp.width; cv.height = vp.height;
  show(cv); hide($('previewPlaceholder'));
  await pdfPg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;

  updateNav();
  syncOverlay(cv);
}

function updateNav() {
  $('pageIndicator').textContent = S.totalPages ? `${S.curPage} / ${S.totalPages}` : '— / —';
  $('prevPage').disabled = !S.totalPages || S.curPage <= 1;
  $('nextPage').disabled = !S.totalPages || S.curPage >= S.totalPages;
}

$('prevPage').addEventListener('click', () => previewMain(S.curPage - 1));
$('nextPage').addEventListener('click', () => previewMain(S.curPage + 1));

$('zoomIn').addEventListener('click', () => {
  S.zoom = Math.min(CFG.ZOOM_MAX, +(S.zoom + CFG.ZOOM_STEP).toFixed(2));
  $('zoomLabel').textContent = Math.round(S.zoom * 100) + '%';
  previewMain();
});
$('zoomOut').addEventListener('click', () => {
  S.zoom = Math.max(CFG.ZOOM_MIN, +(S.zoom - CFG.ZOOM_STEP).toFixed(2));
  $('zoomLabel').textContent = Math.round(S.zoom * 100) + '%';
  previewMain();
});

/* ─── PLACEMENT OVERLAY ───────────────────────────── */
function syncOverlay(cv) {
  const ov = $('placementOverlay');
  if (!ov) return;
  ov.width  = cv.width;
  ov.height = cv.height;
}

function clearPlacementOverlay() {
  const ov = $('placementOverlay');
  if (!ov) return;
  ov.getContext('2d').clearRect(0, 0, ov.width, ov.height);
  ov.style.pointerEvents = 'none';
  $('previewWrap').classList.remove('placement-active');
}

$('placementOverlay').addEventListener('click', e => {
  if (!S.placeMode || !S.pdfJsDoc) return;
  const ov   = $('placementOverlay');
  const rect = ov.getBoundingClientRect();
  const cx   = (e.clientX - rect.left) * (ov.width  / rect.width);
  const cy   = (e.clientY - rect.top)  * (ov.height / rect.height);
  const scale = CFG.PREVIEW_SCALE * S.zoom;
  const px   = Math.round(cx / scale);
  const py   = Math.round(cy / scale);

  if (S.placeMode === 'text')      { $('textX').value = px; $('textY').value = py; }
  if (S.placeMode === 'image')     { $('imgX').value  = px; $('imgY').value  = py; }
  if (S.placeMode === 'signature') { $('sigX').value  = px; $('sigY').value  = py; }

  /* Draw crosshair */
  const ctx = ov.getContext('2d');
  ctx.clearRect(0, 0, ov.width, ov.height);
  ctx.strokeStyle = '#4f8ef7'; ctx.lineWidth = 1.5; ctx.setLineDash([5,3]);
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(ov.width, cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, ov.height); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#4f8ef7';
  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI*2); ctx.fill();
  ctx.font = 'bold 11px monospace'; ctx.fillText(`(${px}, ${py})`, cx + 8, cy - 5);

  toast(`Position set → X: ${px}, Y: ${py} (from top-left)`, 'success', 3000);
});

function setPlaceMode(mode, btnId) {
  /* Toggle off if same mode */
  if (S.placeMode === mode) { mode = null; }
  S.placeMode = mode;

  /* Reset all pick buttons */
  ['textPickBtn','imgPickBtn','sigPickBtn'].forEach(id => {
    const b = $(id);
    if (!b) return;
    b.classList.remove('active-pick');
    b.innerHTML = '<i class="fa-solid fa-crosshairs"></i> Pick on Page';
  });

  const ov = $('placementOverlay');
  if (mode) {
    ov.style.pointerEvents = 'all';
    $('previewWrap').classList.add('placement-active');
    const b = $(btnId);
    if (b) { b.classList.add('active-pick'); b.innerHTML = '<i class="fa-solid fa-xmark"></i> Cancel Pick'; }
    toast('Click anywhere on the preview to set position.', 'info', 4000);
  } else {
    clearPlacementOverlay();
  }
}

$('textPickBtn').addEventListener('click', () => setPlaceMode('text',      'textPickBtn'));
$('imgPickBtn' ).addEventListener('click', () => setPlaceMode('image',     'imgPickBtn'));
$('sigPickBtn' ).addEventListener('click', () => setPlaceMode('signature', 'sigPickBtn'));

/* ─── CORE: REBUILD ──────────────────────────────────
   Reconstruct a clean PDF from rawBytes applying
   current pageOrder and extra rotations.
   KEY FIX: guard getRotation() which can return undefined.
───────────────────────────────────────────────────── */
async function rebuild() {
  if (!S.rawBytes) throw new Error('No PDF loaded.');
  const src  = await PDFDocument.load(S.rawBytes, { ignoreEncryption: true });
  const dest = await PDFDocument.create();
  const pages = await dest.copyPages(src, S.pageOrder);
  pages.forEach((page, i) => {
    const origIdx = S.pageOrder[i];
    const extra   = S.pageRots[origIdx] || 0;
    if (extra !== 0) {
      const cur = getPageRotationAngle(page); /* safe — won't throw */
      page.setRotation(degrees((cur + extra) % 360));
    }
    dest.addPage(page);
  });
  return dest.save();
}

/**
 * After an overlay edit (text / image / sig), the saved bytes
 * represent a clean 1..N page doc. Reset order so subsequent
 * edits chain correctly.
 */
async function applyEdit(bytes) {
  const prevPage = S.curPage;
  S.rawBytes    = bytes;
  S.pdfJsDoc    = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  S.totalPages  = S.pdfJsDoc.numPages;
  S.pageOrder   = Array.from({ length: S.totalPages }, (_, i) => i);
  S.pageRots    = {};
  S.curPage     = Math.min(prevPage, S.totalPages);
  updateNav();
  updateSplitHint();
  await previewMain(S.curPage);
}

/* ─── MERGE ───────────────────────────────────────── */
function updateMergeList() {
  const list = $('mergeList');
  list.innerHTML = '';
  S.mergeFiles.forEach((f, i) => {
    const li = document.createElement('li');
    li.className = 'merge-item' + (i === S.mergeCurDoc ? ' merge-item-active' : '');
    li.innerHTML = `
      <i class="fa-solid fa-file-pdf"></i>
      <span class="merge-item-name" title="${f.name}">${f.name}</span>
      <small class="merge-item-size">${fmtSize(f.size)}</small>
      <button class="icon-btn" title="Preview" onclick="previewMergeDoc(${i})"><i class="fa-solid fa-eye"></i></button>
      <button class="icon-btn danger" title="Remove" onclick="removeMergeFile(${i})"><i class="fa-solid fa-xmark"></i></button>`;
    list.appendChild(li);
  });
  $('mergeBtn').disabled = S.mergeFiles.length < 2;

  /* Update merge preview nav */
  const total = S.mergeJsDocs.length;
  $('mergeDocLabel').textContent = total
    ? `PDF ${S.mergeCurDoc + 1} / ${total} — Page ${S.mergeCurPg} / ${total ? (S.mergeJsDocs[S.mergeCurDoc]?.numPages || '?') : '?'}`
    : 'No PDFs loaded';
  $('mergePrevDoc').disabled = S.mergeCurDoc <= 0;
  $('mergeNextDoc').disabled = S.mergeCurDoc >= total - 1;
  $('mergePrevPg').disabled  = S.mergeCurPg <= 1;
  $('mergeNextPg').disabled  = !total || S.mergeCurPg >= (S.mergeJsDocs[S.mergeCurDoc]?.numPages || 1);
}

window.removeMergeFile = i => {
  S.mergeFiles.splice(i, 1);
  S.mergeJsDocs.splice(i, 1);
  S.mergeCurDoc = Math.min(S.mergeCurDoc, S.mergeFiles.length - 1);
  if (S.mergeCurDoc < 0) S.mergeCurDoc = 0;
  S.mergeCurPg = 1;
  updateMergeList();
  renderMergePreview();
};

window.previewMergeDoc = i => {
  S.mergeCurDoc = i;
  S.mergeCurPg  = 1;
  renderMergePreview();
  updateMergeList();
};

async function addMergeFiles(files) {
  loading(true, 'Loading merge files…');
  try {
    for (const f of files) {
      if (f.type !== 'application/pdf') { toast(`Skipped (not PDF): ${f.name}`, 'error'); continue; }
      if (!okSize(f)) continue;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const jsDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      S.mergeFiles.push(f);
      S.mergeJsDocs.push(jsDoc);
    }
    S.mergeCurDoc = Math.max(0, S.mergeFiles.length - 1);
    S.mergeCurPg  = 1;
    updateMergeList();
    await renderMergePreview();
  } catch (e) {
    toast(`Error loading: ${e.message}`, 'error');
  } finally {
    loading(false);
  }
}

async function renderMergePreview() {
  const cvs = $('mergePreviewCanvas');
  const ph  = $('mergePreviewPlaceholder');
  if (!S.mergeJsDocs.length) { hide(cvs); show(ph); return; }

  const doc = S.mergeJsDocs[S.mergeCurDoc];
  if (!doc) return;
  S.mergeCurPg = Math.max(1, Math.min(S.mergeCurPg, doc.numPages));

  const pg = await doc.getPage(S.mergeCurPg);
  const vp = pg.getViewport({ scale: CFG.PREVIEW_SCALE });
  cvs.width = vp.width; cvs.height = vp.height;
  show(cvs); hide(ph);
  await pg.render({ canvasContext: cvs.getContext('2d'), viewport: vp }).promise;
  updateMergeList();
}

$('mergeInput').addEventListener('change', async e => {
  await addMergeFiles(Array.from(e.target.files));
  e.target.value = '';
});

const mdz = $('mergeDropZone');
mdz.addEventListener('dragover',  e => { e.preventDefault(); mdz.classList.add('drag-over'); });
mdz.addEventListener('dragleave', () => mdz.classList.remove('drag-over'));
mdz.addEventListener('drop', async e => {
  e.preventDefault(); mdz.classList.remove('drag-over');
  await addMergeFiles(Array.from(e.dataTransfer.files));
});

/* Merge preview navigation */
$('mergePrevDoc').addEventListener('click', () => { S.mergeCurDoc--; S.mergeCurPg = 1; renderMergePreview(); updateMergeList(); });
$('mergeNextDoc').addEventListener('click', () => { S.mergeCurDoc++; S.mergeCurPg = 1; renderMergePreview(); updateMergeList(); });
$('mergePrevPg' ).addEventListener('click', () => { S.mergeCurPg--; renderMergePreview(); });
$('mergeNextPg' ).addEventListener('click', () => { S.mergeCurPg++; renderMergePreview(); });

$('mergeBtn').addEventListener('click', async () => {
  if (S.mergeFiles.length < 2) return;
  loading(true, `Merging ${S.mergeFiles.length} PDFs…`);
  try {
    const merged = await PDFDocument.create();
    for (const f of S.mergeFiles) {
      const buf  = await f.arrayBuffer();
      const doc  = await PDFDocument.load(buf, { ignoreEncryption: true });
      const pgs  = await merged.copyPages(doc, doc.getPageIndices());
      pgs.forEach(p => merged.addPage(p));
    }
    dlBytes(await merged.save(), 'merged.pdf');
    toast(`Merged ${S.mergeFiles.length} PDFs!`, 'success');
  } catch (e) {
    console.error(e); toast(`Merge failed: ${e.message}`, 'error');
  } finally {
    loading(false);
  }
});

/* ─── SPLIT ───────────────────────────────────────── */
function updateSplitHint() {
  $('splitPageCount').textContent = S.totalPages ? `Document has ${S.totalPages} pages` : '';
  if (S.totalPages) {
    $('splitTo').value = S.totalPages;
    $('splitFrom').max = $('splitTo').max = S.totalPages;
  }
}

$('splitBtn').addEventListener('click', async () => {
  if (!S.rawBytes) return;
  const from = parseInt($('splitFrom').value, 10);
  const to   = parseInt($('splitTo').value,   10);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to > S.totalPages || from > to) {
    toast('Invalid page range.', 'error'); return;
  }
  loading(true, 'Splitting…');
  try {
    const src  = await PDFDocument.load(S.rawBytes, { ignoreEncryption: true });
    const dest = await PDFDocument.create();
    const idxs = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
    const pgs  = await dest.copyPages(src, idxs);
    pgs.forEach(p => dest.addPage(p));
    dlBytes(await dest.save(), `pages_${from}-${to}.pdf`);
    toast(`Extracted pages ${from}–${to}`, 'success');
  } catch (e) {
    console.error(e); toast(`Split failed: ${e.message}`, 'error');
  } finally {
    loading(false);
  }
});

/* ─── PAGES GRID ──────────────────────────────────── */
let sortable = null;

async function renderGrid() {
  if (!S.pdfJsDoc) return;
  const grid = $('pageGrid');
  grid.innerHTML = '';
  loading(true, 'Rendering thumbnails…');
  try {
    for (let i = 0; i < S.pageOrder.length; i++) {
      const origIdx = S.pageOrder[i];
      const pg      = await S.pdfJsDoc.getPage(origIdx + 1);
      const addRot  = S.pageRots[origIdx] || 0;
      const vp      = pg.getViewport({ scale: CFG.THUMB_SCALE, rotation: (pg.rotate + addRot) % 360 });

      const thumb = document.createElement('div');
      thumb.className = 'page-thumb' + (S.selectedPgs.has(i) ? ' selected' : '');
      thumb.dataset.order = i;

      const cv = document.createElement('canvas');
      cv.width = vp.width; cv.height = vp.height;
      await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;

      const lbl = document.createElement('div');
      lbl.className = 'page-thumb-label';
      lbl.textContent = `Page ${i + 1}`;

      const chk = document.createElement('div');
      chk.className = 'page-thumb-select';
      chk.innerHTML = '<i class="fa-solid fa-check" style="font-size:.6rem"></i>';

      thumb.append(cv, lbl, chk);
      if (addRot) {
        const rb = document.createElement('div');
        rb.className = 'page-rotation-badge'; rb.textContent = `${addRot}°`;
        thumb.appendChild(rb);
      }

      thumb.addEventListener('click', () => {
        const idx = +thumb.dataset.order;
        S.selectedPgs.has(idx) ? (S.selectedPgs.delete(idx), thumb.classList.remove('selected'))
                                : (S.selectedPgs.add(idx),    thumb.classList.add('selected'));
        updateGridBtns();
      });
      grid.appendChild(thumb);
    }

    if (sortable) sortable.destroy();
    sortable = Sortable.create(grid, {
      animation: 160, ghostClass: 'sortable-ghost',
      onEnd(ev) {
        const moved = S.pageOrder.splice(ev.oldIndex, 1)[0];
        S.pageOrder.splice(ev.newIndex, 0, moved);
        grid.querySelectorAll('.page-thumb').forEach((el, i) => {
          el.dataset.order = i;
          el.querySelector('.page-thumb-label').textContent = `Page ${i + 1}`;
        });
        S.selectedPgs.clear(); toast('Pages reordered. Download to save.', 'info');
      },
    });
  } finally { loading(false); }
  updateGridBtns();
}

function updateGridBtns() {
  const has = S.selectedPgs.size > 0;
  $('deleteSelectedBtn').disabled = !has;
  $('rotateLeftBtn').disabled  = !has;
  $('rotateRightBtn').disabled = !has;
}

$('selectAllBtn').addEventListener('click', () => {
  S.pageOrder.forEach((_, i) => S.selectedPgs.add(i));
  document.querySelectorAll('.page-thumb').forEach(t => t.classList.add('selected'));
  updateGridBtns();
});
$('deselectAllBtn').addEventListener('click', () => {
  S.selectedPgs.clear();
  document.querySelectorAll('.page-thumb').forEach(t => t.classList.remove('selected'));
  updateGridBtns();
});

$('deleteSelectedBtn').addEventListener('click', async () => {
  if (!S.selectedPgs.size) return;
  if (S.selectedPgs.size >= S.pageOrder.length) { toast('Cannot delete all pages.', 'error'); return; }
  if (!confirm(`Delete ${S.selectedPgs.size} page(s)?`)) return;
  [...S.selectedPgs].sort((a,b)=>b-a).forEach(i => S.pageOrder.splice(i,1));
  S.selectedPgs.clear();
  S.totalPages = S.pageOrder.length;
  S.curPage    = Math.min(S.curPage, S.totalPages);
  updateNav(); updateSplitHint();
  await renderGrid(); previewMain(S.curPage);
  toast('Pages deleted.', 'success');
});

async function rotateSel(deg) {
  if (!S.selectedPgs.size) return;
  const cnt = S.selectedPgs.size;
  S.selectedPgs.forEach(i => {
    const orig = S.pageOrder[i];
    S.pageRots[orig] = ((S.pageRots[orig] || 0) + deg + 360) % 360;
  });
  S.selectedPgs.clear();
  await renderGrid(); previewMain(S.curPage);
  toast(`Rotated ${cnt} page(s).`, 'success');
}
$('rotateLeftBtn').addEventListener('click',  () => rotateSel(-90));
$('rotateRightBtn').addEventListener('click', () => rotateSel(90));

/* ─── TEXT OVERLAY ────────────────────────────────── */
$('addTextBtn').addEventListener('click', async () => {
  if (!S.rawBytes) return;
  const text = $('overlayText').value.trim();
  if (!text) { toast('Enter some text first.', 'error'); return; }
  const pg   = parseInt($('textPage').value,  10); if (!okPage(pg)) return;
  const size = Math.max(1, parseFloat($('textSize').value) || 24);
  const x    = parseFloat($('textX').value) || 0;
  const yTop = parseFloat($('textY').value) || 0;
  const col  = hexRgb($('textColor').value);

  loading(true, 'Adding text…');
  try {
    const base  = await rebuild();
    const doc   = await PDFDocument.load(base, { ignoreEncryption: true });
    const font  = await doc.embedFont(StandardFonts.Helvetica);
    const page  = doc.getPages()[pg - 1];
    const { height } = page.getSize();
    page.drawText(text, {
      x, y: height - yTop - size,   /* convert top→bottom coords */
      size, font,
      color: rgb(col.r/255, col.g/255, col.b/255),
    });
    await applyEdit(await doc.save());
    setPlaceMode(null);
    toast('Text added!', 'success');
  } catch (e) {
    console.error(e); toast(`Text failed: ${e.message}`, 'error');
  } finally { loading(false); }
});

/* ─── IMAGE OVERLAY ───────────────────────────────── */
$('addImageBtn').addEventListener('click', async () => {
  if (!S.rawBytes) return;
  const fi = $('overlayImageInput');
  if (!fi.files[0]) { toast('Select an image file.', 'error'); return; }
  const f    = fi.files[0];
  const pg   = parseInt($('imgPage').value, 10); if (!okPage(pg)) return;
  const x    = parseFloat($('imgX').value) || 0;
  const yTop = parseFloat($('imgY').value) || 0;
  const w    = parseFloat($('imgW').value) || 150;
  const h    = parseFloat($('imgH').value) || 100;

  loading(true, 'Embedding image…');
  try {
    const base   = await rebuild();
    const doc    = await PDFDocument.load(base, { ignoreEncryption: true });
    const imgBuf = await f.arrayBuffer();
    const img    = f.type === 'image/png'
      ? await doc.embedPng(imgBuf)
      : await doc.embedJpg(imgBuf);
    const page   = doc.getPages()[pg - 1];
    page.drawImage(img, { x, y: page.getSize().height - yTop - h, width: w, height: h });
    await applyEdit(await doc.save());
    setPlaceMode(null);
    toast('Image embedded!', 'success');
  } catch (e) {
    console.error(e); toast(`Image failed: ${e.message}`, 'error');
  } finally { loading(false); }
});

/* ─── SIGNATURE ───────────────────────────────────── */
const sigCv  = $('sigCanvas');
const sigCtx = sigCv.getContext('2d');
$('clearSig').addEventListener('click', () => sigCtx.clearRect(0, 0, sigCv.width, sigCv.height));

function sigPos(e) {
  const r  = sigCv.getBoundingClientRect();
  const src = e.touches ? e.touches[0] : e;
  return { x: (src.clientX-r.left)*(sigCv.width/r.width), y: (src.clientY-r.top)*(sigCv.height/r.height) };
}
sigCv.addEventListener('mousedown',  e => { e.preventDefault(); S.sigDrawing=true; const p=sigPos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x,p.y); });
sigCv.addEventListener('mousemove',  e => { e.preventDefault(); if(!S.sigDrawing)return; const p=sigPos(e); sigCtx.strokeStyle=$('sigColor').value; sigCtx.lineWidth=+$('sigStroke').value; sigCtx.lineCap='round'; sigCtx.lineJoin='round'; sigCtx.lineTo(p.x,p.y); sigCtx.stroke(); });
sigCv.addEventListener('mouseup',    () => { S.sigDrawing=false; });
sigCv.addEventListener('mouseleave', () => { S.sigDrawing=false; });
sigCv.addEventListener('touchstart', e => { e.preventDefault(); S.sigDrawing=true; const p=sigPos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x,p.y); }, {passive:false});
sigCv.addEventListener('touchmove',  e => { e.preventDefault(); if(!S.sigDrawing)return; const p=sigPos(e); sigCtx.strokeStyle=$('sigColor').value; sigCtx.lineWidth=+$('sigStroke').value; sigCtx.lineCap='round'; sigCtx.lineJoin='round'; sigCtx.lineTo(p.x,p.y); sigCtx.stroke(); }, {passive:false});
sigCv.addEventListener('touchend',   () => { S.sigDrawing=false; });

$('addSigBtn').addEventListener('click', async () => {
  if (!S.rawBytes) return;
  const px = sigCtx.getImageData(0,0,sigCv.width,sigCv.height);
  if (!px.data.some(v=>v>0)) { toast('Draw a signature first.', 'error'); return; }
  const pg   = parseInt($('sigPage').value, 10); if (!okPage(pg)) return;
  const x    = parseFloat($('sigX').value) || 50;
  const yTop = parseFloat($('sigY').value) || 50;
  const w    = parseFloat($('sigW').value) || 200;
  const h    = parseFloat($('sigH').value) || 80;

  loading(true, 'Embedding signature…');
  try {
    const pngBytes = du2bytes(sigCv.toDataURL('image/png'));
    const base  = await rebuild();
    const doc   = await PDFDocument.load(base, { ignoreEncryption: true });
    const img   = await doc.embedPng(pngBytes);
    const page  = doc.getPages()[pg - 1];
    page.drawImage(img, { x, y: page.getSize().height - yTop - h, width: w, height: h });
    await applyEdit(await doc.save());
    setPlaceMode(null);
    toast('Signature embedded!', 'success');
  } catch (e) {
    console.error(e); toast(`Signature failed: ${e.message}`, 'error');
  } finally { loading(false); }
});

/* ─── SECURITY ────────────────────────────────────── */
$('applyPwdBtn').addEventListener('click', async () => {
  if (!S.rawBytes) return;
  const up = $('userPassword').value;
  if (!up) { toast('Enter a user password first.', 'error'); return; }
  loading(true, 'Saving PDF…');
  try {
    const bytes = await rebuild();
    dlBytes(bytes, 'document.pdf');
    toast(`PDF saved. To encrypt, run: qpdf --encrypt ${up} ${$('ownerPassword').value||up} 256 -- document.pdf encrypted.pdf`, 'info', 9000);
  } catch (e) {
    console.error(e); toast(`Failed: ${e.message}`, 'error');
  } finally { loading(false); }
});

/* ─── DOWNLOAD ────────────────────────────────────── */
$('downloadBtn').addEventListener('click', async () => {
  if (!S.rawBytes) return;
  loading(true, 'Building PDF…');
  try {
    dlBytes(await rebuild(), 'edited.pdf');
    toast('PDF downloaded!', 'success');
  } catch (e) {
    console.error(e); toast(`Download failed: ${e.message}`, 'error');
  } finally { loading(false); }
});

/* ─── UTILS ───────────────────────────────────────── */
function dlBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a   = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function hexRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? { r:parseInt(m[1],16), g:parseInt(m[2],16), b:parseInt(m[3],16) } : {r:0,g:0,b:0};
}

function du2bytes(dataUrl) {
  const b = atob(dataUrl.split(',')[1]);
  const u = new Uint8Array(b.length);
  for (let i=0; i<b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}

/* ─── INIT ────────────────────────────────────────── */
enableBtns(false);
updateMergeList();
console.log('%c PDF Studio v3 ', 'background:#4f8ef7;color:#fff;font-size:1.1rem;padding:4px 14px;border-radius:4px');
