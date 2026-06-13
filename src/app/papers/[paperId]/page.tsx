'use client';

import Link from 'next/link';
import { useState } from 'react';

import { PaperChatContextBridge } from '@/components/chat/paper-chat-context-bridge';
import { PdfReader } from '@/components/paper/pdf-reader';
import { getMockPaper } from '@/features/papers/mock-data';
import type { PaperSelection } from '@/types/paper';

interface PaperPageProps {
  params: {
    paperId: string;
  };
  searchParams?: {
    pdfUrl?: string;
    title?: string;
  };
}

const PaperPage = ({ params, searchParams }: PaperPageProps) => {
  const mockPaper = getMockPaper(params.paperId);
  const paper = searchParams?.pdfUrl
    ? {
        ...mockPaper,
        id: params.paperId,
        title: searchParams.title ?? mockPaper.title,
        authors: 'Uploaded paper',
        pages: 0,
        status: 'uploaded' as const,
        pdfUrl: searchParams.pdfUrl,
      }
    : mockPaper;
  const [selectedText, setSelectedText] = useState<PaperSelection | null>(null);

  return (
    <main className="flex h-screen flex-col gap-4 p-4">
      <nav className="flex items-center justify-between rounded-3xl bg-white px-5 py-3 shadow-sm">
        <Link className="text-sm font-medium text-primary" href="/">
          ← Paper library
        </Link>
        <div className="text-sm text-muted-foreground">PDF viewer + large floating chat</div>
      </nav>
      <div className="relative min-h-0 flex-1">
        <PdfReader onSelectionChange={setSelectedText} paper={paper} />
        <PaperChatContextBridge paper={paper} selectedText={selectedText} />
      </div>
    </main>
  );
};

export default PaperPage;
