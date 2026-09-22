// Renders PDF pages to raster images in Node, for OCR fallback when a PDF
// has no extractable text layer (scanned pages, or text flattened to
// vector outlines). Uses pdfjs-dist's legacy Node rendering path with
// @napi-rs/canvas -- a prebuilt, dependency-free native canvas (unlike the
// `canvas` package, which needs Cairo/pixman system libraries to build from
// source and has no prebuilt binary for Vercel's build image, so it fails
// to install there). Isolated from lib/pdfToRows.ts's text-extraction path
// so the (much more common) text-based path never pays for canvas/tesseract
// setup.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createCanvas, Image } = require("@napi-rs/canvas");

// pdfjs-dist's Node rendering path expects a browser-like `Image` global to
// paint embedded raster images (logos, etc.) onto the canvas.
if (!(global as any).Image) {
  (global as any).Image = Image;
}

class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    return { canvas, context };
  }
  reset(canvasAndContext: { canvas: any; context: any }, width: number, height: number) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext: { canvas: any; context: any }) {
    // pdf.js also calls this internally (via its own cache) on transient
    // sub-canvases it creates for masks/patterns during rendering, not just
    // on the top-level canvas we create ourselves. @napi-rs/canvas's
    // Rust-backed Canvas can throw ("Failed to unwrap exclusive reference")
    // if mutated after pdf.js has already finished with it internally --
    // zeroing the size is just an optional early-free, so swallow that.
    try {
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
    } catch {
      // already released internally; nothing to do
    }
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

// pdf.js only honors a custom canvasFactory when it's passed to
// getDocument() (it's stored once on the document's transport and reused
// internally for every cache/mask/pattern canvas it creates during
// rendering). Passing it to page.render() instead -- which looks like the
// more obvious place -- is silently ignored: pdf.js then falls back to its
// own built-in Node factory (hardcoded to `require("canvas")`) for all of
// its *internal* canvases, which breaks once that package isn't installed.
const sharedCanvasFactory = new NodeCanvasFactory();

export async function loadPdfForRendering(buffer: Buffer) {
  const data = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({ data, isEvalSupported: false, canvasFactory: sharedCanvasFactory });
  return loadingTask.promise;
}

/** Renders one page at the given absolute rotation (degrees) to a PNG buffer. */
export async function renderPageToPng(doc: any, pageNum: number, rotation: number, scale: number): Promise<Buffer> {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale, rotation });
  const canvasAndContext = sharedCanvasFactory.create(viewport.width, viewport.height);
  await page.render({ canvasContext: canvasAndContext.context, viewport }).promise;
  // Note: no explicit destroy() here -- pdf.js's own render/cancel lifecycle
  // already destroys this same canvas internally once rendering finishes.
  return canvasAndContext.canvas.toBuffer("image/png");
}
