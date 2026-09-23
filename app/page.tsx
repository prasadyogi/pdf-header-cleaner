"use client";

import { useRef, useState } from "react";
import { uploadPresigned } from "@vercel/blob/client";
import PdfCanvas from "./components/PdfCanvas";

type Status = "idle" | "processing" | "done" | "error";
type Scope = "current" | "all";
type OutputMode = "excel" | "text";

// Vercel Serverless Functions cap inbound request bodies at 4.5 MB, and
// that can't be raised from application code. Files under this go straight
// in the POST as before; larger ones are uploaded from the browser directly
// to Blob storage first (bypassing that limit entirely), and we send the
// server just the resulting URL. MAX_FILE_BYTES is this app's own overall
// cap (matching /api/blob-upload's limit) -- past that, OCR on a huge
// document would risk running past the function's max duration anyway.
const DIRECT_UPLOAD_BYTES = 4.4 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string>("");
  const [needsRotation, setNeedsRotation] = useState(false);
  const [usedOcr, setUsedOcr] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [rotations, setRotations] = useState<Record<number, number>>({});
  const [scope, setScope] = useState<Scope>("all");
  const [outputMode, setOutputMode] = useState<OutputMode>("excel");

  function resetForNewFile() {
    setStatus("idle");
    setMessage("");
    setNeedsRotation(false);
    setNumPages(0);
    setCurrentPage(1);
    setRotations({});
    setScope("all");
  }

  function pickFile(f: File | null) {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pdf")) {
      setStatus("error");
      setMessage("Please choose a .pdf file.");
      return;
    }
    setFile(f);
    resetForNewFile();
    if (f.size > MAX_FILE_BYTES) {
      setStatus("error");
      setMessage(
        `This file is ${formatBytes(f.size)}, which is over the ${formatBytes(MAX_FILE_BYTES)} limit for this tool. Try compressing the PDF or splitting it into smaller files.`
      );
    }
  }

  function pagesInScope(): number[] {
    if (scope === "all") {
      return Array.from({ length: Math.max(numPages, 1) }, (_, i) => i + 1);
    }
    return [currentPage];
  }

  function rotateBy(delta: number) {
    setRotations((prev) => {
      const next = { ...prev };
      for (const p of pagesInScope()) {
        next[p] = normalizeAngle((next[p] || 0) + delta);
      }
      return next;
    });
  }

  function resetRotation() {
    setRotations((prev) => {
      const next = { ...prev };
      for (const p of pagesInScope()) {
        delete next[p];
      }
      return next;
    });
  }

  async function handleConvert() {
    if (!file) return;
    setStatus("processing");
    setMessage("");
    setNeedsRotation(false);
    setUsedOcr(false);

    try {
      let res: Response;

      if (file.size > DIRECT_UPLOAD_BYTES) {
        // Too big for a direct POST -- upload straight to Blob storage from
        // the browser, then just hand the server the resulting URL.
        const blob = await uploadPresigned(file.name, file, {
          access: "public",
          handleUploadUrl: "/api/blob-upload",
        });
        res = await fetch("/api/convert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ blobUrl: blob.url, fileName: file.name, rotations, mode: outputMode }),
        });
      } else {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("rotations", JSON.stringify(rotations));
        formData.append("mode", outputMode);
        res = await fetch("/api/convert", { method: "POST", body: formData });
      }

      if (!res.ok) {
        if (res.status === 413) {
          throw new Error(
            `This file is too large to upload (limit is ${formatBytes(MAX_FILE_BYTES)}). Try compressing the PDF or splitting it into smaller files.`
          );
        }
        const data = await res.json().catch(() => ({}));
        if (data.needsRotation) setNeedsRotation(true);
        throw new Error(data.error || "Conversion failed.");
      }

      const blob = await res.blob();
      const rowCount = res.headers.get("X-Row-Count");
      const colCount = res.headers.get("X-Column-Count");
      const rotationUsed = Number(res.headers.get("X-Rotation-Used") || "0");
      const ocrUsed = res.headers.get("X-Used-Ocr") === "true";
      setUsedOcr(ocrUsed);
      let warnings: string[] = [];
      try {
        warnings = JSON.parse(decodeURIComponent(res.headers.get("X-Warnings") || "[]"));
      } catch {
        warnings = [];
      }

      // Reflect any rotation the server auto-detected back into the preview.
      if (rotationUsed && Object.keys(rotations).length === 0) {
        const uniform: Record<number, number> = {};
        for (let p = 1; p <= Math.max(numPages, 1); p++) uniform[p] = rotationUsed;
        setRotations(uniform);
      }

      const ext = outputMode === "text" ? ".txt" : ".xlsx";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name.replace(/\.pdf$/i, "") + ext;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setStatus("done");
      const base =
        outputMode === "text"
          ? `Done — text extracted to a .txt file.`
          : `Done — ${rowCount ?? "your"} rows × ${colCount ?? "?"} columns exported to Excel.`;
      setMessage(warnings.length > 0 ? `${base} ${warnings.join(" ")}` : base);
    } catch (err: any) {
      setStatus("error");
      setMessage(err?.message || "Something went wrong.");
    }
  }

  const currentRotation = rotations[currentPage] || 0;

  return (
    <main className="page">
      <div className="card">
        <h1>PDF to Excel</h1>
        <p className="subtitle">
          Upload a multi-page PDF table. Repeated page headers are detected automatically and
          removed, keeping the first one at the top of your Excel file.
        </p>

        <div
          className={`dropzone ${dragging ? "dragging" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            pickFile(e.dataTransfer.files?.[0] ?? null);
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
          <strong>Click to upload</strong> or drag and drop
          <p>PDF files only</p>
        </div>

        {file && (
          <div className="filename">
            <span>{file.name}</span>
            <button
              onClick={() => {
                setFile(null);
                resetForNewFile();
              }}
            >
              Remove
            </button>
          </div>
        )}

        {file && (
          <div className="preview-panel">
            <div className="pdf-canvas-wrap">
              <PdfCanvas
                file={file}
                pageNum={currentPage}
                rotationDelta={currentRotation}
                onLoaded={({ numPages: n }) => setNumPages(n)}
                onError={(msg) => setMessage(msg)}
              />
            </div>

            <div className="nav-row">
              <button
                className="ghost"
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              >
                ← Previous
              </button>
              <span className="page-indicator">
                Page {currentPage} of {numPages || "…"}
              </span>
              <button
                className="ghost"
                disabled={numPages === 0 || currentPage >= numPages}
                onClick={() => setCurrentPage((p) => Math.min(numPages || p, p + 1))}
              >
                Next →
              </button>
            </div>

            <div className="rotate-row">
              <button className="ghost" onClick={() => rotateBy(-90)}>
                ↶ Rotate Left
              </button>
              <button className="ghost" onClick={() => rotateBy(90)}>
                ↷ Rotate Right
              </button>
              <button className="ghost" onClick={() => rotateBy(180)}>
                Rotate 180°
              </button>
              <button className="ghost" onClick={resetRotation}>
                Reset
              </button>
            </div>

            <div className="scope-row">
              <span className="scope-label">Apply to:</span>
              <label>
                <input
                  type="radio"
                  name="scope"
                  checked={scope === "current"}
                  onChange={() => setScope("current")}
                />
                Current Page
              </label>
              <label>
                <input
                  type="radio"
                  name="scope"
                  checked={scope === "all"}
                  onChange={() => setScope("all")}
                />
                All Pages
              </label>
            </div>
          </div>
        )}

        <div className="scope-row">
          <span className="scope-label">Convert to:</span>
          <label>
            <input
              type="radio"
              name="outputMode"
              checked={outputMode === "excel"}
              onChange={() => setOutputMode("excel")}
            />
            Excel
          </label>
          <label>
            <input
              type="radio"
              name="outputMode"
              checked={outputMode === "text"}
              onChange={() => setOutputMode("text")}
            />
            Text
          </label>
        </div>

        <div className="actions">
          <button
            className="primary"
            disabled={!file || status === "processing" || file.size > MAX_FILE_BYTES}
            onClick={handleConvert}
          >
            {status === "processing"
              ? "Converting…"
              : `Convert & Download ${outputMode === "text" ? "Text" : "Excel"}`}
          </button>
          {status === "processing" && (
            <p className="hint">
              {file && file.size > DIRECT_UPLOAD_BYTES ? "Uploading large file… t" : "T"}hen scanned or
              image-only PDFs are read automatically with OCR, which can take a while for documents
              with many pages.
            </p>
          )}
        </div>

        {status === "error" && needsRotation && (
          <div className="rotate-help">
            <p>{message}</p>
            <div className="rotate-help-actions">
              <button className="ghost" onClick={() => rotateBy(-90)}>
                Rotate Left
              </button>
              <button className="ghost" onClick={() => rotateBy(90)}>
                Rotate Right
              </button>
              <button className="primary" onClick={handleConvert}>
                Reprocess PDF
              </button>
            </div>
          </div>
        )}

        {message && !(status === "error" && needsRotation) && (
          <div
            className={`message ${
              status === "error" ? "error" : usedOcr ? "warning" : "success"
            }`}
          >
            {message}
          </div>
        )}
      </div>
    </main>
  );
}
