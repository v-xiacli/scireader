'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { PaperChatContextBridge } from '@/components/chat/paper-chat-context-bridge';
import { PdfReader } from '@/components/paper/pdf-reader';
import { getMockPaper } from '@/features/papers/mock-data';
import type { PaperSelection } from '@/types/paper';

interface PaperPageProps {
  params: {
    paperId: string;
  };
  searchParams?: {
    filePath?: string;
    pdfUrl?: string;
    title?: string;
  };
}

const normalizePdfUrl = (pdfUrl: string) => {
  const trimmed = pdfUrl.trim();

  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) return trimmed;
  if (trimmed.startsWith('api/')) return `/${trimmed}`;

  return `https://${trimmed}`;
};

const PaperPage = ({ params, searchParams }: PaperPageProps) => {
  const mockPaper = getMockPaper(params.paperId);
  const paper = useMemo(
    () =>
      searchParams?.pdfUrl
        ? {
            ...mockPaper,
            id: params.paperId,
            title: searchParams.title ?? mockPaper.title,
            authors: 'Uploaded paper',
            pages: 0,
            status: 'uploaded' as const,
            pdfUrl: normalizePdfUrl(searchParams.pdfUrl),
            filePath: searchParams.filePath,
          }
        : mockPaper,
    [mockPaper, params.paperId, searchParams?.filePath, searchParams?.pdfUrl, searchParams?.title],
  );
  const [selectedText, setSelectedText] = useState<PaperSelection | null>(null);

  useEffect(() => {
    if (!paper.filePath) return;

    const scheduleUploadedPdfDeletion = () => {
      navigator.sendBeacon(`/api/storage/delete-later/${encodeURIComponent(paper.filePath ?? '')}`);
    };

    window.addEventListener('pagehide', scheduleUploadedPdfDeletion);

    return () => {
      window.removeEventListener('pagehide', scheduleUploadedPdfDeletion);
    };
  }, [paper.filePath]);

  return (
    <main className="flex h-screen flex-col gap-4 p-4">
      <nav className="flex items-center justify-between rounded-3xl bg-white px-5 py-3 shadow-sm">
        <Link className="text-sm font-medium text-primary" href="/">
          ← Paper library
        </Link>
        <div className="text-sm text-muted-foreground">PDF viewer + large floating chat</div>
      </nav>
      <div className="relative flex min-h-0 flex-1 justify-center overflow-hidden">
        <PdfReader onSelectionChange={setSelectedText} paper={paper} />
        <PaperChatContextBridge paper={paper} selectedText={selectedText} />
      </div>
    </main>
  );
};

export default PaperPage;

