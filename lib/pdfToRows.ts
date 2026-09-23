// Extracts table rows from a PDF buffer, detecting a header row that repeats
// across pages (keeping only its first occurrence) and reconstructing each
// row's columns from the PDF's text coordinates.
//
// Rotation handling: a page's declared /Rotate value (and any additional
// user-requested rotation) is applied via pdf.js's viewport transform BEFORE
// grouping text into lines/columns, so a sideways or upside-down page is
// read in its correct, upright orientation.

// Use the legacy Node build so it works without DOM/canvas.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

import { loadPdfForRendering, renderPageToPng } from "./ocrRender";
import os from "os";
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createWorker } = require("tesseract.js");

interface RawItem {
  str: string;
  x: number;
  y: number;
  width: number;
}

interface Line {
  page: number;
  y: number;
  items: RawItem[];
}

interface Token {
  text: string;
  x: number; // left edge
  right: number; // right edge
}

export interface ExtractResult {
  header: string[];
  rows: string[][];
  pageCount: number;
  warnings: string[];
  /** Degrees (90/180/270) the system auto-rotated pages by to find a table, if any. */
  rotationUsed?: number;
  /** True when the PDF has no extractable text at all (scanned image, or text flattened to outlines) -- rotation can't help. */
  noTextLayer?: boolean;
  /** True when the result came from OCR rather than the PDF's text layer. */
  usedOcr?: boolean;
}

const Y_TOLERANCE = 3; // px, for grouping items into the same line
// A gap this many average-char-widths wide starts a new column. Must sit
// strictly between a normal in-word/in-phrase space (~1x) and the smallest
// real column gutter (~2x for tightly padded fixed-width reports), so word
// spaces merge but column gaps split.
const GAP_MULTIPLIER = 1.6;
// OCR word bounding boxes are tight and precise (no synthesized padding),
// so on real dense reports adjacent-but-distinct short column headers (e.g.
// "...Cash ID | User Name...") can sit only marginally further apart than a
// same-column word gap (e.g. "Check No."). A stricter multiplier is needed
// here than for PDF-native glyph runs to avoid merging separate columns.
const OCR_GAP_MULTIPLIER = 1.4;
const MIN_HEADER_TOKENS = 2; // a real header/data row must look tabular (2+ fields)
// Absolute orientations tried (in order) when the page's declared rotation
// doesn't yield a table. 180° is tried last on purpose: a page's true
// correct orientation and its 180°-opposite can BOTH look structurally
// valid (same column count, just mirrored/reversed), so if we tried 180
// too early we could lock in a mirrored misread before ever trying the
// orientations more likely to be genuinely correct.
const ABSOLUTE_ROTATION_FALLBACK_ORDER = [0, 90, 270, 180];

function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function isPageArtifact(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  // "Page 1", "Page 1 of 10", bare page numbers, common report footers.
  // Checked as a substring (not requiring the whole line to be just this)
  // because a page-number fragment often shares a footer line with other
  // boilerplate (a report ID, a filter description) that lands at the same
  // y-position -- e.g. "Page 5 of 6        naguestleddetail". A line
  // containing a page-number fragment is never *also* a real data row.
  if (/\bpage\s*\d+(\s*(of|\/)\s*\d+)?\b/i.test(t)) return true;
  if (/^\d+\s*(\/|of)\s*\d+$/i.test(t)) return true;
  if (/^continued\b/i.test(t)) return true;
  return false;
}

/**
 * Some PDF generators (fixed-width/monospace-style reports) emit an entire
 * row as ONE text run, with columns separated by literal runs of spaces
 * inside the string, instead of one positioned run per field. If we don't
 * split those apart, the whole row collapses into a single token/column.
 * We approximate each field's x-position by its proportional character
 * offset within the original run's x/width span.
 */
function splitWideItem(item: RawItem): RawItem[] {
  if (item.width <= 0 || !/\s{2,}/.test(item.str)) return [item];

  const totalLen = item.str.length;
  const parts: RawItem[] = [];
  let offset = 0;

  for (const piece of item.str.split(/(\s{2,})/)) {
    const start = offset;
    const end = offset + piece.length;
    offset = end;
    if (piece.trim() === "") continue;

    const fracStart = start / totalLen;
    const fracEnd = end / totalLen;
    parts.push({
      str: piece,
      x: item.x + fracStart * item.width,
      y: item.y,
      width: (fracEnd - fracStart) * item.width,
    });
  }

  return parts.length > 0 ? parts : [item];
}

interface PageData {
  pageNum: number;
  nativeRotate: number;
  page: any; // PDFPageProxy, kept to build viewports on demand
  items: { str: string; transform: number[]; width: number }[];
}

