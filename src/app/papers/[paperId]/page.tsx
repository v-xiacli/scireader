'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { PaperChatContextBridge } from '@/components/chat/paper-chat-context-bridge';
import { PdfReader } from '@/components/paper/pdf-reader';
import type { PaperReadingMode, PaperSelection } from '@/types/paper';

interface PaperPageProps {
  params: {
    paperId: string;
  };
  searchParams?: {
    filePath?: string;
    pdfUrl?: string;
    title?: string;
    authors?: string;
    journal?: string;
    year?: string;
    readingMode?: string;
    detailedReport?: string;
  };
}

type ViewerPreferences = {
  pdfZoom?: number;
  readingMode?: PaperReadingMode;
  detailedReport?: boolean;
};

const normalizePdfUrl = (pdfUrl: string) => {
  const trimmed = pdfUrl.trim();

  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) return trimmed;
  if (trimmed.startsWith('api/')) return `/${trimmed}`;

  return `https://${trimmed}`;
};

const normalizeReadingMode = (mode?: string): PaperReadingMode => (mode === 'reader' ? 'reader' : 'reviewer');

const normalizeDetailedReport = (value?: string) => value !== '0' && value !== 'false';

const PaperPage = ({ params, searchParams }: PaperPageProps) => {
  const [selectedText, setSelectedText] = useState<PaperSelection | null>(null);
  const [preferences, setPreferences] = useState<ViewerPreferences | null>(null);
  const readingMode = searchParams?.readingMode ? normalizeReadingMode(searchParams.readingMode) : preferences?.readingMode ?? 'reviewer';
  const detailedReport = searchParams?.detailedReport === undefined ? preferences?.detailedReport ?? false : normalizeDetailedReport(searchParams.detailedReport);
  const paper = useMemo(
    () =>
      searchParams?.pdfUrl
        ? {
            id: params.paperId,
            title: searchParams.title ?? params.paperId,
            authors: searchParams.authors ?? 'Uploaded paper',
            pages: 0,
            status: 'uploaded' as const,
            abstract: 'Uploaded PDF ready for reading and chat.',
            pdfUrl: normalizePdfUrl(searchParams.pdfUrl),
            filePath: searchParams.filePath,
            journal: searchParams.journal,
            year: searchParams.year,
            readingMode,
            detailedReport,
          }
        : null,
    [params.paperId, readingMode, detailedReport, searchParams?.authors, searchParams?.filePath, searchParams?.journal, searchParams?.pdfUrl, searchParams?.title, searchParams?.year],
  );

  useEffect(() => {
    const loadPreferences = async () => {
      try {
        const response = await fetch('/api/auth/viewer-preferences');
        const result = await response.json();
        setPreferences(response.ok ? result.preferences : null);
      } catch {
        setPreferences(null);
      }
    };

    void loadPreferences();
  }, []);

  const saveZoom = useCallback((pdfZoom: number) => {
    void fetch('/api/auth/viewer-preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfZoom }),
    });
  }, []);

  return (
    <main className="relative h-screen overflow-hidden p-1">
      <nav className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-4 rounded-2xl bg-white/90 px-4 py-2 shadow-sm backdrop-blur">
        <Link className="text-sm font-medium text-primary" href="/">
          ← Paper library
        </Link>
        <div className="text-sm text-muted-foreground">PDF viewer + large floating chat</div>
        <div className="rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary">{readingMode === 'reviewer' ? '審稿人模式' : '讀者模式'}</div>
        <div className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">{detailedReport ? '詳細報告' : '極簡速覽'}</div>
      </nav>
      {paper ? (
        <div className="flex h-full min-h-0 justify-center overflow-hidden">
          <PdfReader initialZoom={preferences?.pdfZoom} onSelectionChange={setSelectedText} onZoomChange={saveZoom} paper={paper} />
          <PaperChatContextBridge paper={paper} selectedText={selectedText} />
        </div>
      ) : (
        <div className="flex h-full items-center justify-center px-6">
          <div className="max-w-md rounded-2xl border bg-white p-6 text-center shadow-sm">
            <h1 className="text-xl font-semibold">請從已上傳論文打開</h1>
            <p className="mt-2 text-sm text-muted-foreground">預設樣例論文已關閉。請回到論文庫，打開你上傳後的對應論文。</p>
            <Link className="mt-4 inline-flex rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" href="/">
              返回論文庫
            </Link>
          </div>
        </div>
      )}
    </main>
  );
};

export default PaperPage;
