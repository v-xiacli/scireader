'use client';

import { FileText, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useState } from 'react';

import type { PaperSelection, PaperSummary } from '@/types/paper';

interface PdfReaderProps {
  paper: PaperSummary;
  onSelectionChange: (selection: PaperSelection | null) => void;
}

const sampleParagraphs = [
  'The SCIReader PDF surface is designed to replace the previous Fabric canvas workspace. The first version focuses on viewing papers and capturing text selection as chat context.',
  'Selected text should become a first-class context object for LLM routes. Later versions can attach page coordinates, figures, tables, citations, and extracted PDF chunks.',
  'The reader keeps a large chat workspace visible so that users can ask about the whole paper, current page, selected text, or visual figures without leaving the document.',
];

export const PdfReader = ({ paper, onSelectionChange }: PdfReaderProps) => {
  const [zoom, setZoom] = useState(100);

  const captureSelection = useCallback(() => {
    const text = window.getSelection()?.toString().trim();
    onSelectionChange(text ? { text, pageNumber: 1 } : null);
  }, [onSelectionChange]);

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-3xl bg-slate-900 p-4 shadow-sm">
      <header className="mb-4 flex items-center justify-between text-white">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded-xl bg-white/10 p-2">
            <FileText className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">{paper.title}</h1>
            <p className="truncate text-sm text-white/60">{paper.authors}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="rounded-lg bg-white/10 p-2 hover:bg-white/20" onClick={() => setZoom((value) => Math.max(70, value - 10))}>
            <ZoomOut className="size-4" />
          </button>
          <span className="w-14 text-center text-sm">{zoom}%</span>
          <button className="rounded-lg bg-white/10 p-2 hover:bg-white/20" onClick={() => setZoom((value) => Math.min(160, value + 10))}>
            <ZoomIn className="size-4" />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto rounded-2xl bg-slate-200 p-8">
        {paper.pdfUrl ? (
          <iframe
            className="mx-auto h-full min-h-[980px] w-full origin-top rounded-sm bg-white shadow-xl transition-transform"
            onMouseUp={captureSelection}
            src={paper.pdfUrl}
            style={{ transform: `scale(${zoom / 100})`, transformOrigin: 'top center' }}
            title={paper.title}
          />
        ) : (
          <article
            className="mx-auto min-h-[980px] origin-top rounded-sm bg-white p-12 shadow-xl transition-transform"
            onMouseUp={captureSelection}
            style={{ transform: `scale(${zoom / 100})`, width: 760 }}
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