/** Parses the PDF once and pulls out raw text runs, independent of rotation. */
async function loadPages(buffer: Buffer): Promise<{ pages: PageData[]; pageCount: number }> {
  const data = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({ data, isEvalSupported: false });
  const doc = await loadingTask.promise;
  const pages: PageData[] = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const items = (content.items as any[])
      .filter((it) => it.str !== undefined && it.str.trim() !== "")
      .map((it) => ({ str: it.str as string, transform: it.transform as number[], width: it.width ?? 0 }));
    pages.push({ pageNum, nativeRotate: page.rotate || 0, page, items });
  }

  return { pages, pageCount: doc.numPages };
}

/**
 * Projects each page's raw text runs into upright reading-order coordinates
 * for the given rotation deltas (degrees, keyed by page number; missing
 * pages default to 0), then groups them into lines.
 */
function projectPages(pages: PageData[], rotations: Record<number, number>): Line[] {
  const lines: Line[] = [];

  for (const pd of pages) {
    const total = normalizeAngle(pd.nativeRotate + (rotations[pd.pageNum] ?? 0));
    const viewport = pd.page.getViewport({ scale: 1, rotation: total });
    const pageLines: Line[] = [];

    for (const it of pd.items) {
      const t = it.transform; // [a, b, c, d, e, f] in PDF space; a/b encode font size, not advance width
      const startV = viewport.convertToViewportPoint(t[4], t[5]);
      // it.width is already the final advance width in PDF-space units, so we
      // only need the *direction* of the text run's local x-axis from the
      // matrix (normalized), not its raw (font-size-scaled) magnitude.
      const dirLen = Math.hypot(t[0], t[1]) || 1;
      const ux = t[0] / dirLen;
      const uy = t[1] / dirLen;
      const endPdfX = t[4] + it.width * ux;
      const endPdfY = t[5] + it.width * uy;
      const endV = viewport.convertToViewportPoint(endPdfX, endPdfY);

      const x = Math.min(startV[0], endV[0]);
      const right = Math.max(startV[0], endV[0]);
      const y = (startV[1] + endV[1]) / 2;

      let line = pageLines.find((l) => Math.abs(l.y - y) <= Y_TOLERANCE);
      if (!line) {
        line = { page: pd.pageNum, y, items: [] };
        pageLines.push(line);
      }
      line.items.push(...splitWideItem({ str: it.str, x, y, width: right - x }));
    }

    // Viewport space has y growing downward, so top of page is smallest y.
    pageLines.sort((a, b) => a.y - b.y);
    for (const line of pageLines) {
      line.items.sort((a, b) => a.x - b.x);
    }
    lines.push(...pageLines);
  }

  return lines;
}

/**
 * @param joinWithSpace Insert a space when merging adjacent items into one
 *   token, instead of concatenating directly. PDF glyph runs can be split
 *   mid-word by kerning (e.g. "Wor"+"ld"), where concatenating without a
 *   space is correct; OCR gives us whole words, where merging two adjacent
 *   words ("Destino"+"Hospitality") without a space would wrongly fuse them.
 */
function lineToTokens(line: Line, gapMultiplier: number, joinWithSpace = false): Token[] {
  const tokens: Token[] = [];
  const avgCharWidth =
    line.items.reduce((sum, it) => sum + (it.width || 1) / Math.max(it.str.length, 1), 0) /
      Math.max(line.items.length, 1) || 4;
  const gapThreshold = avgCharWidth * gapMultiplier;

  for (const item of line.items) {
    const text = item.str;
    if (text.trim() === "") continue;
    const itemRight = item.x + (item.width || text.length * avgCharWidth);
    const last = tokens[tokens.length - 1];
    if (last && item.x - last.right <= gapThreshold) {
      last.text += (joinWithSpace ? " " : "") + item.str;
      last.right = Math.max(last.right, itemRight);
    } else {
      tokens.push({ text, x: item.x, right: itemRight });
    }
  }

  return tokens.map((t) => ({ ...t, text: t.text.replace(/\s+/g, " ").trim() })).filter((t) => t.text !== "");
}

function lineText(line: Line): string {
  return line.items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
}

/** Splits a line's tokens into the given number of columns using boundary x-positions. */
function bucketTokens(tokens: Token[], boundaries: number[]): { text: string; count: number }[] {
  const cols = new Array(boundaries.length + 1).fill("").map(() => [] as string[]);
  for (const tok of tokens) {
    const mid = (tok.x + tok.right) / 2;
    let idx = boundaries.length;
    for (let i = 0; i < boundaries.length; i++) {
      if (mid < boundaries[i]) {
        idx = i;
        break;
      }
    }
    cols[idx].push(tok.text);
  }
  return cols.map((c) => ({ text: c.join(" ").trim(), count: c.length }));
}

