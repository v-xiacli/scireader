'use client';

import { CornerDownLeft, Download, Loader2, Maximize2, Minimize2, Type, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import rehypeKatex from 'rehype-katex';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';

import { mockMessages } from '@/features/papers/mock-data';
import type { ChatMessage, PaperReadingMode, PaperSelection, PaperSummary } from '@/types/paper';

interface FloatingChatBoxProps {
  paper?: PaperSummary | null;
  selectedText?: PaperSelection | null;
  initialPosition?: { x: number; y: number };
  initialSize?: { width: number; height: number };
  initialFontSize?: ChatFontSize;
  onLayoutChange?: (layout: { position: { x: number; y: number }; size: { width: number; height: number }; fontSize: ChatFontSize }) => void;
}

const defaultPosition = { x: 0, y: 96 };
const defaultSize = { width: 560, height: 620 };
const minSize = { width: 320, height: 360 };
const edgePadding = 8;
const mobileBreakpoint = 768;
const mobileCollapsedHeight = 58;

type ResizeHandle = 'top' | 'right' | 'bottom' | 'left' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
type ChatFontSize = 'xs' | 'small' | 'medium' | 'large' | 'xl';
type ConversationTurn = Pick<ChatMessage, 'role' | 'content'>;
type StoredHistoryTurn = ConversationTurn & {
  createdAt: string;
  model?: string;
  routedBy?: 'cheap-context' | 'expensive-reader';
  inputTokens?: number;
  outputTokens?: number;
};

type SummaryProgress = {
  percent: number;
  label: string;
  elapsedSeconds: number;
};

type SummaryResponse = {
  summary?: string;
  processing?: boolean;
  retryAfterSeconds?: number;
  cached?: boolean;
  jobStarted?: boolean;
  jobId?: string;
  job?: {
    jobId: string;
    startedAt: string;
    updatedAt: string;
    phase: string;
    currentChunk?: number;
    totalChunks?: number;
    message?: string;
  } | null;
};

const paperReadingPrompts: Record<PaperReadingMode, string> = {
  reviewer: `You are a cross-disciplinary engineering and applied-science paper reviewer. Be skeptical, concise, and evidence-based.

For normal chat questions, answer only the user's question. Do not generate a full report unless the user asks for a whole-paper summary.

For a whole-paper summary, produce a compact review report with these five short sections:
1. Verdict: what problem is solved, whether it is worth reading, and the evidence level (High/Medium/Low).
2. Core mechanism: the actual physical, algorithmic, data, system, or engineering mechanism, including key assumptions and boundary conditions.
3. Key numbers: only the 3-6 most important reported values, with units and operating conditions.
4. Credibility check: whether experiments, simulations, measurements, baselines, ablations, statistics, deployment evidence, or domain logic support the claims.
5. Main weaknesses: the largest missing evidence, hidden cost, narrow condition, or reproducibility risk.

Rules: no section-by-section narration; no long literature survey; no accusations without evidence; if evidence is missing, say "The paper does not provide sufficient information to determine." Keep the whole report short, dense, and anchored to paper text.`,
  reader: `You are a cross-disciplinary engineering and applied-science research reader. Be concise and focus on transferable understanding.

For normal chat questions, answer only the user's question. Do not generate a full report unless the user asks for a whole-paper summary.

For a whole-paper summary, produce a compact reading note with these five short sections:
1. Core idea: the one scientific, engineering, algorithmic, or application insight that makes the work useful.
2. Mechanism: how the method, model, data, system, structure, material, or domain assumption creates the reported behavior.
3. Key numbers: only the 3-6 most important reported values, with units and operating conditions.
4. How to reuse it: what design principle or analysis route can transfer to another project.
5. Limits: what is not proven, what operating range is narrow, and what should be checked before reuse.

Rules: no section-by-section narration; no broad literature essay; explain equations and figures only when they change the technical interpretation; keep the whole report short, practical, and anchored to paper text.`,
};

const chatFontSizeOrder: ChatFontSize[] = ['xs', 'small', 'medium', 'large', 'xl'];
const chatFontSizeStyles: Record<ChatFontSize, { label: string; body: string; h1: string; h2: string; h3: string; textarea: string }> = {
  xs: {
    label: '1',
    body: 'text-sm leading-6',
    h1: 'text-base',
    h2: 'text-base',
    h3: 'text-sm',
    textarea: 'text-sm',
  },
  small: {
    label: '2',
    body: 'text-base leading-7',
    h1: 'text-lg',
    h2: 'text-lg',
    h3: 'text-base',
    textarea: 'text-base',
  },
  medium: {
    label: '3',
    body: 'text-lg leading-8',
    h1: 'text-xl',
    h2: 'text-xl',
    h3: 'text-lg',
    textarea: 'text-lg',
  },
  large: {
    label: '4',
    body: 'text-xl leading-9',
    h1: 'text-2xl',
    h2: 'text-2xl',
    h3: 'text-xl',
    textarea: 'text-xl',
  },
  xl: {
    label: '5',
    body: 'text-2xl leading-10',
    h1: 'text-3xl',
    h2: 'text-3xl',
    h3: 'text-2xl',
    textarea: 'text-2xl',
  },
};

const buildConversationHistory = (messages: ChatMessage[]): ConversationTurn[] =>
  messages
    .filter((message) => message.content && message.contextLabel !== 'Paper brief' && message.contextLabel !== 'Paper report' && !message.imageBase64 && !message.imageUrl && message.content !== 'Analyzing...' && message.content !== 'Generating image...')
    .slice(-8)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, 2000),
    }));

