'use client';

import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';

import type { PaperSelection, PaperSummary } from '@/types/paper';

export type FloatingFinancialMaterial = {
  name: string;
  storagePath: string;
  contentType: string;
  size: number;
};

export type FloatingFinancialStock = {
  name: string;
  code: string;
  market?: 'A' | 'US' | 'HK' | 'FX';
};

export type FloatingFinancialContext = {
  active: boolean;
  materials: FloatingFinancialMaterial[];
  selectedStock: FloatingFinancialStock | null;
  analysisMode?: 'quality' | 'normal';
  billingMultiplier: number;
};

type FloatingChatContextValue = {
  paper: PaperSummary | null;
  selectedText: PaperSelection | null;
  financialContext: FloatingFinancialContext | null;
  setPaperContext: (paper: PaperSummary | null, selectedText?: PaperSelection | null) => void;
  setSelectedText: (selectedText: PaperSelection | null) => void;
  setFinancialContext: (financialContext: FloatingFinancialContext | null) => void;
};

const FloatingChatContext = createContext<FloatingChatContextValue | null>(null);

export const FloatingChatProvider = ({ children }: PropsWithChildren) => {
  const [paper, setPaper] = useState<PaperSummary | null>(null);
  const [selectedText, setSelectedText] = useState<PaperSelection | null>(null);
  const [financialContext, setFinancialContext] = useState<FloatingFinancialContext | null>(null);

  const value = useMemo(
    () => ({
      paper,
      selectedText,
      financialContext,
      setPaperContext: (nextPaper: PaperSummary | null, nextSelectedText: PaperSelection | null = null) => {
        setPaper(nextPaper);
        setSelectedText(nextSelectedText);
      },
      setSelectedText,
      setFinancialContext,
    }),
    [financialContext, paper, selectedText],
  );

  return <FloatingChatContext.Provider value={value}>{children}</FloatingChatContext.Provider>;
};

export const useFloatingChat = () => {
  const context = useContext(FloatingChatContext);

  if (!context) throw new Error('useFloatingChat must be used inside FloatingChatProvider.');

  return context;
};