interface AnalyzedLine {
  line: Line;
  tokens: Token[];
  norm: string;
  text: string;
}

// A "plausible" table-header word has some real content -- at least two
// characters, including a letter or digit -- ruling out the lone symbols
// and single characters that OCR noise (e.g. misread logos/watermarks, or
// text read in the wrong orientation) tends to shred text into.
function isPlausibleToken(text: string): boolean {
  return text.length >= 2 && /[a-zA-Z0-9]/.test(text);
}

function plausibleTokenRatio(tokens: { text: string }[]): number {
  if (tokens.length === 0) return 0;
  return tokens.filter((t) => isPlausibleToken(t.text)).length / tokens.length;
}

const MIN_PLAUSIBLE_TOKEN_RATIO = 0.6;

interface AnalyzeResult {
  header: string[];
  rows: string[][];
  warnings: string[];
  /**
   * Fraction of accepted rows where some single column bucket absorbed an
   * implausible number of raw tokens (0 = clean, 1 = all rows overcrowded).
   * Real data legitimately has rows with fewer tokens than the header (blank
   * cells), so we don't require an exact per-row token-count match -- we
   * only flag rows where tokens that should belong to *different* columns
   * clearly got crammed into the same one (the tell-tale sign of a wrong
   * rotation or bad column boundaries). Used to judge whether a rotation
   * candidate is trustworthy.
   */
  irregularRatio: number;
}

// A single table cell can legitimately hold a few words (a name, a short
// description). More than this landing in one column bucket signals that
// distinct columns got merged, not just a wordy value.
const MAX_PLAUSIBLE_TOKENS_PER_CELL = 6;

