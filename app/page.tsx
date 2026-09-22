"use client";

import { useRef, useState } from "react";
import PdfCanvas from "./components/PdfCanvas";

type Status = "idle" | "processing" | "done" | "error";
type Scope = "current" | "all";

function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
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
      const formData = new FormData();
      formData.append("file", file);
      formData.append("rotations", JSON.stringify(rotations));

      const res = await fetch("/api/convert", { method: "POST", body: formData });

      if (!res.ok) {
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

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name.replace(/\.pdf$/i, "") + ".xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setStatus("done");
      const base = `Done — ${rowCount ?? "your"} rows × ${colCount ?? "?"} columns exported to Excel.`;
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

        <div className="actions">
          <button
            className="primary"
            disabled={!file || status === "processing"}
            onClick={handleConvert}
          >
            {status === "processing" ? "Converting…" : "Convert & Download Excel"}
          </button>
          {status === "processing" && (
            <p className="hint">
              Scanned or image-only PDFs are read automatically with OCR, which can take a
              while for documents with many pages.
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
