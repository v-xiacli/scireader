import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import { zValidator } from '@hono/zod-validator';
import { getCookie } from 'hono/cookie';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { downloadFileAsAdmin, downloadTextAsAdmin, uploadFileAsAdmin, uploadTextAsAdmin } from '@/lib/firebase/server/storage-admin';
import { readNeo4j, verifyNeo4jConnection, writeNeo4j } from '@/lib/neo4j';
import { getUserStoragePrefix } from '@/lib/storage-paths';
import { recordUserTokenUsage } from '@/server/db';
import { getCurrentUser, loadUploadedPapers, sessionCookieName } from '@/server/routes/auth';

type ExtractedPdfPage = {
  pageNumber: number;
  text: string;
};

type ExtractedPdf = {
  pages: ExtractedPdfPage[];
  text: string;
  figureCaptions: string[];
};

type PaperMetadata = {
  title?: string;
  authors?: string[];
  journal?: string;
  year?: string;
};

type PdfPageImage = {
  pageNumber: number;
  data: string;
};

type TavilySearchResult = {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
  score?: number;
};

type PaperAccess = {
  user: { id: string; email: string; created_at: string };
  storagePath: string | null;
};

type StoredDialogTurn = {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  model?: string;
  routedBy?: 'cheap-context' | 'expensive-reader';
  inputTokens?: number;
  outputTokens?: number;
  readingMode?: PaperReadingMode;
  modePrompt?: string;
  systemPrompt?: string;
  userPromptEnglish?: string;
  answerEnglish?: string;
  answerChinese?: string;
};

type CheapTriageResult = {
  sufficient: boolean;
  contextSummary: string;
  answerDraft?: string;
  expensivePrompt?: string;
};

type SummaryFreshnessResult = {
  fresh: boolean;
  reason: string;
  improvementPrompt?: string;
};

type ReferenceEvaluationRecord = {
  referenceKey: string;
  referenceTitle?: string;
  referenceAuthors?: string[];
  referenceJournal?: string;
  referenceYear?: string;
  citedAs?: string;
  sourcePaperKey: string;
  sourceTitle?: string;
  sourceAuthors?: string[];
  sourceJournal?: string;
  sourceYear?: string;
  extractedFrom: 'introduction';
  evaluation: string;
  evidenceText?: string;
  evaluationType?: string;
  createdAt: string;
};

type PaperReadingMode = 'reviewer' | 'reader';

const MAX_EXTRACTED_TEXT_CHARS = 140_000;
const MAX_FIGURE_CAPTIONS = 40;
const MAX_PAGE_IMAGES = 6;
const PDF_RENDER_SCALE = 2;

const readerRequestSchema = z.object({
  paperId: z.string().min(1),
  prompt: z.string().min(1),
  scope: z.enum(['whole-paper', 'current-page', 'selected-text', 'figure']),
  selectedText: z.string().optional(),
  pageNumber: z.number().optional(),
  figureId: z.string().optional(),
  model: z.string().optional(),
  pdfUrl: z.string().optional(),
  title: z.string().optional(),
  authors: z.string().optional(),
  journal: z.string().optional(),
  year: z.string().optional(),
  paperContextSummary: z.string().optional(),
  readingMode: z.enum(['reviewer', 'reader']).optional(),
  modePrompt: z.string().optional(),
  detailedReport: z.boolean().optional(),
  conversationHistory: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      }),
    )
    .optional(),
});

const imageRequestSchema = z.object({
  prompt: z.string().min(1),
  paperId: z.string().optional(),
  title: z.string().optional(),
  selectedText: z.string().optional(),
  model: z.string().optional(),
});

const tokenEstimateRequestSchema = z.object({
  paperId: z.string().min(1),
  pdfUrl: z.string().min(1),
  title: z.string().optional(),
  journal: z.string().optional(),
  year: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
});

const metadataRequestSchema = z.object({
  pdfUrl: z.string().min(1),
  fallbackTitle: z.string().optional(),
});

const TAVILY_API_URL = 'https://api.tavily.com/search';
const TAVILY_RESULT_COUNT = 5;

const shouldUseWebSearch = (prompt: string) => /\b(news|latest|recent|today|current|now|breaking|this week|this month|2026|2025)\b|新闻|最新|最近|今天|当前|现在|实时|热点|头条/i.test(prompt);

const extractFigureCaptions = (text: string) => {
  const captionPattern = /(?:^|\n)\s*(?:fig(?:ure)?\.?|图)\s*\d+[\s\S]{0,600}?(?=\n\s*(?:fig(?:ure)?\.?|图)\s*\d+|\n\s*(?:references|acknowledg|appendix)\b|$)/gi;

  return Array.from(text.matchAll(captionPattern))
    .map((match) => match[0].replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, MAX_FIGURE_CAPTIONS);
};

const ensurePdfCanvasPolyfills = async () => {
  const canvas = await import('@napi-rs/canvas');
  const globalScope = globalThis as typeof globalThis & {
    DOMMatrix?: typeof DOMMatrix;
    ImageData?: typeof ImageData;
    Path2D?: typeof Path2D;
  };

  globalScope.DOMMatrix ??= canvas.DOMMatrix as unknown as typeof DOMMatrix;
  globalScope.ImageData ??= canvas.ImageData as unknown as typeof ImageData;
  globalScope.Path2D ??= canvas.Path2D as unknown as typeof Path2D;

  return canvas;
};

const loadPdfjs = async () => {
  await ensurePdfCanvasPolyfills();

  return import('pdfjs-dist/legacy/build/pdf.mjs');
};

const getPdfDocumentOptions = (data: Uint8Array) => ({
  data,
  useWorkerFetch: false,
  isEvalSupported: false,
  disableFontFace: true,
  standardFontDataUrl: path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep,
});

const extractPdfText = async (localPdfPath: string): Promise<ExtractedPdf> => {
  const startedAt = Date.now();
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await fs.readFile(localPdfPath));
  const pdfBytes = data.byteLength;
  const pdf = await pdfjs.getDocument(getPdfDocumentOptions(data)).promise;
  const pages: ExtractedPdfPage[] = [];

  console.log('[reader-agent:pdf] text extraction started', {
    localPdfPath,
    bytes: pdfBytes,
    pages: pdf.numPages,
  });

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (text) pages.push({ pageNumber, text });
  }

  const fullText = pages.map((page) => `[第 ${page.pageNumber} 页]\n${page.text}`).join('\n\n');
  const text = fullText.length > MAX_EXTRACTED_TEXT_CHARS ? `${fullText.slice(0, MAX_EXTRACTED_TEXT_CHARS)}\n\n[PDF 文本过长，已截断。]` : fullText;
  const figureCaptions = extractFigureCaptions(fullText);

  console.log('[reader-agent:pdf] text extraction finished', {
    localPdfPath,
    durationMs: Date.now() - startedAt,
    pagesWithText: pages.length,
    extractedChars: fullText.length,
    returnedChars: text.length,
    figureCaptions: figureCaptions.length,
  });

  return {
    pages,
    text,
    figureCaptions,
  };
};

const renderPdfPageImages = async (localPdfPath: string, pageNumbers?: number[]): Promise<PdfPageImage[]> => {
  const startedAt = Date.now();
  const canvas = await ensurePdfCanvasPolyfills();
  const pdfjs = await loadPdfjs();

  const data = new Uint8Array(await fs.readFile(localPdfPath));
  const pdf = await pdfjs.getDocument(getPdfDocumentOptions(data)).promise;
  const pagesToRender = (pageNumbers?.length ? pageNumbers : Array.from({ length: Math.min(pdf.numPages, MAX_PAGE_IMAGES) }, (_, index) => index + 1))
    .filter((pageNumber) => pageNumber >= 1 && pageNumber <= pdf.numPages)
    .slice(0, MAX_PAGE_IMAGES);
  const images: PdfPageImage[] = [];

  console.log('[reader-agent:pdf] page rendering started', {
    localPdfPath,
    pages: pdf.numPages,
    pagesToRender,
  });

  for (const pageNumber of pagesToRender) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
    const pageCanvas = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = pageCanvas.getContext('2d');

    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;

    images.push({ pageNumber, data: pageCanvas.toBuffer('image/png').toString('base64') });
    page.cleanup();
  }

  console.log('[reader-agent:pdf] page rendering finished', {
    localPdfPath,
    durationMs: Date.now() - startedAt,
    renderedPages: images.map((image) => image.pageNumber),
  });

  return images;
};

const resolveUploadedPdfStoragePath = (pdfUrl?: string) => {
  if (!pdfUrl) return null;

  const pathname = pdfUrl.startsWith('http') ? new URL(pdfUrl).pathname : pdfUrl;
  const marker = '/api/storage/download/';
  const markerIndex = pathname.indexOf(marker);

  if (markerIndex === -1) return null;

  const storagePath = decodeURIComponent(pathname.slice(markerIndex + marker.length)).replace(/^\/+/, '');

  if (!storagePath || storagePath.split('/').includes('..')) {
    throw new Error('Invalid PDF path.');
  }

  return storagePath;
};

const isPendingUserUpload = (user: { id: string; email: string }, storagePath: string) => storagePath.startsWith(getUserStoragePrefix({ id: user.id, name: user.email }));

const requirePaperAccess = async (c: Context, pdfUrl?: string): Promise<PaperAccess> => {
  const user = await getCurrentUser(getCookie(c, sessionCookieName));

  if (!user) throw new Error('Not authenticated.');

  const storagePath = resolveUploadedPdfStoragePath(pdfUrl);

  if (!storagePath) return { user, storagePath };

  const uploadedPapers = await loadUploadedPapers(user.id);
  const canAccessPaper = uploadedPapers.some((paper) => paper.filePath === storagePath) || isPendingUserUpload(user, storagePath);

  if (!canAccessPaper) throw new Error('You do not have access to this PDF.');

  return { user, storagePath };
};

const materializePdfToTempFile = async (storagePath: string) => {
  const { buffer } = await downloadFileAsAdmin(storagePath);
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scireader-pdf-'));
  const localPdfPath = path.join(outputDir, 'paper.pdf');

  await fs.writeFile(localPdfPath, buffer);

  return { localPdfPath, outputDir, buffer };
};

const cleanPaperKeyPart = (part?: string) => part?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';

const getPaperIdentityKey = (paper: { title?: string; authors?: string[]; journal?: string; year?: string; paperId?: string }) => {
  const parts = [paper.title, ...(paper.authors ?? []).slice(0, 2), paper.journal, paper.year].map(cleanPaperKeyPart).filter(Boolean);

  return parts.join('') || cleanPaperKeyPart(paper.paperId) || 'uploadedpaper';
};

const getPaperIdentitySlug = (request: Pick<z.infer<typeof readerRequestSchema>, 'paperId' | 'title' | 'authors' | 'journal' | 'year'>) =>
  getPaperIdentityKey({
    paperId: request.paperId,
    title: request.title ?? request.paperId,
    authors: parseAuthors(request.authors),
    journal: request.journal,
    year: request.year,
  });

const getReadingMode = (request: Pick<z.infer<typeof readerRequestSchema>, 'readingMode'>): PaperReadingMode => request.readingMode ?? 'reviewer';

const getSummaryDetailMode = (request: Pick<z.infer<typeof readerRequestSchema>, 'detailedReport'>) => request.detailedReport === true ? 'detailed' : 'brief';

const getPaperSummaryStoragePath = (request: z.infer<typeof readerRequestSchema>, pdfStoragePath?: string | null) =>
  `paper-cache/${getPaperIdentitySlug(request)}/${pdfStoragePath ? 'uploaded' : 'sample'}.reader-summary.${getReadingMode(request)}.${getSummaryDetailMode(request)}.review-v5.md`;

const getPaperDialogHistoryPath = (userId: string, paperKey: string) => `user-paper-history/${userId}/${paperKey}.md`;

const getSharedPaperDialogHistoryPath = (paperKey: string) => `paper-cache/${paperKey}/reader-dialog.shared-v1.md`;

const getReferenceExternalEvaluationsPath = (referenceKey: string) => `paper-cache/${referenceKey}/external-reference-evaluations.v1.md`;

const getSourcePaperReferenceEvaluationsPath = (sourcePaperKey: string) => `paper-cache/${sourcePaperKey}/reference-evaluations.introduction.v1.md`;

type SummaryJobPhase = 'queued' | 'materializing-pdf' | 'extracting-text' | 'brief-synthesis' | 'chunk' | 'chunk-retry' | 'final-synthesis' | 'final-synthesis-retry' | 'translating' | 'uploading' | 'finished' | 'failed';

type SummaryJobEntry = {
  jobId: string;
  startedAt: string;
  updatedAt: string;
  phase: SummaryJobPhase;
  currentChunk?: number;
  totalChunks?: number;
  message?: string;
  promise: Promise<void>;
};

const summaryJobs = new Map<string, SummaryJobEntry>();

const getSummaryJobSnapshot = (job?: SummaryJobEntry) =>
  job
    ? {
        jobId: job.jobId,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        phase: job.phase,
        currentChunk: job.currentChunk,
        totalChunks: job.totalChunks,
        message: job.message,
      }
    : null;

const updateSummaryJobStatus = (summaryStoragePath: string, patch: Partial<Omit<SummaryJobEntry, 'jobId' | 'startedAt' | 'promise'>>) => {
  const job = summaryJobs.get(summaryStoragePath);
  if (!job) return;

  Object.assign(job, {
    ...patch,
    updatedAt: new Date().toISOString(),
  });

  console.log('[reader-agent:summarize] job status', {
    summaryStoragePath,
    ...getSummaryJobSnapshot(job),
  });
};

const parseJsonBlock = (content: string) => {
  const match = content.match(/```json\n([\s\S]*?)\n```/);

  return match ? JSON.parse(match[1]) : null;
};

const downloadTextIfExists = async (filePath: string) => {
  try {
    return await downloadTextAsAdmin(filePath);
  } catch {
    return null;
  }
};

const loadDialogHistory = async (userId: string, paperKey: string): Promise<StoredDialogTurn[]> => {
  try {
    const parsed = parseJsonBlock(await downloadTextAsAdmin(getPaperDialogHistoryPath(userId, paperKey)));

    return Array.isArray(parsed)
      ? parsed
          .filter((turn): turn is StoredDialogTurn =>
            typeof turn === 'object' &&
            turn !== null &&
            (turn.role === 'user' || turn.role === 'assistant') &&
            typeof turn.content === 'string' &&
            typeof turn.createdAt === 'string',
          )
          .slice(-80)
      : [];
  } catch {
    return [];
  }
};

const saveDialogHistory = async (userId: string, paperKey: string, turns: StoredDialogTurn[]) => {
  const nextTurns = turns.slice(-80);

  await uploadTextAsAdmin(
    `# Paper dialog history\n\n\`\`\`json\n${JSON.stringify(nextTurns, null, 2)}\n\`\`\`\n`,
    getPaperDialogHistoryPath(userId, paperKey),
  );

  return nextTurns;
};

