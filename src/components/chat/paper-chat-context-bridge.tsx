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
    setPaperContext(paper, selectedText);

    return () => setPaperContext(null);
  }, [paper, selectedText, setPaperContext]);

  return null;
};