function analyzeLines(
  lines: Line[],
  gapMultiplier: number = GAP_MULTIPLIER,
  joinWithSpace = false
): AnalyzeResult {
  const warnings: string[] = [];

  const analyzed: AnalyzedLine[] = lines
    .map((line) => ({ line, text: lineText(line) }))
    .filter((l) => !isPageArtifact(l.text) && l.text !== "")
    .map(({ line, text }) => ({
      line,
      text,
      norm: normalize(text),
      tokens: lineToTokens(line, gapMultiplier, joinWithSpace),
    }));

  // Find the header: the multi-column line whose normalized text repeats
  // across the most distinct pages (this is the "repeated header" the
  // requirements describe). It does not have to be the very first line of
  // page 1 -- there may be cover-letter text before the table.
  const pagesByNorm = new Map<string, Set<number>>();
  const firstByNorm = new Map<string, AnalyzedLine>();
  for (const a of analyzed) {
    if (!pagesByNorm.has(a.norm)) pagesByNorm.set(a.norm, new Set());
    pagesByNorm.get(a.norm)!.add(a.line.page);
    if (!firstByNorm.has(a.norm)) firstByNorm.set(a.norm, a);
  }

  let headerAnalyzed: AnalyzedLine | undefined;
  let bestTokenCount = -1;
  for (const [norm, pages] of pagesByNorm) {
    const candidate = firstByNorm.get(norm)!;
    if (pages.size >= 2 && candidate.tokens.length >= MIN_HEADER_TOKENS) {
      if (candidate.tokens.length > bestTokenCount) {
        bestTokenCount = candidate.tokens.length;
        headerAnalyzed = candidate;
      }
    }
  }

  if (!headerAnalyzed) {
    // No line repeats across pages (e.g. only one page, or OCR noise breaks
    // exact-text matching). Pick the richest PLAUSIBLE candidate line --
    // i.e. the one with the most real-looking fields -- rather than just
    // the first or the most-tokenized one: a stray multi-word fragment (a
    // misread logo/timestamp, a section label, or OCR noise shredded into
    // many single-character "words") can easily appear earlier, or even
    // outnumber the real header's tokens, and would otherwise get mistaken
    // for it.
    const candidates = analyzed
      .filter((a) => a.tokens.length >= MIN_HEADER_TOKENS && plausibleTokenRatio(a.tokens) >= MIN_PLAUSIBLE_TOKEN_RATIO)
      .sort((a, b) => b.tokens.length - a.tokens.length);
    headerAnalyzed = candidates[0];
    if (headerAnalyzed) {
      warnings.push(
        "No header repeating across multiple pages was found; used the most column-like line as the header."
      );
    }
  }

  if (!headerAnalyzed) {
    return { header: [], rows: [], warnings: [], irregularRatio: 1 };
  }

  const header = headerAnalyzed.tokens.map((t) => t.text);
  const boundaries: number[] = [];
  for (let i = 0; i < headerAnalyzed.tokens.length - 1; i++) {
    boundaries.push((headerAnalyzed.tokens[i].right + headerAnalyzed.tokens[i + 1].x) / 2);
  }

  // Some reports wrap column labels onto a second line (e.g. "Payment" /
  // "Method", "Folio" / "Status"). That continuation line repeats across
  // pages exactly like the header itself, so walk forward from the header's
  // position (on the page it was first found) merging in each subsequent
  // line that *also* repeats across pages -- stopping at the first one that
  // doesn't, since that must be real data.
  const headerNorms = new Set<string>([headerAnalyzed.norm]);
  const samePage = analyzed
    .filter((a) => a.line.page === headerAnalyzed!.line.page)
    .sort((a, b) => a.line.y - b.line.y);
  const headerIdx = samePage.findIndex((a) => a === headerAnalyzed);
  for (let i = headerIdx + 1; i < samePage.length; i++) {
    const candidate = samePage[i];
    const pages = pagesByNorm.get(candidate.norm);
    if (!pages || pages.size < 2) break; // first non-repeating line = start of real data
    headerNorms.add(candidate.norm);
    const cols = bucketTokens(candidate.tokens, boundaries);
    for (let c = 0; c < header.length; c++) {
      if (cols[c]?.text) header[c] = header[c] ? `${header[c]} ${cols[c].text}` : cols[c].text;
    }
  }

  // Beyond the header block itself, a repeated report title/date printed on
  // every page (not adjacent to the header, so not folded into a column
  // label above) is still unambiguously boilerplate, not a guest row: real
  // per-guest data can't be byte-identical across every single page the way
  // a static title can. Drop every such line from the output rows too, even
  // though only the adjacent ones contributed to the header text itself.
  const excludedNorms = new Set<string>(headerNorms);
  for (const [norm, pages] of pagesByNorm) {
    if (pages.size >= 2 && (firstByNorm.get(norm)?.tokens.length ?? 0) >= MIN_HEADER_TOKENS) {
      excludedNorms.add(norm);
    }
  }

  const rows: string[][] = [];
  let overcrowdedRows = 0;

  for (const a of analyzed) {
    if (excludedNorms.has(a.norm)) continue; // drop the header, wrapped continuation lines, and other repeated boilerplate
    if (a.tokens.length < MIN_HEADER_TOKENS) continue; // prose/cover-letter/footer, not a data row

    const cols = bucketTokens(a.tokens, boundaries);
    if (cols.every((c) => c.text === "")) continue;
    if (cols.some((c) => c.count > MAX_PLAUSIBLE_TOKENS_PER_CELL)) overcrowdedRows++;
    rows.push(cols.map((c) => c.text));
  }

  if (rows.length === 0) {
    warnings.push("Header was detected but no matching data rows were found.");
  } else if (overcrowdedRows > 0) {
    warnings.push(
      `${overcrowdedRows} row(s) had unusually many values packed into one column; double-check their alignment.`
    );
  }

  const irregularRatio = rows.length > 0 ? overcrowdedRows / rows.length : 1;

  return { header, rows, warnings, irregularRatio };
}

/**
 * A candidate reading is trustworthy only if very few rows show signs of
 * distinct columns having been merged together. A wrong rotation (e.g.
 * reading a page's columns as if they were rows after a 90° axis swap) can
 * still produce *some* multi-token "header" and "rows" -- passing a naive
 * non-empty check -- while being structurally nonsense. Overcrowded cells
 * should be rare in a genuinely correct reading, so the bar is stricter
 * than the old per-row exact-token-count check this replaced (which
 * penalized ordinary blank cells in real-world data).
 */
const MAX_TRUSTED_IRREGULAR_RATIO = 0.2;

function isTrustworthy(result: AnalyzeResult): boolean {
  return (
    result.header.length >= MIN_HEADER_TOKENS &&
    result.rows.length > 0 &&
    result.irregularRatio <= MAX_TRUSTED_IRREGULAR_RATIO &&
    plausibleTokenRatio(result.header.map((text) => ({ text }))) >= MIN_PLAUSIBLE_TOKEN_RATIO
  );
}

/**
 * Shared rotation-search orchestration used by both the text and OCR
 * extraction paths: try the declared/native orientation first, and -- when
 * the caller hasn't manually pinned a rotation -- evaluate the other
 * absolute orientations too, keeping whichever trustworthy candidate has
 * the most columns (see ABSOLUTE_ROTATION_FALLBACK_ORDER for why 180° is
 * tried last).
 *
 * @param stopAtFirstTrustworthy Skip searching further alternates once a
 *   trustworthy candidate is found, instead of always checking all four for
 *   the highest column count. OCR passes are expensive, so the OCR path
 *   trades a little thoroughness for speed here; the cheap text path leaves
 *   this off to keep its existing behavior.
 */
