'use client';

import { useEffect } from 'react';

import { useFloatingChat } from '@/components/chat/floating-chat-context';
import type { PaperSelection, PaperSummary } from '@/types/paper';

interface PaperChatContextBridgeProps {
  paper: PaperSummary;
  selectedText: PaperSelection | null;
}

export const PaperChatContextBridge = ({ paper, selectedText }: PaperChatContextBridgeProps) => {
  const { setPaperContext } = useFloatingChat();

  useEffect(() => {
    console.info('Paper chat context mounted.', {
      paperId: paper.id,
      title: paper.title,
      pdfUrl: paper.pdfUrl,
      hasSelectedText: Boolean(selectedText?.text),
    });

    setPaperContext(paper, selectedText);

    return () => {
      console.info('Paper chat context unmounted.', { paperId: paper.id });
      setPaperContext(null);
    };
  }, [paper, selectedText, setPaperContext]);

  return null;
};