const appendDialogTurns = async (userId: string, paperKey: string, turns: StoredDialogTurn[]) => {
  const currentTurns = await loadDialogHistory(userId, paperKey);

  return saveDialogHistory(userId, paperKey, [...currentTurns, ...turns]);
};

const loadSharedPaperDialogHistory = async (paperKey: string): Promise<StoredDialogTurn[]> => {
  try {
    const parsed = parseJsonBlock(await downloadTextAsAdmin(getSharedPaperDialogHistoryPath(paperKey)));

    return Array.isArray(parsed)
      ? parsed
          .filter((turn): turn is StoredDialogTurn =>
            typeof turn === 'object' &&
            turn !== null &&
            (turn.role === 'user' || turn.role === 'assistant') &&
            typeof turn.content === 'string' &&
            typeof turn.createdAt === 'string',
          )
          .slice(-200)
      : [];
  } catch {
    return [];
  }
};

const saveSharedPaperDialogHistory = async (paperKey: string, turns: StoredDialogTurn[]) => {
  const nextTurns = turns.slice(-200);

  await uploadTextAsAdmin(
    `# Shared paper dialog history\n\n\`\`\`json\n${JSON.stringify(nextTurns, null, 2)}\n\`\`\`\n`,
    getSharedPaperDialogHistoryPath(paperKey),
  );

  return nextTurns;
};

const appendSharedPaperDialogTurns = async (paperKey: string, turns: StoredDialogTurn[]) => {
  const currentTurns = await loadSharedPaperDialogHistory(paperKey);

  return saveSharedPaperDialogHistory(paperKey, [...currentTurns, ...turns]);
};

const formatDialogHistory = (history: StoredDialogTurn[]) =>
  history
    .slice(-24)
    .map((turn) => `${turn.role === 'user' ? '用户' : '助手'}(${turn.createdAt}): ${turn.content.slice(0, 2000)}`)
    .join('\n\n');

const normalizeMetadataText = (value?: string) => value?.replace(/\s+/g, ' ').trim();

const getMetadataInfoValue = (info: Record<string, unknown>, key: string) => {
  const value = info[key];

  return typeof value === 'string' ? normalizeMetadataText(value) : undefined;
};

const parseAuthors = (value?: string) =>
  value
    ?.split(/\s*(?:,|;|\band\b|&|，|；)\s*/i)
    .map((author) => author.replace(/\d+|\*|†|‡|§/g, '').trim())
    .filter(Boolean)
    .slice(0, 2) ?? [];

const extractYear = (text: string) => text.match(/(?:19|20)\d{2}/)?.[0];

const inferMetadataFromText = (text: string, fallbackTitle?: string): PaperMetadata => {
  const lines = text
    .split(/\n+/)
    .map((line) => normalizeMetadataText(line))
    .filter((line): line is string => Boolean(line));
  const title = lines.find((line) => line.length >= 12 && !/^abstract\b/i.test(line)) ?? normalizeMetadataText(fallbackTitle);
  const titleIndex = title ? lines.indexOf(title) : -1;
  const authorLine = titleIndex >= 0 ? lines.slice(titleIndex + 1, titleIndex + 5).find((line) => /,|;|\band\b|&|，|；/i.test(line)) : undefined;
  const journalLine = lines.find((line) => /\b(journal|transactions|proceedings|conference|letters|review|nature|science|ieee|acm)\b/i.test(line));
  const year = extractYear(lines.slice(0, 20).join(' '));

  return {
    title,
    authors: parseAuthors(authorLine),
    journal: journalLine,
    year,
  };
};

const extractPaperMetadata = async (localPdfPath: string, fallbackTitle?: string): Promise<PaperMetadata> => {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await fs.readFile(localPdfPath));
  const pdf = await pdfjs.getDocument(getPdfDocumentOptions(data)).promise;
  const metadata = await pdf.getMetadata().catch(() => null);
  const info = (metadata?.info ?? {}) as Record<string, unknown>;
  const metadataTitle = getMetadataInfoValue(info, 'Title');
  const metadataAuthors = parseAuthors(getMetadataInfoValue(info, 'Author'));
  const page = await pdf.getPage(1);
  const textContent = await page.getTextContent();
  const firstPageText = textContent.items
    .map((item) => ('str' in item ? item.str : ''))
    .join('\n')
    .replace(/[ \t]+/g, ' ');
  const inferred = inferMetadataFromText(firstPageText, fallbackTitle);

  page.cleanup();

  return {
    title: metadataTitle ?? inferred.title ?? normalizeMetadataText(fallbackTitle),
    authors: metadataAuthors.length ? metadataAuthors : inferred.authors,
    journal: inferred.journal,
    year: inferred.year,
  };
};

const buildSystemPrompt = (hasPdfContext: boolean, hasWebSearch: boolean) => {
  const basePrompt = hasPdfContext
    ? `你是 SCIReader 的论文阅读助手，当别人为你是谁或者谁制造了你时或者其他企图探索你来源的问题时，请你回复我来自一名热爱科研的AI工程师。请用中文回答用户问题。
重点能力：翻译论文标题、摘要、结论；提取公式并给出 LaTeX；解释图表；总结论文的主要创新点、论文工作中存在的缺点和不足（特别是非创新、伪创新、不可实现的假创新）、相关前人工作。
你会收到服务端从 PDF 中提取出的正文文本、图题候选，以及 PDF 页面截图。请结合页面截图解释图表内容。若某项无法从已提取内容判断，请明确说明“未在论文中明确找到”，不要编造。`
    : `你是 SCIReader 内置的通用 AI 聊天助手，类似 ChatGPT。请直接回答用户的一般问题；如果用户要求写作、代码、解释概念、翻译、总结或头脑风暴，请正常完成，不要假设必须有论文上下文。`;

  return hasWebSearch
    ? `${basePrompt}\n用户问题涉及新闻、实时信息或近期事件。你会收到 Tavily Web search results，请优先基于这些结果回答，并在答案中引用相关来源 URL；如果搜索结果不足或互相矛盾，请明确说明。`
    : basePrompt;
};

const textFromResponse = (response: { content?: unknown }) => {
  if (!Array.isArray(response.content)) return '';

  return response.content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('\n');
};

const normalizeAnthropicBaseUrl = (baseURL?: string) => {
  const trimmed = baseURL?.trim().replace(/\/+$/, '');

  if (!trimmed) return undefined;

  return trimmed.replace(/\/v1$/i, '');
};

type AnthropicModelTarget = 'cheap' | 'expensive' | 'default';

type AnthropicModelSelection = {
  model: string;
  target: AnthropicModelTarget;
};

const isProfessionalKnowledgePrompt = (prompt: string) =>
  /\b(professional|expert|scientific|academic|peer review|knowledge check|verify|validate|critique|methodology|formula|equation|theorem|statistical|实验|科研|科学|学术|专业|专家|审稿|校验|验证|检查|批判|方法论|公式|定理|统计)\b/i.test(prompt);

const selectReaderModel = (request: z.infer<typeof readerRequestSchema>): AnthropicModelSelection => {
  if (request.model) return { model: request.model, target: 'default' };

  const expertModel = process.env.ANTHROPIC_EXPENSIVE_MODEL?.trim();
  const textModel = process.env.ANTHROPIC_CHEAP_MODEL?.trim();
  const defaultModel = process.env.ANTHROPIC_MODEL?.trim() || 'gpt-5.5';

  if (request.scope === 'figure' || isProfessionalKnowledgePrompt(request.prompt)) {
    return { model: expertModel || defaultModel, target: expertModel ? 'expensive' : 'default' };
  }

  return { model: textModel || defaultModel, target: textModel ? 'cheap' : 'default' };
};

const selectImageModel = (request: z.infer<typeof imageRequestSchema>): AnthropicModelSelection => {
  if (request.model) return { model: request.model, target: 'default' };

  const expertModel = process.env.ANTHROPIC_EXPENSIVE_MODEL?.trim();
  const defaultModel = process.env.ANTHROPIC_MODEL?.trim() || 'gpt-5.5';

  return { model: expertModel || defaultModel, target: expertModel ? 'expensive' : 'default' };
};

const selectTokenEstimateModel = (request: z.infer<typeof tokenEstimateRequestSchema>): AnthropicModelSelection => {
  if (request.model) return { model: request.model, target: 'default' };

  const defaultModel = process.env.ANTHROPIC_MODEL?.trim() || 'gpt-5.5';

  return { model: defaultModel, target: 'default' };
};

const selectCheapTriageModel = (): AnthropicModelSelection => {
  const textModel = process.env.ANTHROPIC_CHEAP_MODEL?.trim();
  const defaultModel = 'gpt-5.4-mini';

  return { model: textModel || defaultModel, target: 'cheap' };
};

const selectExpensiveReaderModel = (): AnthropicModelSelection => {
  const expertModel = process.env.ANTHROPIC_EXPENSIVE_MODEL?.trim();
  const defaultModel = process.env.ANTHROPIC_MODEL?.trim() || 'gpt-5.5';

  return { model: expertModel || defaultModel, target: expertModel ? 'expensive' : 'default' };
};

const getModelTokenWeight = (model?: string) => {
  const normalizedModel = model?.toLowerCase() ?? '';

  return normalizedModel.includes('gpt-5.5') ? 2 : 1;
};

const getBillableTokens = (inputTokens: number, outputTokens: number, model?: string) =>
  Math.ceil((Math.max(0, inputTokens) + Math.max(0, outputTokens)) * getModelTokenWeight(model));

const getAnthropicCredential = (target: AnthropicModelTarget) => {
  if (target === 'cheap') {
    return {
      apiKey: process.env.ANTHROPIC_CHEAP_API_KEY?.trim() || process.env.ANTHROPIC_API_KEY?.trim(),
      authToken: process.env.ANTHROPIC_CHEAP_AUTH_TOKEN?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim(),
    };
  }

  if (target === 'expensive') {
    return {
      apiKey: process.env.ANTHROPIC_EXPENSIVE_API_KEY?.trim() || process.env.ANTHROPIC_API_KEY?.trim(),
      authToken: process.env.ANTHROPIC_EXPENSIVE_AUTH_TOKEN?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim(),
    };
  }

  return {
    apiKey: process.env.ANTHROPIC_API_KEY?.trim(),
    authToken: process.env.ANTHROPIC_AUTH_TOKEN?.trim(),
  };
};

const createAnthropicClient = (target: AnthropicModelTarget = 'default') => {
  const { apiKey, authToken } = getAnthropicCredential(target);

  if (!apiKey && !authToken) {
    throw new Error('Missing Anthropic credentials. Add ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or the matching cheap/expensive credential to .env.local and restart the dev server.');
  }

  return new Anthropic({
    apiKey: apiKey ?? null,
    authToken: authToken ?? null,
    baseURL: normalizeAnthropicBaseUrl(process.env.ANTHROPIC_BASE_URL),
  });
};

const extractImageResult = (text: string) => {
  const dataUrlMatch = text.match(/data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=\s]+/);
  const urlMatch = text.match(/https?:\/\/\S+?\.(?:png|jpe?g|webp|gif)(?:\?\S*)?/i);

  return {
    imageBase64: dataUrlMatch?.[0],
    imageUrl: urlMatch?.[0],
  };
};

const formatWebSearchResults = (results: TavilySearchResult[]) =>
  results
    .map((result, index) => {
      const publishedDate = result.publishedDate ? `\nPublished: ${result.publishedDate}` : '';
      return `[${index + 1}] ${result.title}\nURL: ${result.url}${publishedDate}\nSnippet: ${result.content}`;
    })
    .join('\n\n');

const searchWebForPrompt = async (prompt: string): Promise<TavilySearchResult[]> => {
  if (!shouldUseWebSearch(prompt)) return [];

  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) throw new Error('Missing Tavily credentials. Add TAVILY_API_KEY to .env.local and restart the dev server.');

  const response = await fetch(TAVILY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: prompt,
      search_depth: 'advanced',
      topic: 'news',
      max_results: TAVILY_RESULT_COUNT,
      include_answer: false,
      include_raw_content: false,
    }),
  });
  const result = await response.json();

  if (!response.ok) throw new Error(result.error ?? result.message ?? 'Tavily search failed.');

  return Array.isArray(result.results)
    ? result.results
        .map((item: Record<string, unknown>) => ({
          title: typeof item.title === 'string' ? item.title : 'Untitled result',
          url: typeof item.url === 'string' ? item.url : '',
          content: typeof item.content === 'string' ? item.content.slice(0, 1200) : '',
          publishedDate: typeof item.published_date === 'string' ? item.published_date : undefined,
          score: typeof item.score === 'number' ? item.score : undefined,
        }))
        .filter((item: TavilySearchResult) => item.url && item.content)
    : [];
};

const buildUserPrompt = (request: z.infer<typeof readerRequestSchema>, extractedPdf?: ExtractedPdf, webSearchResults: TavilySearchResult[] = []) => {
  const webSearchText = webSearchResults.length ? `Tavily Web search results:\n${formatWebSearchResults(webSearchResults)}\n\n` : '';

  if (!extractedPdf && !request.selectedText) return `${webSearchText}用户请求：${request.prompt}`;

  const pageText = request.pageNumber ? extractedPdf?.pages.find((page) => page.pageNumber === request.pageNumber)?.text : undefined;
  const figureCaptions = extractedPdf?.figureCaptions.length
    ? `\n图题/图注候选：\n${extractedPdf.figureCaptions.map((caption, index) => `${index + 1}. ${caption}`).join('\n')}`
    : '';
  const pdfText = extractedPdf?.text
    ? `\nPDF 提取正文：\n${request.scope === 'current-page' && pageText ? `[第 ${request.pageNumber} 页]\n${pageText}` : extractedPdf.text}`
    : '\nPDF 提取正文：未能从本地 PDF 提取到文本，请基于用户提供的选中文本回答；没有依据时说明未找到。';

  return `论文标题：${request.title ?? request.paperId}
请求范围：${request.scope}
${request.selectedText ? `选中文本：\n${request.selectedText}\n` : ''}${figureCaptions}${pdfText}

${webSearchText}用户请求：${request.prompt}`;
};

