'use client';

import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';

import type { PaperSelection, PaperSummary } from '@/types/paper';

type FloatingChatContextValue = {
  paper: PaperSummary | null;
  selectedText: PaperSelection | null;
  setPaperContext: (paper: PaperSummary | null, selectedText?: PaperSelection | null) => void;
  setSelectedText: (selectedText: PaperSelection | null) => void;
};

const FloatingChatContext = createContext<FloatingChatContextValue | null>(null);

export const FloatingChatProvider = ({ children }: PropsWithChildren) => {
  const [paper, setPaper] = useState<PaperSummary | null>(null);
  const [selectedText, setSelectedText] = useState<PaperSelection | null>(null);

  const value = useMemo(
    () => ({
      paper,
      selectedText,
      setPaperContext: (nextPaper: PaperSummary | null, nextSelectedText: PaperSelection | null = null) => {
        setPaper(nextPaper);
        setSelectedText(nextSelectedText);
      },
      setSelectedText,
    }),
    [paper, selectedText],
  );

  return <FloatingChatContext.Provider value={value}>{children}</FloatingChatContext.Provider>;
};

export const useFloatingChat = () => {
  const context = useContext(FloatingChatContext);

  if (!context) throw new Error('useFloatingChat must be used inside FloatingChatProvider.');

  return context;
};