async function findBestOrientation(
  pageNums: number[],
  nativeRotateOf: (page: number) => number,
  hasExplicitRotation: boolean,
  explicitRotations: Record<number, number>,
  getLines: (rotationsByPage: Record<number, number>) => Promise<Line[]>,
  stopAtFirstTrustworthy: boolean,
  gapMultiplier: number = GAP_MULTIPLIER
): Promise<{ result: AnalyzeResult; rotationUsed?: number }> {
  if (hasExplicitRotation) {
    return { result: analyzeLines(await getLines(explicitRotations), gapMultiplier) };
  }

  const baseNative = normalizeAngle(nativeRotateOf(pageNums[0]) ?? 0);
  let result = analyzeLines(await getLines({}), gapMultiplier);
  let best = result;
  let bestAbsolute = baseNative;
  if (process.env.DEBUG_OCR) {
    console.error(
      `[orient] absolute=${baseNative} header=${JSON.stringify(result.header)} rows=${result.rows.length} irregularRatio=${result.irregularRatio} trustworthy=${isTrustworthy(result)}`
    );
  }

  if (!stopAtFirstTrustworthy || !isTrustworthy(best)) {
    for (const absolute of ABSOLUTE_ROTATION_FALLBACK_ORDER) {
      if (absolute === baseNative) continue; // that's `result`, already computed

      const uniform: Record<number, number> = {};
      for (const p of pageNums) uniform[p] = normalizeAngle(absolute - nativeRotateOf(p));
      const trialResult = analyzeLines(await getLines(uniform), gapMultiplier);
      if (process.env.DEBUG_OCR) {
        console.error(
          `[orient] absolute=${absolute} header=${JSON.stringify(trialResult.header)} rows=${trialResult.rows.length} irregularRatio=${trialResult.irregularRatio} trustworthy=${isTrustworthy(trialResult)}`
        );
      }

      const trialTrustworthy = isTrustworthy(trialResult);
      const bestTrustworthy = isTrustworthy(best);
      const better =
        (trialTrustworthy && !bestTrustworthy) ||
        (trialTrustworthy === bestTrustworthy && trialResult.header.length > best.header.length);
      if (better) {
        best = trialResult;
        bestAbsolute = absolute;
      }
      if (stopAtFirstTrustworthy && isTrustworthy(best)) break;
    }
  }

  if (bestAbsolute !== baseNative && isTrustworthy(best)) {
    return { result: best, rotationUsed: normalizeAngle(bestAbsolute - baseNative) };
  }
  return { result };
}

const OCR_SCALE = 3; // render scale for OCR; higher helps accuracy on small/dense fonts at the cost of speed
// Tesseract's own page-confidence score (0-100), used to pick the correct
// orientation. A wrong rotation still produces some plausible-looking
// short tokens (shredded characters, misread noise), so text-shape
// heuristics alone can't reliably tell a correct read from a wrong one --
// but its confidence is reliably much lower than a genuinely correct read.
const CONFIDENT_OCR_SCORE = 75; // stop searching rotations once this good
const MIN_VIABLE_OCR_SCORE = 40; // below this, don't trust the "best" rotation enough to override the native one

/** Converts one OCR pass's word-level output into our Line/RawItem shape, reusing tesseract's own line segmentation. */
function ocrDataToLines(pageNum: number, data: any): Line[] {
  const lines: Line[] = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const items: RawItem[] = (line.words || [])
          .filter((w: any) => w.text && w.text.trim() !== "")
          .map((w: any) => ({
            str: w.text,
            x: w.bbox.x0,
            y: (w.bbox.y0 + w.bbox.y1) / 2,
            width: Math.max(w.bbox.x1 - w.bbox.x0, 1),
          }));
        if (items.length === 0) continue;
        items.sort((a, b) => a.x - b.x);
        const y = items.reduce((sum, it) => sum + it.y, 0) / items.length;
        lines.push({ page: pageNum, y, items });
      }
    }
  }
  return lines;
}

/**
 * OCR fallback for PDFs with no text layer at all (scanned pages, or text
 * flattened to vector outlines). Locks in the correct orientation using
 * just the first page (OCR is too slow to brute-force 4 rotations across
 * every page), then OCRs the rest of the document at that orientation.
 */