const buildReaderSystemPrompt = (hasPdfContext: boolean, hasWebSearch: boolean, modePrompt?: string, responseLanguage: 'english' | 'chinese' = 'chinese') => {
  const languageInstruction = responseLanguage === 'english'
    ? 'Respond in English. The answer will be translated to Chinese by a separate low-cost model, so keep terminology precise and preserve all numbers, equations, figure/table labels, citations, and Markdown structure.'
    : 'Respond entirely in Chinese. Preserve all important numbers, equations, figure/table labels, citations, and Markdown structure.';
  const nextBasePrompt = hasPdfContext
    ? `${modePrompt?.trim() || 'You are SCIReader, a careful academic paper reading assistant. Prioritize the provided paper content, saved paper notes, selected text, and page images. If the paper does not provide clear evidence, explicitly say that the paper does not provide sufficient information to determine.'}\n\n${languageInstruction}\n\nUse only the provided paper evidence unless the user asks for outside context. Do not fabricate details.`
    : `You are SCIReader's general AI assistant. Answer the user's question directly.\n\n${languageInstruction}`;

  return hasWebSearch
    ? `${nextBasePrompt}\nThe user question involves recent or real-time information. You will receive Tavily Web search results. Prioritize those results, cite relevant source URLs, and state clearly when the search results are insufficient or conflicting.`
    : nextBasePrompt;

  const basePrompt = hasPdfContext
    ? '你是 SCIReader 的论文阅读助手。请用中文回答用户问题，优先基于已提供的论文内容、论文速记、选中文本和页面截图。你擅长总结论文要点、解释方法和实验、提取公式、比较相关工作、解释图表。若论文中没有明确依据，请直接说明“论文中未明确找到”，不要编造。'
    : '你是 SCIReader 的通用 AI 助手。请直接回答用户问题；如果用户要求写作、代码、解释、翻译或总结，请正常完成，不要假设一定有论文上下文。';

  return hasWebSearch
    ? `${basePrompt}\n用户问题涉及近期或实时信息。你会收到 Tavily Web search results，请优先基于这些结果回答，并在答案中引用相关来源 URL；如果搜索结果不足或互相矛盾，请明确说明。`
    : basePrompt;
};

const buildReaderUserPrompt = (request: z.infer<typeof readerRequestSchema>, extractedPdf?: ExtractedPdf, webSearchResults: TavilySearchResult[] = []) => {
  const webSearchText = webSearchResults.length ? `Tavily Web search results:\n${formatWebSearchResults(webSearchResults)}\n\n` : '';
  const pageText = request.pageNumber ? extractedPdf?.pages.find((page) => page.pageNumber === request.pageNumber)?.text : undefined;
  const englishPaperContextSummary = request.paperContextSummary?.trim()
    ? `\nKnown paper notes:\n${request.paperContextSummary.trim().slice(0, 12000)}\n`
    : '';
  const englishFigureCaptions = extractedPdf?.figureCaptions.length
    ? `\nFigure/table caption candidates:\n${extractedPdf.figureCaptions.map((caption, index) => `${index + 1}. ${caption}`).join('\n')}`
    : '';
  const englishPdfText = extractedPdf?.text
    ? `\nExtracted PDF text:\n${request.scope === 'current-page' && pageText ? `[Page ${request.pageNumber}]\n${pageText}` : extractedPdf.text}`
    : request.selectedText || request.paperContextSummary
      ? '\nExtracted PDF text: Full text is not available in this request. Use the provided notes or selected text; if evidence is missing, say the paper does not provide sufficient information.'
      : '';

  if (!englishPaperContextSummary && !englishFigureCaptions && !englishPdfText && !request.selectedText) {
    return `${webSearchText}User request:\n${request.prompt}`;
  }

  return `Paper title: ${request.title ?? request.paperId}
Request scope: ${request.scope}
${englishPaperContextSummary}${request.selectedText ? `Selected text:\n${request.selectedText}\n` : ''}${englishFigureCaptions}${englishPdfText}

${webSearchText}User request:
${request.prompt}`;
  /*
  const paperContextSummary = request.paperContextSummary?.trim()
    ? `\n已知论文速记：\n${request.paperContextSummary.trim().slice(0, 12000)}\n`
    : '';
  const figureCaptions = extractedPdf?.figureCaptions.length
    ? `\n图题/图注候选：\n${extractedPdf.figureCaptions.map((caption, index) => `${index + 1}. ${caption}`).join('\n')}`
    : '';
  const pdfText = extractedPdf?.text
    ? `\nPDF 提取正文：\n${request.scope === 'current-page' && pageText ? `[第 ${request.pageNumber} 页]\n${pageText}` : extractedPdf.text}`
    : request.selectedText || request.paperContextSummary
      ? '\nPDF 提取正文：本次未提供完整正文，请基于论文速记或选中文本回答；没有依据时说明未找到。'
      : '';

  if (!paperContextSummary && !figureCaptions && !pdfText && !request.selectedText) {
    return `${webSearchText}用户请求：${request.prompt}`;
  }

  return `论文标题：${request.title ?? request.paperId}
请求范围：${request.scope}
${paperContextSummary}${request.selectedText ? `选中文本：\n${request.selectedText}\n` : ''}${figureCaptions}${pdfText}

${webSearchText}用户请求：${request.prompt}`;
  */
};

const askClaude = async (request: z.infer<typeof readerRequestSchema>, forcedModelSelection?: AnthropicModelSelection, responseLanguage: 'english' | 'chinese' = 'chinese') => {
  const storagePath = resolveUploadedPdfStoragePath(request.pdfUrl);
  const tempPdf = storagePath ? await materializePdfToTempFile(storagePath) : null;
  const localPdfPath = tempPdf?.localPdfPath;

  try {
    const extractedPdf = localPdfPath ? await extractPdfText(localPdfPath) : undefined;
    const webSearchResults = await searchWebForPrompt(request.prompt);
    const hasWebSearch = webSearchResults.length > 0;
    let pageImages: PdfPageImage[] = [];
    const shouldRenderPageImages = request.scope === 'current-page' || request.scope === 'figure' || (request.scope === 'selected-text' && Boolean(request.pageNumber));

    if (localPdfPath && shouldRenderPageImages) {
      try {
        pageImages = await renderPdfPageImages(localPdfPath, request.scope === 'current-page' && request.pageNumber ? [request.pageNumber] : undefined);
      } catch (error) {
        console.error('PDF page rendering failed.', error);
      }
    }

    const modelSelection = forcedModelSelection ?? selectReaderModel(request);
    const client = createAnthropicClient(modelSelection.target);
    const content: Exclude<Anthropic.MessageParam['content'], string> = [{ type: 'text', text: buildReaderUserPrompt(request, extractedPdf, webSearchResults) }];

    for (const image of pageImages) {
      if (true) {
        content.push({ type: 'text', text: `Below is a rendered screenshot of PDF page ${image.pageNumber}. Use it to interpret figures, tables, equations, and layout when relevant.` });
      } else
      content.push({ type: 'text', text: `下面是 PDF 第 ${image.pageNumber} 页截图，请结合其中的图表进行解释。` });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: image.data,
        },
      });
    }

    if (tempPdf) {
      content.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: tempPdf.buffer.toString('base64'),
        },
        title: request.title ?? request.paperId,
      });
    }

    const response = await client.beta.messages.create({
      betas: localPdfPath ? ['files-api-2025-04-14'] : [],
      model: modelSelection.model,
      max_tokens: 16000,
      cache_control: { type: 'ephemeral' },
      system: buildReaderSystemPrompt(Boolean(localPdfPath || extractedPdf || request.selectedText || request.paperContextSummary), hasWebSearch, request.modePrompt, responseLanguage),
      messages: [
        ...(request.conversationHistory ?? [])
          .slice(-8)
          .map((message): Anthropic.MessageParam => ({
            role: message.role,
            content: message.content.slice(0, 4000),
          })),
        { role: 'user', content },
      ],
    });

    return {
      answer: textFromResponse(response),
      webSearchResults,
      model: modelSelection.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  } finally {
    if (tempPdf) await fs.rm(tempPdf.outputDir, { recursive: true, force: true });
  }
};

const generateImage = async (request: z.infer<typeof imageRequestSchema>) => {
  const modelSelection = selectImageModel(request);
  const client = createAnthropicClient(modelSelection.target);
  const context = [
    request.title ? `论文标题：${request.title}` : null,
    request.selectedText ? `选中文本：${request.selectedText}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const response = await client.messages.create({
    model: modelSelection.model,
    max_tokens: 4000,
    system:
      '你是 SCIReader 的图像生成助手。请根据用户需求生成图片；如果当前模型不能直接返回图片，请输出可直接用于图像生成模型的详细英文提示词，并用中文简要说明。',
    messages: [
      {
        role: 'user',
        content: `${context ? `${context}\n\n` : ''}用户图像需求：${request.prompt}`,
      },
    ],
  });
  const answer = textFromResponse(response);
  const image = extractImageResult(answer);

  return {
    answer,
    prompt: request.prompt,
    ...image,
  };
};

const extractJsonObject = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {}

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);

  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1]);
    } catch {}
  }

  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;

    for (let index = start; index < text.length; index += 1) {
      if (text[index] === '{') depth += 1;
      if (text[index] === '}') depth -= 1;

      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          break;
        }
      }
    }
  }

  throw new Error('Cheap triage returned invalid JSON.');
};

const extractJsonArray = (text: string) => {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { evaluations?: unknown[] }).evaluations)) return (parsed as { evaluations: unknown[] }).evaluations;
  } catch {}

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);

  if (fencedMatch?.[1]) {
    try {
      const parsed = JSON.parse(fencedMatch[1]);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { evaluations?: unknown[] }).evaluations)) return (parsed as { evaluations: unknown[] }).evaluations;
    } catch {}
  }

  for (let start = text.indexOf('['); start >= 0; start = text.indexOf('[', start + 1)) {
    let depth = 0;

    for (let index = start; index < text.length; index += 1) {
      if (text[index] === '[') depth += 1;
      if (text[index] === ']') depth -= 1;

      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1));
          if (Array.isArray(parsed)) return parsed;
        } catch {
          break;
        }
      }
    }
  }

  throw new Error('Reference evaluation extraction returned invalid JSON.');
};

const parseCheapTriageResult = (text: string): CheapTriageResult => {
  const parsed = extractJsonObject(text) as Partial<CheapTriageResult>;
  const contextSummary = typeof parsed.contextSummary === 'string' ? parsed.contextSummary : '';

  if (parsed.sufficient === true && typeof parsed.answerDraft === 'string' && parsed.answerDraft.trim()) {
    return { sufficient: true, contextSummary, answerDraft: parsed.answerDraft };
  }

  if (parsed.sufficient === false && typeof parsed.expensivePrompt === 'string' && parsed.expensivePrompt.trim()) {
    return { sufficient: false, contextSummary, expensivePrompt: parsed.expensivePrompt };
  }

  throw new Error('Cheap triage returned incomplete JSON.');
};

const parseSummaryFreshnessResult = (text: string): SummaryFreshnessResult => {
  const parsed = extractJsonObject(text) as Partial<SummaryFreshnessResult>;
  const reason = typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason : 'No reason provided.';

  if (parsed.fresh === true) return { fresh: true, reason };

  if (parsed.fresh === false) {
    return {
      fresh: false,
      reason,
      improvementPrompt: typeof parsed.improvementPrompt === 'string' ? parsed.improvementPrompt : undefined,
    };
  }

  throw new Error('Cheap summary freshness check returned incomplete JSON.');
};

const extractIntroductionReferenceContext = (extractedPdf: ExtractedPdf) => {
  const text = extractedPdf.text;
  const lowerText = text.toLowerCase();
  const introductionIndex = lowerText.search(/\b(?:1\.?\s*)?introduction\b/);
  const introStart = introductionIndex >= 0 ? introductionIndex : 0;
  const introSlice = text.slice(introStart, introStart + 36_000);
  const sectionAfterIntro = introSlice.slice(800).search(/\b(?:2|ii)\.?\s+(?:related work|background|method|methods|design|proposed|principle|theory|system|model|analysis)\b/i);
  const introductionText = sectionAfterIntro >= 0 ? introSlice.slice(0, 800 + sectionAfterIntro) : introSlice.slice(0, 28_000);
  const referencesIndex = lowerText.lastIndexOf('references');
  const referencesText = referencesIndex >= 0 ? text.slice(referencesIndex, referencesIndex + 60_000) : '';

  return {
    introductionText: introductionText.trim(),
    referencesText: referencesText.trim(),
  };
};

const normalizeReferenceEvaluationRecords = (rawRecords: unknown[], request: z.infer<typeof readerRequestSchema>): ReferenceEvaluationRecord[] => {
  const sourcePaperKey = getPaperIdentitySlug(request);
  const sourceAuthors = parseAuthors(request.authors);
  const createdAt = new Date().toISOString();

  const normalizedRecords = rawRecords.map((rawRecord): ReferenceEvaluationRecord | null => {
    if (!rawRecord || typeof rawRecord !== 'object') return null;

    const record = rawRecord as Record<string, unknown>;
    const referenceTitle = typeof record.referenceTitle === 'string' ? record.referenceTitle.trim() : undefined;
    const referenceAuthors = Array.isArray(record.referenceAuthors)
      ? record.referenceAuthors.filter((author): author is string => typeof author === 'string' && Boolean(author.trim())).map((author) => author.trim()).slice(0, 4)
      : parseAuthors(typeof record.referenceAuthors === 'string' ? record.referenceAuthors : undefined);
    const referenceJournal = typeof record.referenceJournal === 'string' ? record.referenceJournal.trim() : undefined;
    const referenceYear = typeof record.referenceYear === 'string' ? record.referenceYear.trim() : undefined;
    const citedAs = typeof record.citedAs === 'string' ? record.citedAs.trim() : undefined;
    const evaluation = typeof record.evaluation === 'string' ? record.evaluation.trim() : '';
    const evidenceText = typeof record.evidenceText === 'string' ? record.evidenceText.trim() : undefined;
    const evaluationType = typeof record.evaluationType === 'string' ? record.evaluationType.trim() : undefined;
    const referenceKey = getPaperIdentityKey({
      title: referenceTitle,
      authors: referenceAuthors,
      journal: referenceJournal,
      year: referenceYear,
      paperId: citedAs,
    });

    if (!evaluation || referenceKey === 'uploadedpaper') return null;

    return {
      referenceKey,
      referenceTitle,
      referenceAuthors,
      referenceJournal,
      referenceYear,
      citedAs,
      sourcePaperKey,
      sourceTitle: request.title ?? request.paperId,
      sourceAuthors,
      sourceJournal: request.journal,
      sourceYear: request.year,
      extractedFrom: 'introduction' as const,
      evaluation,
      evidenceText,
      evaluationType,
      createdAt,
    };
    });

  return normalizedRecords.filter((record): record is ReferenceEvaluationRecord => record !== null).slice(0, 80);
};

const loadReferenceEvaluationRecords = async (storagePath: string): Promise<ReferenceEvaluationRecord[]> => {
  try {
    const parsed = parseJsonBlock(await downloadTextAsAdmin(storagePath));

    return Array.isArray(parsed)
      ? parsed.filter((record): record is ReferenceEvaluationRecord =>
          Boolean(record) &&
          typeof record === 'object' &&
          typeof (record as ReferenceEvaluationRecord).referenceKey === 'string' &&
          typeof (record as ReferenceEvaluationRecord).sourcePaperKey === 'string' &&
          typeof (record as ReferenceEvaluationRecord).evaluation === 'string',
        )
      : [];
  } catch {
    return [];
  }
};

const saveReferenceEvaluationRecords = async (storagePath: string, records: ReferenceEvaluationRecord[], title: string) => {
  const nextRecords = records.slice(-300);

  await uploadTextAsAdmin(
    `# ${title}\n\n\`\`\`json\n${JSON.stringify(nextRecords, null, 2)}\n\`\`\`\n`,
    storagePath,
  );

  return nextRecords;
};

