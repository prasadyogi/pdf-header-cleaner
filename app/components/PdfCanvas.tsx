"use client";

import { useEffect, useRef, useState } from "react";

let pdfjsLibPromise: Promise<any> | null = null;
function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import("pdfjs-dist/build/pdf").then((mod: any) => {
      mod.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
      return mod;
    });
  }
  return pdfjsLibPromise;
}

interface PdfCanvasProps {
  file: File;
  pageNum: number;
  rotationDelta: number;
  maxWidth?: number;
  onLoaded?: (info: { numPages: number }) => void;
  onError?: (message: string) => void;
}

export default function PdfCanvas({
  file,
  pageNum,
  rotationDelta,
  maxWidth = 480,
  onLoaded,
  onError,
}: PdfCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const docRef = useRef<any>(null);
  const renderTaskRef = useRef<any>(null);
  const [docKey, setDocKey] = useState<string | null>(null);

  // (Re)load the document whenever the underlying file changes.
  useEffect(() => {
    let cancelled = false;
    const key = `${file.name}-${file.size}-${file.lastModified}`;

    (async () => {
      try {
        const pdfjsLib = await loadPdfjs();
        const buf = await file.arrayBuffer();
        const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
        if (cancelled) return;
        docRef.current = doc;
        setDocKey(key);
        onLoaded?.({ numPages: doc.numPages });
      } catch (err: any) {
        if (!cancelled) onError?.(err?.message || "Failed to load PDF preview.");
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // Render the requested page whenever the doc, page number, or rotation changes.
  useEffect(() => {
    if (!docRef.current || !docKey) return;
    let cancelled = false;

    (async () => {
      try {
        const doc = docRef.current;
        const safePage = Math.min(Math.max(pageNum, 1), doc.numPages);
        const page = await doc.getPage(safePage);
        if (cancelled) return;

        const total = (((page.rotate + rotationDelta) % 360) + 360) % 360;
        const unscaled = page.getViewport({ scale: 1, rotation: total });
        const scale = maxWidth / unscaled.width;
        const viewport = page.getViewport({ scale, rotation: total });

        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        if (renderTaskRef.current) {
          try {
            renderTaskRef.current.cancel();
          } catch {
            // ignore cancellation errors
          }
        }
        const task = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
      } catch (err: any) {
        if (!cancelled && err?.name !== "RenderingCancelledException") {
          onError?.(err?.message || "Failed to render PDF page.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, pageNum, rotationDelta, maxWidth]);

  return <canvas ref={canvasRef} className="pdf-canvas" />;
}
