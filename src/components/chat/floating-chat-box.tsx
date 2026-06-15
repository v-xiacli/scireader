'use client';

import { Bot, CornerDownLeft, FileSearch, ImageIcon, Loader2, Quote } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import ReactMarkdown from 'react-markdown';

import { mockMessages } from '@/features/papers/mock-data';
import type { ChatMessage, PaperReadingMode, PaperSelection, PaperSummary } from '@/types/paper';

interface FloatingChatBoxProps {
  paper?: PaperSummary | null;
  selectedText?: PaperSelection | null;
  initialPosition?: { x: number; y: number };
  initialSize?: { width: number; height: number };
  onLayoutChange?: (layout: { position: { x: number; y: number }; size: { width: number; height: number } }) => void;
}

const defaultPosition = { x: 0, y: 96 };
const defaultSize = { width: 560, height: 620 };
const minSize = { width: 320, height: 360 };
const edgePadding = 8;

type ResizeHandle = 'top' | 'right' | 'bottom' | 'left' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
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
  reviewer: `You are a physics/electromagnetics paper reviewer. Be skeptical, concise, and evidence-based.

For normal chat questions, answer only the user's question. Do not generate a full report unless the user asks for a whole-paper summary.

For a whole-paper summary, produce a compact review report with these five short sections:
1. Verdict: what problem is solved, whether it is worth reading, and the evidence level (High/Medium/Low).
2. Physical mechanism: the actual field/circuit/wave/material mechanism or design trick, including key assumptions and boundary conditions.
3. Key numbers: only the 3-6 most important reported values, with units and operating conditions.
4. Credibility check: whether simulation, measurement, baselines, bandwidth, loss, efficiency, fabrication tolerance, and physical plausibility support the claims.
5. Main weaknesses: the largest missing evidence, hidden cost, narrow condition, or reproducibility risk.

Rules: no section-by-section narration; no long literature survey; no accusations without evidence; if evidence is missing, say "The paper does not provide sufficient information to determine." Keep the whole report short, dense, and anchored to paper text.`,
  reader: `You are a physics/electromagnetics research reader. Be concise and focus on transferable understanding.

For normal chat questions, answer only the user's question. Do not generate a full report unless the user asks for a whole-paper summary.

For a whole-paper summary, produce a compact reading note with these five short sections:
1. Core idea: the one physical or engineering insight that makes the work useful.
2. Mechanism: how the structure, field distribution, circuit model, material choice, or boundary condition creates the reported behavior.
3. Key numbers: only the 3-6 most important reported values, with units and operating conditions.
4. How to reuse it: what design principle or analysis route can transfer to another project.
5. Limits: what is not proven, what operating range is narrow, and what should be checked before reuse.

Rules: no section-by-section narration; no broad literature essay; explain equations and figures only when they change the physical interpretation; keep the whole report short, practical, and anchored to paper text.`,
};

const buildConversationHistory = (messages: ChatMessage[]): ConversationTurn[] =>
  messages
    .filter((message) => message.content && message.contextLabel !== 'Paper brief' && message.contextLabel !== 'Paper report' && !message.imageBase64 && !message.imageUrl && message.content !== 'Analyzing...' && message.content !== 'Generating image...')
    .slice(-8)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, 2000),
    }));

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