const appendReferenceEvaluationRecords = async (storagePath: string, records: ReferenceEvaluationRecord[], title: string) => {
  const currentRecords = await loadReferenceEvaluationRecords(storagePath);
  const recordMap = new Map<string, ReferenceEvaluationRecord>();

  for (const record of [...currentRecords, ...records]) {
    const key = [
      record.referenceKey,
      record.sourcePaperKey,
      record.citedAs ?? '',
      record.evidenceText ?? record.evaluation.slice(0, 160),
    ].join('|');

    recordMap.set(key, record);
  }

  return saveReferenceEvaluationRecords(storagePath, [...recordMap.values()], title);
};

const getReferenceEvaluationDedupKey = (record: ReferenceEvaluationRecord) =>
  [record.referenceKey, record.sourcePaperKey, record.citedAs ?? '', record.evidenceText ?? record.evaluation.slice(0, 160)].join('|');

const mergeReferenceEvaluationRecords = (...recordGroups: ReferenceEvaluationRecord[][]) => {
  const recordMap = new Map<string, ReferenceEvaluationRecord>();

  for (const record of recordGroups.flat()) {
    recordMap.set(getReferenceEvaluationDedupKey(record), record);
  }

  return [...recordMap.values()];
};

const getReferenceEvaluationGraphId = (record: ReferenceEvaluationRecord) =>
  cleanPaperKeyPart([record.sourcePaperKey, record.referenceKey, record.citedAs, record.evidenceText ?? record.evaluation].filter(Boolean).join('|')).slice(0, 180);

let neo4jSchemaReady = false;

const ensureNeo4jReferenceSchema = async () => {
  if (neo4jSchemaReady) return;

  await writeNeo4j('CREATE CONSTRAINT paper_key_unique IF NOT EXISTS FOR (paper:Paper) REQUIRE paper.key IS UNIQUE');
  await writeNeo4j('CREATE CONSTRAINT evaluation_id_unique IF NOT EXISTS FOR (evaluation:Evaluation) REQUIRE evaluation.id IS UNIQUE');
  await writeNeo4j('CREATE CONSTRAINT author_name_unique IF NOT EXISTS FOR (author:Author) REQUIRE author.name IS UNIQUE');
  await writeNeo4j('CREATE CONSTRAINT venue_name_unique IF NOT EXISTS FOR (venue:Venue) REQUIRE venue.name IS UNIQUE');
  await writeNeo4j('CREATE TEXT INDEX paper_title_text IF NOT EXISTS FOR (paper:Paper) ON (paper.title)');
  await writeNeo4j('CREATE TEXT INDEX evaluation_text_text IF NOT EXISTS FOR (evaluation:Evaluation) ON (evaluation.text)');

  neo4jSchemaReady = true;
};