async function extractViaOcr(
  buffer: Buffer,
  pageCount: number,
  nativeRotates: Record<number, number>,
  rotations: Record<number, number>
): Promise<ExtractResult> {
  const hasExplicitRotation = Object.keys(rotations).length > 0;
  const doc = await loadPdfForRendering(buffer);
  // Cache language data under the OS temp dir, not the working directory --
  // the latter may not be writable in a deployed/serverless environment.
  const worker = await createWorker("eng", 1, { cachePath: path.join(os.tmpdir(), "tesseract-cache") });

  try {
    const pageCache = new Map<string, { lines: Line[]; confidence: number }>();
    const ocrPage = async (pageNum: number, rotationsByPage: Record<number, number>) => {
      const total = normalizeAngle((nativeRotates[pageNum] ?? 0) + (rotationsByPage[pageNum] ?? 0));
      const cacheKey = `${pageNum}:${total}`;
      const cached = pageCache.get(cacheKey);
      if (cached) return cached;

      const tRenderStart = Date.now();
      const png = await renderPageToPng(doc, pageNum, total, OCR_SCALE);
      const tRecognizeStart = Date.now();
      const { data } = await worker.recognize(png, {}, { text: true, blocks: true });
      const tEnd = Date.now();
      if (process.env.DEBUG_OCR) {
        console.error(
          `[ocr] page=${pageNum} rotation=${total} render=${tRecognizeStart - tRenderStart}ms recognize=${tEnd - tRecognizeStart}ms confidence=${data.confidence}`
        );
      }
      const entry = { lines: ocrDataToLines(pageNum, data), confidence: data.confidence as number };
      pageCache.set(cacheKey, entry);
      return entry;
    };

    // Lock in orientation using page 1 alone -- OCR-ing every page at every
    // candidate rotation would be far too slow for multi-page documents.
    // Tesseract's own page-confidence score is the deciding signal here:
    // it's far more reliable than trying to infer "does this look like a
    // real table" from the (possibly garbled) text alone -- a wrong
    // orientation can still shred a page into plausible-looking short
    // tokens, but its confidence is reliably much lower than a correct read.
    let rotationUsed: number | undefined;
    if (!hasExplicitRotation) {
      const baseNative = normalizeAngle(nativeRotates[1] ?? 0);
      const candidates = [baseNative, ...ABSOLUTE_ROTATION_FALLBACK_ORDER.filter((a) => a !== baseNative)];
      let bestAbsolute = baseNative;
      let bestConfidence = -Infinity;

      for (const absolute of candidates) {
        const delta = normalizeAngle(absolute - baseNative);
        const { confidence } = await ocrPage(1, { 1: delta });
        if (confidence > bestConfidence) {
          bestConfidence = confidence;
          bestAbsolute = absolute;
        }
        if (bestConfidence >= CONFIDENT_OCR_SCORE) break; // good enough, stop searching
      }

      if (bestAbsolute !== baseNative && bestConfidence >= MIN_VIABLE_OCR_SCORE) {
        rotationUsed = normalizeAngle(bestAbsolute - baseNative);
      }
    }

    const finalRotations: Record<number, number> = hasExplicitRotation
      ? rotations
      : Object.fromEntries(Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => [p, rotationUsed ?? 0]));

    const allLines: Line[] = [];
    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      const { lines } = await ocrPage(pageNum, finalRotations);
      allLines.push(...lines);
    }

    const result = analyzeLines(allLines, OCR_GAP_MULTIPLIER, /* joinWithSpace */ true);

    if (!isTrustworthy(result)) {
      return {
        header: [],
        rows: [],
        pageCount,
        warnings: [
          "This PDF has no text layer, so it was read with OCR, but no table structure could be found in the result. Try rotating it manually if the preview looks sideways or upside down.",
        ],
        noTextLayer: true,
      };
    }

    const warnings = [
      "This PDF had no selectable text, so it was read with optical character recognition (OCR). Please double-check important values (especially numbers) against the original PDF before relying on them.",
      ...(rotationUsed
        ? [`Automatically detected the page was rotated ${rotationUsed}° and corrected it before running OCR.`]
        : []),
      ...result.warnings,
    ];

    return { header: result.header, rows: result.rows, pageCount, warnings, rotationUsed, usedOcr: true };
  } finally {
    await worker.terminate();
  }
}

/**
 * @param rotations Per-page additional rotation in degrees (0/90/180/270),
 *   keyed by 1-based page number, on top of the page's own declared
 *   rotation. Pass {} (or omit) when the user hasn't manually rotated
 *   anything: every absolute orientation (0/90/180/270) is then evaluated
 *   automatically and the most plausible one is used -- see
 *   ABSOLUTE_ROTATION_FALLBACK_ORDER above for why 180° is deprioritized and
 *   column count is the deciding signal. Passing a non-empty map (from the
 *   user's manual rotate controls) is taken as-is, with no auto-guessing.
 */
