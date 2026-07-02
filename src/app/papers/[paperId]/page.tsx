'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { PaperChatContextBridge } from '@/components/chat/paper-chat-context-bridge';
import { LanguageToggle, localizeBilingualText, useLanguage } from '@/components/language/language-context';
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
    start?: string;
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

const normalizeReadingMode = (mode?: string): PaperReadingMode => {
  if (mode === 'quality' || mode === 'detailed' || mode === 'simple' || mode === 'reviewer') return mode;
  if (mode === 'reader') return 'simple';

  return 'detailed';
};

const normalizeDetailedReport = (value?: string) => value !== '0' && value !== 'false';

const PaperPage = ({ params, searchParams }: PaperPageProps) => {
  const { language } = useLanguage();
  const b = (value: string) => localizeBilingualText(value, language);
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
            shouldAutoSummarize: searchParams.start === '1',
          }
        : null,
    [params.paperId, readingMode, detailedReport, searchParams?.authors, searchParams?.filePath, searchParams?.journal, searchParams?.pdfUrl, searchParams?.start, searchParams?.title, searchParams?.year],
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
    <main className="paper-glass-page grid h-screen grid-rows-[64px_minmax(0,1fr)] overflow-hidden sm:grid-rows-[72px_minmax(0,1fr)]">
      <header className="paper-glass-nav relative z-20 flex min-w-0 items-center gap-3 px-3 sm:px-5">
        <Link
          aria-label={b('Back to Paper Library / 返回论文库')}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-primary/30 hover:bg-primary/5 hover:text-primary"
          href="/research"
        >
          <span aria-hidden="true" className="text-lg leading-none">←</span>
          <span className="hidden sm:inline">{b('Paper Library / 论文库')}</span>
        </Link>

        <div className="h-8 w-px shrink-0 bg-slate-200" />

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="size-2 shrink-0 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]" />
            <h1 className="truncate text-sm font-semibold text-slate-900 sm:text-[15px]">
              {paper?.title ?? b('Paper Reader / 论文阅读器')}
            </h1>
          </div>
          {paper?.authors ? <p className="mt-0.5 hidden truncate text-xs text-slate-500 sm:block">{paper.authors}</p> : null}
        </div>

        <div className="hidden shrink-0 items-center gap-2 text-xs text-slate-500 lg:flex">
          <span className="rounded-full bg-slate-100 px-3 py-1.5">PDF</span>
          <span>{b('Select text to ask AI / 选中文字即可提问')}</span>
        </div>
        <LanguageToggle className="shrink-0" />
      </header>

      {paper ? (
        <div className="relative flex min-h-0 overflow-hidden">
          <PdfReader initialZoom={preferences?.pdfZoom} onSelectionChange={setSelectedText} onZoomChange={saveZoom} paper={paper} />
          <PaperChatContextBridge paper={paper} selectedText={selectedText} />
        </div>
      ) : (
        <div className="flex h-full items-center justify-center px-6">
          <div className="max-w-md rounded-2xl border bg-white p-6 text-center shadow-sm">
            <h1 className="text-xl font-semibold">{b('Open an uploaded paper first / 请从已上传论文打开')}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{b('Default sample papers are disabled. Please return to the paper library and open the paper you uploaded. / 预设样例论文已关闭。请回到论文库，打开你上传后的对应论文。')}</p>
            <Link className="mt-4 inline-flex rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" href="/research">
              {b('Back to Paper Library / 返回论文库')}
            </Link>
          </div>
        </div>
      )}
    </main>
  );
};

export default PaperPage;
