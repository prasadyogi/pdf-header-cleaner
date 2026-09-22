// Renders PDF pages to raster images in Node, for OCR fallback when a PDF
// has no extractable text layer (scanned pages, or text flattened to
// vector outlines). Uses pdfjs-dist's legacy Node rendering path with
// node-canvas. Isolated from lib/pdfToRows.ts's text-extraction path so the
// (much more common) text-based path never pays for canvas/tesseract setup.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createCanvas, Image } = require("canvas");

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
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

export async function loadPdfForRendering(buffer: Buffer) {
  const data = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({ data, isEvalSupported: false });
  return loadingTask.promise;
}

/** Renders one page at the given absolute rotation (degrees) to a PNG buffer. */
export async function renderPageToPng(doc: any, pageNum: number, rotation: number, scale: number): Promise<Buffer> {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale, rotation });
  const factory = new NodeCanvasFactory();
  const canvasAndContext = factory.create(viewport.width, viewport.height);
  try {
    await page.render({ canvasContext: canvasAndContext.context, viewport, canvasFactory: factory }).promise;
    return canvasAndContext.canvas.toBuffer("image/png");
  } finally {
    factory.destroy(canvasAndContext);
  }
}