export async function extractTable(
  buffer: Buffer,
  rotations: Record<number, number> = {}
): Promise<ExtractResult> {
  const { pages, pageCount } = await loadPages(buffer);

  const hasAnyText = pages.some((pd) => pd.items.length > 0);
  if (!hasAnyText) {
    const nativeRotates = Object.fromEntries(pages.map((pd) => [pd.pageNum, pd.nativeRotate]));
    return extractViaOcr(buffer, pageCount, nativeRotates, rotations);
  }

  const hasExplicitRotation = Object.keys(rotations).length > 0;
  const pageNums = pages.map((pd) => pd.pageNum);
  const nativeRotateOf = (p: number) => pages.find((pd) => pd.pageNum === p)?.nativeRotate ?? 0;

  const { result, rotationUsed } = await findBestOrientation(
    pageNums,
    nativeRotateOf,
    hasExplicitRotation,
    rotations,
    (rot) => Promise.resolve(projectPages(pages, rot)),
    // Only search alternate rotations when the page's own declared
    // orientation genuinely fails to produce a trustworthy table. Searching
    // "just in case something scores higher" even after a good native
    // reading is what caused a real regression: a dense, correctly-read
    // financial table could still spuriously look "more structured" (more
    // apparent columns) when read at a wrong rotation, so preferring column
    // count once we already had a good answer was actively harmful, not
    // just wasted work. ABSOLUTE_ROTATION_FALLBACK_ORDER's ordering (most
    // to least likely correct) already handles picking well among
    // alternates on the rare occasions we do need to search.
    /* stopAtFirstTrustworthy */ true
  );

  if (!isTrustworthy(result)) {
    return {
      header: [],
      rows: [],
      pageCount,
      warnings: ["Could not detect a table header or column structure in this PDF."],
    };
  }

  const warnings = rotationUsed
    ? [`Automatically detected the page was rotated ${rotationUsed}° and corrected it before extracting the table.`, ...result.warnings]
    : result.warnings;

  return { header: result.header, rows: result.rows, pageCount, warnings, rotationUsed };
}

export interface PlainTextResult {
  pageCount: number;
  text: string;
  usedOcr: boolean;
  rotationUsed?: number;
  warnings: string[];
}

/**
 * How much of a set of lines' tokens look like real words, used to pick the
 * correct orientation for plain-text mode. Deliberately independent of the
 * table-shape checks (isTrustworthy) above -- this mode has no table to
 * validate, just readable text, so a page of ordinary prose (which would
 * fail isTrustworthy for having too few "columns") should still score well
 * here as long as it isn't garbled.
 */
function textPlausibilityScore(lines: Line[]): number {
  const allTokens = lines.flatMap((l) => lineToTokens(l, GAP_MULTIPLIER));
  return plausibleTokenRatio(allTokens);
}

const TEXT_MODE_CONFIDENT_SCORE = 0.7;

/**
 * Plain-text extraction: no table structure required, just the page's
 * text in reading order. For PDFs with a text layer, still auto-corrects
 * orientation (using word-plausibility rather than table-shape as the
 * signal) so the output isn't sideways/upside-down; falls back to OCR
 * (confidence-based orientation, same as extractTable's OCR path) for
 * PDFs with no text layer at all.
 */
