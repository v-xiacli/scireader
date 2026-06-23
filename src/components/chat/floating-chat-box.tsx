'use client';

import { CornerDownLeft, Download, Loader2, Maximize2, Minimize2, Type, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import rehypeKatex from 'rehype-katex';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';

import { mockMessages } from '@/features/papers/mock-data';
import type { ChatMessage, PaperReadingMode, PaperSelection, PaperSummary } from '@/types/paper';
import type { FloatingFinancialContext } from '@/components/chat/floating-chat-context';

interface FloatingChatBoxProps {
  paper?: PaperSummary | null;
  selectedText?: PaperSelection | null;
  financialContext?: FloatingFinancialContext | null;
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

type TokenEstimateResponse = {
  inputTokens: number;
  billableTokens?: number;
  tokenWeight?: number;
  model?: string;
  method?: string;
  pages?: number;
  extractedChars?: number;
  returnedChars?: number;
  sourceLanguage?: 'chinese' | 'english' | 'mixed';
  wasTruncated?: boolean;
  warning?: string;
};

type FigureReadingEstimateResponse = {
  startPage: number;
  endPage: number;
  pageNumbers: number[];
  inputTokens: number;
  billableTokens: number;
  model: string;
  cached: boolean;
  cachePath?: string;
};

type LargeSummaryWarning = {
  summaryKey: string;
  inputTokens: number;
  billableTokens: number;
  model?: string;
  pages?: number;
  reason: string;
};

type PendingImageReading = {
  prompt: string;
  range: ImagePageRange;
  estimate: FigureReadingEstimateResponse;
};

const largeSummaryBillableTokenThreshold = 500_000;
const imageReadingPromptTemplate = '读取第x页到第y页的图片';
const maxImageReadingPagesPerRequest = 6;

type ImagePageRange = {
  startPage: number;
  endPage: number;
  pageNumbers: number[];
  wasLimited: boolean;
};

const paperReadingPrompts: Record<PaperReadingMode, string> = {
  quality: `You are SCIReader's high-quality academic paper analyst. Use the strongest available evidence in the paper and preserve technical precision.

For normal chat questions, answer only the user's question. Do not generate a full report unless the user asks for a whole-paper summary.

For a whole-paper summary, produce a rigorous but concise review report with these sections:
1. Publication-level assessment: infer the technical field and likely paper level from contribution quality, evidence, novelty, validation, venue metadata, and writing.
2. Verdict: what problem is solved, whether it is worth reading, and the evidence level (High/Medium/Low).
3. Core mechanism: the actual physical, algorithmic, data, system, or engineering mechanism, including assumptions and boundary conditions.
4. Key numbers: only the most important reported values, with units and operating conditions.
5. Credibility check: experiments, simulations, measurements, baselines, ablations, statistics, deployment evidence, or domain logic.
6. Innovation and transfer: whether novelty is strong, moderate, or incremental, and how it can be reused.
7. Main weaknesses: missing evidence, hidden cost, narrow condition, reproducibility risk, or weak publication signals.

Rules: be strict but evidence-based; do not fabricate; preserve citations, numbers, equations, figure/table labels, and Markdown structure.`,
  detailed: `You are a cross-disciplinary engineering and applied-science paper reviewer. Be skeptical, concise, and evidence-based.

For normal chat questions, answer only the user's question. Do not generate a full report unless the user asks for a whole-paper summary.

For a whole-paper summary, produce a detailed Chinese review report with these sections:
1. Verdict: what problem is solved, whether it is worth reading, and the evidence level.
2. Core mechanism: the actual mechanism, assumptions, and boundary conditions.
3. Key numbers: the most important reported values with units.
4. Credibility check: whether experiments, simulations, measurements, baselines, ablations, statistics, deployment evidence, or domain logic support the claims.
5. Main weaknesses: missing evidence, hidden cost, narrow condition, or reproducibility risk.

Rules: no section-by-section narration; no long literature survey; if evidence is missing, say the paper does not provide sufficient information to determine.`,
  simple: `You are SCIReader's fast academic reading assistant. Be concise and focus on transferable understanding.

For normal chat questions, answer only the user's question.

For a whole-paper summary, produce a short Chinese reading note with five compact sections:
1. Core idea.
2. Mechanism.
3. Key numbers.
4. How to reuse it.
5. Limits.

Rules: no broad literature essay; explain equations and figures only when they change the technical interpretation; keep the result short and anchored to paper text.`,
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

const normalizePaperReadingMode = (mode: PaperReadingMode): PaperReadingMode => {
  if (mode === 'quality' || mode === 'detailed' || mode === 'simple') return mode;
  if (mode === 'reader') return 'simple';

  return 'detailed';
};

const getPaperReadingModeLabel = (mode: PaperReadingMode) => {
  const normalizedMode = normalizePaperReadingMode(mode);

  if (normalizedMode === 'quality') return '高质量';
  if (normalizedMode === 'simple') return '简单';

  return '详细';
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
  if (elapsedSeconds < 3) return { percent: 12, label: '尚未找到已保存摘要，正在開始生成...', elapsedSeconds };
  if (elapsedSeconds < 10) return { percent: 28, label: '正在讀取上傳的 PDF...', elapsedSeconds };
  if (elapsedSeconds < 25) return { percent: 52, label: '正在生成第一版精簡論文報告...', elapsedSeconds };
  if (elapsedSeconds < 60) return { percent: 76, label: '仍在準備精簡論文報告...', elapsedSeconds };

  return { percent: 90, label: '仍在處理。首次生成可能需要幾分鐘...', elapsedSeconds };
};

const formatSummaryProgressMessage = (progress: SummaryProgress) =>
  `${progress.label}\n\n已完成 ${progress.percent}% · 已用 ${progress.elapsedSeconds}s\n\n摘要完成後會自動顯示在這裡；之後再次打開同一篇文獻會優先讀取已保存摘要。`;

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

const formatTokenCount = (tokens: number) => `${Math.round(tokens).toLocaleString()} token`;

const getSummaryRunKey = (paperId: string | undefined, paperPdfUrl: string | undefined, readingMode: PaperReadingMode, detailedReport: boolean) =>
  paperId && paperPdfUrl ? `${paperId}:${paperPdfUrl}:${readingMode}:${detailedReport ? 'detailed' : 'brief'}` : '';

const isLikelyDissertation = (paper: PaperSummary | null | undefined, estimate?: TokenEstimateResponse) => {
  const metadataText = [paper?.title, paper?.journal, paper?.abstract]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return (
    /\b(dissertation|doctoral thesis|phd thesis|ph\.?d\.?|master'?s thesis|thesis)\b|博士|學位論文|学位论文|碩士|硕士/.test(metadataText) ||
    (estimate?.pages ?? paper?.pages ?? 0) >= 120
  );
};

const buildLargeSummaryWarning = (summaryKey: string, paper: PaperSummary | null | undefined, estimate?: TokenEstimateResponse): LargeSummaryWarning | null => {
  if (!summaryKey || !estimate) return null;

  const inputTokens = estimate.inputTokens ?? 0;
  const billableTokens = estimate.billableTokens ?? inputTokens;
  const likelyDissertation = isLikelyDissertation(paper, estimate);
  const isLarge = billableTokens >= largeSummaryBillableTokenThreshold || inputTokens >= largeSummaryBillableTokenThreshold;

  if (!isLarge && !likelyDissertation) return null;

  const reason = isLarge
    ? `估算本次摘要可能消耗 ${formatTokenCount(Math.max(billableTokens, inputTokens))}，已超過 500,000 token。`
    : '這份文件頁數或元資料像學位論文，完整摘要可能消耗很高。';

  return {
    summaryKey,
    inputTokens,
    billableTokens,
    model: estimate.model,
    pages: estimate.pages ?? paper?.pages,
    reason,
  };
};

const isImageReadingPrompt = (prompt: string) =>
  /(?:读取|阅读|读|分析|查看|看看).*(?:图片|图像|截图|图表)|(?:read|analy[sz]e|inspect|view).*(?:image|figure|screenshot)/i.test(prompt);

const isImageReadingConfirmation = (prompt: string) =>
  /^(继续|继续吧|继续读图|确认|确认继续|是|是的|好的|好|可以|开始|开始吧|开始读图|读图|yes|y|ok|go|sure)$/i.test(prompt.replace(/\s+/g, '').trim());

const isImageReadingCancellation = (prompt: string) =>
  /^(取消|算了|不用|不读了|先不读|否|不要|no|n|cancel|stop)$/i.test(prompt.replace(/\s+/g, '').trim());

const parseImagePageRange = (prompt: string, totalPages?: number): ImagePageRange | null => {
  if (!isImageReadingPrompt(prompt)) return null;

  const normalized = prompt.replace(/\s+/g, '');
  const rangeMatch = normalized.match(/第?(\d+)页?(?:到|至|-|~|～)第?(\d+)页?/);
  const singlePageMatch = normalized.match(/第?(\d+)页/);

  const rawStart = rangeMatch ? Number(rangeMatch[1]) : singlePageMatch ? Number(singlePageMatch[1]) : NaN;
  const rawEnd = rangeMatch ? Number(rangeMatch[2]) : rawStart;

  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return null;

  const orderedStart = Math.max(1, Math.min(rawStart, rawEnd));
  const orderedEnd = Math.max(1, Math.max(rawStart, rawEnd));
  const boundedEnd = totalPages ? Math.min(orderedEnd, totalPages) : orderedEnd;
  const pageNumbers = Array.from({ length: Math.max(0, boundedEnd - orderedStart + 1) }, (_, index) => orderedStart + index);
  const limitedPageNumbers = pageNumbers.slice(0, maxImageReadingPagesPerRequest);

  if (!limitedPageNumbers.length) return null;

  return {
    startPage: limitedPageNumbers[0],
    endPage: limitedPageNumbers[limitedPageNumbers.length - 1],
    pageNumbers: limitedPageNumbers,
    wasLimited: limitedPageNumbers.length < pageNumbers.length,
  };
};

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

export const FloatingChatBox = ({ paper = null, selectedText = null, financialContext = null, initialPosition, initialSize, initialFontSize = 'small', onLayoutChange }: FloatingChatBoxProps) => {
  const dragOffsetRef = useRef(defaultPosition);
  const resizeStartRef = useRef({ x: 0, y: 0, width: defaultSize.width, height: defaultSize.height, left: defaultPosition.x, top: defaultPosition.y });
  const resizeHandleRef = useRef<ResizeHandle>('bottom-right');
  const appliedInitialPositionKeyRef = useRef('');
  const appliedInitialSizeKeyRef = useRef('');
  const appliedInitialFontSizeRef = useRef<ChatFontSize | null>(null);
  const appliedChatModeRef = useRef<'financial' | 'standard' | null>(null);
  const appliedFinancialHistoryKeyRef = useRef('');
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
  const [isDesktopChatCollapsed, setIsDesktopChatCollapsed] = useState(false);
  const [isMobilePortrait, setIsMobilePortrait] = useState(false);
  const [isPortraitHintDismissed, setIsPortraitHintDismissed] = useState(false);
  const [isExportMode, setIsExportMode] = useState(false);
  const [selectedExportIds, setSelectedExportIds] = useState<Set<string>>(() => new Set());
  const [chatFontSize, setChatFontSize] = useState<ChatFontSize>(initialFontSize);
  const [paperContextSummary, setPaperContextSummary] = useState('');
  const [summaryProgress, setSummaryProgress] = useState<SummaryProgress | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [largeSummaryWarning, setLargeSummaryWarning] = useState<LargeSummaryWarning | null>(null);
  const [pendingImageReading, setPendingImageReading] = useState<PendingImageReading | null>(null);
  const [confirmedLargeSummaryKey, setConfirmedLargeSummaryKey] = useState('');
  const [isCheckingSummaryCost, setIsCheckingSummaryCost] = useState(false);
  const hasPaper = Boolean(paper);
  const isFinancialChat = Boolean(financialContext?.active);
  const financialStockKey = financialContext?.selectedStock ? `${financialContext.selectedStock.market ?? 'A'}:${financialContext.selectedStock.code}` : '';
  const paperId = paper?.id;
  const paperPdfUrl = paper?.pdfUrl;
  const paperTitle = paper?.title;
  const readingMode: PaperReadingMode = normalizePaperReadingMode(paper?.readingMode ?? 'detailed');
  const readingModePrompt = paperReadingPrompts[readingMode];
  const detailedReport = paper?.detailedReport ?? false;
  const summaryRunKey = getSummaryRunKey(paperId, paperPdfUrl, readingMode, detailedReport);
  const readingModeLabel = `${getPaperReadingModeLabel(readingMode)} · ${paper?.shouldAutoSummarize ? '解读中' : '待解读'}`;
  const fontSizeIndex = chatFontSizeOrder.indexOf(chatFontSize);
  const fontSizeStyle = chatFontSizeStyles[chatFontSize];
  const canDecreaseFontSize = fontSizeIndex > 0;
  const canIncreaseFontSize = fontSizeIndex < chatFontSizeOrder.length - 1;
  const exportableMessages = messages.filter(isExportableAssistantMessage);
  const selectedExportCount = selectedExportIds.size;
  const viewportWidth = typeof window === 'undefined' ? 390 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 720 : window.innerHeight;
  const isChatCollapsed = isMobileViewport ? !isMobileChatExpanded : isDesktopChatCollapsed;
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
    const nextMode = isFinancialChat ? 'financial' : 'standard';
    if (appliedChatModeRef.current === nextMode) return;
    appliedChatModeRef.current = nextMode;
    appliedFinancialHistoryKeyRef.current = '';

    setMessages(
      isFinancialChat
        ? [
            {
              id: 'financial-welcome',
              role: 'assistant',
              content: '财务分析已接入。请先在页面选择股票并上传材料，然后直接在这里提问；本功能需要单独开通，token 使用费按正常分析的 3 倍计算。',
              contextLabel: 'Financial analysis',
            },
          ]
        : mockMessages,
    );
    setInput('');
    setPendingImageReading(null);
  }, [isFinancialChat]);

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
    async (prompt: string, scope: 'whole-paper' | 'selected-text' | 'figure' = 'whole-paper', pageNumbers?: number[]) => {
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
          selectedText: scope === 'selected-text' ? selectedText?.text : undefined,
          pageNumber: pageNumbers?.[0] ?? (scope === 'selected-text' ? selectedText?.pageNumber : undefined),
          pageNumbers,
          paperContextSummary,
          conversationHistory: buildConversationHistory(messages),
        }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Reader agent failed.');

      return result as { answer: string; usage?: { inputTokens?: number; outputTokens?: number }; routedBy?: string; cached?: boolean; cachePath?: string };
    },
    [messages, paperId, paperPdfUrl, paperTitle, paperContextSummary, readingMode, readingModePrompt, selectedText, paper?.authors, paper?.journal, paper?.year],
  );

  const askFinancialAgent = useCallback(
    async (prompt: string) => {
      if (!financialContext?.selectedStock) throw new Error('请先在财务分析页面输入拟分析板块或股票。');
      if (!financialContext.materials.length) throw new Error('请先上传财报、K线图、盘口截图或走势图。');

      const response = await fetch('/api/reader-agent/financial-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: prompt,
          files: financialContext.materials,
          stock: financialContext.selectedStock,
          analysisMode: financialContext.analysisMode ?? 'normal',
          conversationHistory: buildConversationHistory(messages),
        }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Financial analysis failed.');

      return result as {
        answer: string;
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          baseBillableTokens?: number;
          billableTokens?: number;
          billingMultiplier?: number;
          cacheReadInputTokens?: number;
        };
        archiveEntryCount?: number;
      };
    },
    [financialContext, messages],
  );

  const loadFinancialHistory = useCallback(async () => {
    if (!financialContext?.selectedStock) return [];

    const params = new URLSearchParams({
      name: financialContext.selectedStock.name,
      code: financialContext.selectedStock.code,
    });
    if (financialContext.selectedStock.market) params.set('market', financialContext.selectedStock.market);

    const response = await fetch(`/api/reader-agent/financial-analysis/history?${params.toString()}`);
    const result = await response.json();

    if (!response.ok) throw new Error(result.message ?? result.error ?? 'Financial history failed.');

    return Array.isArray(result.history) ? (result.history as StoredHistoryTurn[]) : [];
  }, [financialContext?.selectedStock]);

  useEffect(() => {
    if (!isFinancialChat || !financialStockKey) return;
    if (appliedFinancialHistoryKeyRef.current === financialStockKey) return;
    appliedFinancialHistoryKeyRef.current = financialStockKey;

    let cancelled = false;

    const loadHistory = async () => {
      const welcomeMessage: ChatMessage = {
        id: 'financial-welcome',
        role: 'assistant',
        content: '财务分析已接入。请先在页面选择股票并上传材料，然后直接在这里提问；本功能需要单独开通，token 使用费按正常分析的 3 倍计算。',
        contextLabel: 'Financial analysis',
      };

      try {
        const history = await loadFinancialHistory();
        if (cancelled) return;

        setMessages([
          welcomeMessage,
          ...history.map((turn, index): ChatMessage => ({
            id: `financial-history-${turn.createdAt}-${index}`,
            role: turn.role,
            content: turn.content,
            contextLabel: turn.role === 'assistant' ? 'Saved financial analysis' : 'Saved financial question',
          })),
        ]);
      } catch {
        if (!cancelled) setMessages([welcomeMessage]);
      }
    };

    void loadHistory();

    return () => {
      cancelled = true;
    };
  }, [financialStockKey, isFinancialChat, loadFinancialHistory]);

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

  const estimateSummaryCost = useCallback(async (signal?: AbortSignal): Promise<TokenEstimateResponse | null> => {
    if (!paperId || !paperPdfUrl) return null;

    const response = await fetch('/api/reader-agent/count-tokens', {
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
      }),
    });
    const result = (await response.json()) as TokenEstimateResponse & { message?: string; error?: string };

    if (!response.ok) throw new Error(result.message ?? result.error ?? 'Token estimate failed.');

    return result;
  }, [paperId, paperPdfUrl, paperTitle, paper?.authors, paper?.journal, paper?.year, readingModePrompt, readingMode, detailedReport]);

  const estimateFigureReadingCost = useCallback(
    async (prompt: string, pageNumbers: number[]): Promise<FigureReadingEstimateResponse> => {
      const response = await fetch('/api/reader-agent/figure-estimate', {
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
          detailedReport,
          scope: 'figure',
          pageNumber: pageNumbers[0],
          pageNumbers,
          paperContextSummary,
        }),
      });
      const result = (await response.json()) as FigureReadingEstimateResponse & { message?: string; error?: string };

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Figure reading estimate failed.');

      return result;
    },
    [paperId, paperPdfUrl, paperTitle, paper?.authors, paper?.journal, paper?.year, readingMode, readingModePrompt, detailedReport, paperContextSummary],
  );

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
      setIsCheckingSummaryCost(false);
      setLargeSummaryWarning(null);
      setMessages(mockMessages);
      return;
    }

    if (!paper?.shouldAutoSummarize) {
      setPaperContextSummary('');
      setSummaryProgress(null);
      setIsSummarizing(false);
      setIsCheckingSummaryCost(false);
      setLargeSummaryWarning(null);
      loadPaperHistory()
        .then((history) => {
          setMessages([
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: '已打开论文。请先在论文库选择模式并点击“解读”，或直接在这里提出具体问题。',
              contextLabel: 'Paper chat',
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
        .catch(() => {
          setMessages([
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: '已打开论文。请先在论文库选择模式并点击“解读”，或直接在这里提出具体问题。',
              contextLabel: 'Paper chat',
            },
          ]);
        });
      return;
    }

    let isActive = true;
    const abortController = new AbortController();
    const loadingId = crypto.randomUUID();
    let progressTimer: number | undefined;

    const clearProgressTimer = () => {
      if (progressTimer !== undefined) {
        window.clearInterval(progressTimer);
        progressTimer = undefined;
      }
    };

    const runSummaryFlow = async () => {
      setPaperContextSummary('');
      setSummaryProgress(null);
      setLargeSummaryWarning(null);
      setIsSummarizing(false);
      setIsCheckingSummaryCost(true);
      setMessages([
        {
          id: loadingId,
          role: 'assistant',
          content: '正在估算這份文獻的摘要 token 消耗。超大文件不會自動生成摘要，需要你確認後才會開始。',
          contextLabel: 'Paper report',
        },
      ]);

      let estimate: TokenEstimateResponse | null = null;

      try {
        estimate = await estimateSummaryCost(abortController.signal);
      } catch (error) {
        if (abortController.signal.aborted) throw error;
        console.warn('[reader-agent:summarize] token estimate before auto-summary failed; continuing cautiously', error);
      }

      if (!isActive) return;

      const warning = buildLargeSummaryWarning(summaryRunKey, paper, estimate ?? undefined);

      if (warning && confirmedLargeSummaryKey !== summaryRunKey) {
        setIsCheckingSummaryCost(false);
        setLargeSummaryWarning(warning);
        setMessages([
          {
            id: loadingId,
            role: 'assistant',
            content: `${warning.reason}\n\n這類博士論文/超長文獻不會自動生成摘要。你可以直接提問，我會按需抽取相關頁面回答；如果仍要生成整篇摘要，請點上方確認按鈕。`,
            contextLabel: 'Paper report',
          },
        ]);
        return;
      }

      setIsCheckingSummaryCost(false);
      setLargeSummaryWarning(null);

      const startedAt = Date.now();
      const initialProgress = getSummaryProgress(0);
      const updateProgress = () => {
        const nextProgress = getSummaryProgress(Math.floor((Date.now() - startedAt) / 1000));
        setSummaryProgress(nextProgress);
        setMessages((current) => current.map((message) => (message.id === loadingId ? { ...message, content: formatSummaryProgressMessage(nextProgress) } : message)));
      };

      progressTimer = window.setInterval(updateProgress, 1000);

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

      const summary = await summarizePaper(abortController.signal);

      if (!isActive) return;

      clearProgressTimer();
      setSummaryProgress(null);
      setIsSummarizing(false);
      const history = await loadPaperHistory().catch(() => []);
      if (!isActive) return;

      setPaperContextSummary(summary);
      setInput((current) => (current.trim() ? current : imageReadingPromptTemplate));
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
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `是否需要我继续阅读文献中所有图片？你可以说：${imageReadingPromptTemplate}`,
          contextLabel: 'Image reading',
        },
      ]);
    };

    runSummaryFlow().catch((error) => {
        if (!isActive) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;

        clearProgressTimer();
        setSummaryProgress(null);
        setIsSummarizing(false);
        setIsCheckingSummaryCost(false);
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
      clearProgressTimer();
      setIsSummarizing(false);
      setIsCheckingSummaryCost(false);
    };
  }, [confirmedLargeSummaryKey, estimateSummaryCost, loadPaperHistory, paper, paperId, paperPdfUrl, readingMode, summarizePaper, summaryRunKey]);

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

  const runConfirmedImageReading = async (pending: PendingImageReading) => {
    if (isThinking) return;

    const loadingId = crypto.randomUUID();
    setPendingImageReading(null);
    setMessages((current) => [
      ...current,
      {
        id: loadingId,
        role: 'assistant',
        content: pending.estimate.cached ? '正在读取已保存的读图结果...' : '正在读取页面截图并综合文字描述...',
        contextLabel: `Image reading ${pending.range.startPage}-${pending.range.endPage}`,
      },
    ]);
    setIsThinking(true);

    try {
      const visualReadingInstruction = '请优先参考系统从前面文献简介中提取出的图表相关描述，再结合这些页面的文字/图注和页面截图读图；如果文字描述和图片细节不一致，请明确指出。';
      const readerPrompt = pending.range.wasLimited
        ? `${pending.prompt}\n\n${visualReadingInstruction}\n\n系统提示：本次只附上第 ${pending.range.startPage} 页到第 ${pending.range.endPage} 页的页面截图；一次最多读取 ${maxImageReadingPagesPerRequest} 页。请明确说明你只分析了这些页面。`
        : `${pending.prompt}\n\n${visualReadingInstruction}`;
      const result = await askReaderAgent(readerPrompt, 'figure', pending.range.pageNumbers);
      const usageLabel = result.usage?.inputTokens ? ` · ${result.usage.inputTokens.toLocaleString()} in / ${(result.usage.outputTokens ?? 0).toLocaleString()} out` : '';
      const cacheLabel = result.cached ? 'Saved image reading' : 'Image reading saved';
      const contextLabel = `${cacheLabel}${usageLabel}`;

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

  const sendMessage = async (overrideInput?: string) => {
    const trimmed = (overrideInput ?? input).trim();
    if (!trimmed || isThinking) return;

    if (isFinancialChat) {
      const loadingId = crypto.randomUUID();
      const stockLabel = financialContext?.selectedStock ? `${financialContext.selectedStock.name} ${financialContext.selectedStock.code}` : '未填写分析对象';
      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: trimmed,
        contextLabel: `Financial analysis · ${stockLabel}`,
      };

      setMessages((current) => [
        ...current,
        userMessage,
        { id: loadingId, role: 'assistant', content: '正在进行财务分析...', contextLabel: 'Financial analysis' },
      ]);
      setInput('');
      setIsThinking(true);

      try {
        const result = await askFinancialAgent(trimmed);
        const usage = result.usage;
        const usageLabel = usage?.billableTokens
          ? ` · ${usage.billableTokens.toLocaleString()} billable${usage.billingMultiplier ? ` · ${usage.billingMultiplier}x` : ''}${usage.baseBillableTokens ? ` · base ${usage.baseBillableTokens.toLocaleString()}` : ''}`
          : '';
        const archiveLabel = result.archiveEntryCount ? ` · archive ${result.archiveEntryCount}` : '';

        setMessages((current) =>
          current.map((message) =>
            message.id === loadingId
              ? { ...message, content: result.answer, contextLabel: `Financial analysis${usageLabel}${archiveLabel}` }
              : message,
          ),
        );
        window.dispatchEvent(new Event('financial-analysis-report-created'));
      } catch (error) {
        setMessages((current) =>
          current.map((message) =>
            message.id === loadingId ? { ...message, content: error instanceof Error ? error.message : 'Financial analysis failed.' } : message,
          ),
        );
      } finally {
        setIsThinking(false);
      }

      return;
    }

    const wantsImageReading = hasPaper && isImageReadingPrompt(trimmed);
    const imagePageRange = wantsImageReading ? parseImagePageRange(trimmed, paper?.pages) : null;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      contextLabel: pendingImageReading && (isImageReadingConfirmation(trimmed) || isImageReadingCancellation(trimmed))
        ? 'Confirm image reading'
        : imagePageRange
        ? `Page screenshots ${imagePageRange.startPage}-${imagePageRange.endPage}`
        : selectedText
          ? `Selection on page ${selectedText.pageNumber ?? '?'}`
          : hasPaper
            ? 'Whole paper'
            : 'General chat',
    };

    if (pendingImageReading && isImageReadingConfirmation(trimmed)) {
      const pending = pendingImageReading;

      setInput('');
      setMessages((current) => [...current, userMessage]);
      await runConfirmedImageReading(pending);
      return;
    }

    if (pendingImageReading && isImageReadingCancellation(trimmed)) {
      setPendingImageReading(null);
      setInput('');
      setMessages((current) => [
        ...current,
        userMessage,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: '已取消本次读图。',
          contextLabel: 'Image reading',
        },
      ]);
      return;
    }

    if (wantsImageReading && !imagePageRange) {
      setMessages((current) => [
        ...current,
        userMessage,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `请把页码写成具体数字，例如：${imageReadingPromptTemplate}`,
          contextLabel: 'Image reading',
        },
      ]);
      setInput(imageReadingPromptTemplate);
      return;
    }

    if (imagePageRange) {
      setMessages((current) => [...current, userMessage, { id: crypto.randomUUID(), role: 'assistant', content: '正在估算本次读图 token 消耗...', contextLabel: 'Image reading estimate' }]);
      setInput('');
      setIsThinking(true);

      try {
        const estimate = await estimateFigureReadingCost(trimmed, imagePageRange.pageNumbers);

        setPendingImageReading({ prompt: trimmed, range: imagePageRange, estimate });
        setMessages((current) => [
          ...current.filter((message) => message.content !== '正在估算本次读图 token 消耗...'),
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: estimate.cached
              ? `第 ${estimate.startPage} 页到第 ${estimate.endPage} 页已有保存的读图结果，可直接读取，不会重复消耗视觉模型 token。请点击“继续读图”，或回复“继续”。`
              : `本次读图从第 ${estimate.startPage} 页到第 ${estimate.endPage} 页，预计消耗约 ${formatTokenCount(estimate.billableTokens)}。请点击“继续读图”，或回复“继续”。`,
            contextLabel: 'Confirm image reading',
          },
        ]);
      } catch (error) {
        setMessages((current) => [
          ...current.filter((message) => message.content !== '正在估算本次读图 token 消耗...'),
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: error instanceof Error ? error.message : 'Figure reading estimate failed.',
            contextLabel: 'Image reading estimate',
          },
        ]);
      } finally {
        setIsThinking(false);
      }

      return;
    }

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

  useEffect(() => {
    if (!isFinancialChat) return;

    const handleFinancialStart = (event: Event) => {
      const detail = (event as CustomEvent<{ prompt?: string }>).detail;
      const prompt = detail?.prompt?.trim() || '请综合分析本次上传材料，并结合该股票历史档案给出交易员视角的判断。';

      void sendMessage(prompt);
    };

    window.addEventListener('financial-analysis-start', handleFinancialStart);

    return () => window.removeEventListener('financial-analysis-start', handleFinancialStart);
  }, [isFinancialChat, sendMessage]);

  return (
    <aside
      className="fixed z-50 flex max-w-[calc(100vw-1rem)] flex-col rounded-2xl border bg-white/95 shadow-2xl backdrop-blur"
      style={{
        left: mobileLayout?.x ?? position.x,
        top: mobileLayout?.y ?? position.y,
        width: mobileLayout?.width ?? size.width,
        height: mobileLayout?.height ?? (isDesktopChatCollapsed ? mobileCollapsedHeight : size.height),
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
              <h2 className="text-sm font-semibold">{isFinancialChat ? '财务分析 chat' : hasPaper ? 'Paper chat' : 'SCIReader chat'}</h2>
            </div>
            <p className="truncate text-[11px] text-muted-foreground">
              {isFinancialChat
                ? `${financialContext?.selectedStock ? `${financialContext.selectedStock.name} ${financialContext.selectedStock.code}` : '请输入拟分析对象'} · ${financialContext?.materials.length ?? 0} 个材料 · 3x token`
                : paper?.title ?? 'Ask without opening a paper'}
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {exportableMessages.length ? (
              <button
                aria-label={isExportMode ? '退出匯出選擇' : '選擇回答匯出 PDF'}
                className={`${isExportMode ? 'border-primary bg-primary/10 text-primary' : 'border text-slate-700 hover:bg-slate-50'} inline-flex h-9 items-center justify-center rounded-lg text-xs font-medium ${isMobileViewport ? 'w-9' : 'gap-1 px-2'}`}
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
                <span className={isMobileViewport ? 'sr-only' : ''}>{isExportMode ? '取消' : '匯出'}</span>
              </button>
            ) : null}
            <button
              aria-label={isChatCollapsed ? '展開聊天框' : '最小化聊天框'}
              className={`inline-flex h-9 items-center justify-center rounded-lg border text-xs font-medium text-slate-700 hover:bg-slate-50 ${isMobileViewport ? 'w-9' : 'gap-1 px-2'}`}
              onClick={(event) => {
                event.stopPropagation();
                if (isMobileViewport) setIsMobileChatExpanded((current) => !current);
                else setIsDesktopChatCollapsed((current) => !current);
              }}
              onPointerDown={(event) => event.stopPropagation()}
              title={isChatCollapsed ? '展開聊天框' : '最小化聊天框'}
              type="button"
            >
              {isChatCollapsed ? <Maximize2 className="size-4" /> : <Minimize2 className="size-4" />}
              <span className={isMobileViewport ? 'sr-only' : ''}>{isChatCollapsed ? '展開' : '收起'}</span>
            </button>
            <button
              aria-label="縮小聊天字體"
              className={`inline-flex h-9 items-center justify-center rounded-lg border text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-35 ${isMobileViewport ? 'w-9' : 'gap-1 px-2'}`}
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
              <span className={isMobileViewport ? 'sr-only' : ''}>-</span>
            </button>
            <span className={isMobileViewport ? 'sr-only' : 'min-w-5 text-center text-[11px] font-medium text-slate-500'} title="目前字體檔位">
              {fontSizeStyle.label}
            </span>
            <button
              aria-label="放大聊天字體"
              className={`inline-flex h-9 items-center justify-center rounded-lg border text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-35 ${isMobileViewport ? 'w-9' : 'gap-1 px-2'}`}
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
              <span className={isMobileViewport ? 'sr-only' : ''}>+</span>
            </button>
          </div>
        </div>
      </header>

      {isMobilePortrait && !isPortraitHintDismissed && !isChatCollapsed ? (
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

      {isExportMode && !isChatCollapsed ? (
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

      {isChatCollapsed ? null : largeSummaryWarning ? (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">超長文獻需要確認</p>
              <p className="mt-1 leading-5 text-amber-800">
                {largeSummaryWarning.reason}
                {largeSummaryWarning.pages ? ` 頁數：約 ${largeSummaryWarning.pages.toLocaleString()} 頁。` : ' '}
                直接提問會按需抽取頁面；整篇摘要需手動開始。
              </p>
            </div>
            <button
              className="rounded-lg bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700"
              onClick={() => {
                setConfirmedLargeSummaryKey(largeSummaryWarning.summaryKey);
                setLargeSummaryWarning(null);
              }}
              type="button"
            >
              仍要生成摘要
            </button>
          </div>
          <p className="mt-1 text-[11px] text-amber-700">
            估算：{formatTokenCount(largeSummaryWarning.billableTokens)} billable
            {largeSummaryWarning.model ? ` · ${largeSummaryWarning.model}` : ''}
          </p>
        </div>
      ) : null}

      {isChatCollapsed ? null : summaryProgress ? (
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

      {isChatCollapsed ? null : pendingImageReading ? (
        <div className="border-b border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-950">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">确认读图</p>
              <p className="mt-1 leading-5 text-blue-800">
                第 {pendingImageReading.estimate.startPage} 页到第 {pendingImageReading.estimate.endPage} 页
                {pendingImageReading.estimate.cached
                  ? ' 已有保存结果，可直接读取。'
                  : ` 预计消耗约 ${formatTokenCount(pendingImageReading.estimate.billableTokens)}。`}
                {' '}点击继续读图，或回复“继续”。
              </p>
            </div>
            <button
              className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 font-medium text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isThinking}
              onClick={() => setPendingImageReading(null)}
              type="button"
            >
              取消
            </button>
            <button
              className="rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isThinking}
              onClick={() => void runConfirmedImageReading(pendingImageReading)}
              type="button"
            >
              继续读图
            </button>
          </div>
        </div>
      ) : null}

      {isChatCollapsed ? null : selectedText ? (
        <div className="border-b bg-blue-50 p-3 text-xs">
          <p className="font-medium text-blue-900">Selected text context</p>
          <p className="mt-1 line-clamp-3 text-blue-800">{selectedText.text}</p>
        </div>
      ) : null}

      <div className={isChatCollapsed ? 'hidden' : 'min-h-0 flex-1 space-y-2 overflow-auto p-3'}>
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

      <footer className={isChatCollapsed ? 'hidden' : 'border-t p-3'}>
        <textarea
          className={`max-h-48 min-h-20 w-full resize-y rounded-xl border bg-slate-50 p-2.5 outline-none focus:border-primary ${fontSizeStyle.textarea}`}
          disabled={isThinking}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void sendMessage();
          }}
          placeholder={isFinancialChat ? '输入财务分析问题，例如：结合盘口和财报，短线资金是否有异动？' : 'Ask about the paper, selected text, methods, or citations...'}
          value={input}
        />
        <button
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-70"
          disabled={isThinking}
          onClick={() => void sendMessage()}
          type="button"
        >
          {isThinking ? <Loader2 className="size-4 animate-spin" /> : <CornerDownLeft className="size-4" />}
          {isThinking ? (isFinancialChat ? 'Financial analyst is working...' : 'Reader agent is working...') : isFinancialChat ? 'Send to financial analyst' : 'Send to reader agent'}
        </button>
      </footer>
      {!isMobileViewport && !isDesktopChatCollapsed && (
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