const isExportableAssistantMessage = (message: ChatMessage) =>
  message.role === 'assistant' && Boolean(message.content.trim()) && !['Analyzing...', 'Generating image...'].includes(message.content);

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const normalizeExportHtml = (html: string) =>
  html
    .replace(/\sclass="[^"]*"/g, '')
    .replace(/\sstyle="[^"]*"/g, '')
    .replace(/<(h[1-6])[^>]*>/g, '<$1>')
    .replace(/<(p|ul|ol|li|strong|em|code|pre|blockquote|table|thead|tbody|tr|th|td|span|div)[^>]*>/g, '<$1>');

const getSummaryProgress = (elapsedSeconds: number): SummaryProgress => {
  if (elapsedSeconds < 3) return { percent: 12, label: 'No saved summary found yet. Starting summary generation...', elapsedSeconds };
  if (elapsedSeconds < 10) return { percent: 28, label: 'Reading the uploaded PDF...', elapsedSeconds };
  if (elapsedSeconds < 25) return { percent: 52, label: 'Generating the first compact paper report...', elapsedSeconds };
  if (elapsedSeconds < 60) return { percent: 76, label: 'Still preparing the compact paper report...', elapsedSeconds };

  return { percent: 90, label: 'Still working. First-time summaries can take a few minutes...', elapsedSeconds };
};

const formatSummaryProgressMessage = (progress: SummaryProgress) =>
  `${progress.label}\n\n${progress.percent}% complete · ${progress.elapsedSeconds}s elapsed\n\nI will show the summary here automatically when it is ready. After that, future opens should load the saved summary instead of regenerating.`;

const wait = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timeout = window.setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

const normalizeMathMarkdown = (content: string) =>
  content
    .replace(/\\\[((?:.|\n)*?)\\\]/g, (_match, expression: string) => `\n$$\n${expression.trim()}\n$$\n`)
    .replace(/\\\(((?:.|\n)*?)\\\)/g, (_match, expression: string) => `$${expression.trim()}$`);

const clampLayout = (position: { x: number; y: number }, size: { width: number; height: number }) => {
  if (typeof window === 'undefined') return { position, size };

  const nextSize = {
    width: Math.min(Math.max(minSize.width, size.width), Math.max(minSize.width, window.innerWidth - edgePadding * 2)),
    height: Math.min(Math.max(minSize.height, size.height), Math.max(minSize.height, window.innerHeight - edgePadding * 2)),
  };

  return {
    size: nextSize,
    position: {
      x: Math.min(Math.max(edgePadding, position.x), Math.max(edgePadding, window.innerWidth - nextSize.width - edgePadding)),
      y: Math.min(Math.max(edgePadding, position.y), Math.max(edgePadding, window.innerHeight - nextSize.height - edgePadding)),
    },
  };
};

