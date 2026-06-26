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
  if (mode === 'quality' || mode === 'detailed' || mode === 'simple') return mode;
  if (mode === 'reviewer') return 'detailed';
  if (mode === 'reader') return 'simple';

  return 'detailed';
};

const getReadingModeLabel = (mode: PaperReadingMode) => {
  if (mode === 'quality') return 'High Quality / 高质量';
  if (mode === 'simple' || mode === 'reader') return 'Simple / 简单';

  return 'Detailed / 详细';
};

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
    <main className="relative h-screen overflow-hidden p-1">
      <nav className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-4 rounded-2xl bg-white/90 px-4 py-2 shadow-sm backdrop-blur">
        <Link className="text-sm font-medium text-primary" href="/research">
          ← Paper Library / 论文库
        </Link>
        <div className="text-sm text-muted-foreground">PDF Reader + Floating Chat / PDF 阅读器 + 浮动聊天窗</div>
        <div className="rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary">{getReadingModeLabel(readingMode)}</div>
        <div className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">{paper?.shouldAutoSummarize ? 'Start Reading / 开始解读' : 'Open Only / 仅打开'}</div>
      </nav>
      {paper ? (
        <div className="flex h-full min-h-0 justify-center overflow-hidden">
          <PdfReader initialZoom={preferences?.pdfZoom} onSelectionChange={setSelectedText} onZoomChange={saveZoom} paper={paper} />
          <PaperChatContextBridge paper={paper} selectedText={selectedText} />
        </div>
      ) : (
        <div className="flex h-full items-center justify-center px-6">
          <div className="max-w-md rounded-2xl border bg-white p-6 text-center shadow-sm">
            <h1 className="text-xl font-semibold">Open an uploaded paper first / 请从已上传论文打开</h1>
            <p className="mt-2 text-sm text-muted-foreground">Default sample papers are disabled. Please return to the paper library and open the paper you uploaded. / 预设样例论文已关闭。请回到论文库，打开你上传后的对应论文。</p>
            <Link className="mt-4 inline-flex rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" href="/research">
              Back to Paper Library / 返回论文库
            </Link>
          </div>
        </div>
      )}
    </main>
  );
};

export default PaperPage;
