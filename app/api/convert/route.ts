import { NextRequest, NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { extractTable } from "@/lib/pdfToRows";
import { buildWorkbookBuffer } from "@/lib/buildWorkbook";

export const runtime = "nodejs";
// OCR fallback (for PDFs with no text layer) renders + recognizes every
// page and can take well over a minute for multi-page documents.
export const maxDuration = 300;

const VALID_ANGLES = new Set([0, 90, 180, 270]);

function parseRotations(raw: FormDataEntryValue | null): Record<number, number> {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const rotations: Record<number, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const page = Number(key);
      const angle = (((Number(value) % 360) + 360) % 360) as number;
      if (Number.isInteger(page) && page > 0 && VALID_ANGLES.has(angle) && angle !== 0) {
        rotations[page] = angle;
      }
    }
    return rotations;
  } catch {
    return {};
  }
}

const PDF_NAME_RE = /\.pdf$/i;

export async function POST(req: NextRequest) {
  // Files under the ~4.4 MB Vercel request-body limit are posted directly as
  // multipart form data (existing flow). Larger files are uploaded from the
  // browser straight to Blob storage first (see /api/blob-upload), and the
  // client sends us just the resulting URL as JSON instead of the bytes.
  const isJson = (req.headers.get("content-type") || "").includes("application/json");

  let buffer: Buffer;
  let fileName: string;
  let rotations: Record<number, number>;
  let blobUrlToClean: string | null = null;

  try {
    if (isJson) {
      const body = await req.json();
      const { blobUrl, fileName: name, rotations: rot } = body as {
        blobUrl?: string;
        fileName?: string;
        rotations?: Record<number, number>;
      };

      if (!blobUrl || typeof blobUrl !== "string") {
        return NextResponse.json({ error: "No uploaded file reference provided." }, { status: 400 });
      }
      fileName = typeof name === "string" && name ? name : "document.pdf";
      if (!PDF_NAME_RE.test(fileName)) {
        return NextResponse.json({ error: "Please upload a .pdf file." }, { status: 400 });
      }
      rotations = rot && typeof rot === "object" ? rot : {};
      blobUrlToClean = blobUrl;

      const blobRes = await fetch(blobUrl);
      if (!blobRes.ok) {
        return NextResponse.json({ error: "Could not retrieve the uploaded file." }, { status: 400 });
      }
      buffer = Buffer.from(await blobRes.arrayBuffer());
    } else {
      const formData = await req.formData();
      const file = formData.get("file");

      if (!file || typeof file === "string") {
        return NextResponse.json({ error: "No PDF file uploaded." }, { status: 400 });
      }
      if (!("name" in file) || !PDF_NAME_RE.test(file.name)) {
        return NextResponse.json({ error: "Please upload a .pdf file." }, { status: 400 });
      }

      rotations = parseRotations(formData.get("rotations"));
      fileName = file.name;
      buffer = Buffer.from(await file.arrayBuffer());
    }

    const { header, rows, pageCount, warnings, rotationUsed, noTextLayer, usedOcr } = await extractTable(
      buffer,
      rotations
    );

    if (header.length === 0 || rows.length === 0) {
      return NextResponse.json(
        noTextLayer
          ? {
              error:
                warnings[0] ||
                "This PDF has no selectable text, and OCR could not find a table in it either.",
              needsRotation: false,
              pageCount,
            }
          : {
              error:
                "We couldn't detect the table structure. Please check the PDF orientation using the preview below. You can rotate the PDF and try again.",
              needsRotation: true,
              pageCount,
            },
        { status: 422 }
      );
    }

    const xlsxBuffer = buildWorkbookBuffer(header, rows);

    const outName = fileName.replace(PDF_NAME_RE, "") + ".xlsx";

    return new NextResponse(xlsxBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${outName}"`,
        "X-Row-Count": String(rows.length),
        "X-Page-Count": String(pageCount),
        "X-Column-Count": String(header.length),
        "X-Rotation-Used": String(rotationUsed ?? 0),
        "X-Used-Ocr": String(!!usedOcr),
        "X-Warnings": encodeURIComponent(JSON.stringify(warnings)),
      },
    });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json(
      { error: err?.message || "Failed to process PDF." },
      { status: 500 }
    );
  } finally {
    // Uploaded-to-blob files are one-shot inputs for this conversion; don't
    // leave them sitting in storage afterward.
    if (blobUrlToClean) {
      del(blobUrlToClean).catch(() => {
        // best-effort cleanup; a leftover blob isn't worth failing the request over
      });
    }
  }
}