export const FloatingChatBox = ({ paper = null, selectedText = null, initialPosition, initialSize, initialFontSize = 'small', onLayoutChange }: FloatingChatBoxProps) => {
  const dragOffsetRef = useRef(defaultPosition);
  const resizeStartRef = useRef({ x: 0, y: 0, width: defaultSize.width, height: defaultSize.height, left: defaultPosition.x, top: defaultPosition.y });
  const resizeHandleRef = useRef<ResizeHandle>('bottom-right');
  const appliedInitialPositionKeyRef = useRef('');
  const appliedInitialSizeKeyRef = useRef('');
  const appliedInitialFontSizeRef = useRef<ChatFontSize | null>(null);
  const sizeRef = useRef(initialSize ?? defaultSize);
  const messageBodyRefs = useRef(new Map<string, HTMLDivElement>());
  const [messages, setMessages] = useState<ChatMessage[]>(mockMessages);
  const [input, setInput] = useState('');
  const [position, setPosition] = useState(initialPosition ?? defaultPosition);
  const [size, setSize] = useState(initialSize ?? defaultSize);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [isMobileChatExpanded, setIsMobileChatExpanded] = useState(false);
  const [isMobilePortrait, setIsMobilePortrait] = useState(false);
  const [isPortraitHintDismissed, setIsPortraitHintDismissed] = useState(false);
  const [isExportMode, setIsExportMode] = useState(false);
  const [selectedExportIds, setSelectedExportIds] = useState<Set<string>>(() => new Set());
  const [chatFontSize, setChatFontSize] = useState<ChatFontSize>(initialFontSize);
  const [paperContextSummary, setPaperContextSummary] = useState('');
  const [summaryProgress, setSummaryProgress] = useState<SummaryProgress | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const hasPaper = Boolean(paper);
  const paperId = paper?.id;
  const paperPdfUrl = paper?.pdfUrl;
  const paperTitle = paper?.title;
  const readingMode: PaperReadingMode = paper?.readingMode ?? 'reviewer';
  const readingModePrompt = paperReadingPrompts[readingMode];
  const detailedReport = paper?.detailedReport ?? false;
  const readingModeLabel = `${readingMode === 'reviewer' ? '審稿人模式' : '讀者模式'} · ${detailedReport ? '詳細' : '極簡'}`;
  const fontSizeIndex = chatFontSizeOrder.indexOf(chatFontSize);
  const fontSizeStyle = chatFontSizeStyles[chatFontSize];
  const canDecreaseFontSize = fontSizeIndex > 0;
  const canIncreaseFontSize = fontSizeIndex < chatFontSizeOrder.length - 1;
  const exportableMessages = messages.filter(isExportableAssistantMessage);
  const selectedExportCount = selectedExportIds.size;
  const viewportWidth = typeof window === 'undefined' ? 390 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 720 : window.innerHeight;
  const mobileLayout = isMobileViewport
    ? {
        x: edgePadding,
        y: isMobileChatExpanded ? edgePadding : Math.max(edgePadding, viewportHeight - mobileCollapsedHeight - edgePadding),
        width: Math.max(minSize.width, viewportWidth - edgePadding * 2),
        height: isMobileChatExpanded ? Math.max(minSize.height, viewportHeight - edgePadding * 2) : mobileCollapsedHeight,
      }
    : null;

  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  useEffect(() => {
    const updateViewportMode = () => {
      const nextIsMobileViewport = window.innerWidth < mobileBreakpoint;
      setIsMobileViewport(nextIsMobileViewport);
      setIsMobilePortrait(nextIsMobileViewport && window.innerHeight > window.innerWidth);
    };

    updateViewportMode();
    window.addEventListener('resize', updateViewportMode);
    window.addEventListener('orientationchange', updateViewportMode);

    return () => {
      window.removeEventListener('resize', updateViewportMode);
      window.removeEventListener('orientationchange', updateViewportMode);
    };
  }, []);

  useEffect(() => {
    if (!isMobilePortrait) setIsPortraitHintDismissed(false);
  }, [isMobilePortrait]);

  useEffect(() => {
    setSelectedExportIds((current) => {
      const validIds = new Set(exportableMessages.map((message) => message.id));
      const next = new Set([...current].filter((id) => validIds.has(id)));

      return next.size === current.size ? current : next;
    });
  }, [exportableMessages]);

  useEffect(() => {
    console.info('Floating chat mounted/rendered.', {
      hasPaper,
      paperId,
      position,
      size,
      initialPosition,
      initialSize,
      initialFontSize,
      chatFontSize,
      viewport: typeof window === 'undefined' ? null : { width: window.innerWidth, height: window.innerHeight },
    });
  }, [hasPaper, paperId, position, size, initialPosition, initialSize, initialFontSize, chatFontSize]);

  useEffect(() => {
    if (appliedInitialFontSizeRef.current === initialFontSize) return;
    appliedInitialFontSizeRef.current = initialFontSize;
    setChatFontSize(initialFontSize);
  }, [initialFontSize]);

  useEffect(() => {
    if (!initialPosition) return;
    const initialPositionKey = `${initialPosition.x}:${initialPosition.y}`;
    if (appliedInitialPositionKeyRef.current === initialPositionKey) return;
    appliedInitialPositionKeyRef.current = initialPositionKey;

    setPosition((current) => {
      const nextPosition = clampLayout(initialPosition, size).position;

      return current.x === nextPosition.x && current.y === nextPosition.y ? current : nextPosition;
    });
  }, [initialPosition, size]);

  useEffect(() => {
    if (!initialSize) return;
    const initialSizeKey = `${initialSize.width}:${initialSize.height}`;
    if (appliedInitialSizeKeyRef.current === initialSizeKey) return;
    appliedInitialSizeKeyRef.current = initialSizeKey;

    setPosition((current) => {
      const layout = clampLayout(current, initialSize);

      return current.x === layout.position.x && current.y === layout.position.y ? current : layout.position;
    });
    setSize((current) => {
      const layout = clampLayout(position, initialSize);

      return current.width === layout.size.width && current.height === layout.size.height ? current : layout.size;
    });
  }, [initialSize, position]);

  useEffect(() => {
    onLayoutChange?.({ position, size, fontSize: chatFontSize });
  }, [chatFontSize, onLayoutChange, position, size]);

  useEffect(() => {
    const placeOnRight = () => {
      setPosition((current) => {
        if (initialPosition) return current;

        return {
          x: Math.max(edgePadding, window.innerWidth - sizeRef.current.width - 28),
          y: current.y,
        };
      });
    };

    placeOnRight();
    window.addEventListener('resize', placeOnRight);

    return () => window.removeEventListener('resize', placeOnRight);
  }, [initialPosition]);

  const askReaderAgent = useCallback(
    async (prompt: string, scope: 'whole-paper' | 'selected-text' = 'whole-paper') => {
      const response = await fetch('/api/reader-agent/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paperId: paperId ?? 'general-chat',
          pdfUrl: paperPdfUrl,
          title: paperTitle ?? 'SCIReader',
          authors: paper?.authors,
          journal: paper?.journal,
          year: paper?.year,
          prompt,
          readingMode,
          modePrompt: readingModePrompt,
          scope,
          selectedText: selectedText?.text,
          pageNumber: selectedText?.pageNumber,
          paperContextSummary,
          conversationHistory: buildConversationHistory(messages),
        }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Reader agent failed.');

      return result as { answer: string; usage?: { inputTokens?: number; outputTokens?: number }; routedBy?: string };
    },
    [messages, paperId, paperPdfUrl, paperTitle, paperContextSummary, readingMode, readingModePrompt, selectedText, paper?.authors, paper?.journal, paper?.year],
  );

  const loadPaperHistory = useCallback(async () => {
    if (!paperId || !paperPdfUrl) return [];

    const params = new URLSearchParams({
      paperId,
      pdfUrl: paperPdfUrl,
      title: paperTitle ?? paperId,
    });

    if (paper?.authors) params.set('authors', paper.authors);
    if (paper?.journal) params.set('journal', paper.journal);
    if (paper?.year) params.set('year', paper.year);

    const response = await fetch(`/api/reader-agent/history?${params.toString()}`);
    const result = await response.json();

    if (!response.ok) throw new Error(result.message ?? result.error ?? 'Paper history failed.');

    return Array.isArray(result.history) ? (result.history as StoredHistoryTurn[]) : [];
  }, [paperId, paperPdfUrl, paperTitle, paper?.authors, paper?.journal, paper?.year]);

  const summarizePaper = useCallback(async (signal?: AbortSignal) => {
    if (!paperId || !paperPdfUrl) return '';

    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      console.info('[reader-agent:summarize] polling summary', {
        paperId,
        attempt: attempt + 1,
        readingMode,
      });

      const response = await fetch('/api/reader-agent/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          paperId,
          pdfUrl: paperPdfUrl,
          title: paperTitle,
          authors: paper?.authors,
          journal: paper?.journal,
          year: paper?.year,
          prompt: readingModePrompt,
          readingMode,
          modePrompt: readingModePrompt,
          detailedReport,
          scope: 'whole-paper',
        }),
      });
      const result = (await response.json()) as SummaryResponse & { message?: string; error?: string };

      if (!response.ok && response.status !== 202) throw new Error(result.message ?? result.error ?? 'Paper summary failed.');
      console.info('[reader-agent:summarize] polling result', {
        paperId,
        attempt: attempt + 1,
        status: response.status,
        cached: result.cached,
        processing: result.processing,
        jobStarted: result.jobStarted,
        jobId: result.jobId ?? result.job?.jobId,
        phase: result.job?.phase,
        currentChunk: result.job?.currentChunk,
        totalChunks: result.job?.totalChunks,
        message: result.job?.message,
        hasSummary: Boolean(result.summary?.trim()),
      });

      if (result.summary?.trim()) return result.summary;

      const retryAfterSeconds = typeof result.retryAfterSeconds === 'number' ? result.retryAfterSeconds : 5;
      await wait(Math.max(2, retryAfterSeconds) * 1000, signal);
    }

    throw new Error('Paper summary is still processing. Please reopen this paper in a moment.');
  }, [paperId, paperPdfUrl, paperTitle, readingMode, readingModePrompt, detailedReport, paper?.authors, paper?.journal, paper?.year]);

  useEffect(() => {
    if (!paperId || !paperPdfUrl) {
      setPaperContextSummary('');
      setSummaryProgress(null);
      setIsSummarizing(false);
      setMessages(mockMessages);
      return;
    }

    let isActive = true;
    const abortController = new AbortController();
    const loadingId = crypto.randomUUID();
    const startedAt = Date.now();
    const initialProgress = getSummaryProgress(0);

    const updateProgress = () => {
      const nextProgress = getSummaryProgress(Math.floor((Date.now() - startedAt) / 1000));
      setSummaryProgress(nextProgress);
      setMessages((current) => current.map((message) => (message.id === loadingId ? { ...message, content: formatSummaryProgressMessage(nextProgress) } : message)));
    };

    const progressTimer = window.setInterval(updateProgress, 1000);

    setPaperContextSummary('');
    setSummaryProgress(initialProgress);
    setIsSummarizing(true);
    setMessages([
      {
        id: loadingId,
        role: 'assistant',
        content: formatSummaryProgressMessage(initialProgress),
        contextLabel: 'Paper report',
      },
    ]);

    summarizePaper(abortController.signal)
      .then(async (summary) => {
        if (!isActive) return;

        window.clearInterval(progressTimer);
        setSummaryProgress(null);
        setIsSummarizing(false);
        const history = await loadPaperHistory().catch(() => []);
        if (!isActive) return;

        setPaperContextSummary(summary);
        setMessages([
          {
            id: loadingId,
            role: 'assistant',
            content: summary,
            contextLabel: 'Paper report',
          },
          ...history.map((turn, index): ChatMessage => ({
            id: `history-${turn.createdAt}-${index}`,
            role: turn.role,
            content: turn.content,
            contextLabel: turn.role === 'assistant'
              ? `${turn.routedBy === 'cheap-context' ? 'Saved answer · cheap context' : 'Saved answer · expensive reader'}${turn.inputTokens ? ` · ${turn.inputTokens.toLocaleString()} in / ${(turn.outputTokens ?? 0).toLocaleString()} out` : ''}`
              : 'Saved question',
          })),
        ]);
      })
      .catch((error) => {
        if (!isActive) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;

        window.clearInterval(progressTimer);
        setSummaryProgress(null);
        setIsSummarizing(false);
        setMessages([
          {
            id: loadingId,
            role: 'assistant',
            content: error instanceof Error ? error.message : '論文要點生成失敗，可以直接提問，我會讀取論文回答。',
            contextLabel: 'Paper report',
          },
        ]);
      });

    return () => {
      isActive = false;
      abortController.abort();
      window.clearInterval(progressTimer);
      setIsSummarizing(false);
    };
  }, [paperId, paperPdfUrl, readingMode, summarizePaper, loadPaperHistory]);

  const startDragging = (event: PointerEvent<HTMLElement>) => {
    if (isMobileViewport) return;
    const target = event.target as HTMLElement;
    if (target.closest('button')) return;

    dragOffsetRef.current = {
      x: event.clientX - position.x,
      y: event.clientY - position.y,
    };
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const drag = (event: PointerEvent<HTMLElement>) => {
    if (isMobileViewport) return;
    if (!isDragging) return;

    const maxX = Math.max(0, window.innerWidth - size.width);
    const maxY = Math.max(0, window.innerHeight - size.height);

    setPosition({
      x: Math.min(Math.max(edgePadding, event.clientX - dragOffsetRef.current.x), maxX),
      y: Math.min(Math.max(edgePadding, event.clientY - dragOffsetRef.current.y), maxY),
    });
  };

  const stopDragging = (event: PointerEvent<HTMLElement>) => {
    setIsDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const startResizing = (handle: ResizeHandle) => (event: PointerEvent<HTMLDivElement>) => {
    if (isMobileViewport) return;
    event.preventDefault();
    event.stopPropagation();
    resizeHandleRef.current = handle;
    resizeStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      width: size.width,
      height: size.height,
      left: position.x,
      top: position.y,
    };
    setIsResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const resizeFromClient = (clientX: number, clientY: number) => {
    const handle = resizeHandleRef.current;
    const start = resizeStartRef.current;
    const deltaX = clientX - start.x;
    const deltaY = clientY - start.y;
    const right = start.left + start.width;
    const bottom = start.top + start.height;
    let nextLeft = start.left;
    let nextTop = start.top;
    let nextWidth = start.width;
    let nextHeight = start.height;

    if (handle.includes('left')) {
      nextWidth = start.width - deltaX;
      nextWidth = Math.min(Math.max(minSize.width, nextWidth), right - edgePadding);
      nextLeft = Math.max(edgePadding, right - nextWidth);
    } else if (handle.includes('right')) {
      nextWidth = start.width + deltaX;
      nextWidth = Math.min(Math.max(minSize.width, nextWidth), window.innerWidth - start.left - edgePadding);
    }

    if (handle.includes('top')) {
      nextHeight = start.height - deltaY;
      nextHeight = Math.min(Math.max(minSize.height, nextHeight), bottom - edgePadding);
      nextTop = Math.max(edgePadding, bottom - nextHeight);
    } else if (handle.includes('bottom')) {
      nextHeight = start.height + deltaY;
      nextHeight = Math.min(Math.max(minSize.height, nextHeight), window.innerHeight - start.top - edgePadding);
    }

    setPosition({ x: nextLeft, y: nextTop });
    setSize({ width: nextWidth, height: nextHeight });
  };

  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (!isResizing) return;

    resizeFromClient(event.clientX, event.clientY);
  };

  const stopResizing = (event: PointerEvent<HTMLDivElement>) => {
    setIsResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const toggleExportSelection = (messageId: string) => {
    setSelectedExportIds((current) => {
      const next = new Set(current);

      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }

      return next;
    });
  };

  const getPreviousUserQuestion = (assistantIndex: number) => {
    for (let index = assistantIndex - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'user') return messages[index].content;
    }

    return '';
  };

  const exportSelectedAnswersToPdf = () => {
    const selectedMessages = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => selectedExportIds.has(message.id) && isExportableAssistantMessage(message));

    if (!selectedMessages.length) {
      window.alert('請選擇至少一條 AI 回答。');
      return;
    }

    const title = paper?.title ?? 'SCIReader chat export';
    const exportedAt = new Date().toLocaleString();
    const sections = selectedMessages
      .map(({ message, index }, selectionIndex) => {
        const renderedHtml = messageBodyRefs.current.get(message.id)?.innerHTML;
        const question = getPreviousUserQuestion(index);

        return `<section class="answer-section">
          <div class="answer-meta">#${selectionIndex + 1}${message.contextLabel ? ` · ${escapeHtml(message.contextLabel)}` : ''}</div>
          ${question ? `<h2>Question</h2><div class="question">${escapeHtml(question)}</div>` : ''}
          <h2>Answer</h2>
          <div class="answer">${renderedHtml ? normalizeExportHtml(renderedHtml) : `<p>${escapeHtml(message.content).replace(/\n/g, '<br />')}</p>`}</div>
        </section>`;
      })
      .join('\n');
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)} - SCIReader export</title>
  <style>
    html { font-size: 11pt; }
    body { color: #111827; font-family: Arial, "Microsoft YaHei", sans-serif; line-height: 1.48; margin: 0; }
    header { border-bottom: 1px solid #d1d5db; margin-bottom: 14px; padding-bottom: 10px; }
    h1 { font-size: 16pt; line-height: 1.25; margin: 0 0 5px; }
    h2 { font-size: 11.5pt; line-height: 1.3; margin: 10px 0 5px; }
    h3 { font-size: 11pt; line-height: 1.3; margin: 8px 0 4px; }
    p { margin: 4px 0; }
    .subtle, .answer-meta { color: #6b7280; font-size: 8.5pt; }
    .answer-section { break-inside: auto; border-bottom: 1px solid #e5e7eb; margin-bottom: 14px; padding-bottom: 12px; }
    .question { background: #eff6ff; border-radius: 5px; font-size: 9.5pt; line-height: 1.45; padding: 7px 8px; white-space: pre-wrap; }
    .answer { background: #f8fafc; border-radius: 5px; font-size: 10.2pt; line-height: 1.5; padding: 8px 9px; }
    .answer p { margin: 4px 0; white-space: pre-wrap; }
    .answer ul, .answer ol { margin: 4px 0; padding-left: 18px; }
    .answer li { margin: 2px 0; }
    .answer table { border-collapse: collapse; font-size: 9pt; width: 100%; }
    .answer th, .answer td { border: 1px solid #d1d5db; padding: 4px 5px; vertical-align: top; }
    code { background: #eef2f7; border-radius: 3px; font-family: Consolas, monospace; font-size: 9pt; padding: 1px 3px; }
    pre { background: #111827; border-radius: 5px; color: white; font-size: 8.5pt; line-height: 1.4; overflow-wrap: anywhere; padding: 8px; white-space: pre-wrap; }
    .katex-display { overflow-x: auto; overflow-y: hidden; }
    @page { size: A4; margin: 15mm 14mm; }
    @media print { body { margin: 0; } .answer-section { break-inside: avoid; } }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <div class="subtle">SCIReader export · ${escapeHtml(readingModeLabel)} · ${escapeHtml(exportedAt)}</div>
  </header>
  ${sections}
  <script>
    window.addEventListener('load', () => {
      setTimeout(() => window.print(), 250);
    });
  </script>
</body>
</html>`;
    const printWindow = window.open('', '_blank', 'width=980,height=720');

    if (!printWindow) {
      window.alert('瀏覽器阻止了匯出視窗，請允許彈窗後重試。');
      return;
    }

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
  };

  useEffect(() => {
    if (!isResizing) return;

    const handlePointerMove = (event: globalThis.PointerEvent) => {
      event.preventDefault();
      resizeFromClient(event.clientX, event.clientY);
    };
    const handlePointerUp = () => setIsResizing(false);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [isResizing]);

  const sendMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || isThinking) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      contextLabel: selectedText ? `Selection on page ${selectedText.pageNumber ?? '?'}` : hasPaper ? 'Whole paper' : 'General chat',
    };
    const loadingId = crypto.randomUUID();

    if (isSummarizing && hasPaper) {
      const summaryNotice: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'I am still generating the first summary for this paper. Questions may use only saved history until the summary is ready.',
        contextLabel: 'Summary still running',
      };

      setMessages((current) => [...current, summaryNotice]);
    }

    setMessages((current) => [
      ...current,
      userMessage,
      { id: loadingId, role: 'assistant', content: 'Analyzing...' },
    ]);
    setInput('');
    setIsThinking(true);

    try {
      const result = await askReaderAgent(trimmed, selectedText ? 'selected-text' : 'whole-paper');
      const usageLabel = result.usage?.inputTokens ? ` · ${result.usage.inputTokens.toLocaleString()} in / ${(result.usage.outputTokens ?? 0).toLocaleString()} out` : '';
      const contextLabel = result.routedBy === 'cheap-context' ? `Cheap context${usageLabel}` : result.routedBy === 'expensive-reader' ? `Expensive reader${usageLabel}` : undefined;

      setMessages((current) => current.map((message) => (message.id === loadingId ? { ...message, content: result.answer, contextLabel } : message)));
    } catch (error) {
      setMessages((current) =>
        current.map((message) =>
          message.id === loadingId ? { ...message, content: error instanceof Error ? error.message : 'Reader agent failed.' } : message,
        ),
      );
    } finally {
      setIsThinking(false);
    }
  };

  return (
    <aside
      className="fixed z-50 flex max-w-[calc(100vw-1rem)] flex-col rounded-2xl border bg-white/95 shadow-2xl backdrop-blur"
      style={{
        left: mobileLayout?.x ?? position.x,
        top: mobileLayout?.y ?? position.y,
        width: mobileLayout?.width ?? size.width,
        height: mobileLayout?.height ?? size.height,
      }}
    >
      <header
        className={`${isMobileViewport ? 'cursor-default' : isDragging ? 'cursor-grabbing' : 'cursor-grab'} border-b px-3 py-2`}
        onPointerDown={startDragging}
        onPointerMove={drag}
        onPointerUp={stopDragging}
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-primary">{readingModeLabel}</p>
              <h2 className="text-sm font-semibold">{hasPaper ? 'Paper chat' : 'SCIReader chat'}</h2>
            </div>
            <p className="truncate text-[11px] text-muted-foreground">{paper?.title ?? 'Ask without opening a paper'}</p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {exportableMessages.length ? (
              <button
                className={isExportMode ? 'inline-flex items-center gap-1 rounded-lg border border-primary bg-primary/10 px-2 py-1.5 text-xs font-medium text-primary' : 'inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50'}
                onClick={(event) => {
                  event.stopPropagation();
                  setIsExportMode((current) => {
                    if (current) setSelectedExportIds(new Set());
                    return !current;
                  });
                }}
                onPointerDown={(event) => event.stopPropagation()}
                title={isExportMode ? '退出匯出選擇' : '選擇回答匯出 PDF'}
                type="button"
              >
                {isExportMode ? <X className="size-4" /> : <Download className="size-4" />}
                {isExportMode ? '取消' : '匯出'}
              </button>
            ) : null}
            {isMobileViewport ? (
              <button
                className="inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                onClick={(event) => {
                  event.stopPropagation();
                  setIsMobileChatExpanded((current) => !current);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                title={isMobileChatExpanded ? '最小化聊天框' : '展開聊天框'}
                type="button"
              >
                {isMobileChatExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                {isMobileChatExpanded ? 'PDF' : 'Chat'}
              </button>
            ) : null}
            <button
              className="inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-35"
              disabled={!canDecreaseFontSize}
              onClick={(event) => {
                event.stopPropagation();
                setChatFontSize((current) => chatFontSizeOrder[Math.max(0, chatFontSizeOrder.indexOf(current) - 1)]);
              }}
              onPointerDown={(event) => event.stopPropagation()}
              title="縮小聊天字體"
              type="button"
            >
              <Type className="size-4" />
              -
            </button>
            <span className="min-w-5 text-center text-[11px] font-medium text-slate-500" title="目前字體檔位">
              {fontSizeStyle.label}
            </span>
            <button
              className="inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-35"
              disabled={!canIncreaseFontSize}
              onClick={(event) => {
                event.stopPropagation();
                setChatFontSize((current) => chatFontSizeOrder[Math.min(chatFontSizeOrder.length - 1, chatFontSizeOrder.indexOf(current) + 1)]);
              }}
              onPointerDown={(event) => event.stopPropagation()}
              title="放大聊天字體"
              type="button"
            >
              <Type className="size-4" />
              +
            </button>
          </div>
        </div>
      </header>

      {isMobilePortrait && !isPortraitHintDismissed ? (
        <div className="absolute inset-x-3 top-16 z-30 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 shadow-lg">
          <p className="font-semibold">建議橫屏閱讀</p>
          <p className="mt-1 text-xs leading-5 text-amber-800">手機豎屏空間太窄，橫屏更適合一邊看 PDF、一邊展開聊天。</p>
          <button
            className="mt-2 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white"
            onClick={() => setIsPortraitHintDismissed(true)}
            type="button"
          >
            繼續豎屏
          </button>
        </div>
      ) : null}

      {isExportMode && !(isMobileViewport && !isMobileChatExpanded) ? (
        <div className="flex items-center gap-2 border-b bg-slate-50 px-3 py-2 text-xs">
          <span className="text-slate-600">已選 {selectedExportCount} 條回答</span>
          <button
            className="ml-auto rounded-lg border px-2.5 py-1.5 font-medium text-slate-700 hover:bg-white"
            onClick={() => setSelectedExportIds(new Set(exportableMessages.map((message) => message.id)))}
            type="button"
          >
            全選
          </button>
          <button
            className="rounded-lg border px-2.5 py-1.5 font-medium text-slate-700 hover:bg-white"
            onClick={() => setSelectedExportIds(new Set())}
            type="button"
          >
            清空
          </button>
          <button
            className="rounded-lg bg-primary px-2.5 py-1.5 font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!selectedExportCount}
            onClick={exportSelectedAnswersToPdf}
            type="button"
          >
            匯出選中
          </button>
        </div>
      ) : null}

      {isMobileViewport && !isMobileChatExpanded ? null : summaryProgress ? (
        <div className="border-b bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">{summaryProgress.label}</span>
            <span>{summaryProgress.percent}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-amber-100">
            <div className="h-full rounded-full bg-amber-500 transition-all duration-500" style={{ width: `${summaryProgress.percent}%` }} />
          </div>
          <p className="mt-1 text-[11px] text-amber-700">{summaryProgress.elapsedSeconds}s elapsed</p>
        </div>
      ) : null}

      {isMobileViewport && !isMobileChatExpanded ? null : selectedText ? (
        <div className="border-b bg-blue-50 p-3 text-xs">
          <p className="font-medium text-blue-900">Selected text context</p>
          <p className="mt-1 line-clamp-3 text-blue-800">{selectedText.text}</p>
        </div>
      ) : null}

      <div className={isMobileViewport && !isMobileChatExpanded ? 'hidden' : 'min-h-0 flex-1 space-y-2 overflow-auto p-3'}>
        {messages.map((message) => {
          const canExportMessage = isExportableAssistantMessage(message);
          const isSelectedForExport = selectedExportIds.has(message.id);

          return (
          <div className={message.role === 'user' ? 'ml-auto max-w-[92%] rounded-xl bg-primary p-2.5 text-primary-foreground' : 'mr-auto max-w-[96%] rounded-xl bg-slate-100 p-2.5'} key={message.id}>
            <div className="mb-1 flex items-center gap-2">
              {isExportMode && canExportMessage ? (
                <label className="inline-flex items-center gap-1 text-[11px] font-medium opacity-80">
                  <input
                    checked={isSelectedForExport}
                    className="size-3.5"
                    onChange={() => toggleExportSelection(message.id)}
                    type="checkbox"
                  />
                  PDF
                </label>
              ) : null}
              {message.contextLabel ? <p className="text-[11px] opacity-70">{message.contextLabel}</p> : null}
            </div>
            {message.imageUrl || message.imageBase64 ? (
              <img alt={message.imageAlt ?? 'Generated image'} className="mb-2 max-h-80 w-full rounded-lg object-contain" src={message.imageUrl ?? message.imageBase64} />
            ) : null}
            <div
              className={`max-w-none break-words ${fontSizeStyle.body}`}
              ref={(node) => {
                if (!canExportMessage) return;
                if (node) {
                  messageBodyRefs.current.set(message.id, node);
                } else {
                  messageBodyRefs.current.delete(message.id);
                }
              }}
            >
              <ReactMarkdown
                remarkPlugins={[remarkMath]}
                rehypePlugins={[rehypeKatex]}
                components={{
                  p: ({ children }) => <p className="my-1 whitespace-pre-wrap">{children}</p>,
                  li: ({ children }) => <li className="my-0.5 pl-0">{children}</li>,
                  ul: ({ children }) => <ul className="my-1 list-disc space-y-0 pl-4">{children}</ul>,
                  ol: ({ children }) => <ol className="my-1 list-decimal space-y-0 pl-4">{children}</ol>,
                  h1: ({ children }) => <h1 className={`my-1 font-semibold ${fontSizeStyle.h1}`}>{children}</h1>,
                  h2: ({ children }) => <h2 className={`my-1 font-semibold ${fontSizeStyle.h2}`}>{children}</h2>,
                  h3: ({ children }) => <h3 className={`my-1 font-semibold ${fontSizeStyle.h3}`}>{children}</h3>,
                  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                  div: ({ children, className }) => <div className={className?.includes('math-display') ? `${className} overflow-x-auto py-1` : className}>{children}</div>,
                }}
              >
                {normalizeMathMarkdown(message.content)}
              </ReactMarkdown>
            </div>
          </div>
          );
        })}
      </div>

      <footer className={isMobileViewport && !isMobileChatExpanded ? 'hidden' : 'border-t p-3'}>
        <textarea
          className={`max-h-48 min-h-20 w-full resize-y rounded-xl border bg-slate-50 p-2.5 outline-none focus:border-primary ${fontSizeStyle.textarea}`}
          disabled={isThinking}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void sendMessage();
          }}
          placeholder="Ask about the paper, selected text, methods, or citations..."
          value={input}
        />
        <button
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-70"
          disabled={isThinking}
          onClick={() => void sendMessage()}
          type="button"
        >
          {isThinking ? <Loader2 className="size-4 animate-spin" /> : <CornerDownLeft className="size-4" />}
          {isThinking ? 'Reader agent is working...' : 'Send to reader agent'}
        </button>
      </footer>
      {!isMobileViewport && (
        [
          ['top', 'left-6 right-6 top-0 h-3 cursor-ns-resize'],
          ['right', 'bottom-6 right-0 top-6 w-3 cursor-ew-resize'],
          ['bottom', 'bottom-0 left-6 right-6 h-3 cursor-ns-resize'],
          ['left', 'bottom-6 left-0 top-6 w-3 cursor-ew-resize'],
          ['top-left', 'left-0 top-0 size-8 cursor-nwse-resize rounded-tl-2xl border-l-2 border-t-2'],
          ['top-right', 'right-0 top-0 size-8 cursor-nesw-resize rounded-tr-2xl border-r-2 border-t-2'],
          ['bottom-left', 'bottom-0 left-0 size-8 cursor-nesw-resize rounded-bl-2xl border-b-2 border-l-2'],
          ['bottom-right', 'bottom-0 right-0 size-10 cursor-nwse-resize rounded-br-2xl border-b-2 border-r-2'],
        ] as Array<[ResizeHandle, string]>
      ).map(([handle, placement]) => (
        <div
          aria-label={`Resize chat box from ${handle}`}
          className={`absolute z-20 touch-none ${placement} ${isResizing && resizeHandleRef.current === handle ? 'border-primary bg-primary/10' : 'border-slate-400/80 hover:border-primary hover:bg-primary/5'}`}
          key={handle}
          onPointerDown={startResizing(handle)}
          onPointerMove={resize}
          onPointerUp={stopResizing}
          role="separator"
        >
          {handle === 'bottom-right' ? <div className="absolute bottom-2 right-2 size-3 border-b-2 border-r-2 border-current text-slate-500" /> : null}
        </div>
      ))}
    </aside>
  );
};