export async function extractPlainText(
  buffer: Buffer,
  rotations: Record<number, number> = {}
): Promise<PlainTextResult> {
  const { pages, pageCount } = await loadPages(buffer);
  const hasAnyText = pages.some((pd) => pd.items.length > 0);

  if (!hasAnyText) {
    const nativeRotates = Object.fromEntries(pages.map((pd) => [pd.pageNum, pd.nativeRotate]));
    return extractPlainTextViaOcr(buffer, pageCount, nativeRotates, rotations);
  }

  const hasExplicitRotation = Object.keys(rotations).length > 0;
  const pageNums = pages.map((pd) => pd.pageNum);
  const nativeRotateOf = (p: number) => pages.find((pd) => pd.pageNum === p)?.nativeRotate ?? 0;
  const baseNative = normalizeAngle(nativeRotateOf(pageNums[0]) ?? 0);

  let rotationUsed: number | undefined;
  let effectiveRotations = rotations;

  if (!hasExplicitRotation) {
    let bestAbsolute = baseNative;
    let bestScore = textPlausibilityScore(projectPages(pages, {}));

    if (bestScore < TEXT_MODE_CONFIDENT_SCORE) {
      for (const absolute of ABSOLUTE_ROTATION_FALLBACK_ORDER) {
        if (absolute === baseNative) continue;
        const uniform: Record<number, number> = {};
        for (const p of pageNums) uniform[p] = normalizeAngle(absolute - nativeRotateOf(p));
        const score = textPlausibilityScore(projectPages(pages, uniform));
        if (score > bestScore) {
          bestScore = score;
          bestAbsolute = absolute;
        }
        if (bestScore >= TEXT_MODE_CONFIDENT_SCORE) break;
      }
    }

    if (bestAbsolute !== baseNative) {
      rotationUsed = normalizeAngle(bestAbsolute - baseNative);
      effectiveRotations = Object.fromEntries(
        pageNums.map((p) => [p, normalizeAngle(bestAbsolute - nativeRotateOf(p))])
      );
    }
  }

  const lines = projectPages(pages, effectiveRotations);
  const byPage = new Map<number, Line[]>();
  for (const line of lines) {
    if (!byPage.has(line.page)) byPage.set(line.page, []);
    byPage.get(line.page)!.push(line);
  }

  const pageTexts: string[] = [];
  for (let p = 1; p <= pageCount; p++) {
    const pageLines = (byPage.get(p) || []).slice().sort((a, b) => a.y - b.y);
    pageTexts.push(
      pageLines
        .map((l) => lineText(l))
        .filter((t) => t !== "")
        .join("\n")
    );
  }

  return {
    pageCount,
    text: pageTexts.join("\n\n"),
    usedOcr: false,
    rotationUsed,
    warnings: rotationUsed
      ? [`Automatically detected the page was rotated ${rotationUsed}° and corrected it.`]
      : [],
  };
}

async function extractPlainTextViaOcr(
  buffer: Buffer,
  pageCount: number,
  nativeRotates: Record<number, number>,
  rotations: Record<number, number>
): Promise<PlainTextResult> {
  const hasExplicitRotation = Object.keys(rotations).length > 0;
  const doc = await loadPdfForRendering(buffer);
  const worker = await createWorker("eng", 1, { cachePath: path.join(os.tmpdir(), "tesseract-cache") });

  try {
    const pageCache = new Map<string, { text: string; confidence: number }>();
    const ocrPage = async (pageNum: number, rotationsByPage: Record<number, number>) => {
      const total = normalizeAngle((nativeRotates[pageNum] ?? 0) + (rotationsByPage[pageNum] ?? 0));
      const cacheKey = `${pageNum}:${total}`;
      const cached = pageCache.get(cacheKey);
      if (cached) return cached;

      const png = await renderPageToPng(doc, pageNum, total, OCR_SCALE);
      const { data } = await worker.recognize(png, {}, { text: true });
      const entry = { text: (data.text as string).trim(), confidence: data.confidence as number };
      pageCache.set(cacheKey, entry);
      return entry;
    };

    let rotationUsed: number | undefined;
    if (!hasExplicitRotation) {
      const baseNative = normalizeAngle(nativeRotates[1] ?? 0);
      const candidates = [baseNative, ...ABSOLUTE_ROTATION_FALLBACK_ORDER.filter((a) => a !== baseNative)];
      let bestAbsolute = baseNative;
      let bestConfidence = -Infinity;

      for (const absolute of candidates) {
        const delta = normalizeAngle(absolute - baseNative);
        const { confidence } = await ocrPage(1, { 1: delta });
        if (confidence > bestConfidence) {
          bestConfidence = confidence;
          bestAbsolute = absolute;
        }
        if (bestConfidence >= CONFIDENT_OCR_SCORE) break;
      }

      if (bestAbsolute !== baseNative && bestConfidence >= MIN_VIABLE_OCR_SCORE) {
        rotationUsed = normalizeAngle(bestAbsolute - baseNative);
      }
    }

    const finalRotations: Record<number, number> = hasExplicitRotation
      ? rotations
      : Object.fromEntries(Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => [p, rotationUsed ?? 0]));

    const pageTexts: string[] = [];
    for (let p = 1; p <= pageCount; p++) {
      const { text } = await ocrPage(p, finalRotations);
      pageTexts.push(text);
    }

    return {
      pageCount,
      text: pageTexts.join("\n\n"),
      usedOcr: true,
      rotationUsed,
      warnings: [
        "This PDF had no selectable text, so it was read with optical character recognition (OCR). Please review the text for recognition errors.",
        ...(rotationUsed
          ? [`Automatically detected the page was rotated ${rotationUsed}° and corrected it before running OCR.`]
          : []),
      ],
    };
  } finally {
    await worker.terminate();
  }
}
