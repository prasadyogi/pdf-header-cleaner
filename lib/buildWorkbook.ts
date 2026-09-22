import * as XLSX from "xlsx";

// Matches amounts like "3,855.50", "-3,855.50", "0.00", "1234"
const NUMERIC_RE = /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/;

function parseNumeric(value: string): number | null {
  const t = value.trim();
  if (!t || !NUMERIC_RE.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// A column counts as numeric if most (not necessarily all) of its non-empty
// values parse as a number. Requiring every single value was too strict for
// real-world data -- one OCR misread anywhere in a long column (e.g. a
// stray character in row 400 of 600) would otherwise turn the *entire*
// column back into left-aligned text. The rare unparseable outlier just
// stays as its original string, mixed in with numeric cells around it,
// which Excel handles fine.
const NUMERIC_COLUMN_THRESHOLD = 0.8;

export function buildWorkbookBuffer(header: string[], rows: string[][]): Buffer {
  const numericCol = header.map((_, i) => {
    const values = rows.map((r) => r[i] ?? "").filter((v) => v !== "");
    if (values.length === 0) return false;
    const numericCount = values.filter((v) => parseNumeric(v) !== null).length;
    return numericCount / values.length >= NUMERIC_COLUMN_THRESHOLD;
  });
  const hasDecimals = header.map((_, i) => rows.some((r) => (r[i] || "").includes(".")));

  const aoa: (string | number)[][] = [
    header,
    ...rows.map((row) =>
      row.map((cell, i) => {
        if (!numericCol[i] || cell === "") return cell;
        return parseNumeric(cell) ?? cell;
      })
    ),
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(aoa);

  // Apply a consistent number format to numeric columns (e.g. amounts).
  const range = XLSX.utils.decode_range(worksheet["!ref"] || "A1");
  for (let c = 0; c < header.length; c++) {
    if (!numericCol[c]) continue;
    const fmt = hasDecimals[c] ? "#,##0.00;-#,##0.00" : "#,##0;-#,##0";
    for (let r = 1; r <= range.e.r; r++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = worksheet[addr];
      if (cell && cell.t === "n") cell.z = fmt;
    }
  }

  // Reasonable column widths based on content length.
  const colWidths = header.map((h, i) => {
    const maxLen = Math.max(h.length, ...rows.map((r) => (r[i] ? String(r[i]).length : 0)));
    return { wch: Math.min(Math.max(maxLen + 2, 10), 40) };
  });
  worksheet["!cols"] = colWidths;

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Data");

  const out = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return out as Buffer;
}
