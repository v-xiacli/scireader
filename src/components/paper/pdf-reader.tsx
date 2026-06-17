'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { PaperSelection, PaperSummary } from '@/types/paper';

interface PdfReaderProps {
  paper: PaperSummary;
  onSelectionChange: (selection: PaperSelection | null) => void;
  initialZoom?: number;
  onZoomChange?: (zoom: number) => void;
}

const sampleParagraphs = [
  'The SCIReader PDF surface is designed to replace the previous Fabric canvas workspace. The first version focuses on viewing papers and capturing text selection as chat context.',
  'Selected text should become a first-class context object for LLM routes. Later versions can attach page coordinates, figures, tables, citations, and extracted PDF chunks.',
  'The reader keeps a large chat workspace visible so that users can ask about the whole paper, current page, selected text, or visual figures without leaving the document.',
];

export const PdfReader = ({ paper, onSelectionChange, initialZoom = 100, onZoomChange }: PdfReaderProps) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [pdfFrameStatus, setPdfFrameStatus] = useState<string | null>(null);
  const pdfUrlWithZoom = useMemo(() => `${paper.pdfUrl}${paper.pdfUrl.includes('#') ? '&' : '#'}zoom=${initialZoom}`, [initialZoom, paper.pdfUrl]);

  useEffect(() => {
    onZoomChange?.(initialZoom);
  }, [initialZoom, onZoomChange]);

  useEffect(() => {
    const saveZoomOnLeave = () => {
      const pdfFrameUrl = iframeRef.current?.contentWindow?.location.href;
      const match = pdfFrameUrl?.match(/[?#&]zoom=([^&]+)/);
      const nextZoom = match ? Number.parseInt(match[1], 10) : initialZoom;

      if (Number.isFinite(nextZoom)) onZoomChange?.(nextZoom);
    };

    window.addEventListener('pagehide', saveZoomOnLeave);

    return () => window.removeEventListener('pagehide', saveZoomOnLeave);
  }, [initialZoom, onZoomChange]);

  const captureSelection = useCallback(() => {
    const text = window.getSelection()?.toString().trim();
    onSelectionChange(text ? { text, pageNumber: 1 } : null);
  }, [onSelectionChange]);

  const inspectPdfFrame = useCallback((frame: HTMLIFrameElement | null) => {
    if (!frame) return;

    try {
      const frameTitle = frame.contentDocument?.title;
      const frameText = frame.contentDocument?.body?.innerText?.slice(0, 200);

      if (frameTitle || frameText) {
        console.info('PDF iframe loaded document', {
          pdfUrl: paper.pdfUrl,
          title: frameTitle,
          bodyPreview: frameText,
        });
      }

      if (frameTitle?.includes('404') || frameText?.includes('File not found')) {
        setPdfFrameStatus('PDF URL returned an error page. Open the PDF URL directly or check server storage logs.');
      } else {
        setPdfFrameStatus(null);
      }
    } catch {
      setPdfFrameStatus(null);
    }
  }, [paper.pdfUrl]);

  return (
    <section className="relative flex min-h-0 w-[min(72vw,1180px)] -translate-x-[12vw] flex-col rounded-3xl bg-slate-200 p-4 shadow-sm max-md:landscape:w-full max-md:landscape:translate-x-0 max-md:landscape:rounded-none max-md:landscape:p-1">
      <div className="min-h-0 flex-1 overflow-auto rounded-2xl bg-slate-200 p-4 max-md:landscape:rounded-none max-md:landscape:p-1">
        {paper.pdfUrl ? (
          <>
            {pdfFrameStatus ? <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{pdfFrameStatus}</div> : null}
            <iframe
              className="mx-auto h-full min-h-[980px] w-full origin-top rounded-sm bg-white shadow-xl transition-transform"
              onLoad={(event) => inspectPdfFrame(event.currentTarget)}
              onMouseUp={captureSelection}
              ref={iframeRef}
              src={pdfUrlWithZoom}
              style={{ transformOrigin: 'top center' }}
              title={paper.title}
            />
          </>
        ) : (
          <article
            className="mx-auto min-h-[980px] origin-top rounded-sm bg-white p-12 shadow-xl transition-transform"
            onMouseUp={captureSelection}
            style={{ width: 760 }}
          >
            <p className="text-sm font-semibold uppercase tracking-wide text-primary">PDF preview placeholder</p>
            <h2 className="mt-4 text-3xl font-bold leading-tight">{paper.title}</h2>
            <p className="mt-3 text-muted-foreground">{paper.authors}</p>
            <div className="mt-8 rounded-2xl border bg-slate-50 p-5">
              <h3 className="font-semibold">Abstract</h3>
              <p className="mt-3 leading-7 text-slate-700">{paper.abstract}</p>
            </div>
            <div className="mt-8 space-y-5 text-[15px] leading-8 text-slate-800">
              {sampleParagraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
            <div className="mt-10 rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              Figure area placeholder: future versions can attach selected figures or page regions to the chat context.
            </div>
          </article>
        )}
      </div>
    </section>
  );
};
