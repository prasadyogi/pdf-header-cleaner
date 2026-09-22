# PDF to Excel — Remove Repeated Headers

Upload a multi-page PDF containing a table whose header row repeats on every
page, and download a single `.xlsx` with the header kept only once and every
data row preserved. Includes a PDF preview with page navigation and rotation
controls for PDFs that are sideways or upside down.

## How it works

- `lib/pdfToRows.ts` reads the PDF with `pdfjs-dist`, groups text into lines
  by position, and reconstructs columns from position gaps (handling both
  individually-positioned text runs and fixed-width/monospace-style rows
  drawn as a single text run per line).
- The header is the multi-column line whose text repeats across the most
  pages (not assumed to be the very first line — cover-letter text before
  the table is filtered out). Every occurrence of it is dropped from the
  data rows, so it appears exactly once in the output.
- Rotation handling: each page's declared `/Rotate` value, plus any
  additional rotation the user applies in the preview, is applied via
  pdf.js's viewport transform *before* line/column grouping. When no
  manual rotation is given, every absolute orientation (0/90/180/270) is
  evaluated and the most plausible one (most trustworthy columns) is used
  automatically; if nothing looks trustworthy, conversion fails with a
  message asking the user to check orientation in the preview and rotate.
- Lines like "Page 1 of 3" are filtered out as page artifacts.
- `lib/buildWorkbook.ts` writes the header + rows to a single-sheet `.xlsx`
  with `xlsx` (SheetJS), converting numeric-looking columns (amounts, IDs)
  to real numbers with consistent formatting.
- `app/api/convert/route.ts` is the upload/convert endpoint (accepts an
  optional `rotations` field: JSON map of page number → degrees).
  `app/page.tsx` is the upload/preview/rotate/download UI.
- `app/components/PdfCanvas.tsx` renders the live PDF preview client-side
  via `pdfjs-dist`, driven by the page's own rotation plus the user's
  chosen delta.

## Run locally

```bash
npm install
npm run dev
```

Then open http://localhost:3000, upload a PDF. A preview appears with page
navigation and rotate controls (rotate left/right/180°/reset, applied to the
current page or all pages). Click "Convert & Download Excel" — if the table
can't be detected, a friendly error offers Rotate Left/Right and Reprocess
PDF without needing to re-upload.

## Notes / limitations

- Works on text-based PDFs (not scanned images — those would need OCR first).
- Assumes a single-line header and consistent column positions across pages,
  which holds for standard exported/reported tables.
- Automatic orientation detection tries all 4 absolute rotations and picks
  the one yielding the most trustworthy column structure; it can't fully
  distinguish a correctly-declared 180°-rotated document from its mirror in
  every case — use the manual rotate controls if the auto-corrected result
  looks reversed.
