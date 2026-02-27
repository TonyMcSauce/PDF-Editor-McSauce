// ============================
// HARD LIBRARY CHECKS
// ============================
if (!window.PDFLib) throw new Error("pdf-lib not loaded.");
if (!window.pdfjsLib) throw new Error("pdf.js not loaded.");

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ============================
// HELPERS
// ============================
const $ = (id) => document.getElementById(id);

const S = {
  rawBytes: null,
  pdfPreview: null,
  pageCount: 0,
  pageOrder: [],
  rotations: {}, // pageIndex: degrees
  currentPage: 1,
};

// ============================
// FILE UPLOAD
// ============================
$("pdfUpload").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  S.rawBytes = await file.arrayBuffer();

  const loadingTask = pdfjsLib.getDocument({ data: S.rawBytes });
  S.pdfPreview = await loadingTask.promise;

  S.pageCount = S.pdfPreview.numPages;
  S.pageOrder = Array.from({ length: S.pageCount }, (_, i) => i);
  S.rotations = {};
  S.currentPage = 1;

  renderPage(S.currentPage);
  renderThumbnails();
  enableControls(true);
});

// ============================
// RENDER MAIN PAGE (pdf.js)
// ============================
async function renderPage(pageNumber) {
  const page = await S.pdfPreview.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1.4 });

  const canvas = $("pdfCanvas");
  const ctx = canvas.getContext("2d");

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({
    canvasContext: ctx,
    viewport,
  }).promise;

  $("pageInfo").textContent =
    `Page ${pageNumber} of ${S.pageCount}`;
}

// ============================
// THUMBNAILS + SORTABLE
// ============================
async function renderThumbnails() {
  const container = $("thumbnailContainer");
  container.innerHTML = "";

  for (let i = 0; i < S.pageOrder.length; i++) {
    const pageIndex = S.pageOrder[i];

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.dataset.index = i;
    thumb.textContent = pageIndex + 1;

    thumb.addEventListener("click", () => {
      S.currentPage = pageIndex + 1;
      renderPage(S.currentPage);
    });

    container.appendChild(thumb);
  }

  if (window.Sortable) {
    Sortable.create(container, {
      animation: 150,
      onEnd: (evt) => {
        const moved = S.pageOrder.splice(evt.oldIndex, 1)[0];
        S.pageOrder.splice(evt.newIndex, 0, moved);

        normalizePageOrder();
      },
    });
  }
}

// ============================
// DELETE CURRENT PAGE
// ============================
$("deletePage").addEventListener("click", () => {
  if (!S.pageOrder.length) return;

  const indexToRemove = S.currentPage - 1;
  S.pageOrder = S.pageOrder.filter(i => i !== indexToRemove);

  normalizePageOrder();

  if (S.currentPage > S.pageOrder.length)
    S.currentPage = S.pageOrder.length;

  renderThumbnails();
});

// ============================
// ROTATE CURRENT PAGE
// ============================
$("rotatePage").addEventListener("click", () => {
  const pageIndex = S.currentPage - 1;
  S.rotations[pageIndex] =
    ((S.rotations[pageIndex] || 0) + 90) % 360;
});

// ============================
// DOWNLOAD (SAFE REBUILD)
// ============================
$("downloadBtn").addEventListener("click", rebuild);

async function rebuild() {
  if (!S.rawBytes) return;

  // Strict validation
  const totalSrcPages = S.pageCount;

  const safeOrder = S.pageOrder.filter(i =>
    Number.isInteger(i) &&
    i >= 0 &&
    i < totalSrcPages
  );

  if (safeOrder.length !== S.pageOrder.length) {
    console.error("Corrupted pageOrder:", S.pageOrder);
    alert("Internal page order corruption detected.");
    return;
  }

  const srcDoc = await PDFLib.PDFDocument.load(S.rawBytes);
  const newDoc = await PDFLib.PDFDocument.create();

  const copiedPages = await newDoc.copyPages(srcDoc, safeOrder);

  copiedPages.forEach((page, idx) => {
    const originalIndex = safeOrder[idx];
    const rotation = S.rotations[originalIndex];

    if (rotation) {
      page.setRotation(
        PDFLib.degrees(rotation)
      );
    }

    newDoc.addPage(page);
  });

  const finalBytes = await newDoc.save();

  const blob = new Blob([finalBytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "modified.pdf";
  a.click();

  URL.revokeObjectURL(url);
}

// ============================
// STATE NORMALIZATION
// ============================
function normalizePageOrder() {
  S.pageOrder = S.pageOrder.filter(Number.isInteger);
  renderThumbnails();
}

// ============================
// NAVIGATION
// ============================
$("prevPage").addEventListener("click", () => {
  if (S.currentPage <= 1) return;
  S.currentPage--;
  renderPage(S.currentPage);
});

$("nextPage").addEventListener("click", () => {
  if (S.currentPage >= S.pageCount) return;
  S.currentPage++;
  renderPage(S.currentPage);
});

// ============================
// UTIL
// ============================
function enableControls(enabled) {
  [
    "prevPage",
    "nextPage",
    "deletePage",
    "rotatePage",
    "downloadBtn"
  ].forEach(id => {
    if ($(id)) $(id).disabled = !enabled;
  });
}