const syncReferenceEvaluationRecordsToNeo4j = async (records: ReferenceEvaluationRecord[], jobId?: string, paperId?: string) => {
  if (!records.length) return;

  const graphRecords = records.map((record) => ({
    ...record,
    evaluationId: getReferenceEvaluationGraphId(record),
  }));

  try {
    await ensureNeo4jReferenceSchema();

    const result = await writeNeo4j(
      `
UNWIND $records AS record
MERGE (source:Paper {key: record.sourcePaperKey})
SET source.title = coalesce(record.sourceTitle, source.title),
    source.authors = coalesce(record.sourceAuthors, source.authors),
    source.journal = coalesce(record.sourceJournal, source.journal),
    source.year = coalesce(record.sourceYear, source.year)
MERGE (reference:Paper {key: record.referenceKey})
SET reference.title = coalesce(record.referenceTitle, reference.title),
    reference.authors = coalesce(record.referenceAuthors, reference.authors),
    reference.journal = coalesce(record.referenceJournal, reference.journal),
    reference.year = coalesce(record.referenceYear, reference.year)
MERGE (source)-[citation:CITES {citedAs: coalesce(record.citedAs, record.referenceKey)}]->(reference)
SET citation.updatedAt = datetime()
FOREACH (authorName IN coalesce(record.sourceAuthors, []) |
  MERGE (author:Author {name: authorName})
  MERGE (author)-[:AUTHORED]->(source)
)
FOREACH (authorName IN coalesce(record.referenceAuthors, []) |
  MERGE (author:Author {name: authorName})
  MERGE (author)-[:AUTHORED]->(reference)
)
FOREACH (_ IN CASE WHEN record.sourceJournal IS NULL OR record.sourceJournal = '' THEN [] ELSE [1] END |
  MERGE (venue:Venue {name: record.sourceJournal})
  MERGE (source)-[:PUBLISHED_IN]->(venue)
)
FOREACH (_ IN CASE WHEN record.referenceJournal IS NULL OR record.referenceJournal = '' THEN [] ELSE [1] END |
  MERGE (venue:Venue {name: record.referenceJournal})
  MERGE (reference)-[:PUBLISHED_IN]->(venue)
)
MERGE (evaluation:Evaluation {id: record.evaluationId})
SET evaluation.text = record.evaluation,
    evaluation.evidenceText = record.evidenceText,
    evaluation.type = record.evaluationType,
    evaluation.sourceSection = record.extractedFrom,
    evaluation.createdAt = datetime(record.createdAt),
    evaluation.updatedAt = datetime()
MERGE (source)-[:EVALUATES]->(evaluation)
MERGE (evaluation)-[:ABOUT]->(reference)
      `,
      { records: graphRecords },
    );

    console.log('[reader-agent:references] neo4j sync finished', {
      jobId,
      paperId,
      records: graphRecords.length,
      skipped: result.skipped,
    });
  } catch (error) {
    console.error('[reader-agent:references] neo4j sync failed', {
      jobId,
      paperId,
      records: graphRecords.length,
      message: error instanceof Error ? error.message : 'Unknown Neo4j sync error.',
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
};

const loadExternalReferenceEvaluationsFromNeo4j = async (paperKey: string): Promise<ReferenceEvaluationRecord[]> => {
  try {
    const result = await readNeo4j(
      `
MATCH (source:Paper)-[:EVALUATES]->(evaluation:Evaluation)-[:ABOUT]->(reference:Paper {key: $paperKey})
OPTIONAL MATCH (source)-[:CITES]->(reference)
WITH source, reference, evaluation
ORDER BY evaluation.updatedAt DESC
RETURN
  reference.key AS referenceKey,
  reference.title AS referenceTitle,
  reference.authors AS referenceAuthors,
  reference.journal AS referenceJournal,
  reference.year AS referenceYear,
  source.key AS sourcePaperKey,
  source.title AS sourceTitle,
  source.authors AS sourceAuthors,
  source.journal AS sourceJournal,
  source.year AS sourceYear,
  evaluation.text AS evaluation,
  evaluation.evidenceText AS evidenceText,
  evaluation.type AS evaluationType,
  evaluation.sourceSection AS extractedFrom,
  toString(evaluation.createdAt) AS createdAt
LIMIT 80
      `,
      { paperKey },
      (record): ReferenceEvaluationRecord => ({
        referenceKey: String(record.get('referenceKey') ?? paperKey),
        referenceTitle: typeof record.get('referenceTitle') === 'string' ? record.get('referenceTitle') : undefined,
        referenceAuthors: Array.isArray(record.get('referenceAuthors')) ? record.get('referenceAuthors') : undefined,
        referenceJournal: typeof record.get('referenceJournal') === 'string' ? record.get('referenceJournal') : undefined,
        referenceYear: typeof record.get('referenceYear') === 'string' ? record.get('referenceYear') : undefined,
        sourcePaperKey: String(record.get('sourcePaperKey') ?? ''),
        sourceTitle: typeof record.get('sourceTitle') === 'string' ? record.get('sourceTitle') : undefined,
        sourceAuthors: Array.isArray(record.get('sourceAuthors')) ? record.get('sourceAuthors') : undefined,
        sourceJournal: typeof record.get('sourceJournal') === 'string' ? record.get('sourceJournal') : undefined,
        sourceYear: typeof record.get('sourceYear') === 'string' ? record.get('sourceYear') : undefined,
        extractedFrom: record.get('extractedFrom') === 'introduction' ? 'introduction' : 'introduction',
        evaluation: String(record.get('evaluation') ?? ''),
        evidenceText: typeof record.get('evidenceText') === 'string' ? record.get('evidenceText') : undefined,
        evaluationType: typeof record.get('evaluationType') === 'string' ? record.get('evaluationType') : undefined,
        createdAt: String(record.get('createdAt') ?? new Date().toISOString()),
      }),
    );

    console.log('[reader-agent:references] neo4j external evaluations loaded', {
      paperKey,
      records: result.records.length,
      skipped: result.skipped,
    });

    return result.records.filter((record) => record.sourcePaperKey && record.evaluation);
  } catch (error) {
    console.error('[reader-agent:references] neo4j external evaluation load failed', {
      paperKey,
      message: error instanceof Error ? error.message : 'Unknown Neo4j read error.',
      stack: error instanceof Error ? error.stack : undefined,
    });

    return [];
  }
};

const extractAndStoreIntroductionReferenceEvaluations = async (request: z.infer<typeof readerRequestSchema>, extractedPdf: ExtractedPdf, jobId?: string) => {
  const { introductionText, referencesText } = extractIntroductionReferenceContext(extractedPdf);

  if (introductionText.length < 800 || !/\[\d+\]|\(\d{4}\)|et al\.|previous|prior|reported|proposed|demonstrated|showed|introduced|limited|however/i.test(introductionText)) {
    console.log('[reader-agent:references] skipped introduction evaluation extraction', {
      jobId,
      paperId: request.paperId,
      introductionChars: introductionText.length,
      referencesChars: referencesText.length,
    });
    return { records: [], model: 'skipped', inputTokens: 0, outputTokens: 0 };
  }

  const startedAt = Date.now();

  console.log('[reader-agent:references] introduction evaluation extraction started', {
    jobId,
    paperId: request.paperId,
    model: selectExpensiveReaderModel().model,
    introductionChars: introductionText.length,
    referencesChars: referencesText.length,
  });

  const extractionResult = await createExpensiveTextResponse(
    'You extract citation-context records from a paper Introduction. Use only the Introduction text and References list. Do not infer from outside knowledge. Output only JSON: {"evaluations":[...]}.',
    `Source paper:
Title: ${request.title ?? request.paperId}
Authors: ${request.authors ?? 'unknown'}
Journal: ${request.journal ?? 'unknown'}
Year: ${request.year ?? 'unknown'}

Task:
Find as many cited papers as possible that appear in the Introduction with any meaningful role: background, prior route, method, comparison, benchmark, limitation, gap, motivation, application precedent, or claimed improvement.

For each cited paper, output:
- citedAs: citation marker such as [1], Smith et al., or whatever appears
- referenceTitle: title from References if available; otherwise omit
- referenceAuthors: array of author names from References if available
- referenceJournal: journal/conference from References if available
- referenceYear: year if available
- evaluationType: one of background, prior-work-route, limitation, comparison, gap, method, benchmark, application, improvement, motivation
- evaluation: one concise sentence describing how the source paper positions, uses, compares, or evaluates that cited work
- evidenceText: the shortest exact Introduction phrase/sentence supporting the record

Rules:
- Include grouped citations separately when the References metadata lets you resolve each citation marker.
- Include background citations if they establish prior work or a research route; mark evaluationType as background or prior-work-route.
- Do not include citations that are merely listed with no interpretable role.
- Do not claim we have read the cited paper itself.
- If metadata cannot be found in References, keep the evaluation with citedAs.
- Return up to 60 records.
- Prefer recall over excessive filtering; downstream deduplication will clean repeated records.

Introduction text:
${introductionText}

References text:
${referencesText || '[References section not found]'}`,
    6000,
    { jobId, paperId: request.paperId, phase: 'reference-extraction' },
    SUMMARY_CHUNK_TIMEOUT_MS,
  );

  const rawReferenceRecords = extractJsonArray(extractionResult.answer.trim());
  const records = normalizeReferenceEvaluationRecords(rawReferenceRecords, request);
  const sourcePaperKey = getPaperIdentitySlug(request);

  if (records.length) {
    await appendReferenceEvaluationRecords(getSourcePaperReferenceEvaluationsPath(sourcePaperKey), records, 'Introduction reference evaluations made by this paper');

    for (const record of records) {
      await appendReferenceEvaluationRecords(
        getReferenceExternalEvaluationsPath(record.referenceKey),
        [record],
        'External evaluations of this paper from other papers',
      );
    }

    await syncReferenceEvaluationRecordsToNeo4j(records, jobId, request.paperId);
  }

  console.log('[reader-agent:references] introduction evaluation extraction finished', {
    jobId,
    paperId: request.paperId,
    model: extractionResult.model,
    durationMs: Date.now() - startedAt,
    rawRecords: rawReferenceRecords.length,
    records: records.length,
    inputTokens: extractionResult.inputTokens,
    outputTokens: extractionResult.outputTokens,
  });

  return {
    records,
    model: extractionResult.model,
    inputTokens: extractionResult.inputTokens,
    outputTokens: extractionResult.outputTokens,
  };
};

const checkSummaryFreshnessWithCheapModel = async (request: z.infer<typeof readerRequestSchema>, cachedSummary: string) => {
  const modelSelection = selectCheapTriageModel();
  const client = createAnthropicClient(modelSelection.target);
  const response = await client.messages.create({
    model: modelSelection.model,
    max_tokens: 1200,
    system:
      '你是 SCIReader 的低成本总结质检助手。你只能检查已保存论文报告是否已经足够简洁、结构化，并包含核心技术机制、关键数值、证据强度和主要局限。不要重新总结论文，不要做深度论文理解。只输出 JSON。',
    messages: [
      {
        role: 'user',
        content: `论文标题: ${request.title ?? request.paperId}\n期刊: ${request.journal ?? '未知'}\n年份: ${request.year ?? '未知'}\n\n用户期望的总结任务:\n${request.prompt}\n\n已保存总结:\n${cachedSummary.slice(0, 20000)}\n\n请判断已保存总结是否需要用高成本模型重新读取 PDF 更新。只有当总结明显为空泛、过长失控、缺少核心技术机制/关键数值/证据强度/主要局限、与用户期望不匹配，或看起来被截断时，fresh=false。输出 JSON，格式为 {"fresh": boolean, "reason": string, "improvementPrompt": string }。fresh=false 时 improvementPrompt 给高成本模型明确说明需要补强什么；fresh=true 时不要输出 improvementPrompt。`,
      },
    ],
  });

  return {
    result: parseSummaryFreshnessResult(textFromResponse(response).trim()),
    model: modelSelection.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
};

const translateUserQuestionToEnglish = async (request: z.infer<typeof readerRequestSchema>) => {
  const modelSelection = selectCheapTriageModel();
  const client = createAnthropicClient(modelSelection.target);
  const context = [
    request.title ? `Paper title: ${request.title}` : null,
    request.scope ? `Question scope: ${request.scope}` : null,
    request.selectedText ? `Selected text:\n${request.selectedText.slice(0, 3000)}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');
  const response = await client.messages.create({
    model: modelSelection.model,
    max_tokens: 2000,
    system:
      'You are a precise academic translator. Translate the user question into clear English for a paper-reading AI. Preserve technical terms, symbols, units, equations, figure/table labels, citations, and the user intent. Output only the translated English question.',
    messages: [
      {
        role: 'user',
        content: `${context ? `${context}\n\n` : ''}User question:\n${request.prompt}`,
      },
    ],
  });

  return {
    text: textFromResponse(response).trim() || request.prompt,
    model: modelSelection.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
};

const translateReaderAnswerToChinese = async (englishAnswer: string, request: z.infer<typeof readerRequestSchema>) => {
  const modelSelection = selectCheapTriageModel();
  const client = createAnthropicClient(modelSelection.target);
  const response = await client.messages.create({
    model: modelSelection.model,
    max_tokens: 5000,
    system:
      'You are a precise academic translator. Translate the assistant answer into natural Chinese for the user interface. Preserve Markdown structure, equations, variable names, units, numbers, figure/table labels, citations, URLs, and field-specific terminology. Do not add new analysis or remove caveats.',
    messages: [
      {
        role: 'user',
        content: `Paper title: ${request.title ?? request.paperId}\n\nEnglish answer:\n${englishAnswer}`,
      },
    ],
  });

  return {
    text: textFromResponse(response).trim() || englishAnswer,
    model: modelSelection.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
};

const summarizeReaderAnswerBrieflyInChinese = async (fullAnswer: string, request: z.infer<typeof readerRequestSchema>, jobId?: string) => {
  const modelSelection = selectCheapTriageModel();
  const client = createAnthropicClient(modelSelection.target);
  const startedAt = Date.now();

  console.log('[reader-agent:llm] cheap brief summary started', {
    jobId,
    paperId: request.paperId,
    model: modelSelection.model,
    fullAnswerChars: fullAnswer.length,
  });

  const response = await client.messages.create({
    model: modelSelection.model,
    max_tokens: 800,
    system: briefSummaryPrompt,
    messages: [
      {
        role: 'user',
        content: `论文标题：${request.title ?? request.paperId}\n\n完整深度阅读笔记：\n${fullAnswer}`,
      },
    ],
  });
  const answer = textFromResponse(response).trim() || fullAnswer;

  console.log('[reader-agent:llm] cheap brief summary finished', {
    jobId,
    paperId: request.paperId,
    model: modelSelection.model,
    durationMs: Date.now() - startedAt,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    answerChars: answer.length,
  });

  return {
    text: answer,
    model: modelSelection.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
};

const formatSharedPaperMemory = (history: StoredDialogTurn[]) =>
  history
    .slice(-80)
    .map((turn, index) => {
      const parts = [
        `Record ${index + 1}`,
        `role: ${turn.role}`,
        `mode: ${turn.readingMode ?? 'unknown'}`,
        `createdAt: ${turn.createdAt}`,
        turn.modePrompt ? `modePrompt:\n${turn.modePrompt.slice(0, 3000)}` : null,
        turn.systemPrompt ? `systemPrompt:\n${turn.systemPrompt.slice(0, 3000)}` : null,
        turn.userPromptEnglish ? `userPromptEnglish:\n${turn.userPromptEnglish.slice(0, 4000)}` : null,
        turn.answerEnglish ? `answerEnglish:\n${turn.answerEnglish.slice(0, 6000)}` : null,
        turn.answerChinese ? `answerChinese:\n${turn.answerChinese.slice(0, 6000)}` : null,
        `content:\n${turn.content.slice(0, 6000)}`,
      ].filter(Boolean);

      return parts.join('\n');
    })
    .join('\n\n---\n\n');

const formatExternalReferenceEvaluations = (records: ReferenceEvaluationRecord[]) =>
  records
    .slice(-80)
    .map((record, index) => {
      const parts = [
        `External evaluation ${index + 1}`,
        `referenceKey: ${record.referenceKey}`,
        record.referenceTitle ? `referenceTitle: ${record.referenceTitle}` : null,
        record.referenceAuthors?.length ? `referenceAuthors: ${record.referenceAuthors.join(', ')}` : null,
        record.referenceJournal ? `referenceJournal: ${record.referenceJournal}` : null,
        record.referenceYear ? `referenceYear: ${record.referenceYear}` : null,
        record.citedAs ? `citedAs: ${record.citedAs}` : null,
        `sourcePaperKey: ${record.sourcePaperKey}`,
        record.sourceTitle ? `sourceTitle: ${record.sourceTitle}` : null,
        record.sourceJournal ? `sourceJournal: ${record.sourceJournal}` : null,
        record.sourceYear ? `sourceYear: ${record.sourceYear}` : null,
        record.evaluationType ? `evaluationType: ${record.evaluationType}` : null,
        `evaluation: ${record.evaluation}`,
        record.evidenceText ? `introductionEvidence: ${record.evidenceText}` : null,
      ].filter(Boolean);

      return parts.join('\n');
    })
    .join('\n\n---\n\n');

const retrieveAnswerFromSharedPaperMemory = async (
  request: z.infer<typeof readerRequestSchema>,
  cachedSummary: string,
  sharedHistory: StoredDialogTurn[],
  externalEvaluations: ReferenceEvaluationRecord[],
  translatedPrompt: string,
) => {
  if (!cachedSummary.trim() && sharedHistory.length === 0 && externalEvaluations.length === 0) {
    return {
      result: {
        sufficient: false,
        contextSummary: '',
        expensivePrompt: translatedPrompt,
      },
      model: 'no-shared-paper-memory',
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  const modelSelection = selectCheapTriageModel();
  const client = createAnthropicClient(modelSelection.target);
  const response = await client.messages.create({
    model: modelSelection.model,
    max_tokens: 4000,
    system:
      'You are SCIReader memory retrieval and routing. Search saved Azure Blob records for this exact paper key. Records may include the cached paper brief, shared dialog history, and external evaluations made by other papers in their Introductions. Your primary job is to decide whether the saved records are enough, or whether GPT-5.5 must read the PDF again. Be conservative. You may answer directly only when the saved records contain explicit evidence that directly answers the user question. Route to GPT-5.5 when the user asks for new expert judgment, critique, novelty assessment, credibility assessment, causal explanation, comparison, methodology interpretation, or anything that requires checking original PDF evidence beyond the saved records. Do not invent new paper analysis. If using external evaluations, clearly state in Chinese that they are other papers\' Introduction evaluations, not conclusions from reading the target paper itself. Output only JSON.',
    messages: [
      {
        role: 'user',
        content: `Paper title: ${request.title ?? request.paperId}
Reading mode: ${getReadingMode(request)}

Current user question in Chinese:
${request.prompt}

Current user question translated to English:
${translatedPrompt}

Cached paper brief:
${cachedSummary.slice(0, 12000) || 'None'}

Shared paper memory records:
${formatSharedPaperMemory(sharedHistory)}

External evaluations of this paper by other papers:
${formatExternalReferenceEvaluations(externalEvaluations) || 'None'}

Return JSON exactly in this shape:
{"sufficient": boolean, "contextSummary": string, "answerDraft": string, "expensivePrompt": string}

Rules:
- Think step by step internally before producing JSON: What exact claim is the user asking for? Is that claim already explicitly supported by saved records? Would a careful reviewer need to inspect the PDF text, figures, equations, methods, or tables?
- sufficient=true only for direct factual recall or simple restatement when saved records explicitly contain the needed answer.
- sufficient=false for new judgments, critique, novelty assessment, credibility assessment, "why" explanations, interpretation of method/model design, comparison, or when the saved records are only partially relevant.
- answerDraft must be Chinese and must mention when it is based on saved records if appropriate.
- If answerDraft uses external evaluations, explicitly say they come from other papers' Introduction sections and are not target-paper full-text evidence.
- sufficient=false when the answer would require reading the PDF again, interpreting new figures/tables/equations, or making new claims not present in saved records or external evaluations.
- When sufficient=false, contextSummary should briefly summarize relevant saved context for GPT-5.5.
- expensivePrompt must be English, preserve the user's intent, and explicitly ask GPT-5.5 to answer from PDF evidence and mention uncertainty when the paper does not provide enough evidence.`,
      },
    ],
  });
  const parsed = parseCheapTriageResult(textFromResponse(response).trim());

  return {
    result: parsed,
    model: modelSelection.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
};

const triageWithCheapModel = async (request: z.infer<typeof readerRequestSchema>, cachedSummary: string, storedHistory: StoredDialogTurn[]) => {
  if (!cachedSummary.trim() && storedHistory.length === 0) {
    return {
      result: {
        sufficient: false,
        contextSummary: '',
        expensivePrompt: `${request.prompt}\n\n当前还没有保存的论文总结或历史对话。请基于 PDF 原文回答，不要声称已经读取过总结。`,
      },
      model: 'no-stored-context',
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  const modelSelection = selectCheapTriageModel();
  const client = createAnthropicClient(modelSelection.target);
  const historyText = formatDialogHistory(storedHistory);
  const response = await client.messages.create({
    model: modelSelection.model,
    max_tokens: 2000,
    system:
      '你是 SCIReader 的低成本上下文检索助手。你的职责只有两件事：1) 从已保存的论文总结和历史对话里查找、压缩和整理已有信息；2) 判断这些已有信息是否足够回答当前问题。你不能做新的论文理解、推理扩展或深度分析。如果已有信息足够，就输出基于已有信息的简洁回答草稿；如果不够，就输出给高成本模型的更清晰任务提示。只输出 JSON。',
    messages: [
      {
        role: 'user',
        content: `论文标题: ${request.title ?? request.paperId}\n\n已保存总结:\n${cachedSummary || '暂无总结'}\n\n已保存历史:\n${historyText || '暂无历史'}\n\n当前问题:\n${request.prompt}\n\n请输出 JSON，格式为 {"sufficient": boolean, "contextSummary": string, "answerDraft": string, "expensivePrompt": string }。当 sufficient=true 时必须提供 answerDraft；当 sufficient=false 时必须提供 expensivePrompt。`,
      },
    ],
  });
  const text = textFromResponse(response).trim();
  const parsed = parseCheapTriageResult(text);

  return {
    result: parsed,
    model: modelSelection.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
};

const estimateTextTokensLocally = (text: string) => {
  const cjkChars = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const latinWords = text.match(/[A-Za-z]+(?:['-][A-Za-z]+)?/g)?.length ?? 0;
  const numbers = text.match(/\b\d+(?:[.,:/-]\d+)*\b/g)?.length ?? 0;
  const nonWhitespaceChars = text.replace(/\s+/g, '').length;
  const latinWordChars = text.match(/[A-Za-z0-9]+/g)?.join('').length ?? 0;
  const otherChars = Math.max(0, nonWhitespaceChars - cjkChars - latinWordChars);

  return Math.max(1, Math.ceil(cjkChars * 1.05 + latinWords * 1.3 + numbers * 1.1 + otherChars / 3));
};

const estimateTokensLocally = (text: string, prompt: string) => estimateTextTokensLocally(`${prompt}\n\n${text}`);

const estimatePdfTokensFromBytes = (pdfBytes: number, prompt: string) => Math.ceil(pdfBytes / 5) + estimateTextTokensLocally(prompt);

const SUMMARY_CHUNK_MAX_CHARS = 12_000;
const SUMMARY_BRIEF_SINGLE_PASS_MAX_CHARS = 60_000;
const SUMMARY_CHUNK_TIMEOUT_MS = 90_000;
const SUMMARY_FINAL_TIMEOUT_MS = 120_000;

const getCompactSummaryInstruction = (mode: PaperReadingMode) =>
  mode === 'reviewer'
    ? 'You are a cross-disciplinary engineering and applied-science reviewer. Extract only the real technical mechanism, novelty, key numbers with units, evidence strength, paper tier clues, and the largest credibility risk. Be terse.'
    : 'You are a cross-disciplinary engineering and applied-science research reader. Extract only the core technical idea, mechanism, key numbers with units, reusable design insight, paper tier clues, and limits. Be terse.';

const briefSummaryPrompt = `你将收到一份针对某篇论文生成的"深度阅读笔记"（完整版，可能来自"审稿模式"或"写稿模式"两种模板之一）。

请基于这份笔记，只提炼以下五点，使用中文输出，每点严格控制在1-2句话内：

## 速览

* **核心卖点**：去掉包装后，这篇论文真正的新东西/最大优势是什么（即论文最想让审稿人/读者记住的一点）。
* **核心数据**：列出笔记中最关键的1-3个量化结果（保留具体数值、单位，如增益/dB、精度/mAP、带宽/GHz、良率等——以笔记中实际出现的指标为准，不要编造）。
* **主要缺陷**：方法、实验或证据层面最大的弱点（如笔记中明确未提及缺陷，写"未发现明显缺陷"）。
* **是否有价值**：值得细读 / 可选 / 不必细读，附极简理由（不超过8字）。
* **数据造假嫌疑**：有 / 未见明显异常 / 信息不足无法判断（严格沿用笔记"证据强度核查"部分的结论，不得自行加重或减轻判断）。

硬性要求：
* 只能基于完整笔记中已有内容提炼，禁止引入笔记之外的新判断、新信息或推测。
* "核心数据"必须是笔记中出现过的真实数值，不得四舍五入到面目全非或编造。
* 禁止展开论述、禁止给出建议、禁止追问索引、禁止输出除上述五点之外的任何内容。
* 总输出不超过180字。
* 不要输出"完整笔记见附件"等附加说明。`;

const estimateTokenConsumption = async (request: z.infer<typeof tokenEstimateRequestSchema>) => {
  const startedAt = Date.now();
  const storagePath = resolveUploadedPdfStoragePath(request.pdfUrl);

  if (!storagePath) throw new Error('Only uploaded PDFs can be estimated.');

  console.log('[reader-agent:count-tokens] started', {
    paperId: request.paperId,
    title: request.title,
    storagePath,
  });

  const modelSelection = selectTokenEstimateModel(request);
  const prompt = request.prompt?.trim() || '请总结这篇文档';
  const tempPdf = await materializePdfToTempFile(storagePath);

  try {
    const extractedPdf = await extractPdfText(tempPdf.localPdfPath);
    const inputTokens = extractedPdf.text.trim()
      ? estimateTokensLocally(extractedPdf.text, prompt)
      : estimatePdfTokensFromBytes(tempPdf.buffer.byteLength, prompt);

    console.log('[reader-agent:count-tokens] finished with local estimate', {
      paperId: request.paperId,
      model: modelSelection.model,
      target: modelSelection.target,
      inputTokens,
      pdfBytes: tempPdf.buffer.byteLength,
      extractedChars: extractedPdf.text.length,
      durationMs: Date.now() - startedAt,
    });

    return {
      inputTokens,
      billableTokens: getBillableTokens(inputTokens, 0, modelSelection.model),
      tokenWeight: getModelTokenWeight(modelSelection.model),
      model: modelSelection.model,
      prompt,
      estimated: true,
      method: 'local-text-estimate',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PDF text extraction failed.';
    const inputTokens = estimatePdfTokensFromBytes(tempPdf.buffer.byteLength, prompt);

    console.warn('[reader-agent:count-tokens] text extraction failed; using byte estimate', {
      paperId: request.paperId,
      model: modelSelection.model,
      target: modelSelection.target,
      inputTokens,
      pdfBytes: tempPdf.buffer.byteLength,
      durationMs: Date.now() - startedAt,
      message,
    });

    return {
      inputTokens,
      billableTokens: getBillableTokens(inputTokens, 0, modelSelection.model),
      tokenWeight: getModelTokenWeight(modelSelection.model),
      model: modelSelection.model,
      prompt,
      estimated: true,
      method: 'local-byte-estimate',
      warning: `PDF text extraction failed; returned a byte-based local estimate: ${message}`,
    };
  } finally {
    await fs.rm(tempPdf.outputDir, { recursive: true, force: true });
  }
};

const chunkExtractedPdfPages = (pages: ExtractedPdfPage[]) => {
  const chunks: Array<{ pageNumbers: number[]; text: string }> = [];
  let currentPages: number[] = [];
  let currentText = '';

  for (const page of pages) {
    const pageText = `[Page ${page.pageNumber}]\n${page.text}`;
    const nextText = currentText ? `${currentText}\n\n${pageText}` : pageText;

    if (currentText && nextText.length > SUMMARY_CHUNK_MAX_CHARS) {
      chunks.push({ pageNumbers: currentPages, text: currentText });
      currentPages = [page.pageNumber];
      currentText = pageText;
    } else {
      currentPages.push(page.pageNumber);
      currentText = nextText;
    }
  }

  if (currentText) chunks.push({ pageNumbers: currentPages, text: currentText });

  return chunks.length ? chunks : [{ pageNumbers: [], text: 'No extractable PDF text was found.' }];
};

const createExpensiveTextResponse = async (system: string, userContent: string, maxTokens = 6000, logContext?: Record<string, unknown>, timeoutMs = SUMMARY_CHUNK_TIMEOUT_MS) => {
  const modelSelection = selectExpensiveReaderModel();
  const client = createAnthropicClient(modelSelection.target);
  const startedAt = Date.now();

  console.log('[reader-agent:llm] expensive text request started', {
    ...logContext,
    model: modelSelection.model,
    maxTokens,
    timeoutMs,
    maxRetries: 0,
    userChars: userContent.length,
    systemChars: system.length,
  });

  let response;

  try {
    response = await client.messages.create(
      {
        model: modelSelection.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userContent }],
      },
      { timeout: timeoutMs, maxRetries: 0 },
    );
  } catch (error) {
    console.error('[reader-agent:llm] expensive text request failed', {
      ...logContext,
      model: modelSelection.model,
      durationMs: Date.now() - startedAt,
      timeoutMs,
      errorName: error instanceof Error ? error.name : undefined,
      errorStack: error instanceof Error ? error.stack?.slice(0, 1200) : undefined,
      message: error instanceof Error ? error.message : 'Unknown expensive text request error.',
    });

    throw error;
  }
  const answer = textFromResponse(response);

  console.log('[reader-agent:llm] expensive text request finished', {
    ...logContext,
    model: modelSelection.model,
    durationMs: Date.now() - startedAt,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    answerChars: answer.length,
  });

  return {
    answer,
    model: modelSelection.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
};

const generateChunkedEnglishSummary = async (
  request: z.infer<typeof readerRequestSchema>,
  jobId: string,
  setJobStatus: (patch: Partial<Omit<SummaryJobEntry, 'jobId' | 'startedAt' | 'promise'>>) => void,
) => {
  const storagePath = resolveUploadedPdfStoragePath(request.pdfUrl);

  if (!storagePath) {
    setJobStatus({ phase: 'final-synthesis', message: 'No uploaded PDF path; generating from prompt/context only.' });
    const result = await createExpensiveTextResponse(
      buildReaderSystemPrompt(Boolean(request.paperContextSummary), false, request.modePrompt, 'english'),
      `Paper title: ${request.title ?? request.paperId}\n\nTask:\n${request.prompt}`,
      12000,
      { jobId, paperId: request.paperId, phase: 'fallback-no-pdf' },
    );

    return { answer: result.answer, inputTokens: result.inputTokens, outputTokens: result.outputTokens, model: result.model };
  }

  setJobStatus({ phase: 'materializing-pdf', message: 'Downloading PDF from storage into a temporary file.' });
  const tempPdf = await materializePdfToTempFile(storagePath);

  try {
    setJobStatus({ phase: 'extracting-text', message: 'Extracting text from PDF pages.' });
    const extractedPdf = await extractPdfText(tempPdf.localPdfPath);
    await extractAndStoreIntroductionReferenceEvaluations(request, extractedPdf, jobId).catch((error) => {
      console.error('[reader-agent:references] introduction evaluation extraction failed', {
        jobId,
        paperId: request.paperId,
        message: error instanceof Error ? error.message : 'Unknown reference evaluation extraction error.',
        stack: error instanceof Error ? error.stack : undefined,
      });
    });

    const wantsDetailedReport = request.detailedReport === true;

    if (!wantsDetailedReport && extractedPdf.text.length <= SUMMARY_BRIEF_SINGLE_PASS_MAX_CHARS) {
      setJobStatus({
        phase: 'brief-synthesis',
        currentChunk: undefined,
        totalChunks: 1,
        message: 'Generating a compact first-pass paper brief from the full extracted text.',
      });

      console.log('[reader-agent:summarize] brief single-pass started', {
        jobId,
        paperId: request.paperId,
        extractedChars: extractedPdf.text.length,
        pages: extractedPdf.pages.length,
        estimatedTokens: estimateTextTokensLocally(extractedPdf.text),
      });

      const briefResult = await createExpensiveTextResponse(
        `${getCompactSummaryInstruction(getReadingMode(request))}

Respond in English. Create a compact first-pass evidence note, not a full report.
Use exactly these five bullets, each under 35 words:
- core technical mechanism
- key structure/parameter
- strongest reported numbers with units
- evidence strength: simulation/measurement/baseline
- main limitation or missing proof
Do not write paragraphs. Do not include a literature review or follow-up questions.`,
        `Paper title: ${request.title ?? request.paperId}
Reading mode: ${getReadingMode(request)}

Task:
${request.prompt}

Extracted paper text:
${extractedPdf.text}`,
        550,
        { jobId, paperId: request.paperId, phase: 'brief-synthesis', pages: extractedPdf.pages.length },
        SUMMARY_CHUNK_TIMEOUT_MS,
      );

      console.log('[reader-agent:summarize] brief single-pass finished', {
        jobId,
        paperId: request.paperId,
        model: briefResult.model,
        inputTokens: briefResult.inputTokens,
        outputTokens: briefResult.outputTokens,
        answerChars: briefResult.answer.length,
      });

      return {
        answer: briefResult.answer,
        inputTokens: briefResult.inputTokens,
        outputTokens: briefResult.outputTokens,
        model: briefResult.model,
      };
    }

    const chunks = chunkExtractedPdfPages(extractedPdf.pages);
    const chunkNotes: string[] = [];
    const compactInstruction = getCompactSummaryInstruction(getReadingMode(request));
    let inputTokens = 0;
    let outputTokens = 0;
    let model = '';

    console.log('[reader-agent:summarize] chunked summary extraction ready', {
      jobId,
      paperId: request.paperId,
      chunks: chunks.length,
      extractedChars: extractedPdf.text.length,
      chunkPlan: chunks.map((chunk, index) => ({
        chunk: index + 1,
        pages: chunk.pageNumbers,
        chars: chunk.text.length,
        estimatedTokens: estimateTextTokensLocally(chunk.text),
      })),
    });

    for (const [index, chunk] of chunks.entries()) {
      setJobStatus({
        phase: 'chunk',
        currentChunk: index + 1,
        totalChunks: chunks.length,
        message: `Generating chunk ${index + 1}/${chunks.length} for pages ${chunk.pageNumbers.join(', ') || 'unknown'}.`,
      });

      console.log('[reader-agent:summarize] chunk summary started', {
        jobId,
        paperId: request.paperId,
        chunk: index + 1,
        chunks: chunks.length,
        pages: chunk.pageNumbers,
        chars: chunk.text.length,
      });

      let chunkResult;

      try {
        const chunkSystem = wantsDetailedReport
          ? `${compactInstruction}

Respond in English. This is batch ${index + 1} of ${chunks.length}. Write compact but useful notes for a detailed review.
Use 7-10 bullets, each under 45 words. Capture only evidence present in this batch:
- venue/journal/conference or publication clues if visible
- technical mechanism and assumptions
- method/model/processing pipeline
- experimental setup, validation source, or baseline
- strongest numerical results with units
- figures/tables/equations only if central
- uncertainty, error source, limitation, or credibility concern
- innovation type if this batch supports it
Do not write a full report. Do not mention pages outside this batch.`
          : `${compactInstruction}

Respond in English. This is batch ${index + 1} of ${chunks.length}. Write exactly 5 bullets, each under 28 words:
- mechanism/design trick
- key structure or equation only if essential
- strongest 1-3 numbers with units
- evidence type: simulation/measurement/baseline
- main weakness or missing proof
Do not write paragraphs. Do not write a full report. Do not mention pages outside this batch.`;

        chunkResult = await createExpensiveTextResponse(
          chunkSystem,
          `Paper title: ${request.title ?? request.paperId}
Reading mode: ${getReadingMode(request)}
Pages in this batch: ${chunk.pageNumbers.join(', ') || 'unknown'}

Overall summary task:
${request.prompt}

Extracted text for this batch:
${chunk.text}`,
          wantsDetailedReport ? 900 : 450,
          { jobId, paperId: request.paperId, phase: 'chunk', chunk: index + 1, chunks: chunks.length, pages: chunk.pageNumbers.join(',') },
          SUMMARY_CHUNK_TIMEOUT_MS,
        );
      } catch {
        setJobStatus({
          phase: 'chunk-retry',
          currentChunk: index + 1,
          totalChunks: chunks.length,
          message: `Retrying chunk ${index + 1}/${chunks.length} with a shorter prompt.`,
        });

        console.warn('[reader-agent:summarize] chunk summary retrying with shorter request', {
          jobId,
          paperId: request.paperId,
          chunk: index + 1,
          chunks: chunks.length,
        });

        chunkResult = await createExpensiveTextResponse(
          `${compactInstruction}

Respond in English. Retry output: exactly 4 bullets, each under 22 words. Keep only mechanism, key numbers, evidence type, and main weakness.`,
          `Paper title: ${request.title ?? request.paperId}
Pages in this batch: ${chunk.pageNumbers.join(', ') || 'unknown'}

Extracted text for this batch:
${chunk.text.slice(0, 5000)}`,
          260,
          { jobId, paperId: request.paperId, phase: 'chunk-retry', chunk: index + 1, chunks: chunks.length, pages: chunk.pageNumbers.join(',') },
          60_000,
        ).catch((error) => {
          const message = error instanceof Error ? error.message : 'Unknown chunk retry error.';

          console.error('[reader-agent:summarize] chunk summary skipped after retry failure', {
            jobId,
            paperId: request.paperId,
            chunk: index + 1,
            chunks: chunks.length,
            message,
          });

          return {
            answer: `Batch ${index + 1} pages ${chunk.pageNumbers.join(', ') || 'unknown'} could not be summarized because the model request timed out or failed. The final report should explicitly mark evidence from these pages as incomplete.`,
            model: 'chunk-summary-failed',
            inputTokens: 0,
            outputTokens: 0,
          };
        });
      }

      model = chunkResult.model;
      inputTokens += chunkResult.inputTokens;
      outputTokens += chunkResult.outputTokens;
      chunkNotes.push(`## Batch ${index + 1}/${chunks.length} - Pages ${chunk.pageNumbers.join(', ') || 'unknown'}\n\n${chunkResult.answer}`);

      console.log('[reader-agent:summarize] chunk summary finished', {
        jobId,
        paperId: request.paperId,
        chunk: index + 1,
        chunks: chunks.length,
        model: chunkResult.model,
        inputTokens: chunkResult.inputTokens,
        outputTokens: chunkResult.outputTokens,
      });
    }

    if (request.detailedReport !== true) {
      const combinedChunkNotes = chunkNotes.join('\n\n---\n\n');

      setJobStatus({
        phase: 'translating',
        currentChunk: undefined,
        totalChunks: chunks.length,
        message: 'Brief mode: skipping final GPT-5.5 synthesis; cheap model will compress chunk notes.',
      });

      console.log('[reader-agent:summarize] brief mode skipped final synthesis', {
        jobId,
        paperId: request.paperId,
        chunks: chunks.length,
        noteChars: combinedChunkNotes.length,
        inputTokens,
        outputTokens,
      });

      return {
        answer: combinedChunkNotes,
        inputTokens,
        outputTokens,
        model: model || selectExpensiveReaderModel().model,
      };
    }

    console.log('[reader-agent:summarize] final synthesis started', {
      jobId,
      paperId: request.paperId,
      chunks: chunks.length,
      noteChars: chunkNotes.join('\n\n').length,
    });

    const finalInput = `Paper title: ${request.title ?? request.paperId}
Authors: ${request.authors ?? 'unknown'}
Venue/journal/conference: ${request.journal ?? 'unknown'}
Year: ${request.year ?? 'unknown'}
Reading mode: ${getReadingMode(request)}

Final report task:
${request.prompt}

Batch notes:
${chunkNotes.join('\n\n---\n\n')}`;
    let finalResult;

    try {
      setJobStatus({
        phase: 'final-synthesis',
        currentChunk: undefined,
        totalChunks: chunks.length,
        message: 'Synthesizing final English report from chunk notes.',
      });

      finalResult = await createExpensiveTextResponse(
        `${compactInstruction}

Respond in English. Synthesize the batch notes into a structured detailed cross-disciplinary paper review under 1500 words.
Use exactly these sections:
1. Paper tier / publication-level assessment
2. Verdict
3. Core technical mechanism
4. Key numbers
5. Evidence and credibility
6. Innovation assessment
7. Main limitations

Paper tier / publication-level assessment requirements:
- First identify the paper's technical field from the content. Do not force physics/electromagnetics if the paper is computer science, civil engineering, geoscience, medicine, management, etc.
- Evaluate the paper itself, not just the journal. Estimate the likely publication level from the quality of contribution, evidence, novelty, validation, venue metadata, and writing.
- Classify into one of: CAS Q1-level paper, CAS Q2-level paper, CAS Q3-level paper, CAS Q4-level paper, Chinese Core-level paper, ordinary Open Access paper, conference paper, preprint/unpublished work, possible opportunistic/weak publication, unknown/needs lookup.
- If the venue is known, mention it as context only. A good venue does not automatically make the paper high-level; a low/ordinary venue does not automatically make the paper bad.
- Be strict but evidence-based. If the paper looks like a weak or opportunistic publication, say so and explain the evidence. If uncertain, say uncertain and list what must be checked.

Innovation assessment requirements:
- Judge whether the novelty is mainly scientific mechanism, engineering system, algorithm/modeling, dataset/product, experimental demonstration, application scenario, or integration.
- Say whether the contribution is strong, moderate, or incremental, with evidence.

Do not add unsupported claims. Do not repeat points. Do not include a follow-up question index.`,
        finalInput,
        2600,
        { jobId, paperId: request.paperId, phase: 'final-synthesis', chunks: chunks.length },
        SUMMARY_FINAL_TIMEOUT_MS,
      );
    } catch {
      setJobStatus({
        phase: 'final-synthesis-retry',
        currentChunk: undefined,
        totalChunks: chunks.length,
        message: 'Retrying final synthesis with shorter notes.',
      });

      console.warn('[reader-agent:summarize] final synthesis retrying with shorter request', {
        jobId,
        paperId: request.paperId,
        chunks: chunks.length,
      });

      finalResult = await createExpensiveTextResponse(
        `${compactInstruction}

Respond in English. Create a short final report under 600 words from these batch notes. Preserve only mechanism, key numbers, evidence strength, and limits.`,
        finalInput.slice(0, 35_000),
        1200,
        { jobId, paperId: request.paperId, phase: 'final-synthesis-retry', chunks: chunks.length },
        75_000,
      ).catch((error) => {
        const message = error instanceof Error ? error.message : 'Unknown final synthesis retry error.';

        console.error('[reader-agent:summarize] final synthesis skipped after retry failure', {
          jobId,
          paperId: request.paperId,
          chunks: chunks.length,
          message,
        });

        return {
          answer: `The final synthesis step failed, so these are the available batch notes.\n\n${chunkNotes.join('\n\n---\n\n')}`,
          model: 'final-synthesis-failed',
          inputTokens: 0,
          outputTokens: 0,
        };
      });
    }

    inputTokens += finalResult.inputTokens;
    outputTokens += finalResult.outputTokens;
    model = finalResult.model || model;

    console.log('[reader-agent:summarize] final synthesis finished', {
      jobId,
      paperId: request.paperId,
      chunks: chunks.length,
      model,
      inputTokens: finalResult.inputTokens,
      outputTokens: finalResult.outputTokens,
    });

    return {
      answer: finalResult.answer,
      inputTokens,
      outputTokens,
      model,
    };
  } finally {
    await fs.rm(tempPdf.outputDir, { recursive: true, force: true });
  }
};

const startSummaryGenerationJob = (
  request: z.infer<typeof readerRequestSchema>,
  summaryStoragePath: string,
  userId?: string,
  freshness?: { inputTokens: number; outputTokens: number },
) => {
  const existingJob = summaryJobs.get(summaryStoragePath);

  if (existingJob) {
    console.log('[reader-agent:summarize] existing background job reused', {
      jobId: existingJob.jobId,
      paperId: request.paperId,
      summaryStoragePath,
      startedAt: existingJob.startedAt,
    });

    return { started: false, startedAt: existingJob.startedAt, jobId: existingJob.jobId, job: getSummaryJobSnapshot(existingJob) };
  }

  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  const jobEntry: SummaryJobEntry = {
    jobId,
    startedAt,
    updatedAt: startedAt,
    phase: 'queued',
    message: 'Summary job queued.',
    promise: Promise.resolve(),
  };
  summaryJobs.set(summaryStoragePath, jobEntry);
  const setJobStatus = (patch: Partial<Omit<SummaryJobEntry, 'jobId' | 'startedAt' | 'promise'>>) => updateSummaryJobStatus(summaryStoragePath, patch);

  const runJob = async () => {
    console.log('[reader-agent:summarize] background summary generation started', {
      jobId,
      paperId: request.paperId,
      title: request.title,
      summaryStoragePath,
      readingMode: getReadingMode(request),
    });

    const result = await generateChunkedEnglishSummary(request, jobId, setJobStatus);
    const wantsDetailedReport = request.detailedReport === true;
    setJobStatus({
      phase: 'translating',
      message: wantsDetailedReport
        ? 'Translating final English summary into Chinese with cheap model.'
        : 'Compressing final report into a brief Chinese overview with cheap model.',
    });
    const finalChineseResult = wantsDetailedReport
      ? await translateReaderAnswerToChinese(result.answer, request)
      : await summarizeReaderAnswerBrieflyInChinese(result.answer, request, jobId);
    const summary = finalChineseResult.text;
    const inputTokens = (freshness?.inputTokens ?? 0) + result.inputTokens + finalChineseResult.inputTokens;
    const outputTokens = (freshness?.outputTokens ?? 0) + result.outputTokens + finalChineseResult.outputTokens;
    const billableTokens =
      (freshness ? getBillableTokens(freshness.inputTokens, freshness.outputTokens, selectCheapTriageModel().model) : 0) +
      getBillableTokens(result.inputTokens, result.outputTokens, result.model) +
      getBillableTokens(finalChineseResult.inputTokens, finalChineseResult.outputTokens, finalChineseResult.model);

    console.log('[reader-agent:summarize] background summary generation finished', {
      jobId,
      paperId: request.paperId,
      model: result.model,
      detailedReport: wantsDetailedReport,
      inputTokens,
      outputTokens,
      billableTokens,
      saved: Boolean(summary.trim()),
    });

    if (userId) {
      await recordUserTokenUsage({
        userId,
        paperId: request.paperId,
        action: wantsDetailedReport ? 'summary:detailed' : 'summary:brief',
        model: `${result.model} -> ${finalChineseResult.model}`,
        inputTokens,
        outputTokens,
        billableTokens,
        metadata: {
          detailedReport: wantsDetailedReport,
          readingMode: getReadingMode(request),
          summaryStoragePath,
          jobId,
        },
      });
    }

    if (summary.trim()) {
      setJobStatus({ phase: 'uploading', message: 'Uploading Chinese summary to Azure Blob cache.' });
      await uploadTextAsAdmin(summary, summaryStoragePath);
    }

    setJobStatus({ phase: 'finished', message: summary.trim() ? 'Summary saved to Azure Blob cache.' : 'Summary finished but empty; nothing was uploaded.' });
  };

  const promise = runJob()
    .catch((error) => {
      setJobStatus({ phase: 'failed', message: error instanceof Error ? error.message : 'Unknown background summary error.' });
      console.error('[reader-agent:summarize] background summary generation failed', {
        jobId,
        paperId: request.paperId,
        summaryStoragePath,
        message: error instanceof Error ? error.message : 'Unknown background summary error.',
      });
    })
    .finally(() => {
      const currentJob = summaryJobs.get(summaryStoragePath);
      if (currentJob?.jobId === jobId) summaryJobs.delete(summaryStoragePath);
    });

  jobEntry.promise = promise;
  void promise;

  return { started: true, startedAt, jobId, job: getSummaryJobSnapshot(jobEntry) };
};

const app = new Hono()
  .get('/history', async (c) => {
    const paperId = c.req.query('paperId');
    const title = c.req.query('title');
    const authors = c.req.query('authors');
    const journal = c.req.query('journal');
    const year = c.req.query('year');
    const pdfUrl = c.req.query('pdfUrl');

    if (!paperId) return c.json({ error: 'paperId is required.' }, 400);

    try {
      const { user } = await requirePaperAccess(c, pdfUrl);
      const paperKey = getPaperIdentitySlug({ paperId, title, authors, journal, year });
      const history = await loadDialogHistory(user.id, paperKey);

      return c.json({ history });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Paper history failed.';
      const status = message === 'Not authenticated.' ? 401 : message === 'You do not have access to this PDF.' ? 403 : 500;

      return c.json({ error: 'Paper history failed.', message }, status);
    }
  })
  .get('/neo4j/status', async (c) => {
    try {
      await requirePaperAccess(c);
      const status = await verifyNeo4jConnection();

      return c.json(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Neo4j status check failed.';
      const status = message === 'Not authenticated.' ? 401 : 500;

      return c.json({ configured: false, ok: false, error: 'Neo4j status check failed.', message }, status);
    }
  })
  .post('/metadata', zValidator('json', metadataRequestSchema), async (c) => {
    const request = c.req.valid('json');

    try {
      const { storagePath } = await requirePaperAccess(c, request.pdfUrl);

      if (!storagePath) return c.json({ error: 'Only uploaded PDFs can be inspected.' }, 400);

      const tempPdf = await materializePdfToTempFile(storagePath);

      try {
        const metadata = await extractPaperMetadata(tempPdf.localPdfPath, request.fallbackTitle);
        const paperKey = getPaperIdentityKey(metadata);

        return c.json({ ...metadata, paperKey });
      } finally {
        await fs.rm(tempPdf.outputDir, { recursive: true, force: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'PDF metadata extraction failed.';
      const status = message === 'Not authenticated.' ? 401 : message === 'You do not have access to this PDF.' ? 403 : 500;

      return c.json({ error: 'PDF metadata extraction failed.', message }, status);
    }
  })
  .post('/count-tokens', zValidator('json', tokenEstimateRequestSchema), async (c) => {
    const request = c.req.valid('json');

    try {
      const { user } = await requirePaperAccess(c, request.pdfUrl);
      return c.json(await estimateTokenConsumption(request));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Token estimate failed.';
      const status = message === 'Not authenticated.' ? 401 : message === 'You do not have access to this PDF.' ? 403 : 500;

      console.error('[reader-agent:count-tokens] failed', {
        paperId: request.paperId,
        status,
        message,
      });

      return c.json({ error: 'Token estimate failed.', message }, status);
    }
  })
  .post('/ask', zValidator('json', readerRequestSchema), async (c) => {
    const request = c.req.valid('json');

    try {
      const { user } = await requirePaperAccess(c, request.pdfUrl);
      const paperKey = getPaperIdentitySlug(request);
      const summaryStoragePath = getPaperSummaryStoragePath(request, resolveUploadedPdfStoragePath(request.pdfUrl));
      const cachedSummary = (await downloadTextIfExists(summaryStoragePath)) ?? '';
      const storedHistory = await loadDialogHistory(user.id, paperKey);
      const sharedHistory = await loadSharedPaperDialogHistory(paperKey);
      const [neo4jExternalEvaluations, blobExternalEvaluations] = await Promise.all([
        loadExternalReferenceEvaluationsFromNeo4j(paperKey),
        loadReferenceEvaluationRecords(getReferenceExternalEvaluationsPath(paperKey)),
      ]);
      const externalEvaluations = mergeReferenceEvaluationRecords(neo4jExternalEvaluations, blobExternalEvaluations);
      console.log('[reader-agent:references] external evaluations loaded for retrieval', {
        paperId: request.paperId,
        paperKey,
        records: externalEvaluations.length,
        neo4jRecords: neo4jExternalEvaluations.length,
        blobRecords: blobExternalEvaluations.length,
      });
      const translatedPrompt = await translateUserQuestionToEnglish(request);
      const nowForTranslatedPipeline = new Date().toISOString();
      let memoryResult;

      try {
        memoryResult = await retrieveAnswerFromSharedPaperMemory(request, cachedSummary, sharedHistory, externalEvaluations, translatedPrompt.text);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown memory retrieval error.';

        console.warn('[reader-agent:ask] memory routing failed; escalating to expensive reader', {
          paperId: request.paperId,
          paperKey,
          message,
        });

        memoryResult = {
          result: {
            sufficient: false,
            contextSummary: '',
            expensivePrompt: `${translatedPrompt.text}\n\nThe cheap memory router failed (${message}). Please answer by reading the PDF evidence directly.`,
          },
          model: 'cheap-memory-routing-failed',
          inputTokens: 0,
          outputTokens: 0,
        };
      }
      const memoryInputTokens = translatedPrompt.inputTokens + memoryResult.inputTokens;
      const memoryOutputTokens = translatedPrompt.outputTokens + memoryResult.outputTokens;

      console.log('[reader-agent:ask] memory routing result', {
        paperId: request.paperId,
        paperKey,
        sufficient: memoryResult.result.sufficient,
        model: memoryResult.model,
        hasCachedSummary: Boolean(cachedSummary.trim()),
        sharedHistoryTurns: sharedHistory.length,
        externalEvaluationRecords: externalEvaluations.length,
      });

      if (memoryResult.result.sufficient && memoryResult.result.answerDraft?.trim()) {
        const billableTokens = getBillableTokens(memoryInputTokens, memoryOutputTokens, memoryResult.model);
        const tokenAccount = await recordUserTokenUsage({
          userId: user.id,
          paperId: request.paperId,
          action: 'ask:cheap-context',
          model: `${translatedPrompt.model} -> ${memoryResult.model}`,
          inputTokens: memoryInputTokens,
          outputTokens: memoryOutputTokens,
          billableTokens,
          metadata: {
            routedBy: 'cheap-context',
            readingMode: getReadingMode(request),
          },
        });

        await appendDialogTurns(user.id, paperKey, [
          { role: 'user', content: request.prompt, createdAt: nowForTranslatedPipeline, readingMode: getReadingMode(request), userPromptEnglish: translatedPrompt.text },
          {
            role: 'assistant',
            content: memoryResult.result.answerDraft,
            createdAt: nowForTranslatedPipeline,
            model: `${translatedPrompt.model} -> ${memoryResult.model}`,
            routedBy: 'cheap-context',
            inputTokens: memoryInputTokens,
            outputTokens: memoryOutputTokens,
            readingMode: getReadingMode(request),
            answerChinese: memoryResult.result.answerDraft,
          },
        ]);
        await appendSharedPaperDialogTurns(paperKey, [
          {
            role: 'user',
            content: request.prompt,
            createdAt: nowForTranslatedPipeline,
            readingMode: getReadingMode(request),
            modePrompt: request.modePrompt,
            userPromptEnglish: translatedPrompt.text,
          },
          {
            role: 'assistant',
            content: memoryResult.result.answerDraft,
            createdAt: nowForTranslatedPipeline,
            model: `${translatedPrompt.model} -> ${memoryResult.model}`,
            routedBy: 'cheap-context',
            inputTokens: memoryInputTokens,
            outputTokens: memoryOutputTokens,
            readingMode: getReadingMode(request),
            modePrompt: request.modePrompt,
            userPromptEnglish: translatedPrompt.text,
            answerChinese: memoryResult.result.answerDraft,
          },
        ]);

        return c.json({
          answer: memoryResult.result.answerDraft,
          citations: [],
          sources: [],
          scope: request.scope,
          paperId: request.paperId,
          routedBy: 'cheap-context',
          contextSummary: memoryResult.result.contextSummary,
          translatedPrompt: translatedPrompt.text,
          usage: {
            inputTokens: memoryInputTokens,
            outputTokens: memoryOutputTokens,
            billableTokens,
          },
          tokenAccount,
        });
      }

      const expensiveSystemPrompt = buildReaderSystemPrompt(true, false, request.modePrompt, 'english');
      const expensiveContext = [
        cachedSummary ? `Cached paper brief:\n${cachedSummary.slice(0, 12000)}` : null,
        memoryResult.result.contextSummary ? `Cheap retrieval context:\n${memoryResult.result.contextSummary}` : null,
        externalEvaluations.length ? `External evaluations by other papers:\n${formatExternalReferenceEvaluations(externalEvaluations).slice(0, 12000)}` : null,
      ]
        .filter(Boolean)
        .join('\n\n');
      const expensiveTranslatedResult = await askClaude(
        {
          ...request,
          prompt: memoryResult.result.expensivePrompt?.trim() || translatedPrompt.text,
          paperContextSummary: expensiveContext,
          conversationHistory: [],
        },
        selectExpensiveReaderModel(),
        'english',
      );
      const translatedAnswer = await translateReaderAnswerToChinese(expensiveTranslatedResult.answer, request);
      const translatedInputTokens = memoryInputTokens + expensiveTranslatedResult.inputTokens + translatedAnswer.inputTokens;
      const translatedOutputTokens = memoryOutputTokens + expensiveTranslatedResult.outputTokens + translatedAnswer.outputTokens;
      const translatedBillableTokens =
        getBillableTokens(memoryInputTokens, memoryOutputTokens, memoryResult.model) +
        getBillableTokens(expensiveTranslatedResult.inputTokens, expensiveTranslatedResult.outputTokens, expensiveTranslatedResult.model) +
        getBillableTokens(translatedAnswer.inputTokens, translatedAnswer.outputTokens, translatedAnswer.model);
      const translatedTokenAccount = await recordUserTokenUsage({
        userId: user.id,
        paperId: request.paperId,
        action: 'ask:expensive-reader',
        model: `${translatedPrompt.model} -> ${memoryResult.model} -> ${expensiveTranslatedResult.model} -> ${translatedAnswer.model}`,
        inputTokens: translatedInputTokens,
        outputTokens: translatedOutputTokens,
        billableTokens: translatedBillableTokens,
        metadata: {
          routedBy: 'expensive-reader',
          readingMode: getReadingMode(request),
          expensiveModel: expensiveTranslatedResult.model,
        },
      });

      await appendDialogTurns(user.id, paperKey, [
        { role: 'user', content: request.prompt, createdAt: nowForTranslatedPipeline, readingMode: getReadingMode(request), userPromptEnglish: translatedPrompt.text },
        {
          role: 'assistant',
          content: translatedAnswer.text,
          createdAt: nowForTranslatedPipeline,
          model: `${translatedPrompt.model} -> ${expensiveTranslatedResult.model} -> ${translatedAnswer.model}`,
          routedBy: 'expensive-reader',
          inputTokens: translatedInputTokens,
          outputTokens: translatedOutputTokens,
          readingMode: getReadingMode(request),
          modePrompt: request.modePrompt,
          systemPrompt: expensiveSystemPrompt,
          userPromptEnglish: memoryResult.result.expensivePrompt?.trim() || translatedPrompt.text,
          answerEnglish: expensiveTranslatedResult.answer,
          answerChinese: translatedAnswer.text,
        },
      ]);
      await appendSharedPaperDialogTurns(paperKey, [
        {
          role: 'user',
          content: request.prompt,
          createdAt: nowForTranslatedPipeline,
          readingMode: getReadingMode(request),
          modePrompt: request.modePrompt,
          systemPrompt: expensiveSystemPrompt,
          userPromptEnglish: memoryResult.result.expensivePrompt?.trim() || translatedPrompt.text,
        },
        {
          role: 'assistant',
          content: translatedAnswer.text,
          createdAt: nowForTranslatedPipeline,
          model: `${translatedPrompt.model} -> ${memoryResult.model} -> ${expensiveTranslatedResult.model} -> ${translatedAnswer.model}`,
          routedBy: 'expensive-reader',
          inputTokens: translatedInputTokens,
          outputTokens: translatedOutputTokens,
          readingMode: getReadingMode(request),
          modePrompt: request.modePrompt,
          systemPrompt: expensiveSystemPrompt,
          userPromptEnglish: memoryResult.result.expensivePrompt?.trim() || translatedPrompt.text,
          answerEnglish: expensiveTranslatedResult.answer,
          answerChinese: translatedAnswer.text,
        },
      ]);

      return c.json({
        answer: translatedAnswer.text,
        citations: [],
        sources: expensiveTranslatedResult.webSearchResults.map((item) => ({
          title: item.title,
          url: item.url,
          publishedDate: item.publishedDate,
        })),
        scope: request.scope,
        paperId: request.paperId,
        routedBy: 'expensive-reader',
        translatedPrompt: translatedPrompt.text,
        usage: {
          inputTokens: translatedInputTokens,
          outputTokens: translatedOutputTokens,
          billableTokens: translatedBillableTokens,
        },
        tokenAccount: translatedTokenAccount,
      });
      let triage;

      try {
        triage = await triageWithCheapModel(request, cachedSummary, storedHistory);
      } catch (caughtError: unknown) {
        const caughtRecord = caughtError as { message?: unknown };
        const message = typeof caughtRecord.message === 'string' ? caughtRecord.message : 'Cheap triage failed.';
        triage = {
          result: {
            sufficient: false,
            contextSummary: '',
            expensivePrompt: `${request.prompt}\n\n低成本上下文检索失败：${message}`,
          },
          model: 'cheap-triage-failed',
          inputTokens: 0,
          outputTokens: 0,
        };
      }
      const now = new Date().toISOString();

      if (triage.result.sufficient && triage.result.answerDraft?.trim()) {
        await appendDialogTurns(user.id, paperKey, [
          { role: 'user', content: request.prompt, createdAt: now },
          {
            role: 'assistant',
            content: triage.result.answerDraft,
            createdAt: now,
            model: triage.model,
            routedBy: 'cheap-context',
            inputTokens: triage.inputTokens,
            outputTokens: triage.outputTokens,
          },
        ]);

        return c.json({
          answer: triage.result.answerDraft,
          citations: [],
          sources: [],
          scope: request.scope,
          paperId: request.paperId,
          routedBy: 'cheap-context',
          contextSummary: triage.result.contextSummary,
          usage: { inputTokens: triage.inputTokens, outputTokens: triage.outputTokens },
        });
      }

      const expensiveResult = await askClaude(
        {
          ...request,
          prompt: triage.result.expensivePrompt?.trim() || request.prompt,
          paperContextSummary: [cachedSummary, triage.result.contextSummary, request.paperContextSummary].filter(Boolean).join('\n\n'),
          conversationHistory: storedHistory.slice(-8).map((turn) => ({ role: turn.role, content: turn.content })),
        },
        selectExpensiveReaderModel(),
      );

      await appendDialogTurns(user.id, paperKey, [
        { role: 'user', content: request.prompt, createdAt: now },
        {
          role: 'assistant',
          content: expensiveResult.answer,
          createdAt: now,
          model: expensiveResult.model,
          routedBy: 'expensive-reader',
          inputTokens: triage.inputTokens + expensiveResult.inputTokens,
          outputTokens: triage.outputTokens + expensiveResult.outputTokens,
        },
      ]);

      return c.json({
        answer: expensiveResult.answer,
        citations: [],
        sources: expensiveResult.webSearchResults.map((item) => ({
          title: item.title,
          url: item.url,
          publishedDate: item.publishedDate,
        })),
        scope: request.scope,
        paperId: request.paperId,
        routedBy: 'expensive-reader',
        contextSummary: triage.result.contextSummary,
        usage: {
          inputTokens: triage.inputTokens + expensiveResult.inputTokens,
          outputTokens: triage.outputTokens + expensiveResult.outputTokens,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Reader agent failed.';
      const status = message === 'Not authenticated.' ? 401 : message === 'You do not have access to this PDF.' ? 403 : 500;

      return c.json({ error: 'Reader agent failed.', message }, status);
    }
  })
  .post('/image', zValidator('json', imageRequestSchema), async (c) => {
    const request = c.req.valid('json');

    try {
      const result = await generateImage(request);

      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Image generation failed.';

      return c.json({ error: 'Image generation failed.', message }, 500);
    }
  })
  .post('/summarize', zValidator('json', readerRequestSchema), async (c) => {
    const request = c.req.valid('json');

    try {
      const { user } = await requirePaperAccess(c, request.pdfUrl);
      const storagePath = resolveUploadedPdfStoragePath(request.pdfUrl);
      const summaryStoragePath = getPaperSummaryStoragePath(request, storagePath);
      const cachedSummary = await downloadTextIfExists(summaryStoragePath);

      console.log('[reader-agent:summarize] request', {
        paperId: request.paperId,
        title: request.title,
        hasCachedSummary: Boolean(cachedSummary?.trim()),
        summaryStoragePath,
        activeJob: getSummaryJobSnapshot(summaryJobs.get(summaryStoragePath)),
      });

      if (cachedSummary?.trim()) {
        let freshness;

        try {
          freshness = await checkSummaryFreshnessWithCheapModel(request, cachedSummary);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Cheap summary freshness check failed.';

          console.error('[reader-agent:summarize] cheap freshness check failed; reusing cached summary', {
            paperId: request.paperId,
            message,
          });

          return c.json({
            summary: cachedSummary,
            cached: true,
            scope: request.scope,
            paperId: request.paperId,
            summaryFreshness: {
              fresh: true,
              reason: `Freshness check failed, reused saved summary: ${message}`,
              model: 'cheap-freshness-failed',
              inputTokens: 0,
              outputTokens: 0,
            },
          });
        }

        if (freshness.result.fresh) {
          const billableTokens = getBillableTokens(freshness.inputTokens, freshness.outputTokens, freshness.model);
          const tokenAccount = await recordUserTokenUsage({
            userId: user.id,
            paperId: request.paperId,
            action: 'summary:freshness-check',
            model: freshness.model,
            inputTokens: freshness.inputTokens,
            outputTokens: freshness.outputTokens,
            billableTokens,
            metadata: {
              reusedCachedSummary: true,
              summaryStoragePath,
              reason: freshness.result.reason,
            },
          });

          console.log('[reader-agent:summarize] cheap freshness check passed; reusing cached summary', {
            paperId: request.paperId,
            model: freshness.model,
            inputTokens: freshness.inputTokens,
            outputTokens: freshness.outputTokens,
            billableTokens,
            reason: freshness.result.reason,
          });

          return c.json({
            summary: cachedSummary,
            cached: true,
            scope: request.scope,
            paperId: request.paperId,
            summaryFreshness: {
              ...freshness.result,
              model: freshness.model,
              inputTokens: freshness.inputTokens,
              outputTokens: freshness.outputTokens,
              billableTokens,
            },
            tokenAccount,
          });
        }

        console.log('[reader-agent:summarize] cheap freshness check failed; refreshing summary with expensive model', {
          paperId: request.paperId,
          model: freshness.model,
          inputTokens: freshness.inputTokens,
          outputTokens: freshness.outputTokens,
          reason: freshness.result.reason,
        });

        const job = startSummaryGenerationJob(
          {
            ...request,
            prompt: freshness.result.improvementPrompt?.trim() || request.prompt,
          },
          summaryStoragePath,
          user.id,
          { inputTokens: freshness.inputTokens, outputTokens: freshness.outputTokens },
        );

        console.log('[reader-agent:summarize] returning processing response for refresh', {
          paperId: request.paperId,
          summaryStoragePath,
          job,
        });

        return c.json({
          summary: cachedSummary,
          cached: true,
          refreshed: true,
          refreshing: true,
          processing: true,
          jobStarted: job.started,
          jobId: job.jobId,
          job: job.job,
          retryAfterSeconds: 10,
          scope: request.scope,
          paperId: request.paperId,
          summaryFreshness: {
            ...freshness.result,
            model: freshness.model,
            inputTokens: freshness.inputTokens,
            outputTokens: freshness.outputTokens,
          },
        });

        const result = await askClaude({
          ...request,
          scope: 'whole-paper',
          prompt: request.prompt,
          paperContextSummary: '',
          conversationHistory: [],
        }, selectExpensiveReaderModel(), 'english');
        const translatedSummary = await translateReaderAnswerToChinese(result.answer, request);
        const summary = translatedSummary.text;

        console.log('[reader-agent:summarize] expensive summary generation finished', {
          paperId: request.paperId,
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          saved: Boolean(summary.trim()),
        });

        if (summary.trim()) {
          await uploadTextAsAdmin(summary, summaryStoragePath);
        }

        return c.json({
          summary,
          cached: false,
          refreshed: true,
          scope: request.scope,
          paperId: request.paperId,
          summaryFreshness: {
            ...freshness.result,
            model: freshness.model,
            inputTokens: freshness.inputTokens,
            outputTokens: freshness.outputTokens,
          },
          usage: {
            inputTokens: freshness.inputTokens + result.inputTokens + translatedSummary.inputTokens,
            outputTokens: freshness.outputTokens + result.outputTokens + translatedSummary.outputTokens,
          },
        });
      }

      const job = startSummaryGenerationJob(request, summaryStoragePath, user.id);

      console.log('[reader-agent:summarize] returning processing response for new summary', {
        paperId: request.paperId,
        summaryStoragePath,
        job,
      });

      return c.json({
        summary: '',
        cached: false,
        processing: true,
        jobStarted: job.started,
        jobId: job.jobId,
        job: job.job,
        retryAfterSeconds: 10,
        scope: request.scope,
        paperId: request.paperId,
      }, 202);

      const result = await askClaude({
        ...request,
        scope: 'whole-paper',
        prompt:
          request.prompt ||
          `请用中文生成一份精简的跨学科论文阅读报告。只包含：核心技术机制、关键结构/参数/方法、3-6个最重要数值、证据强度、主要局限。不要逐段复述，不要逐图逐公式展开，不要列可追问索引。输出 Markdown，尽量控制在1000字以内。`,
        paperContextSummary: '',
        conversationHistory: [],
      }, selectExpensiveReaderModel(), 'english');
      const translatedSummary = await translateReaderAnswerToChinese(result.answer, request);
      const summary = translatedSummary.text;

      console.log('[reader-agent:summarize] no cached summary; expensive summary generation finished', {
        paperId: request.paperId,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        saved: Boolean(summary.trim()),
      });

      if (summary.trim()) {
        await uploadTextAsAdmin(summary, summaryStoragePath);
      }

      return c.json({
        summary,
        cached: false,
        scope: request.scope,
        paperId: request.paperId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Paper summary failed.';
      const status = message === 'Not authenticated.' ? 401 : message === 'You do not have access to this PDF.' ? 403 : 500;

      console.error('[reader-agent:summarize] request failed', {
        paperId: request.paperId,
        status,
        message,
      });

      return c.json({ error: 'Paper summary failed.', message }, status);
    }
  })
  .post('/explain-selection', zValidator('json', readerRequestSchema), async (c) => {
    const request = c.req.valid('json');

    return c.json({
      explanation: 'Selected-text explanation placeholder.',
      selectedText: request.selectedText,
      paperId: request.paperId,
    });
  })
  .post('/figure', zValidator('json', readerRequestSchema), async (c) => {
    const request = c.req.valid('json');

    return c.json({
      explanation: 'Figure-aware reader placeholder. Future implementation can attach image crops or rendered PDF regions.',
      figureId: request.figureId,
      paperId: request.paperId,
    });
  });

export default app;