export const FloatingChatBox = ({ paper = null, selectedText = null, initialPosition, initialSize, onLayoutChange }: FloatingChatBoxProps) => {
  const dragOffsetRef = useRef(defaultPosition);
  const resizeStartRef = useRef({ x: 0, y: 0, width: defaultSize.width, height: defaultSize.height, left: defaultPosition.x, top: defaultPosition.y });
  const resizeHandleRef = useRef<ResizeHandle>('bottom-right');
  const appliedInitialPositionKeyRef = useRef('');
  const appliedInitialSizeKeyRef = useRef('');
  const sizeRef = useRef(initialSize ?? defaultSize);
  const [messages, setMessages] = useState<ChatMessage[]>(mockMessages);
  const [input, setInput] = useState('');
  const [position, setPosition] = useState(initialPosition ?? defaultPosition);
  const [size, setSize] = useState(initialSize ?? defaultSize);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isImageMode, setIsImageMode] = useState(false);
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
  const readingModeLabel = `${readingMode === 'reviewer' ? '审稿人模式' : '读者模式'} · ${detailedReport ? '详细' : '极简'}`;

  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  useEffect(() => {
    console.info('Floating chat mounted/rendered.', {
      hasPaper,
      paperId,
      position,
      size,
      initialPosition,
      initialSize,
      viewport: typeof window === 'undefined' ? null : { width: window.innerWidth, height: window.innerHeight },
    });
  }, [hasPaper, paperId, position, size, initialPosition, initialSize]);

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
    onLayoutChange?.({ position, size });
  }, [onLayoutChange, position, size]);

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

  const generateImage = useCallback(
    async (prompt: string) => {
      const response = await fetch('/api/reader-agent/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          paperId,
          title: paperTitle,
          selectedText: selectedText?.text,
        }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Image generation failed.');

      return result as { answer: string; imageUrl?: string; imageBase64?: string; prompt: string };
    },
    [paperId, paperTitle, selectedText?.text],
  );

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
            content: error instanceof Error ? error.message : '论文要点生成失败，可以直接提问，我会读取论文回答。',
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
      contextLabel: isImageMode ? 'Image generation' : selectedText ? `Selection on page ${selectedText.pageNumber ?? '?'}` : hasPaper ? 'Whole paper' : 'General chat',
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
      { id: loadingId, role: 'assistant', content: isImageMode ? 'Generating image...' : 'Analyzing...' },
    ]);
    setInput('');
    setIsThinking(true);

    try {
      if (isImageMode) {
        const result = await generateImage(trimmed);
        setMessages((current) =>
          current.map((message) =>
            message.id === loadingId
              ? {
                  ...message,
                  content: result.answer,
                  imageUrl: result.imageUrl,
                  imageBase64: result.imageBase64,
                  imageAlt: result.prompt,
                }
              : message,
          ),
        );
      } else {
        const result = await askReaderAgent(trimmed, selectedText ? 'selected-text' : 'whole-paper');
        const usageLabel = result.usage?.inputTokens
          ? ` · ${result.usage.inputTokens.toLocaleString()} in / ${(result.usage.outputTokens ?? 0).toLocaleString()} out`
          : '';
        const contextLabel = result.routedBy === 'cheap-context' ? `Cheap context${usageLabel}` : result.routedBy === 'expensive-reader' ? `Expensive reader${usageLabel}` : undefined;

        setMessages((current) => current.map((message) => (message.id === loadingId ? { ...message, content: result.answer, contextLabel } : message)));
      }
    } catch (error) {
      setMessages((current) =>
        current.map((message) =>
          message.id === loadingId
            ? { ...message, content: error instanceof Error ? error.message : isImageMode ? 'Image generation failed.' : 'Reader agent failed.' }
            : message,
        ),
      );
    } finally {
      setIsThinking(false);
    }
  };

  return (
    <aside
      className="fixed z-50 flex max-w-[calc(100vw-1rem)] flex-col rounded-2xl border bg-white/95 shadow-2xl backdrop-blur"
      style={{ left: position.x, top: position.y, width: size.width, height: size.height }}
    >
      <header
        className={isDragging ? 'cursor-grabbing border-b px-3 py-2' : 'cursor-grab border-b px-3 py-2'}
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
            <button className="rounded-lg border p-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-40" disabled={!hasPaper} title="Paper context" type="button">
              <FileSearch className="size-4" />
            </button>
            <button className="rounded-lg border p-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-40" disabled={!selectedText} title="Selected text" type="button">
              <Quote className="size-4" />
            </button>
            <button
              className={isImageMode ? 'rounded-lg border border-primary bg-primary/10 p-1.5 text-primary' : 'rounded-lg border p-1.5 text-slate-700 hover:bg-slate-50'}
              onClick={() => setIsImageMode((current) => !current)}
              title="Image mode"
              type="button"
            >
              <ImageIcon className="size-4" />
            </button>
            <div className="rounded-lg bg-primary/10 p-1.5 text-primary">
              <Bot className="size-4" />
            </div>
          </div>
        </div>
      </header>

      {summaryProgress ? (
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

      {selectedText && !isImageMode ? (
        <div className="border-b bg-blue-50 p-3 text-xs">
          <p className="font-medium text-blue-900">Selected text context</p>
          <p className="mt-1 line-clamp-3 text-blue-800">{selectedText.text}</p>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
        {messages.map((message) => (
          <div className={message.role === 'user' ? 'ml-auto max-w-[92%] rounded-xl bg-primary p-2.5 text-primary-foreground' : 'mr-auto max-w-[96%] rounded-xl bg-slate-100 p-2.5'} key={message.id}>
            {message.contextLabel ? <p className="mb-1 text-[11px] opacity-70">{message.contextLabel}</p> : null}
            {message.imageUrl || message.imageBase64 ? (
              <img alt={message.imageAlt ?? 'Generated image'} className="mb-2 max-h-80 w-full rounded-lg object-contain" src={message.imageUrl ?? message.imageBase64} />
            ) : null}
            <div className="max-w-none break-words text-xs leading-5">
              <ReactMarkdown
                components={{
                  p: ({ children }) => <p className="my-1 whitespace-pre-wrap">{children}</p>,
                  li: ({ children }) => <li className="my-0.5 pl-0">{children}</li>,
                  ul: ({ children }) => <ul className="my-1 list-disc space-y-0 pl-4">{children}</ul>,
                  ol: ({ children }) => <ol className="my-1 list-decimal space-y-0 pl-4">{children}</ol>,
                  h1: ({ children }) => <h1 className="my-1 text-sm font-semibold">{children}</h1>,
                  h2: ({ children }) => <h2 className="my-1 text-sm font-semibold">{children}</h2>,
                  h3: ({ children }) => <h3 className="my-1 text-xs font-semibold">{children}</h3>,
                  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          </div>
        ))}
      </div>

      <footer className="border-t p-3">
        <textarea
          className="max-h-48 min-h-20 w-full resize-y rounded-xl border bg-slate-50 p-2.5 text-sm outline-none focus:border-primary"
          disabled={isThinking}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void sendMessage();
          }}
          placeholder={isImageMode ? 'Describe the image you want generated...' : 'Ask about the paper, selected text, methods, or citations...'}
          value={input}
        />
        <button
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-70"
          disabled={isThinking}
          onClick={() => void sendMessage()}
          type="button"
        >
          {isThinking ? <Loader2 className="size-4 animate-spin" /> : <CornerDownLeft className="size-4" />}
          {isThinking ? (isImageMode ? 'Image agent is working...' : 'Reader agent is working...') : isImageMode ? 'Generate image' : 'Send to reader agent'}
        </button>
      </footer>
      {(
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
