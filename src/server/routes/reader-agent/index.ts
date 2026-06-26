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
import { getUserFinancialAnalysisAccess, getUserTokenAccount, listFinancialAnalysisReports, recordFinancialAnalysisReport, recordUserTokenUsage } from '@/server/db';
import { getCurrentUser, loadUploadedPapers, sessionCookieName } from '@/server/routes/auth';

type ExtractedPdfPage = {
  pageNumber: number;
  text: string;
};

type ExtractedPdf = {
  pages: ExtractedPdfPage[];
  text: string;
  figureCaptions: string[];
  sourceLanguage: 'chinese' | 'english' | 'mixed';
  extractedChars: number;
  returnedChars: number;
  wasTruncated: boolean;
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

type ReaderMessageContent = Exclude<Anthropic.MessageParam['content'], string>;
type ReaderMessageContentBlock = ReaderMessageContent[number];

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

type StoredFigureReading = {
  answer: string;
  createdAt: string;
  model?: string;
  pageNumbers: number[];
  inputTokens?: number;
  outputTokens?: number;
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

type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
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

type FinancialStockArchiveEntry = {
  id: string;
  createdAt: string;
  question: string;
  answer: string;
  model: string;
  materialNames: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    baseBillableTokens: number;
    billableTokens: number;
    billingMultiplier: number;
  };
};

type PaperReadingMode = 'quality' | 'detailed' | 'simple' | 'reviewer' | 'reader';

const MAX_EXTRACTED_TEXT_CHARS = 600_000;
const MAX_DIRECT_READER_TEXT_CHARS = 140_000;
const MAX_RETRIEVED_READER_TEXT_CHARS = 80_000;
const MIN_PROMPT_CACHE_TEXT_CHARS = 4_000;
const READER_RETRIEVAL_TOP_PAGES = 10;
const MAX_FIGURE_CAPTIONS = 40;
const MAX_PAGE_IMAGES = 6;
const PDF_RENDER_SCALE = 2;
const ESTIMATED_IMAGE_TOKENS_PER_RENDERED_PAGE = 2500;
const WRITING_BILLING_MULTIPLIER = 1.5;
const FINANCIAL_ANALYSIS_BILLING_MULTIPLIER = 3;

const readerRequestSchema = z.object({
  paperId: z.string().min(1),
  prompt: z.string().min(1),
  scope: z.enum(['whole-paper', 'current-page', 'selected-text', 'figure']),
  selectedText: z.string().optional(),
  pageNumber: z.number().optional(),
  pageNumbers: z.array(z.number().int().positive()).max(MAX_PAGE_IMAGES).optional(),
  figureId: z.string().optional(),
  model: z.string().optional(),
  pdfUrl: z.string().optional(),
  title: z.string().optional(),
  authors: z.string().optional(),
  journal: z.string().optional(),
  year: z.string().optional(),
  paperContextSummary: z.string().optional(),
  readingMode: z.enum(['quality', 'detailed', 'simple', 'reviewer', 'reader']).optional(),
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

const financialAnalysisFileSchema = z.object({
  name: z.string().min(1).max(240),
  storagePath: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().nonnegative().optional(),
  url: z.string().url().optional(),
});

const financialAnalysisRequestSchema = z.object({
  topic: z.string().trim().max(1000).optional(),
  files: z.array(financialAnalysisFileSchema).min(1).max(12),
  stock: z.object({
    name: z.string().trim().min(1).max(80),
    code: z.string().trim().min(1).max(24),
    market: z.enum(['A', 'US', 'HK', 'FX']).optional(),
  }),
  analysisMode: z.enum(['quality', 'normal']).optional(),
  conversationHistory: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      }),
    )
    .optional(),
  model: z.string().optional(),
});

const stockWatchlistItemSchema = z.object({
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().min(1).max(24),
  market: z.enum(['A', 'US', 'HK', 'FX']).optional(),
});

const stockQuotesRequestSchema = z.object({
  watchlist: z.array(stockWatchlistItemSchema).min(1).max(80),
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

const writingPaperSchema = z.object({
  paperId: z.string().min(1),
  title: z.string().min(1),
  authors: z.string().optional(),
  journal: z.string().optional(),
  year: z.string().optional(),
  pdfUrl: z.string().optional(),
  filePath: z.string().optional(),
});

const writingArticleSchema = z.object({
  topic: z.string().min(1),
  storagePath: z.string().min(1),
  outputLanguage: z.enum(['chinese', 'english']).optional(),
  kind: z.enum(['introduction', 'follow-up']).optional(),
});

const writingBaseRequestSchema = z.object({
  topic: z.string().trim().min(2).max(500),
  outputLanguage: z.enum(['chinese', 'english']),
  selectedPapers: z.array(writingPaperSchema).max(20).default([]),
  selectedArticles: z.array(writingArticleSchema).max(10).default([]),
});

const writingRequestSchema = writingBaseRequestSchema.refine((request) => request.selectedPapers.length > 0 || request.selectedArticles.length > 0, {
  message: 'Select at least one paper or article.',
  path: ['selectedPapers'],
});

const writingFollowUpRequestSchema = writingBaseRequestSchema.extend({
  question: z.string().trim().min(1).max(1000),
  currentDraft: z.string().trim().min(1).max(60000),
}).refine((request) => request.selectedPapers.length > 0 || request.selectedArticles.length > 0, {
  message: 'Select at least one paper or article.',
  path: ['selectedPapers'],
});

const writingResultPathSchema = z.object({
  storagePath: z.string().min(1),
});

const metadataRequestSchema = z.object({
  pdfUrl: z.string().min(1),
  fallbackTitle: z.string().optional(),
});

const TAVILY_API_URL = 'https://api.tavily.com/search';
const TAVILY_RESULT_COUNT = 5;

const shouldUseWebSearch = (prompt: string) => /\b(news|latest|recent|today|current|now|breaking|this week|this month|2026|2025)\b|新闻|最新|最近|今天|当前|现在|实时|热点|头条/i.test(prompt);

const extractFigureCaptions = (text: string) => {
  const captionPattern = /(?:^|\n)\s*(?:fig(?:ure)?\.?|table\.?)\s*\d+[\s\S]{0,600}?(?=\n\s*(?:fig(?:ure)?\.?|table\.?)\s*\d+|\n\s*(?:references|acknowledg|appendix)\b|$)/gi;

  return Array.from(text.matchAll(captionPattern))
    .map((match) => match[0].replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, MAX_FIGURE_CAPTIONS);
};

const detectTextLanguage = (text: string): ExtractedPdf['sourceLanguage'] => {
  const sample = text.slice(0, 80_000);
  const cjkChars = sample.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const latinWords = sample.match(/[A-Za-z]+(?:['-][A-Za-z]+)?/g)?.length ?? 0;

  if (cjkChars >= 500 && cjkChars > latinWords * 1.2) return 'chinese';
  if (cjkChars >= 300 && latinWords >= 300) return 'mixed';
  return 'english';
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

  const fullText = pages.map((page) => `[Page ${page.pageNumber}]\n${page.text}`).join('\n\n');
  const wasTruncated = fullText.length > MAX_EXTRACTED_TEXT_CHARS;
  const text = wasTruncated ? `${fullText.slice(0, MAX_EXTRACTED_TEXT_CHARS)}\n\n[PDF text is very long; direct-reader context was truncated. Chunked summary still uses all extracted pages.]` : fullText;
  const figureCaptions = extractFigureCaptions(fullText);
  const sourceLanguage = detectTextLanguage(fullText);

  console.log('[reader-agent:pdf] text extraction finished', {
    localPdfPath,
    durationMs: Date.now() - startedAt,
    pagesWithText: pages.length,
    extractedChars: fullText.length,
    returnedChars: text.length,
    sourceLanguage,
    wasTruncated,
    figureCaptions: figureCaptions.length,
  });

  return {
    pages,
    text,
    figureCaptions,
    sourceLanguage,
    extractedChars: fullText.length,
    returnedChars: text.length,
    wasTruncated,
  };
};

const detectPdfLanguageFromTempFile = async (localPdfPath: string, maxPages = 6): Promise<ExtractedPdf['sourceLanguage']> => {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await fs.readFile(localPdfPath));
  const pdf = await pdfjs.getDocument(getPdfDocumentOptions(data)).promise;
  const pageTexts: string[] = [];

  for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, maxPages); pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (text) pageTexts.push(text);
  }

  return detectTextLanguage(pageTexts.join('\n\n'));
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

const assertUserStorageAccess = (user: { id: string; email: string }, storagePath: string) => {
  if (!storagePath || storagePath.includes('..') || !isPendingUserUpload(user, storagePath)) {
    throw new Error('You do not have access to this file.');
  }
};

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

const detectSourceLanguageForAsk = async (request: z.infer<typeof readerRequestSchema>, storagePath: string | null): Promise<ExtractedPdf['sourceLanguage']> => {
  const selectedTextLanguage = request.selectedText?.trim() ? detectTextLanguage(request.selectedText) : null;

  if (selectedTextLanguage === 'chinese') return 'chinese';
  if (!storagePath) return selectedTextLanguage ?? 'english';

  const tempPdf = await materializePdfToTempFile(storagePath);

  try {
    return await detectPdfLanguageFromTempFile(tempPdf.localPdfPath);
  } catch (error) {
    console.warn('[reader-agent:ask] source language detection failed; using translation pipeline', {
      paperId: request.paperId,
      message: error instanceof Error ? error.message : 'Unknown language detection error.',
    });
    return selectedTextLanguage ?? 'english';
  } finally {
    await fs.rm(tempPdf.outputDir, { recursive: true, force: true });
  }
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

const getReadingMode = (request: Pick<z.infer<typeof readerRequestSchema>, 'readingMode'>): PaperReadingMode => {
  if (request.readingMode === 'quality' || request.readingMode === 'detailed' || request.readingMode === 'simple') return request.readingMode;
  if (request.readingMode === 'reader') return 'simple';

  return 'detailed';
};

const isQualityReadingMode = (request: Pick<z.infer<typeof readerRequestSchema>, 'readingMode'>) => getReadingMode(request) === 'quality';

const getSummaryDetailMode = (request: Pick<z.infer<typeof readerRequestSchema>, 'detailedReport'>) => request.detailedReport === true ? 'detailed' : 'brief';

const getPaperSummaryStoragePath = (request: z.infer<typeof readerRequestSchema>, pdfStoragePath?: string | null) =>
  `paper-cache/${getPaperIdentitySlug(request)}/${pdfStoragePath ? 'uploaded' : 'sample'}.reader-summary.${getReadingMode(request)}.${getSummaryDetailMode(request)}.review-v5.md`;

const normalizeRequestedPageNumbers = (pageNumbers?: number[], pageNumber?: number) =>
  Array.from(new Set((pageNumbers?.length ? pageNumbers : pageNumber ? [pageNumber] : []).filter((value) => Number.isInteger(value) && value > 0)))
    .sort((left, right) => left - right)
    .slice(0, MAX_PAGE_IMAGES);

const getFigureReadingStoragePath = (request: z.infer<typeof readerRequestSchema>) => {
  const pageNumbers = normalizeRequestedPageNumbers(request.pageNumbers, request.pageNumber);
  const pageKey = pageNumbers.length ? pageNumbers.join('-') : 'auto';

  return `paper-cache/${getPaperIdentitySlug(request)}/figure-reading.pages-${pageKey}.${getReadingMode(request)}.${getSummaryDetailMode(request)}.v1.md`;
};

const getPaperDialogHistoryPath = (userId: string, paperKey: string) => `user-paper-history/${userId}/${paperKey}.md`;

const getSharedPaperDialogHistoryPath = (paperKey: string) => `paper-cache/${paperKey}/reader-dialog.shared-v1.md`;

const getReferenceExternalEvaluationsPath = (referenceKey: string) => `paper-cache/${referenceKey}/external-reference-evaluations.v1.md`;

const getSourcePaperReferenceEvaluationsPath = (sourcePaperKey: string) => `paper-cache/${sourcePaperKey}/reference-evaluations.introduction.v1.md`;

const cleanFinancialStockKey = (value: string) =>
  value
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);

const getFinancialStockArchivePath = (userId: string, stock: { name: string; code: string }) => {
  const stockKey = cleanFinancialStockKey(`${stock.name}-${stock.code}`) || cleanFinancialStockKey(stock.code) || 'stock';

  return `user-financial-analysis/${userId}/${stockKey}.md`;
};

const getFinancialStockDialogHistoryPath = (userId: string, stock: { name: string; code: string }) => {
  const stockKey = cleanFinancialStockKey(`${stock.name}-${stock.code}`) || cleanFinancialStockKey(stock.code) || 'stock';

  return `user-financial-analysis/${userId}/${stockKey}.chat.md`;
};

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

const loadFinancialStockArchive = async (userId: string, stock: { name: string; code: string }): Promise<FinancialStockArchiveEntry[]> => {
  const content = await downloadTextIfExists(getFinancialStockArchivePath(userId, stock));
  if (!content) return [];

  try {
    const parsed = parseJsonBlock(content);

    return Array.isArray(parsed)
      ? parsed
          .filter((entry): entry is FinancialStockArchiveEntry =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof entry.id === 'string' &&
            typeof entry.createdAt === 'string' &&
            typeof entry.question === 'string' &&
            typeof entry.answer === 'string',
          )
          .slice(-30)
      : [];
  } catch {
    return [];
  }
};

const saveFinancialStockArchive = async (userId: string, stock: { name: string; code: string }, entries: FinancialStockArchiveEntry[]) => {
  const nextEntries = entries.slice(-60);
  const title = `${stock.name} ${stock.code}`.trim();

  await uploadTextAsAdmin(
    `# Financial analysis archive: ${title}\n\n\`\`\`json\n${JSON.stringify(nextEntries, null, 2)}\n\`\`\`\n`,
    getFinancialStockArchivePath(userId, stock),
  );

  return nextEntries;
};

const appendFinancialStockArchive = async (userId: string, stock: { name: string; code: string }, entry: FinancialStockArchiveEntry) => {
  const currentEntries = await loadFinancialStockArchive(userId, stock);

  return saveFinancialStockArchive(userId, stock, [...currentEntries, entry]);
};

const formatFinancialStockArchiveContext = (entries: FinancialStockArchiveEntry[]) =>
  entries
    .slice(-8)
    .map((entry, index) => `历史分析 ${index + 1}（${entry.createdAt}）\n问题：${entry.question}\n回答摘录：${entry.answer.slice(0, 5000)}`)
    .join('\n\n');

const loadFinancialDialogHistory = async (userId: string, stock: { name: string; code: string }): Promise<StoredDialogTurn[]> => {
  const content = await downloadTextIfExists(getFinancialStockDialogHistoryPath(userId, stock));
  if (!content) return [];

  try {
    const parsed = parseJsonBlock(content);

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

const saveFinancialDialogHistory = async (userId: string, stock: { name: string; code: string }, turns: StoredDialogTurn[]) => {
  const nextTurns = turns.slice(-80);
  const title = `${stock.name} ${stock.code}`.trim();

  await uploadTextAsAdmin(
    `# Financial dialog history: ${title}\n\n\`\`\`json\n${JSON.stringify(nextTurns, null, 2)}\n\`\`\`\n`,
    getFinancialStockDialogHistoryPath(userId, stock),
  );

  return nextTurns;
};

const appendFinancialDialogTurns = async (userId: string, stock: { name: string; code: string }, turns: StoredDialogTurn[]) => {
  const currentTurns = await loadFinancialDialogHistory(userId, stock);

  return saveFinancialDialogHistory(userId, stock, [...currentTurns, ...turns]);
};

const loadFigureReadingIfExists = async (filePath: string): Promise<StoredFigureReading | null> => {
  const content = await downloadTextIfExists(filePath);
  if (!content) return null;

  try {
    const parsed = parseJsonBlock(content);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.answer === 'string' &&
      Array.isArray(parsed.pageNumbers)
    ) {
      return parsed as StoredFigureReading;
    }
  } catch {
    // Fall back to the raw markdown body below.
  }

  return {
    answer: content,
    createdAt: '',
    pageNumbers: [],
  };
};

const saveFigureReading = async (filePath: string, reading: StoredFigureReading) => {
  await uploadTextAsAdmin(
    `# Figure reading result\n\n\`\`\`json\n${JSON.stringify(reading, null, 2)}\n\`\`\`\n`,
    filePath,
  );
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
    ?.split(/\s*(?:,|;|\band\b|&)\s*/i)
    .map((author) => author.replace(/\d+|\*|†|‡|§/g, '').trim())
    .filter(Boolean)
    .slice(0, 2) ?? [];

const cleanCitationAuthor = (author: string) => author.replace(/\d+|\*|†|‡|§/g, '').replace(/\s+/g, ' ').trim();

const isInvalidCitationAuthor = (author: string) => {
  const normalized = author.toLowerCase();
  const initialCount = author.match(/\b[A-Z]\./g)?.length ?? 0;
  const wordCount = author.split(/\s+/).filter(Boolean).length;

  return (
    !author ||
    /\b(fig(?:ure)?|table|abstract|keywords?|journal|homepage|conference|proceedings|transactions|vol\.?|university|department|institute|school|supported|grant|received|accepted|revised|corresponding|email|doi|www|http|ieee|nips|neurips)\b/i.test(author) ||
    (initialCount >= 4 && wordCount >= 5) ||
    (wordCount > 6 && !/[\u3400-\u9fff]/.test(author)) ||
    normalized === 'uploaded paper'
  );
};

const parseCitationAuthors = (value?: string) => {
  const normalized = normalizeMetadataText(value);
  if (!normalized) return [];

  const normalizeList = (authors: string[]) => authors.map(cleanCitationAuthor).filter((author) => Boolean(author) && !isInvalidCitationAuthor(author));
  if (/;|\band\b|&/i.test(normalized)) return normalizeList(normalized.split(/\s*(?:;|\band\b|&)\s*/i));

  const commaParts = normalized.split(/\s*,\s*/).filter(Boolean);
  if (commaParts.length === 2 && /^[A-Z](?:\.?\s*[A-Z])*\.?$/i.test(commaParts[1])) return normalizeList([normalized]);
  if (commaParts.length > 2 && commaParts.length % 2 === 0 && commaParts.every((part, index) => index % 2 === 0 || /^[A-Z](?:\.?\s*[A-Z])*\.?$/i.test(part))) {
    const authors: string[] = [];
    for (let index = 0; index < commaParts.length; index += 2) authors.push(`${commaParts[index]}, ${commaParts[index + 1]}`);

    return normalizeList(authors);
  }

  return normalizeList(commaParts.length > 1 ? commaParts : [normalized]);
};

const formatIeeeAuthorName = (author: string) => {
  const cleanAuthor = author.replace(/\.$/, '').trim();
  if (!cleanAuthor || /\bet\s+al\.?$/i.test(cleanAuthor) || /[\u3400-\u9fff]/.test(cleanAuthor)) return cleanAuthor;
  if (/^[A-Z](?:\.\s*)+[A-Za-z' -]+$/.test(cleanAuthor)) return cleanAuthor;

  const commaMatch = cleanAuthor.match(/^([^,]+),\s*(.+)$/);
  const nameParts = commaMatch ? `${commaMatch[2]} ${commaMatch[1]}`.split(/\s+/) : cleanAuthor.split(/\s+/);
  if (nameParts.length < 2) return cleanAuthor;

  const surname = nameParts[nameParts.length - 1];
  const initials = nameParts
    .slice(0, -1)
    .map((part) => part.match(/[A-Za-z]/)?.[0]?.toUpperCase())
    .filter(Boolean)
    .map((initial) => `${initial}.`)
    .join(' ');

  return initials ? `${initials} ${surname}` : cleanAuthor;
};

const joinIeeeAuthors = (authors: string[]) => {
  if (!authors.length) return '';
  const formattedAuthors = authors.map(formatIeeeAuthorName).filter(Boolean);
  if (!formattedAuthors.length) return '';
  if (formattedAuthors.length > 6) return `${formattedAuthors[0]} et al.`;
  if (formattedAuthors.length === 1) return formattedAuthors[0];
  if (formattedAuthors.length === 2) return `${formattedAuthors[0]} and ${formattedAuthors[1]}`;

  return `${formattedAuthors.slice(0, -1).join(', ')}, and ${formattedAuthors[formattedAuthors.length - 1]}`;
};

const trimCitationField = (value?: string) => normalizeMetadataText(value)?.replace(/[.。]+$/, '');

const cleanCitationVenue = (value?: string) => {
  const venue = trimCitationField(value);
  if (!venue) return undefined;
  if (/^(ieee|acm|journal homepage:?|homepage:?)$/i.test(venue)) return undefined;
  if (/\b(journal homepage|available online|www\.|https?:\/\/|doi:|copyright|all rights reserved)\b/i.test(venue)) return undefined;
  if (/^(this work was supported|manuscript received|received|accepted|revised|corresponding author)\b/i.test(venue)) return undefined;
  if (venue.length > 180) return undefined;

  return venue;
};

const isConferenceVenue = (venue: string) => /\b(conference|proceedings|symposium|workshop|congress|nips|neurips|icml|cvpr|acl|emnlp|proc\.)\b/i.test(venue);

const buildIeeeCitation = (request: Pick<z.infer<typeof readerRequestSchema>, 'paperId' | 'title' | 'authors' | 'journal' | 'year'>) => {
  const authors = joinIeeeAuthors(parseCitationAuthors(request.authors));
  const title = trimCitationField(request.title) || trimCitationField(request.paperId) || 'Untitled paper';
  const venue = cleanCitationVenue(request.journal);
  const year = trimCitationField(request.year);
  const publication = venue
    ? `${isConferenceVenue(venue) ? `in Proc. ${venue}` : `*${venue}*`}${year ? `, ${year}` : ''}`
    : year;
  const authorPrefix = authors ? `${authors}, ` : '';

  return `${authorPrefix}"${title},"${publication ? ` ${publication}` : ''}.`;
};

const hasIeeeCitationPreface = (summary: string) => /^##\s*(?:IEEE规范引用格式|IEEE Citation)\b/i.test(summary.trim());

const withIeeeCitationPreface = (
  summary: string,
  request: Pick<z.infer<typeof readerRequestSchema>, 'paperId' | 'title' | 'authors' | 'journal' | 'year'>,
) => {
  const trimmedSummary = summary.trim();
  if (!trimmedSummary) return trimmedSummary;

  const citationPreface = `## IEEE规范引用格式\n\n${buildIeeeCitation(request)}`;
  if (hasIeeeCitationPreface(trimmedSummary)) {
    return trimmedSummary.replace(/^##\s*(?:IEEE规范引用格式|IEEE Citation)\b[\s\S]*?(?=\n---\n)/i, citationPreface);
  }

  return `${citationPreface}\n\n---\n\n${trimmedSummary}`;
};

type WritingSource = {
  citationKey: string;
  paperKey: string;
  paper: z.infer<typeof writingPaperSchema>;
  summary: string;
  ieeeCitation: string;
  externalEvaluations: ReferenceEvaluationRecord[];
};

type WritingArticleSource = {
  topic: string;
  storagePath: string;
  outputLanguage?: 'chinese' | 'english';
  kind?: 'introduction' | 'follow-up';
  content: string;
};

type WritingArticleRecord = {
  id: string;
  topic: string;
  outputLanguage: 'chinese' | 'english';
  storagePath: string;
  savedAt: string;
  kind: 'introduction' | 'follow-up';
  selectedPaperCount: number;
  billableTokens?: number;
};

const sanitizeWritingTitle = (topic: string) => {
  const sanitized = topic
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  return sanitized || 'writing';
};

const formatWritingStorageTimestamp = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;

      return acc;
    }, {});

  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
};

const getWritingStoragePath = (userId: string, topic: string, date = new Date()) =>
  `user-writing/${userId}/${sanitizeWritingTitle(topic)}-${formatWritingStorageTimestamp(date)}.md`;

const getWritingIndexPath = (userId: string) => `user-writing/${userId}/index.md`;

const assertUserWritingStoragePath = (userId: string, storagePath: string) => {
  const normalizedPath = storagePath.replace(/^\/+/, '');
  const prefix = `user-writing/${userId}/`;

  if (!normalizedPath.startsWith(prefix) || normalizedPath.endsWith('/index.md') || normalizedPath.includes('..')) {
    const error = new Error('Invalid writing result path.');
    error.name = 'InvalidWritingResultPathError';
    throw error;
  }

  return normalizedPath;
};

const loadWritingArticleRecords = async (userId: string): Promise<WritingArticleRecord[]> => {
  try {
    const parsed = parseJsonBlock(await downloadTextAsAdmin(getWritingIndexPath(userId)));

    return Array.isArray(parsed)
      ? parsed.filter((record): record is WritingArticleRecord =>
          Boolean(record) &&
          typeof record === 'object' &&
          typeof (record as WritingArticleRecord).id === 'string' &&
          typeof (record as WritingArticleRecord).topic === 'string' &&
          typeof (record as WritingArticleRecord).storagePath === 'string' &&
          typeof (record as WritingArticleRecord).savedAt === 'string',
        )
      : [];
  } catch {
    return [];
  }
};

const saveWritingArticleRecords = async (userId: string, articles: WritingArticleRecord[]) => {
  const deduped = [...new Map(articles.map((article) => [article.storagePath, article])).values()]
    .sort((left, right) => right.savedAt.localeCompare(left.savedAt))
    .slice(0, 300);

  await uploadTextAsAdmin(
    `# Writing articles\n\n\`\`\`json\n${JSON.stringify(deduped, null, 2)}\n\`\`\`\n`,
    getWritingIndexPath(userId),
  );

  return deduped;
};

const appendWritingArticleRecord = async (userId: string, article: WritingArticleRecord) => {
  const currentArticles = await loadWritingArticleRecords(userId);

  return saveWritingArticleRecords(userId, [article, ...currentArticles.filter((currentArticle) => currentArticle.storagePath !== article.storagePath)]);
};

const removeWritingArticleRecord = async (userId: string, storagePath: string) => {
  const normalizedPath = assertUserWritingStoragePath(userId, storagePath);
  const currentArticles = await loadWritingArticleRecords(userId);
  const nextArticles = currentArticles.filter((article) => article.storagePath !== normalizedPath);

  return saveWritingArticleRecords(userId, nextArticles);
};

const extractWritingArticleDraft = (content: string) => {
  const jsonBlockMatch = content.match(/^# .+?\n\n```json\n[\s\S]*?\n```\n\n/);

  return jsonBlockMatch ? content.slice(jsonBlockMatch[0].length).trim() : content.trim();
};

const getWritingPaperRequest = (paper: z.infer<typeof writingPaperSchema>) => ({
  paperId: paper.paperId,
  prompt: 'writing-mode-summary-lookup',
  scope: 'whole-paper' as const,
  pdfUrl: paper.pdfUrl,
  title: paper.title,
  authors: paper.authors,
  journal: paper.journal,
  year: paper.year,
});

const getWritingSummaryCandidates = (paper: z.infer<typeof writingPaperSchema>) => {
  const storagePath = paper.filePath ?? resolveUploadedPdfStoragePath(paper.pdfUrl);
  const baseRequest = getWritingPaperRequest(paper);
  const candidates: string[] = [];

  for (const readingMode of ['reviewer', 'reader'] as const) {
    for (const detailedReport of [false, true]) {
      candidates.push(getPaperSummaryStoragePath({ ...baseRequest, readingMode, detailedReport }, storagePath));
    }
  }

  return [...new Set(candidates)];
};

const loadCachedSummaryForWriting = async (paper: z.infer<typeof writingPaperSchema>) => {
  for (const summaryPath of getWritingSummaryCandidates(paper)) {
    const summary = await downloadTextIfExists(summaryPath);

    if (summary?.trim()) return { summary: withIeeeCitationPreface(summary, getWritingPaperRequest(paper)), summaryPath };
  }

  return null;
};

const loadSelectedWritingArticles = async (userId: string, articles: z.infer<typeof writingArticleSchema>[]): Promise<WritingArticleSource[]> => {
  const indexedArticles = await loadWritingArticleRecords(userId);
  const indexedPaths = new Set(indexedArticles.map((article) => article.storagePath));
  const sources: WritingArticleSource[] = [];

  for (const article of articles) {
    const storagePath = assertUserWritingStoragePath(userId, article.storagePath);
    if (!indexedPaths.has(storagePath)) continue;

    const content = await downloadTextIfExists(storagePath);
    if (!content?.trim()) continue;

    const indexedArticle = indexedArticles.find((item) => item.storagePath === storagePath);
    sources.push({
      topic: indexedArticle?.topic ?? article.topic,
      storagePath,
      outputLanguage: indexedArticle?.outputLanguage ?? article.outputLanguage,
      kind: indexedArticle?.kind ?? article.kind,
      content,
    });
  }

  return sources;
};

const stripGeneratedReferences = (draft: string) => draft.split(/\n#{1,3}\s*(?:References|参考文献|引用文献)\b/i)[0]?.trim() || draft.trim();

const numberWritingCitations = (draft: string, sources: WritingSource[]) => {
  const sourceByKey = new Map(sources.map((source) => [source.citationKey, source]));
  const orderedSources: WritingSource[] = [];
  const seenKeys = new Set<string>();
  const body = stripGeneratedReferences(draft).replace(/\{\{cite:([a-zA-Z0-9_-]+)\}\}/g, (_match, citationKey: string) => {
    const source = sourceByKey.get(citationKey);
    if (!source) return '';

    if (!seenKeys.has(citationKey)) {
      seenKeys.add(citationKey);
      orderedSources.push(source);
    }

    return `[${orderedSources.findIndex((item) => item.citationKey === citationKey) + 1}]`;
  });
  const referenceSources = orderedSources.length ? orderedSources : sources;
  const references = referenceSources.map((source, index) => `[${index + 1}] ${source.ieeeCitation}`);

  return {
    draft: `${body.trim()}\n\n## References\n\n${references.join('\n')}`,
    references,
    citedPaperKeys: referenceSources.map((source) => source.paperKey),
  };
};

const formatWritingExternalEvaluations = (records: ReferenceEvaluationRecord[]) =>
  records
    .slice(0, 8)
    .map((record, index) => {
      const source = [record.sourceTitle, record.sourceJournal, record.sourceYear].filter(Boolean).join(', ') || record.sourcePaperKey;
      const evidence = record.evidenceText ? ` Evidence: ${record.evidenceText}` : '';

      return `${index + 1}. From ${source}: ${record.evaluation}${evidence}`;
    })
    .join('\n');

const extractYear = (text: string) => text.match(/(?:19|20)\d{2}/)?.[0];

const inferMetadataFromText = (text: string, fallbackTitle?: string): PaperMetadata => {
  const lines = text
    .split(/\n+/)
    .map((line) => normalizeMetadataText(line))
    .filter((line): line is string => Boolean(line));
  const title = lines.find((line) => line.length >= 12 && !/^abstract\b/i.test(line)) ?? normalizeMetadataText(fallbackTitle);
  const titleIndex = title ? lines.indexOf(title) : -1;
  const authorLine = titleIndex >= 0 ? lines.slice(titleIndex + 1, titleIndex + 5).find((line) => /,|;|\band\b|&/i.test(line)) : undefined;
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
    ? 'You are SCIReader paper reading assistant. Answer in Chinese. Use provided PDF text, selected text, page screenshots, saved notes, and figure/table captions. Explain methods, equations, figures, contributions, weaknesses, and related work. If the provided paper evidence is insufficient, say so clearly and do not fabricate.'
    : 'You are SCIReader general AI assistant. Answer the user directly in Chinese unless another language is requested. Do not assume paper context is required.';

  return hasWebSearch
    ? `${basePrompt}\nThe user question may involve recent or real-time information. Use provided Tavily web search results first, cite relevant source URLs, and say when results are insufficient or conflicting.`
    : basePrompt;
};

const identityAnswerChinese = '我是论文阅读小助手';
const isIdentityQuestion = (prompt: string) =>
  /(?:你是(?:谁|什么|哪个|哪种|chatgpt|gpt|claude)|你叫(?:什么|啥)|谁(?:做|创造|制造|训练|开发|发明)了你|谁是你的?(?:爸爸|父亲|爹|创造者|制造者|开发者|作者)|who\s+(?:are|r)\s+you|what\s+are\s+you|who\s+(?:made|created|built|trained|developed)\s+you|who\s+is\s+your\s+(?:father|creator|maker|developer)|which\s+(?:model|version)\s+are\s+you|what\s+(?:model|version)\s+are\s+you|are\s+you\s+(?:chatgpt|gpt|claude))/i.test(prompt);

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

const isExpertReviewPrompt = (prompt: string) =>
  /\b(fake innovation|pseudo[-\s]?innovation|novelty|peer review|reviewer|accept|reject|major revision|minor revision|credibility|fabricat|fraud|data quality|paper tier|publication level|top journal|weak paper|opportunistic|审稿|创新性|伪创新|假创新|能不能发|为什么能发|接收|拒稿|大修|小修|可信度|数据造假|造假嫌疑|论文档次|论文水平|期刊档次|灌水|水刊|捡漏|分区|中科院|核心期刊)\b/i.test(prompt);

const selectReaderModel = (request: z.infer<typeof readerRequestSchema>): AnthropicModelSelection => {
  if (request.model) return { model: request.model, target: 'default' };

  const expertModel = process.env.ANTHROPIC_EXPERT_MODEL?.trim() || process.env.ANTHROPIC_EXPENSIVE_MODEL?.trim();
  const readerModel = process.env.ANTHROPIC_READER_MODEL?.trim();
  const textModel = process.env.ANTHROPIC_CHEAP_MODEL?.trim();
  const defaultReaderModel = process.env.ANTHROPIC_MODEL?.trim() || 'gpt-5.4';
  const defaultExpertModel = 'gpt-5.5';

  if (request.scope === 'figure' || isExpertReviewPrompt(request.prompt)) {
    return { model: expertModel || defaultExpertModel, target: 'expensive' };
  }

  if (isProfessionalKnowledgePrompt(request.prompt)) {
    return { model: readerModel || defaultReaderModel, target: readerModel ? 'expensive' : 'default' };
  }

  return { model: textModel || defaultReaderModel, target: textModel ? 'cheap' : 'default' };
};

const selectImageModel = (request: z.infer<typeof imageRequestSchema>): AnthropicModelSelection => {
  if (request.model) return { model: request.model, target: 'default' };

  const expertModel = process.env.ANTHROPIC_EXPERT_MODEL?.trim();
  const defaultModel = process.env.ANTHROPIC_MODEL?.trim() || 'gpt-5.4';

  return { model: expertModel || defaultModel, target: expertModel ? 'expensive' : 'default' };
};

const selectTokenEstimateModel = (request: z.infer<typeof tokenEstimateRequestSchema>): AnthropicModelSelection => {
  if (request.model) return { model: request.model, target: 'default' };

  const defaultModel = process.env.ANTHROPIC_MODEL?.trim() || 'gpt-5.4';

  return { model: defaultModel, target: 'default' };
};

const selectCheapTriageModel = (): AnthropicModelSelection => {
  const textModel = process.env.ANTHROPIC_CHEAP_MODEL?.trim();
  const defaultModel = 'gpt-5.4-mini';

  return { model: textModel || defaultModel, target: 'cheap' };
};

const selectExpensiveReaderModel = (): AnthropicModelSelection => {
  const readerModel = process.env.ANTHROPIC_READER_MODEL?.trim();
  const defaultModel = process.env.ANTHROPIC_MODEL?.trim() || 'gpt-5.4';

  return { model: readerModel || defaultModel, target: readerModel ? 'expensive' : 'default' };
};

const selectExpertReviewModel = (): AnthropicModelSelection => {
  const expertModel = process.env.ANTHROPIC_EXPERT_MODEL?.trim() || process.env.ANTHROPIC_EXPENSIVE_MODEL?.trim();
  const defaultModel = 'gpt-5.5';

  return { model: expertModel || defaultModel, target: 'expensive' };
};

const getModelTokenWeight = (model?: string) => {
  const normalizedModel = model?.toLowerCase() ?? '';

  if (normalizedModel.includes('gpt-5.5')) return 2;
  if (/gpt-5\.4(?!-mini)/.test(normalizedModel)) return 1.5;
  return 1;
};

const billingTokensPerUsdCost = 5_000_000;

const getModelPricePerMillionTokens = (model?: string) => {
  const normalizedModel = model?.toLowerCase() ?? '';

  if (normalizedModel.includes('gpt-5.5')) return { input: 0.15, output: 0.9, cacheRead: 0.015 };
  if (/gpt-5\.4(?!-mini)/.test(normalizedModel)) return { input: 0.075, output: 0.45, cacheRead: 0.0075 };
  return { input: 0.0225, output: 0.135, cacheRead: 0.0022 };
};

const getBillableTokens = (inputTokens: number, outputTokens: number, model?: string, cachedUsage?: Pick<ModelUsage, 'cacheCreationInputTokens' | 'cacheReadInputTokens'>) => {
  const price = getModelPricePerMillionTokens(model);
  const cacheCreationInputTokens = Math.max(0, cachedUsage?.cacheCreationInputTokens ?? 0);
  const cacheReadInputTokens = Math.max(0, cachedUsage?.cacheReadInputTokens ?? 0);
  const inputCost = ((Math.max(0, inputTokens) + cacheCreationInputTokens) / 1_000_000) * price.input;
  const cacheReadCost = (cacheReadInputTokens / 1_000_000) * price.cacheRead;
  const outputCost = (Math.max(0, outputTokens) / 1_000_000) * price.output;

  return Math.ceil((inputCost + cacheReadCost + outputCost) * billingTokensPerUsdCost);
};

const getUsageBillableTokens = (usage: ModelUsage, model?: string) =>
  getBillableTokens(usage.inputTokens, usage.outputTokens, model, {
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
  });

const parseCsvEnv = (value?: string) =>
  new Set((value ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));

const isFinancialAnalysisEnabled = async (user: { id: string; email: string }) => {
  if (process.env.FINANCIAL_ANALYSIS_ENABLED === 'true') return true;

  const enabledUserIds = parseCsvEnv(process.env.FINANCIAL_ANALYSIS_ENABLED_USER_IDS);
  const enabledEmails = parseCsvEnv(process.env.FINANCIAL_ANALYSIS_ENABLED_EMAILS);

  return enabledUserIds.has(user.id.toLowerCase()) || enabledEmails.has(user.email.toLowerCase()) || await getUserFinancialAnalysisAccess(user.id);
};

const insufficientTokenMessage = 'token余额不足，请充值';

const ensurePositiveTokenBalance = async (userId: string) => {
  const tokenAccount = await getUserTokenAccount(userId);

  if (tokenAccount.tokenAvailable < 0) {
    const error = new Error(insufficientTokenMessage);
    error.name = 'InsufficientTokenBalanceError';
    throw error;
  }

  return tokenAccount;
};

const isInsufficientTokenBalanceError = (error: unknown) =>
  error instanceof Error && (error.name === 'InsufficientTokenBalanceError' || error.message === insufficientTokenMessage);

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

  if (!extractedPdf && !request.selectedText) return `${webSearchText}User request:\n${request.prompt}`;

  const pageText = request.pageNumber ? extractedPdf?.pages.find((page) => page.pageNumber === request.pageNumber)?.text : undefined;
  const figureCaptions = extractedPdf?.figureCaptions.length
    ? `\nFigure/table caption candidates:\n${extractedPdf.figureCaptions.map((caption, index) => `${index + 1}. ${caption}`).join('\n')}`
    : '';
  const pdfText = extractedPdf?.text
    ? `\nExtracted PDF text:\n${request.scope === 'current-page' && pageText ? `[Page ${request.pageNumber}]\n${pageText}` : extractedPdf.text}`
    : '\nExtracted PDF text: No full text was extracted. Use selected text if provided; say when evidence is missing.';

  return `Paper title: ${request.title ?? request.paperId}
Request scope: ${request.scope}
${request.selectedText ? `Selected text:\n${request.selectedText}\n` : ''}${figureCaptions}${pdfText}

${webSearchText}User request:
${request.prompt}`;
};

const buildReaderSystemPrompt = (hasPdfContext: boolean, hasWebSearch: boolean, modePrompt?: string, responseLanguage: 'english' | 'chinese' = 'chinese') => {
  const languageInstruction = responseLanguage === 'english'
    ? 'Respond in English. The answer will be translated to Chinese by a separate low-cost model, so keep terminology precise and preserve all numbers, equations, figure/table labels, citations, and Markdown structure. Format inline math as \\(...\\) and display math as $$...$$ so the UI can render it with KaTeX.'
    : 'Respond entirely in Chinese. Preserve important numbers, equations, figure/table labels, citations, and Markdown structure. Format inline math as \\(...\\) and display math as $$...$$ for KaTeX rendering.';
  const nextBasePrompt = hasPdfContext
    ? `${modePrompt?.trim() || 'You are SCIReader, a careful academic paper reading assistant. Prioritize the provided paper content, saved paper notes, selected text, and page images. If the paper does not provide clear evidence, explicitly say that the paper does not provide sufficient information to determine.'}\n\n${languageInstruction}\n\nUse only the provided paper evidence unless the user asks for outside context. Do not fabricate details.`
    : `You are SCIReader's general AI assistant. Answer the user's question directly.\n\n${languageInstruction}`;

  return hasWebSearch
    ? `${nextBasePrompt}\nThe user question involves recent or real-time information. You will receive Tavily Web search results. Prioritize those results, cite relevant source URLs, and state clearly when the search results are insufficient or conflicting.`
    : nextBasePrompt;
};

const addReaderTextBlock = (blocks: ReaderMessageContent, text: string, cacheable = false) => {
  const trimmedText = text.trim();

  if (!trimmedText) return false;

  const shouldCache = cacheable && trimmedText.length >= MIN_PROMPT_CACHE_TEXT_CHARS;
  blocks.push(
    shouldCache
      ? ({ type: 'text', text: trimmedText, cache_control: { type: 'ephemeral' } } as ReaderMessageContentBlock)
      : ({ type: 'text', text: trimmedText } as ReaderMessageContentBlock),
  );

  return shouldCache;
};

const countOccurrences = (text: string, term: string) => {
  if (!term) return 0;

  let count = 0;
  let index = 0;

  while ((index = text.indexOf(term, index)) !== -1) {
    count += 1;
    index += term.length;
  }

  return count;
};

const readerRetrievalStopWords = new Set([
  'about',
  'above',
  'after',
  'again',
  'against',
  'analysis',
  'answer',
  'based',
  'because',
  'before',
  'between',
  'could',
  'detail',
  'does',
  'from',
  'have',
  'into',
  'main',
  'method',
  'paper',
  'please',
  'result',
  'show',
  'study',
  'that',
  'their',
  'there',
  'these',
  'this',
  'what',
  'when',
  'where',
  'which',
  'with',
  'would',
]);

const extractReaderRetrievalTerms = (prompt: string) => {
  const lowerPrompt = prompt.toLowerCase();
  const latinTerms = lowerPrompt.match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  const cjkTerms = lowerPrompt.match(/[\u4e00-\u9fff]{2,}/g) ?? [];

  return Array.from(new Set([...latinTerms, ...cjkTerms])).filter((term) => !readerRetrievalStopWords.has(term) && term.length <= 40);
};

const scorePdfPageForPrompt = (prompt: string, pageText: string, terms: string[]) => {
  const lowerPrompt = prompt.toLowerCase();
  const lowerPageText = pageText.toLowerCase();
  let score = 0;

  for (const term of terms) {
    score += countOccurrences(lowerPageText, term) * Math.min(term.length, 16);
  }

  if (/\b(introduction|related work|background)\b|引言|相关工作|背景/.test(lowerPrompt) && /\b(introduction|related work|background)\b|引言|相关工作|背景/i.test(pageText)) {
    score += 120;
  }

  if (/\b(method|approach|model|algorithm|architecture)\b|方法|模型|算法|结构/.test(lowerPrompt) && /\b(method|approach|model|algorithm|architecture)\b|方法|模型|算法|结构/i.test(pageText)) {
    score += 90;
  }

  if (/\b(result|experiment|evaluation|baseline|ablation)\b|实验|结果|对比|消融/.test(lowerPrompt) && /\b(result|experiment|evaluation|baseline|ablation)\b|实验|结果|对比|消融/i.test(pageText)) {
    score += 90;
  }

  if (/\b(conclusion|discussion|limitation)\b|结论|讨论|局限/.test(lowerPrompt) && /\b(conclusion|discussion|limitation)\b|结论|讨论|局限/i.test(pageText)) {
    score += 100;
  }

  return score;
};

const formatPdfPageText = (page: ExtractedPdfPage) => `[Page ${page.pageNumber}]\n${page.text}`;

const extractVisualNotesFromSummary = (summary?: string, pageNumbers: number[] = []) => {
  const trimmedSummary = summary?.trim();
  if (!trimmedSummary) return '';

  const pagePatterns = pageNumbers.flatMap((pageNumber) => [
    new RegExp(`(?:page|p\\.?|第)\\s*${pageNumber}\\s*(?:页)?`, 'i'),
    new RegExp(`(?:pages|pp\\.?)\\s*${Math.max(1, pageNumber - 1)}\\s*[-–—~～]\\s*${pageNumber + 1}`, 'i'),
  ]);
  const visualPattern = /(?:\bfig(?:ure)?s?\.?\s*\d*|\btable?s?\.?\s*\d*|图\s*\d*|表\s*\d*|图像|图片|截图|曲线|柱状图|热图|流程图|架构图|结构图|示意图|实验结果|消融|对比|可视化|caption|legend|axis|plot|chart|diagram|schematic|visuali[sz]ation|ablation|qualitative)/i;
  const chunks = trimmedSummary
    .split(/\n{2,}|(?<=。)|(?<=；)|(?<=\.)\s+(?=[A-Z])/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const selected: string[] = [];
  let chars = 0;

  for (const chunk of chunks) {
    const isVisual = visualPattern.test(chunk);
    const isPageRelated = pagePatterns.some((pattern) => pattern.test(chunk));

    if (!isVisual && !isPageRelated) continue;
    if (selected.includes(chunk)) continue;

    const remainingChars = 6000 - chars;
    if (remainingChars <= 0) break;

    selected.push(chunk.length > remainingChars ? `${chunk.slice(0, remainingChars)}...` : chunk);
    chars += Math.min(chunk.length, remainingChars);
  }

  return selected.length ? selected.join('\n') : trimmedSummary.slice(0, 2000);
};

const selectRetrievedPdfPages = (prompt: string, pages: ExtractedPdfPage[]) => {
  const terms = extractReaderRetrievalTerms(prompt);
  const scoredPages = pages
    .map((page) => ({
      page,
      score: scorePdfPageForPrompt(prompt, page.text, terms),
    }))
    .sort((left, right) => right.score - left.score);
  const selectedPageNumbers = new Set<number>();

  for (const page of pages.slice(0, 2)) selectedPageNumbers.add(page.pageNumber);
  for (const page of pages.slice(-2)) selectedPageNumbers.add(page.pageNumber);

  for (const scoredPage of scoredPages) {
    if (selectedPageNumbers.size >= READER_RETRIEVAL_TOP_PAGES) break;
    if (scoredPage.score <= 0 && terms.length > 0) continue;
    selectedPageNumbers.add(scoredPage.page.pageNumber);
  }

  if (selectedPageNumbers.size < Math.min(READER_RETRIEVAL_TOP_PAGES, pages.length)) {
    for (const page of pages) {
      if (selectedPageNumbers.size >= Math.min(READER_RETRIEVAL_TOP_PAGES, pages.length)) break;
      selectedPageNumbers.add(page.pageNumber);
    }
  }

  const selectedPages = pages.filter((page) => selectedPageNumbers.has(page.pageNumber));
  const pageTexts: string[] = [];
  let chars = 0;

  for (const page of selectedPages) {
    const text = formatPdfPageText(page);
    const remainingChars = MAX_RETRIEVED_READER_TEXT_CHARS - chars;

    if (remainingChars <= 0) break;

    if (text.length > remainingChars) {
      pageTexts.push(`${text.slice(0, remainingChars)}\n[Page excerpt truncated to fit the retrieval budget.]`);
      chars = MAX_RETRIEVED_READER_TEXT_CHARS;
      break;
    }

    pageTexts.push(text);
    chars += text.length;
  }

  return {
    pageNumbers: selectedPages.map((page) => page.pageNumber),
    text: pageTexts.join('\n\n'),
    terms,
  };
};

const selectReaderPdfContext = (request: z.infer<typeof readerRequestSchema>, extractedPdf?: ExtractedPdf) => {
  if (!extractedPdf?.text.trim()) return null;

  if (request.scope === 'figure' && request.pageNumbers?.length) {
    const requestedPageNumbers = new Set(request.pageNumbers);
    const selectedPages = extractedPdf.pages.filter((page) => requestedPageNumbers.has(page.pageNumber) && page.text.trim());
    const pageTexts: string[] = [];
    let chars = 0;

    for (const page of selectedPages) {
      const text = formatPdfPageText(page);
      const remainingChars = MAX_RETRIEVED_READER_TEXT_CHARS - chars;

      if (remainingChars <= 0) break;

      if (text.length > remainingChars) {
        pageTexts.push(`${text.slice(0, remainingChars)}\n[Page excerpt truncated to fit the visual-reading budget.]`);
        chars = MAX_RETRIEVED_READER_TEXT_CHARS;
        break;
      }

      pageTexts.push(text);
      chars += text.length;
    }

    if (pageTexts.length) {
      return {
        text: `Extracted PDF text from the same pages as the attached screenshots. Use this as textual figure/table description and cross-check it against the images:\n${pageTexts.join('\n\n')}`,
        strategy: `figure-pages-${selectedPages.map((page) => page.pageNumber).join('-')}`,
        pageNumbers: selectedPages.map((page) => page.pageNumber),
        cacheable: chars >= MIN_PROMPT_CACHE_TEXT_CHARS,
      };
    }
  }

  const pageText = request.pageNumber ? extractedPdf.pages.find((page) => page.pageNumber === request.pageNumber) : undefined;

  if ((request.scope === 'current-page' || request.scope === 'figure' || request.scope === 'selected-text') && pageText?.text.trim()) {
    return {
      text: `Extracted PDF text for the current page:\n${formatPdfPageText(pageText)}`,
      strategy: `page-${pageText.pageNumber}`,
      pageNumbers: [pageText.pageNumber],
      cacheable: pageText.text.length >= MIN_PROMPT_CACHE_TEXT_CHARS,
    };
  }

  if (extractedPdf.text.length <= MAX_DIRECT_READER_TEXT_CHARS) {
    return {
      text: `Extracted PDF text:\n${extractedPdf.text}`,
      strategy: 'full-text',
      pageNumbers: extractedPdf.pages.map((page) => page.pageNumber),
      cacheable: true,
    };
  }

  const retrieved = selectRetrievedPdfPages(request.prompt, extractedPdf.pages);

  return {
    text: `Retrieved PDF excerpts for this question. The full extracted paper has ${extractedPdf.extractedChars} characters across ${extractedPdf.pages.length} pages, so this request sends only the most relevant pages plus opening/closing context.\nRetrieved pages: ${retrieved.pageNumbers.join(', ') || 'none'}\nRetrieval terms: ${retrieved.terms.join(', ') || 'none'}\n\n${retrieved.text}`,
    strategy: 'retrieved-pages',
    pageNumbers: retrieved.pageNumbers,
    cacheable: retrieved.text.length >= MIN_PROMPT_CACHE_TEXT_CHARS,
  };
};

const formatConversationHistoryForReaderPrompt = (history?: Array<{ role: 'user' | 'assistant'; content: string }>) => {
  const turns = (history ?? [])
    .slice(-8)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content.slice(0, 3000)}`);

  return turns.length ? `Recent conversation for continuity:\n${turns.join('\n\n')}` : '';
};

const buildReaderPromptContent = (request: z.infer<typeof readerRequestSchema>, extractedPdf?: ExtractedPdf, webSearchResults: TavilySearchResult[] = []) => {
  const blocks: ReaderMessageContent = [];
  const pdfContext = selectReaderPdfContext(request, extractedPdf);
  const visualSummaryNotes = request.scope === 'figure'
    ? extractVisualNotesFromSummary(request.paperContextSummary, normalizeRequestedPageNumbers(request.pageNumbers, request.pageNumber))
    : '';
  const paperContextSummary = request.paperContextSummary?.trim()
    ? `Known paper notes:\n${request.paperContextSummary.trim().slice(0, 12000)}`
    : '';
  const visualNotes = visualSummaryNotes
    ? `Figure/table notes extracted from the previous paper summary:\n${visualSummaryNotes}`
    : '';
  const figureCaptions = extractedPdf?.figureCaptions.length
    ? `Figure/table caption candidates:\n${extractedPdf.figureCaptions.map((caption, index) => `${index + 1}. ${caption}`).join('\n')}`
    : '';
  const visualReadingInstruction = request.scope === 'figure'
    ? 'Visual reading instruction: combine the known paper notes, figure/table captions, same-page extracted text, and the attached page screenshots. Use the text to identify what each figure/table is about, then verify details against the image. If text and image disagree or the screenshot is unclear, say so explicitly.'
    : '';
  const stableHeader = [
    `Paper title: ${request.title ?? request.paperId}`,
    `Request scope: ${request.scope}`,
    visualReadingInstruction,
    visualNotes,
    paperContextSummary,
    figureCaptions,
  ]
    .filter(Boolean)
    .join('\n\n');
  let cacheableBlocks = 0;

  addReaderTextBlock(blocks, stableHeader);

  if (pdfContext) {
    if (addReaderTextBlock(blocks, pdfContext.text, pdfContext.cacheable)) cacheableBlocks += 1;
  } else if (request.selectedText || request.paperContextSummary) {
    addReaderTextBlock(blocks, 'Extracted PDF text: Full text is not available in this request. Use the provided notes or selected text; if evidence is missing, say the paper does not provide sufficient information.');
  }

  const webSearchText = webSearchResults.length ? `Tavily Web search results:\n${formatWebSearchResults(webSearchResults)}` : '';
  const dynamicPrompt = [
    formatConversationHistoryForReaderPrompt(request.conversationHistory),
    request.selectedText ? `Selected text:\n${request.selectedText}` : '',
    webSearchText,
    `User request:\n${request.prompt}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  addReaderTextBlock(blocks, dynamicPrompt);

  return {
    content: blocks,
    cacheableBlocks,
    pdfContextChars: pdfContext?.text.length ?? 0,
    pdfContextStrategy: pdfContext?.strategy ?? 'none',
    pdfContextPages: pdfContext?.pageNumbers ?? [],
  };
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
    ? `\nExtracted PDF text:\n${request.scope === 'current-page' && pageText ? `[Page ${request.pageNumber}]\n${pageText}` : extractedPdf.text.slice(0, MAX_DIRECT_READER_TEXT_CHARS)}${request.scope !== 'current-page' && extractedPdf.text.length > MAX_DIRECT_READER_TEXT_CHARS ? '\n\n[Direct-reader context truncated for this question. Ask for a section/chapter or use the generated summary for full-document coverage.]' : ''}`
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
    ? `\nPDF 提取正文：\n${request.scope === 'current-page' && pageText ? `[第 ${request.pageNumber} 页]\n${pageText}` : extractedPdf.text.slice(0, MAX_DIRECT_READER_TEXT_CHARS)}${request.scope !== 'current-page' && extractedPdf.text.length > MAX_DIRECT_READER_TEXT_CHARS ? '\n\n[本次直接问答的全文上下文已截断。需要全书覆盖时，请使用后台分块总结或指定章节/页码追问。]' : ''}`
    : request.selectedText || request.paperContextSummary
      ? '\nPDF 提取正文：本次未提供完整正文，请基于论文速记或选中文本回答；没有依据时说明未找到�?
      : '';

  if (!paperContextSummary && !figureCaptions && !pdfText && !request.selectedText) {
    return `${webSearchText}用户请求�?{request.prompt}`;
  }

  return `论文标题�?{request.title ?? request.paperId}
请求范围�?{request.scope}
${paperContextSummary}${request.selectedText ? `选中文本：\n${request.selectedText}\n` : ''}${figureCaptions}${pdfText}

${webSearchText}用户请求�?{request.prompt}`;
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
    const requestedPageNumbers = request.pageNumbers?.length
      ? request.pageNumbers
      : request.pageNumber
        ? [request.pageNumber]
        : undefined;

    if (localPdfPath && shouldRenderPageImages) {
      try {
        pageImages = await renderPdfPageImages(localPdfPath, requestedPageNumbers);
      } catch (error) {
        console.error('PDF page rendering failed.', error);
      }
    }

    const modelSelection = forcedModelSelection ?? selectReaderModel(request);
    const client = createAnthropicClient(modelSelection.target);
    const promptContent = buildReaderPromptContent(request, extractedPdf, webSearchResults);
    const content = promptContent.content;
    const finalPromptBlock = content.pop();

    for (const image of pageImages) {
      if (true) {
        content.push({ type: 'text', text: `Below is a rendered screenshot of PDF page ${image.pageNumber}. Use it to interpret figures, tables, equations, and layout when relevant.` });
      } else
      content.push({ type: 'text', text: `下面�?PDF �?${image.pageNumber} 页截图，请结合其中的图表进行解释。` });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: image.data,
        },
      });
    }

    if (finalPromptBlock) content.push(finalPromptBlock);

    const shouldAttachPdfDocument = Boolean(tempPdf && !extractedPdf?.text.trim() && pageImages.length === 0);

    if (shouldAttachPdfDocument && tempPdf) {
      content.splice(Math.max(content.length - 1, 0), 0, {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: tempPdf.buffer.toString('base64'),
        },
        title: request.title ?? request.paperId,
        cache_control: { type: 'ephemeral' },
      } as ReaderMessageContentBlock);
    }

    console.log('[reader-agent:ask] prompt context prepared', {
      paperId: request.paperId,
      scope: request.scope,
      model: modelSelection.model,
      pdfContextStrategy: promptContent.pdfContextStrategy,
      pdfContextChars: promptContent.pdfContextChars,
      pdfContextPages: promptContent.pdfContextPages.slice(0, 20),
      cacheableBlocks: promptContent.cacheableBlocks,
      pageImages: pageImages.map((image) => image.pageNumber),
      attachedPdfDocument: shouldAttachPdfDocument,
      messageBlocks: content.length,
    });

    const response = await client.beta.messages.create({
      betas: shouldAttachPdfDocument ? ['files-api-2025-04-14'] : [],
      model: modelSelection.model,
      max_tokens: 16000,
      system: buildReaderSystemPrompt(Boolean(localPdfPath || extractedPdf || request.selectedText || request.paperContextSummary), hasWebSearch, request.modePrompt, responseLanguage),
      messages: [{ role: 'user', content }],
    });
    const usageWithCache = response.usage as typeof response.usage & {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };

    console.log('[reader-agent:ask] reader request finished', {
      paperId: request.paperId,
      scope: request.scope,
      model: modelSelection.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: usageWithCache.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: usageWithCache.cache_read_input_tokens ?? 0,
    });

    return {
      answer: textFromResponse(response),
      webSearchResults,
      model: modelSelection.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: usageWithCache.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: usageWithCache.cache_read_input_tokens ?? 0,
    };
  } finally {
    if (tempPdf) await fs.rm(tempPdf.outputDir, { recursive: true, force: true });
  }
};

const askGeneralChat = async (request: z.infer<typeof readerRequestSchema>) => {
  const modelSelection = selectCheapTriageModel();
  const client = createAnthropicClient(modelSelection.target);
  const response = await client.messages.create({
    model: modelSelection.model,
    max_tokens: 4000,
    system:
      'You are SCIReader general chat assistant. For identity, source, creator, father, provider, model, or version questions, answer exactly in Chinese: 我是论文阅读小助手. Do not claim to be ChatGPT, GPT, Claude, Anthropic, OpenAI, or any specific model/provider. For other questions, answer directly in Chinese unless another language is requested. Do not refuse just because there is no PDF context.',
    messages: [
      ...(request.conversationHistory ?? [])
        .slice(-8)
        .map((message): Anthropic.MessageParam => ({
          role: message.role,
          content: message.content.slice(0, 4000),
        })),
      { role: 'user', content: request.prompt },
    ],
  });

  return {
    answer: textFromResponse(response),
    model: modelSelection.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
};

const generateImage = async (request: z.infer<typeof imageRequestSchema>) => {
  const modelSelection = selectImageModel(request);
  const client = createAnthropicClient(modelSelection.target);
  const context = [
    request.title ? `Paper title: ${request.title}` : null,
    request.selectedText ? `Selected text: ${request.selectedText}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const response = await client.messages.create({
    model: modelSelection.model,
    max_tokens: 4000,
    system:
      'You are SCIReader image assistant. If the current model cannot directly return an image, output a detailed English image-generation prompt and a brief Chinese explanation.',
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
    model: modelSelection.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    ...image,
  };
};

const inferStockMarket = (code: string, market?: 'A' | 'US' | 'HK' | 'FX') => {
  const normalizedCode = code.trim().toUpperCase();

  if (market) return market;
  if (normalizedCode.toLowerCase().startsWith('hf_')) return 'FX';
  if (/^HK\.?\d{1,5}$/.test(normalizedCode)) return 'HK';
  if (/^\d{1,5}$/.test(normalizedCode)) return 'HK';
  if (/^[a-z]+$/i.test(normalizedCode)) return 'US';
  return 'A';
};

const getTencentQuotePrefix = (code: string, market?: 'A' | 'US' | 'HK' | 'FX') => {
  const normalizedCode = code.trim().toUpperCase().replace(/[^A-Z0-9_.]/g, '');
  const normalizedMarket = inferStockMarket(normalizedCode, market);
  const hongKongCode = normalizedCode.match(/^HK\.?(\d{1,5})$/)?.[1] ?? normalizedCode;
  const quoteCode = normalizedMarket === 'HK' && /^\d{1,5}$/.test(hongKongCode) ? hongKongCode.padStart(5, '0') : normalizedCode;

  if (normalizedMarket === 'US') return `us${quoteCode}`;
  if (normalizedMarket === 'HK') return `hk${quoteCode}`;
  if (normalizedMarket === 'FX') return quoteCode.toLowerCase().startsWith('hf_') ? quoteCode : `hf_${quoteCode}`;
  return quoteCode.startsWith('60') || quoteCode.startsWith('68') ? `sh${quoteCode}` : `sz${quoteCode}`;
};

const fetchWithTimeout = async (url: string, timeoutMs = 12000, init?: RequestInit) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const extractReadableTextFromHtml = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

const readWebMaterial = async (url: string) => {
  const response = await fetchWithTimeout(url, 15000, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.8',
      'User-Agent': 'SCIReader/1.0 financial-analysis (+https://scireader.xyz)',
    },
  });

  if (!response.ok) throw new Error(`Web material request failed: ${response.status}`);

  const contentType = response.headers.get('content-type') ?? '';
  const rawText = await response.text();
  const text = contentType.includes('html') ? extractReadableTextFromHtml(rawText) : rawText.replace(/\s+/g, ' ').trim();

  return {
    contentType: contentType || 'text/html',
    text: text.slice(0, 80_000),
    extractedChars: text.length,
  };
};

const fetchTencentQuoteText = async (query: string) => {
  const response = await fetchWithTimeout(`https://qt.gtimg.cn/q=${query}`);
  if (!response.ok) throw new Error(`Tencent quote request failed: ${response.status}`);
  const buffer = await response.arrayBuffer();

  return new TextDecoder('gbk').decode(buffer);
};

const fetchStockQuotes = async (watchlist: z.infer<typeof stockWatchlistItemSchema>[]) => {
  const requests = watchlist.map((stock) => ({
    stock,
    prefix: getTencentQuotePrefix(stock.code, stock.market),
  }));
  const query = requests.map((request) => request.prefix).join(',');
  const text = await fetchTencentQuoteText(query);
  const lineByPrefix = new Map<string, string>();

  for (const line of text.split(';')) {
    const quoteLine = line.trim();
    const match = quoteLine.match(/^v_([^=]+)=/);
    if (match && quoteLine.includes('~')) lineByPrefix.set(match[1].toLowerCase(), quoteLine);
  }

  const quotes = [];

  for (const request of requests) {
    const { stock, prefix } = request;
    const line = lineByPrefix.get(prefix.toLowerCase());
    const market = inferStockMarket(stock.code, stock.market);
    const normalizedStockCode = stock.code.trim().toUpperCase();
    const hongKongDisplayCode = normalizedStockCode.match(/^HK\.?(\d{1,5})$/)?.[1] ?? normalizedStockCode;
    const displayCode = market === 'HK' && /^\d{1,5}$/.test(hongKongDisplayCode) ? hongKongDisplayCode.padStart(5, '0') : normalizedStockCode;

    if (!line) {
      quotes.push({
        name: stock.name,
        code: displayCode,
        market,
        price: null,
        prevClose: null,
        change: 0,
        changePct: 0,
        currency: market === 'US' ? '$' : market === 'HK' ? 'HK$' : '¥',
      });
      continue;
    }

    const parts = line.split('~');
    const rawPrice = parts[3];
    const rawPrevClose = parts[4] || rawPrice;
    const price = Number.parseFloat(rawPrice);
    const prevClose = Number.parseFloat(rawPrevClose);
    let changePct = Number.parseFloat(parts[32]);

    if (!Number.isFinite(changePct) && Number.isFinite(price) && Number.isFinite(prevClose) && prevClose > 0) {
      changePct = ((price - prevClose) / prevClose) * 100;
    }

    const change = Number.isFinite(price) && Number.isFinite(prevClose) ? price - prevClose : 0;

    quotes.push({
      name: parts[1] || stock.name || stock.code,
      code: displayCode,
      market,
      price: Number.isFinite(price) ? price : null,
      prevClose: Number.isFinite(prevClose) ? prevClose : null,
      change,
      changePct: Number.isFinite(changePct) ? changePct : 0,
      currency: market === 'US' ? '$' : market === 'HK' ? 'HK$' : '¥',
    });
  }

  return quotes;
};

const financialAnalystSystemPrompt = `你是一个在北京金融界头部证券公司上班的股票交易员，你对A股市场的潜规则和各种习惯非常熟悉，你了解国家队的操作风格，你也熟悉游资和量化交易公司的各种套路。

你正在帮助用户分析财务报告、走势图、K线、盘口截图和相关材料。请保持交易员视角，但必须谨慎：不要编造不存在的数据，不要承诺收益，不要给出确定性买卖指令。必须使用简体中文输出，且输出必须包含“风险提示：以下仅为研究分析，不构成投资建议”。`;

const buildFinancialAnalysis = async (user: { id: string; email: string }, request: z.infer<typeof financialAnalysisRequestSchema>) => {
  const analysisMode = request.analysisMode ?? 'normal';
  const modelSelection = analysisMode === 'quality' ? selectExpertReviewModel() : selectExpensiveReaderModel();
  const client = createAnthropicClient(modelSelection.target);
  const stockArchive = await loadFinancialStockArchive(user.id, request.stock);
  const stockArchiveContext = formatFinancialStockArchiveContext(stockArchive);
  const content: ReaderMessageContent = [
    {
      type: 'text',
      text: `本次分析对象：${request.stock.name}（${request.stock.code}，${request.stock.market ?? 'A'}）
分析主题或问题：${request.topic?.trim() || '请综合分析上传的财务报告、走势图、K线和盘口材料。'}
分析模式：${analysisMode === 'quality' ? '高质量模式，需要更严格地交叉核验材料、历史档案、基本面和盘面信号。' : '一般模式，直接基于现有材料给出清晰判断。'}

该分析对象历史 AI 分析档案：
${stockArchiveContext || '暂无历史档案，这是该对象第一次财务/股价分析。'}

本用户最近对话历史：
${formatConversationHistoryForReaderPrompt(request.conversationHistory) || '暂无最近对话历史。'}

请按以下结构输出简体中文分析：
1. 核心结论：用交易员语言给出多空判断、确定性强弱、关键触发条件。
2. 基本面：收入、利润、现金流、负债、经营质量、估值或行业对比，明确哪些来自材料、哪些是推断。
3. 技术面和盘口：趋势、量价、K线形态、支撑压力、筹码/资金行为、可能的量化或游资痕迹。
4. A股语境：结合国家队、机构、游资、量化、政策窗口、财报披露期等常见交易习惯分析，但不要阴谋化。
5. 和历史档案的关系：说明本次新材料/新行情相较历史判断，是增强、削弱还是反转，并点名原因。
6. 风险和反证：列出可能推翻判断的信号。
7. 后续观察清单：给出需要继续跟踪的指标、价量条件和公告事件。

风险提示：以下仅为研究分析，不构成投资建议。`,
    },
  ];
  const fileSummaries: Array<{ name: string; contentType: string; storagePath: string; extractedChars?: number }> = [];

  for (const file of request.files) {
    const webUrl = file.url ?? (file.storagePath.startsWith('url:') ? file.storagePath.slice(4) : null);

    if (webUrl) {
      try {
        const webMaterial = await readWebMaterial(webUrl);

        content.push({
          type: 'text',
          text: `\n\n[网页材料] ${file.name}\nURL: ${webUrl}\nExtracted text:\n${webMaterial.text || '未能提取到可读网页正文。'}`,
          cache_control: webMaterial.text.length >= MIN_PROMPT_CACHE_TEXT_CHARS ? { type: 'ephemeral' } : undefined,
        } as ReaderMessageContentBlock);
        fileSummaries.push({ name: file.name, contentType: webMaterial.contentType, storagePath: file.storagePath, extractedChars: webMaterial.extractedChars });
      } catch (error) {
        const message = error instanceof Error ? error.message : '网页读取失败。';
        content.push({ type: 'text', text: `\n\n[网页材料] ${file.name}\nURL: ${webUrl}\n读取失败：${message}\n请在分析中说明该网页材料未能读取，不要编造网页内容。` });
        fileSummaries.push({ name: file.name, contentType: file.contentType, storagePath: file.storagePath });
      }

      continue;
    }

    assertUserStorageAccess(user, file.storagePath);

    if (file.contentType === 'application/pdf') {
      const tempPdf = await materializePdfToTempFile(file.storagePath);

      try {
        const extracted = await extractPdfText(tempPdf.localPdfPath);
        const text = extracted.text.slice(0, 80_000);
        content.push({
          type: 'text',
          text: `\n\n[PDF材料] ${file.name}\nStorage path: ${file.storagePath}\nExtracted text:\n${text || '未能提取到可读文本。'}`,
          cache_control: text.length >= MIN_PROMPT_CACHE_TEXT_CHARS ? { type: 'ephemeral' } : undefined,
        } as ReaderMessageContentBlock);
        fileSummaries.push({ name: file.name, contentType: file.contentType, storagePath: file.storagePath, extractedChars: extracted.extractedChars });
      } finally {
        await fs.rm(tempPdf.outputDir, { recursive: true, force: true });
      }

      continue;
    }

    if (file.contentType.startsWith('image/')) {
      const { buffer, contentType } = await downloadFileAsAdmin(file.storagePath);
      const mediaType = contentType === 'image/jpg' ? 'image/jpeg' : contentType;

      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) {
        content.push({ type: 'text', text: `\n\n[图片材料] ${file.name}\n该图片格式 ${mediaType} 暂不支持直接视觉分析。` });
        fileSummaries.push({ name: file.name, contentType: mediaType, storagePath: file.storagePath });
        continue;
      }

      content.push({ type: 'text', text: `\n\n[图片材料] ${file.name}\nStorage path: ${file.storagePath}` });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: buffer.toString('base64'),
        },
      } as ReaderMessageContentBlock);
      fileSummaries.push({ name: file.name, contentType: mediaType, storagePath: file.storagePath });
    }
  }

  const response = await client.beta.messages.create({
    model: request.model?.trim() || modelSelection.model,
    max_tokens: 6000,
    system: financialAnalystSystemPrompt,
    messages: [{ role: 'user', content }],
  });
  const usageWithCache = response.usage as typeof response.usage & {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };

  return {
    answer: textFromResponse(response),
    model: request.model?.trim() || modelSelection.model,
    files: fileSummaries,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheCreationInputTokens: usageWithCache.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usageWithCache.cache_read_input_tokens ?? 0,
    archiveEntryCount: stockArchive.length,
    analysisMode,
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
      'You are SCIReader low-cost summary freshness checker. Check only whether the saved paper report is concise, structured, and covers core mechanism, key numbers, evidence strength, and main limitations. Do not re-summarize the paper. Output only JSON.',
    messages: [
      {
        role: 'user',
        content: `Paper title: ${request.title ?? request.paperId}\nJournal: ${request.journal ?? 'Unknown'}\nYear: ${request.year ?? 'Unknown'}\n\nUser summary request:\n${request.prompt}\n\nSaved summary:\n${cachedSummary.slice(0, 20000)}\n\nReturn JSON: {"fresh": boolean, "reason": string, "improvementPrompt": string}. Set fresh=false only if the summary is empty, generic, too long, missing core mechanism/key numbers/evidence strength/main limitations, mismatched to the user request, or appears truncated. When fresh=false, improvementPrompt must explain what GPT-5.5 should improve.`,
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
      'You are a precise academic translator. Translate the assistant answer into natural Chinese for the user interface. Preserve Markdown structure, equations, variable names, units, numbers, figure/table labels, citations, URLs, and field-specific terminology. Preserve inline math as \\(...\\) and display math as $$...$$ so the UI can render it with KaTeX. Do not add new analysis or remove caveats.',
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
        content: `论文标题�?{request.title ?? request.paperId}\n\n完整深度阅读笔记：\n${fullAnswer}`,
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
      'You are SCIReader memory retrieval and routing. Search saved Azure Blob records for this exact paper key. Identity rule: if the user asks identity, source, creator, father, provider, model, or version questions, set sufficient=true and answerDraft exactly: 我是论文阅读小助手. Do not route identity questions to the high-cost reader. For paper analysis, decide whether saved records are enough or the high-cost reader must read the PDF again. If the question is clearly unrelated to the paper, answer as normal general chat in Chinese and set sufficient=true. Do not refuse just because paper evidence is absent for a non-paper question. Output only JSON.',
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
- For identity/provider/model-version/source/creator/father questions, sufficient=true and answerDraft must be exactly: 我是论文阅读小助手。
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
      'You are SCIReader low-cost context retrieval assistant. Search saved paper summary and dialog history. Decide whether saved information is enough to answer. Do not perform new paper analysis. Output only JSON.',
    messages: [
      {
        role: 'user',
        content: `Paper title: ${request.title ?? request.paperId}\n\nSaved summary:\n${cachedSummary || 'None'}\n\nSaved history:\n${historyText || 'None'}\n\nCurrent question:\n${request.prompt}\n\nReturn JSON: {"sufficient": boolean, "contextSummary": string, "answerDraft": string, "expensivePrompt": string}. Provide answerDraft when sufficient=true and expensivePrompt when sufficient=false.`,
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

const getCompactSummaryInstruction = (mode: PaperReadingMode) => {
  const normalizedMode = mode === 'reader' ? 'simple' : mode === 'reviewer' ? 'detailed' : mode;

  if (normalizedMode === 'quality') {
    return 'You are SCIReader high-quality academic analyst. Extract the real technical mechanism, novelty, key numbers with units, evidence strength, publication-level clues, innovation type, transfer value, and credibility risk. Be strict and evidence-based.';
  }

  if (normalizedMode === 'simple') {
    return 'You are a fast cross-disciplinary research reader. Extract only the core technical idea, mechanism, key numbers with units, reusable design insight, and limits. Be terse.';
  }

  return 'You are a senior peer reviewer for natural-science and engineering journals. Extract evidence-anchored notes on real contribution, venue-fit novelty, technical mechanism, key numbers with units, evidence strength, reproducibility gaps, integrity or padding red flags, and the largest credibility risk. Be terse and do not accuse without evidence.';
};

const getSummaryLanguageInstruction = (language: 'english' | 'chinese') =>
  language === 'chinese'
    ? 'Respond in Chinese. Do not translate the paper into English first. Preserve numbers, units, equations, figure/table labels, citations, and Markdown structure.'
    : 'Respond in English. The final result may be translated to Chinese by a low-cost model; preserve numbers, units, equations, figure/table labels, citations, and Markdown structure.';

const briefSummaryPrompt = `你将收到一份针对某篇论文生成的"深度阅读笔记"（完整版，可能来�?审稿模式"�?写稿模式"两种模板之一）�?
请基于这份笔记，只提炼以下五点，使用中文输出，每点严格控制在1-2句话内：

## 速览

* **核心卖点**：去掉包装后，这篇论文真正的新东�?最大优势是什么（即论文最想让审稿�?读者记住的一点）�?* **核心数据**：列出笔记中最关键�?-3个量化结果（保留具体数值、单位，如增�?dB、精�?mAP、带�?GHz、良率等——以笔记中实际出现的指标为准，不要编造）�?* **主要缺陷**：方法、实验或证据层面最大的弱点（如笔记中明确未提及缺陷，写"未发现明显缺�?）�?* **是否有价�?*：值得细读 / 可�?/ 不必细读，附极简理由（不超过8字）�?* **数据造假嫌疑**：有 / 未见明显异常 / 信息不足无法判断（严格沿用笔�?证据强度核查"部分的结论，不得自行加重或减轻判断）�?
硬性要求：
* 只能基于完整笔记中已有内容提炼，禁止引入笔记之外的新判断、新信息或推测�?* "核心数据"必须是笔记中出现过的真实数值，不得四舍五入到面目全非或编造�?* 禁止展开论述、禁止给出建议、禁止追问索引、禁止输出除上述五点之外的任何内容�?* 总输出不超过180字�?* 不要输出"完整笔记见附�?等附加说明。`;

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
      pages: extractedPdf.pages.length,
      sourceLanguage: extractedPdf.sourceLanguage,
      wasTruncated: extractedPdf.wasTruncated,
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
      pages: extractedPdf.pages.length,
      extractedChars: extractedPdf.extractedChars,
      returnedChars: extractedPdf.returnedChars,
      sourceLanguage: extractedPdf.sourceLanguage,
      wasTruncated: extractedPdf.wasTruncated,
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
      pdfBytes: tempPdf.buffer.byteLength,
      warning: `PDF text extraction failed; returned a byte-based local estimate: ${message}`,
    };
  } finally {
    await fs.rm(tempPdf.outputDir, { recursive: true, force: true });
  }
};

const estimateFigureReadingConsumption = async (request: z.infer<typeof readerRequestSchema>) => {
  const storagePath = resolveUploadedPdfStoragePath(request.pdfUrl);
  const pageNumbers = normalizeRequestedPageNumbers(request.pageNumbers, request.pageNumber);

  if (!storagePath) throw new Error('Only uploaded PDFs can be estimated.');
  if (!pageNumbers.length) throw new Error('Please specify the PDF pages to read as images.');

  const cachePath = getFigureReadingStoragePath({ ...request, pageNumbers, pageNumber: pageNumbers[0] });
  const cachedReading = await loadFigureReadingIfExists(cachePath);
  const modelSelection = selectReaderModel({ ...request, scope: 'figure' });

  if (cachedReading?.answer.trim()) {
    return {
      startPage: pageNumbers[0],
      endPage: pageNumbers[pageNumbers.length - 1],
      pageNumbers,
      inputTokens: 0,
      billableTokens: 0,
      model: modelSelection.model,
      cached: true,
      cachePath,
      method: 'cached-figure-reading',
    };
  }

  const tempPdf = await materializePdfToTempFile(storagePath);

  try {
    const extractedPdf = await extractPdfText(tempPdf.localPdfPath);
    const requestedPages = new Set(pageNumbers);
    const samePageText = extractedPdf.pages
      .filter((page) => requestedPages.has(page.pageNumber))
      .map(formatPdfPageText)
      .join('\n\n');
    const visualSummaryNotes = extractVisualNotesFromSummary(request.paperContextSummary, pageNumbers);
    const textualContext = [
      request.prompt,
      visualSummaryNotes,
      request.paperContextSummary?.slice(0, 4000),
      extractedPdf.figureCaptions.join('\n'),
      samePageText,
    ]
      .filter(Boolean)
      .join('\n\n');
    const textTokens = estimateTextTokensLocally(textualContext);
    const imageTokens = pageNumbers.length * ESTIMATED_IMAGE_TOKENS_PER_RENDERED_PAGE;
    const inputTokens = textTokens + imageTokens;

    return {
      startPage: pageNumbers[0],
      endPage: pageNumbers[pageNumbers.length - 1],
      pageNumbers,
      inputTokens,
      billableTokens: getBillableTokens(inputTokens, 0, modelSelection.model),
      model: modelSelection.model,
      cached: false,
      cachePath,
      method: 'local-figure-estimate',
      textTokens,
      imageTokens,
      imageTokensPerPage: ESTIMATED_IMAGE_TOKENS_PER_RENDERED_PAGE,
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

const prepareWritingSources = async (userId: string, request: z.infer<typeof writingRequestSchema>) => {
  const uploadedPapers = await loadUploadedPapers(userId);
  const sources: WritingSource[] = [];
  const missingSummaries: string[] = [];

  for (const [index, selectedPaper] of request.selectedPapers.entries()) {
    const ownedPaper = uploadedPapers.find((paper) =>
      (selectedPaper.filePath && paper.filePath === selectedPaper.filePath) ||
      (paper.id === selectedPaper.paperId && paper.title === selectedPaper.title),
    );

    if (!ownedPaper) {
      const error = new Error(`You do not have access to selected paper: ${selectedPaper.title}.`);
      error.name = 'ForbiddenWritingPaperError';
      throw error;
    }

    const paper = {
      paperId: ownedPaper.id,
      title: ownedPaper.title,
      authors: ownedPaper.authors,
      journal: ownedPaper.journal,
      year: ownedPaper.year,
      pdfUrl: ownedPaper.pdfUrl,
      filePath: ownedPaper.filePath,
    };
    const cached = await loadCachedSummaryForWriting(paper);

    if (!cached) {
      missingSummaries.push(paper.title);
      continue;
    }

    const paperKey = getPaperIdentitySlug(getWritingPaperRequest(paper));
    const [neo4jExternalEvaluations, blobExternalEvaluations] = await Promise.all([
      loadExternalReferenceEvaluationsFromNeo4j(paperKey),
      loadReferenceEvaluationRecords(getReferenceExternalEvaluationsPath(paperKey)),
    ]);

    sources.push({
      citationKey: `p${index + 1}`,
      paperKey,
      paper,
      summary: cached.summary,
      ieeeCitation: buildIeeeCitation(getWritingPaperRequest(paper)),
      externalEvaluations: mergeReferenceEvaluationRecords(neo4jExternalEvaluations, blobExternalEvaluations),
    });
  }

  if (missingSummaries.length) {
    const error = new Error(`以下文献还没有已保存读书笔记，请先打开论文生成摘要：${missingSummaries.join('；')}`);
    error.name = 'MissingWritingSummaryError';
    throw error;
  }

  if (request.selectedPapers.length > 0 && !sources.length) {
    const error = new Error('No usable reading notes were found for the selected papers.');
    error.name = 'MissingWritingSummaryError';
    throw error;
  }

  return sources;
};

const buildWritingPrompt = (request: z.infer<typeof writingRequestSchema>, sources: WritingSource[], articleSources: WritingArticleSource[]) => {
  const languageInstruction = request.outputLanguage === 'english'
    ? 'Write in polished academic English.'
    : '使用中文写作，保持学术论文 Introduction 的正式语气。';
  const sourceBlocks = sources
    .map((source, index) => `Source ${index + 1}
Citation placeholder: {{cite:${source.citationKey}}}
Title: ${source.paper.title}
Authors: ${source.paper.authors ?? 'unknown'}
Venue/journal/conference: ${source.paper.journal ?? 'unknown'}
Year: ${source.paper.year ?? 'unknown'}
IEEE reference: ${source.ieeeCitation}

Saved reading note:
${source.summary.slice(0, 9000)}

External evaluations of this cited paper by other papers:
${formatWritingExternalEvaluations(source.externalEvaluations) || 'None found in Neo4j/cache.'}`)
    .join('\n\n---\n\n');
  const articleBlocks = articleSources
    .map((article, index) => `Article material ${index + 1}
Topic: ${article.topic}
Kind: ${article.kind ?? 'unknown'}
Storage path: ${article.storagePath}

Saved writing content:
${article.content.slice(0, 12000)}`)
    .join('\n\n---\n\n');

  return {
    system: `You are SCIReader writing mode, an academic Introduction drafting assistant.
${languageInstruction}
Use only the provided saved reading notes, selected previous writing articles, and external evaluation records. Do not read or claim to have reread PDFs.
Organize the selected literature according to Introduction conventions: background, existing approaches, research gap, motivation, and positioning.
Every factual claim about a selected paper must cite that paper using its exact placeholder, for example {{cite:p1}}.
Citation numbers will be assigned by the server in first-appearance order, so do not write numeric citations yourself.
Selected previous writing articles are writing material, not bibliographic sources. Use them for structure, wording, argument flow, and reusable synthesis, but do not cite them as references unless they cite selected papers through placeholders.
Integrate external evaluations naturally when useful, phrased as how other papers position, compare, or criticize the cited work. Do not overstate those evaluations as target-paper evidence.
Return only the Introduction body. Do not include a References section, bibliography, title, outline, or explanatory notes.`,
    user: `Writing topic or direction:
${request.topic}

Selected paper notes and external evaluations:
${sourceBlocks || 'No selected papers.'}

Selected previous writing articles:
${articleBlocks || 'None.'}`,
  };
};

const generateWritingIntroduction = async (userId: string, request: z.infer<typeof writingRequestSchema>) => {
  const sources = await prepareWritingSources(userId, request);
  const articleSources = await loadSelectedWritingArticles(userId, request.selectedArticles);
  if (!sources.length && !articleSources.length) {
    const error = new Error('No usable writing materials were found. Please select at least one uploaded paper with reading notes or one saved article.');
    error.name = 'MissingWritingMaterialsError';
    throw error;
  }
  const prompt = buildWritingPrompt(request, sources, articleSources);
  const result = await createExpensiveTextResponse(
    prompt.system,
    prompt.user,
    request.outputLanguage === 'english' ? 4500 : 5000,
    { phase: 'writing-introduction', selectedPapers: sources.length, selectedArticles: articleSources.length, outputLanguage: request.outputLanguage },
    SUMMARY_FINAL_TIMEOUT_MS,
  );
  const numbered = numberWritingCitations(result.answer, sources);
  const storagePath = getWritingStoragePath(userId, request.topic);
  const savedAt = new Date().toISOString();
  const savedContent = `# Writing mode result

\`\`\`json
${JSON.stringify({
  topic: request.topic,
  outputLanguage: request.outputLanguage,
  selectedPapers: sources.map((source) => ({
    paperKey: source.paperKey,
    title: source.paper.title,
    authors: source.paper.authors,
    journal: source.paper.journal,
    year: source.paper.year,
    citationKey: source.citationKey,
  })),
  references: numbered.references,
  citedPaperKeys: numbered.citedPaperKeys,
  model: result.model,
  savedAt,
}, null, 2)}
\`\`\`

${numbered.draft}
`;

  await uploadTextAsAdmin(savedContent, storagePath);

  return {
    draft: numbered.draft,
    references: numbered.references,
    storagePath,
    savedAt,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    sourceCount: sources.length,
  };
};

const isExplicitSupplementalReadingRequest = (question: string) =>
  /\b(reread|re-read|read again|search the pdf|inspect the pdf|full text|not summarized|unsummarized)\b|重新阅读|重读|再读|检索原文|查看原文|检查PDF|补充阅读|没有总结|未总结|全文检索|重新检索/i.test(question);

type WritingFollowUpStrategy = 'local-revision' | 'full-regeneration' | 'supplemental-reading';

const normalizeWritingFollowUpStrategy = (value: unknown): WritingFollowUpStrategy => {
  if (value === 'full-regeneration' || value === 'supplemental-reading') return value;

  return 'local-revision';
};

const triageWritingFollowUp = async (request: z.infer<typeof writingFollowUpRequestSchema>, sources: WritingSource[]) => {
  if (isExplicitSupplementalReadingRequest(request.question)) {
    return {
      needsSupplementalReading: true,
      strategy: 'supplemental-reading' as const,
      reason: 'User explicitly requested rereading or searching content beyond saved notes.',
      model: 'explicit-supplemental-reading-request',
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  const modelSelection = selectCheapTriageModel();
  const client = createAnthropicClient(modelSelection.target);
  const response = await client.messages.create({
    model: modelSelection.model,
    max_tokens: 600,
    system:
      'You are SCIReader writing follow-up router. Decide whether the user follow-up needs only a local revision of the current draft, a full regeneration from saved notes, or supplemental PDF reading. Output only JSON.',
    messages: [
      {
        role: 'user',
        content: `Writing topic:
${request.topic}

Follow-up request:
${request.question}

Current draft:
${request.currentDraft.slice(0, 12000)}

Selected papers:
${sources.map((source) => `${source.citationKey}: ${source.paper.title}; ${source.paper.authors ?? 'unknown'}; ${source.paper.journal ?? 'unknown'}; ${source.paper.year ?? 'unknown'}`).join('\n')}

Return JSON exactly: {"strategy": "local-revision" | "full-regeneration" | "supplemental-reading", "needsSupplementalReading": boolean, "reason": string}.
Use local-revision for formatting changes, citation/reference style fixes, language polishing, shortening, expanding a paragraph, changing structure, or edits that can be done from the current draft.
Use full-regeneration when the user asks to reorganize the whole Introduction, change the argument logic, rebalance all selected papers, or rewrite from the selected saved notes.
Use supplemental-reading only when the user asks for evidence, data, equations, pages, methods, or claims not present in the current draft/saved notes, or asks to reread/search original PDFs.
For requests like "fix IEEE references", "modify reference format", or "renumber citations", choose local-revision and needsSupplementalReading=false.`,
      },
    ],
  });
  const parsed = extractJsonObject(textFromResponse(response).trim()) as Partial<{ strategy: string; needsSupplementalReading: boolean; reason: string }>;
  const strategy = normalizeWritingFollowUpStrategy(parsed.strategy);

  return {
    strategy,
    needsSupplementalReading: strategy === 'supplemental-reading' || parsed.needsSupplementalReading === true,
    reason: typeof parsed.reason === 'string' ? parsed.reason : 'No reason returned.',
    model: modelSelection.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
};

const generateWritingFollowUp = async (userId: string, request: z.infer<typeof writingFollowUpRequestSchema>) => {
  const sources = await prepareWritingSources(userId, request);
  const articleSources = await loadSelectedWritingArticles(userId, request.selectedArticles);
  if (!sources.length && !articleSources.length) {
    const error = new Error('No usable writing materials were found. Please select at least one uploaded paper with reading notes or one saved article.');
    error.name = 'MissingWritingMaterialsError';
    throw error;
  }
  const triage = await triageWritingFollowUp(request, sources);

  if (triage.needsSupplementalReading) {
    return {
      needsSupplementalReading: true,
      strategy: triage.strategy,
      answer: request.outputLanguage === 'english'
        ? `This follow-up requires supplemental reading or PDF search before I revise the draft. Reason: ${triage.reason}`
        : `这个追问需要先补充阅读或检索原文后再改写。原因：${triage.reason}`,
      storagePath: '',
      savedAt: '',
      references: [],
      model: triage.model,
      inputTokens: triage.inputTokens,
      outputTokens: triage.outputTokens,
      sourceCount: sources.length,
      baseBillableTokens: getBillableTokens(triage.inputTokens, triage.outputTokens, triage.model),
    };
  }

  const languageInstruction = request.outputLanguage === 'english' ? 'Write in polished academic English.' : '使用中文写作，保持学术论文 Introduction 的正式语气。';
  const isLocalRevision = triage.strategy === 'local-revision';
  const revisionSystem = isLocalRevision
    ? `You are SCIReader writing mode. ${languageInstruction}
Apply the user's requested local revision to the current draft. This is a local editing task, not a full literature synthesis.
If the request is about citation or reference formatting, preserve the Introduction body as much as possible and fix citations/References to IEEE style.
Use citation placeholders like {{cite:p1}} only where a cited claim should point to a selected paper. Return the complete revised Introduction body only, without References.`
    : `You are SCIReader writing mode. ${languageInstruction}
Regenerate the whole Introduction from the selected saved reading notes and external evaluations. Do not reread PDFs.
Use citation placeholders like {{cite:p1}} when adding or changing cited claims. Return the complete revised Introduction body only, without References.`;
  const revisionUserContent = isLocalRevision
    ? `Writing topic:
${request.topic}

Follow-up request:
${request.question}

Current draft:
${stripGeneratedReferences(request.currentDraft)}

Available reference targets:
${sources.map((source) => `${source.citationKey}: ${source.ieeeCitation}`).join('\n')}`
    : `Writing topic:
${request.topic}

Follow-up request:
${request.question}

Current draft:
${stripGeneratedReferences(request.currentDraft)}

Saved paper notes:
${sources.map((source) => `${source.citationKey}: ${source.paper.title}
${source.summary.slice(0, 7000)}

External evaluations:
${formatWritingExternalEvaluations(source.externalEvaluations) || 'None found.'}`).join('\n\n---\n\n')}

Selected previous writing articles:
${articleSources.map((article, index) => `Article material ${index + 1}
Topic: ${article.topic}
Kind: ${article.kind ?? 'unknown'}
${article.content.slice(0, 10000)}`).join('\n\n---\n\n') || 'None.'}`;
  const result = await createExpensiveTextResponse(
    revisionSystem,
    revisionUserContent,
    request.outputLanguage === 'english' ? 4500 : 5000,
    { phase: 'writing-follow-up', strategy: triage.strategy, selectedPapers: sources.length, outputLanguage: request.outputLanguage },
    SUMMARY_FINAL_TIMEOUT_MS,
  );
  const numbered = numberWritingCitations(result.answer, sources);
  const storagePath = getWritingStoragePath(userId, request.topic);
  const savedAt = new Date().toISOString();
  const savedContent = `# Writing mode follow-up result

\`\`\`json
${JSON.stringify({
  topic: request.topic,
  followUpQuestion: request.question,
  outputLanguage: request.outputLanguage,
  references: numbered.references,
  citedPaperKeys: numbered.citedPaperKeys,
  model: `${triage.model} -> ${result.model}`,
  savedAt,
}, null, 2)}
\`\`\`

${numbered.draft}
`;

  await uploadTextAsAdmin(savedContent, storagePath);

  return {
    needsSupplementalReading: false,
    strategy: triage.strategy,
    answer: numbered.draft,
    references: numbered.references,
    storagePath,
    savedAt,
    model: `${triage.model} -> ${result.model}`,
    inputTokens: triage.inputTokens + result.inputTokens,
    outputTokens: triage.outputTokens + result.outputTokens,
    sourceCount: sources.length,
    baseBillableTokens: getBillableTokens(triage.inputTokens, triage.outputTokens, triage.model) + getUsageBillableTokens(result, result.model),
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
    const responseLanguage = isQualityReadingMode(request) ? 'english' : 'chinese';
    const result = await createExpensiveTextResponse(
      buildReaderSystemPrompt(Boolean(request.paperContextSummary), false, request.modePrompt, responseLanguage),
      `Paper title: ${request.title ?? request.paperId}\n\nTask:\n${request.prompt}`,
      12000,
      { jobId, paperId: request.paperId, phase: 'fallback-no-pdf' },
    );

    return { answer: result.answer, inputTokens: result.inputTokens, outputTokens: result.outputTokens, model: result.model, responseLanguage };
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

    const readingMode = getReadingMode(request);
    const wantsDetailedReport = readingMode === 'quality' || readingMode === 'detailed' || request.detailedReport === true;
    const wantsTranslationPipeline = readingMode === 'quality' && extractedPdf.sourceLanguage === 'english';
    const summaryLanguage: 'english' | 'chinese' = wantsTranslationPipeline ? 'english' : 'chinese';
    const summaryLanguageInstruction = getSummaryLanguageInstruction(summaryLanguage);

    console.log('[reader-agent:summarize] source language detected', {
      jobId,
      paperId: request.paperId,
      sourceLanguage: extractedPdf.sourceLanguage,
      summaryLanguage,
      readingMode,
      translationPipeline: wantsTranslationPipeline,
      extractedChars: extractedPdf.extractedChars,
      returnedChars: extractedPdf.returnedChars,
      wasTruncated: extractedPdf.wasTruncated,
    });

    if (readingMode === 'simple' && extractedPdf.text.length <= SUMMARY_BRIEF_SINGLE_PASS_MAX_CHARS) {
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

${summaryLanguageInstruction}
Create a compact first-pass evidence note, not a full report.
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
        responseLanguage: summaryLanguage,
      };
    }

    const chunks = chunkExtractedPdfPages(extractedPdf.pages);
    const chunkNotes: string[] = [];
    const compactInstruction = getCompactSummaryInstruction(readingMode);
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

${summaryLanguageInstruction}
This is batch ${index + 1} of ${chunks.length}. Write compact but useful notes for a detailed peer-review report.
Use 7-10 bullets, each under 45 words. Capture only evidence present in this batch:
- concrete claim or contribution and where the batch supports it
- venue/journal/conference or publication-tier clues if visible
- technical mechanism, assumptions, method, model, or processing pipeline
- experimental setup, validation source, baseline, ablation, statistics, or deployment evidence
- strongest numerical results with units and operating conditions
- reproducibility gaps: missing parameters, data, code, derivation steps, baselines, error bars, or conditions
- integrity/padding flags: overclaiming, implausible statistics, suspicious figure/data reuse, citation manipulation, salami-slicing, or filler content; label as OBSERVED or POSSIBLE-NEEDS-VERIFICATION
- innovation type and whether it appears strong, moderate, or incremental if supported by this batch
Do not write a full report. Do not mention pages outside this batch. Do not accuse without evidence.`
          : `${compactInstruction}

${summaryLanguageInstruction}
This is batch ${index + 1} of ${chunks.length}. Write exactly 5 bullets, each under 28 words:
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

${summaryLanguageInstruction}
Retry output: exactly 4 bullets, each under 22 words. Keep only mechanism, key numbers, evidence type, and main weakness.`,
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

    if (readingMode === 'simple') {
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
        responseLanguage: summaryLanguage,
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

${summaryLanguageInstruction}
Synthesize the batch notes into a detailed senior peer-review report under 1800 words.
Use exactly these sections:
1. Summary
2. Venue-fit / publication-level assessment
3. Genuine strengths
4. Major concerns
5. Minor concerns
6. Integrity flags
7. Reproducibility
8. Per-dimension scores
9. Overall recommendation and confidence

Review requirements:
- First identify the paper's technical field from the content. Do not force physics/electromagnetics if the paper is computer science, civil engineering, geoscience, medicine, management, etc.
- If a target venue is not provided, state the assumed tier. Calibrate novelty/significance to the assumed venue tier, but keep honesty, soundness, and reproducibility standards fixed.
- Evaluate the paper itself, not just the journal. A good venue does not automatically make the paper high-level; a weak venue does not automatically make the paper wrong.
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

${summaryLanguageInstruction}
Create a short final report under 600 words from these batch notes. Preserve only mechanism, key numbers, evidence strength, and limits.`,
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
      responseLanguage: summaryLanguage,
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
    const readingMode = getReadingMode(request);
    const wantsDetailedReport = readingMode === 'quality' || readingMode === 'detailed' || request.detailedReport === true;
    const alreadyChinese = result.responseLanguage === 'chinese';

    setJobStatus({
      phase: 'translating',
      message: wantsDetailedReport
        ? alreadyChinese
          ? 'Final report is already Chinese; skipping translation.'
          : 'Translating final English summary into Chinese with cheap model.'
        : 'Compressing final report into a brief Chinese overview with cheap model.',
    });
    const finalChineseResult = wantsDetailedReport
      ? alreadyChinese
        ? { text: result.answer, model: 'source-language-direct', inputTokens: 0, outputTokens: 0 }
        : await translateReaderAnswerToChinese(result.answer, request)
      : await summarizeReaderAnswerBrieflyInChinese(result.answer, request, jobId);
    const summary = withIeeeCitationPreface(finalChineseResult.text, request);
    const inputTokens = (freshness?.inputTokens ?? 0) + result.inputTokens + finalChineseResult.inputTokens;
    const outputTokens = (freshness?.outputTokens ?? 0) + result.outputTokens + finalChineseResult.outputTokens;
    const billableTokens =
      (freshness ? getBillableTokens(freshness.inputTokens, freshness.outputTokens, selectCheapTriageModel().model) : 0) +
      getUsageBillableTokens(result, result.model) +
      getUsageBillableTokens(finalChineseResult, finalChineseResult.model);

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
      readingMode,
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

const startMissingWritingSummaryJobs = async (userId: string, request: z.infer<typeof writingRequestSchema>) => {
  const uploadedPapers = await loadUploadedPapers(userId);
  const jobs: Array<{ title: string; summaryStoragePath: string; jobStarted: boolean; jobId: string; job: ReturnType<typeof getSummaryJobSnapshot> }> = [];

  for (const selectedPaper of request.selectedPapers) {
    const ownedPaper = uploadedPapers.find((paper) =>
      (selectedPaper.filePath && paper.filePath === selectedPaper.filePath) ||
      (paper.id === selectedPaper.paperId && paper.title === selectedPaper.title),
    );

    if (!ownedPaper) continue;

    const paper = {
      paperId: ownedPaper.id,
      title: ownedPaper.title,
      authors: ownedPaper.authors,
      journal: ownedPaper.journal,
      year: ownedPaper.year,
      pdfUrl: ownedPaper.pdfUrl,
      filePath: ownedPaper.filePath,
    };
    const cached = await loadCachedSummaryForWriting(paper);

    if (cached) continue;

    const summaryRequest: z.infer<typeof readerRequestSchema> = {
      ...getWritingPaperRequest(paper),
      prompt: '请生成这篇论文的读书笔记，用于写作模式后续组织 Introduction。保留核心机制、关键数据、证据强度、局限和可引用贡献。',
      modePrompt: 'Generate a compact saved reading note for writing mode. Preserve citable claims, key numbers, limitations, and methodology evidence.',
      readingMode: 'reader',
      detailedReport: false,
    };
    const summaryStoragePath = getPaperSummaryStoragePath(summaryRequest, paper.filePath ?? resolveUploadedPdfStoragePath(paper.pdfUrl));
    const job = startSummaryGenerationJob(summaryRequest, summaryStoragePath, userId);

    jobs.push({
      title: paper.title,
      summaryStoragePath,
      jobStarted: job.started,
      jobId: job.jobId,
      job: job.job,
    });
  }

  return jobs;
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
  .post('/figure-estimate', zValidator('json', readerRequestSchema), async (c) => {
    const request = c.req.valid('json');

    try {
      await requirePaperAccess(c, request.pdfUrl);

      return c.json(await estimateFigureReadingConsumption({ ...request, scope: 'figure' }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Figure reading estimate failed.';
      const status = message === 'Not authenticated.' ? 401 : message === 'You do not have access to this PDF.' ? 403 : 500;

      console.error('[reader-agent:figure-estimate] failed', {
        paperId: request.paperId,
        pageNumbers: request.pageNumbers,
        status,
        message,
      });

      return c.json({ error: 'Figure reading estimate failed.', message }, status);
    }
  })
  .get('/writing-results', async (c) => {
    try {
      const { user } = await requirePaperAccess(c);

      return c.json({ articles: await loadWritingArticleRecords(user.id) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Writing results failed.';
      const status = message === 'Not authenticated.' ? 401 : 500;

      return c.json({ error: 'Writing results failed.', message }, status);
    }
  })
  .post('/writing-results/read', zValidator('json', writingResultPathSchema), async (c) => {
    const request = c.req.valid('json');

    try {
      const { user } = await requirePaperAccess(c);
      const storagePath = assertUserWritingStoragePath(user.id, request.storagePath);
      const articles = await loadWritingArticleRecords(user.id);
      const article = articles.find((item) => item.storagePath === storagePath);

      if (!article) return c.json({ error: 'Writing result not found in article list.' }, 404);

      const content = await downloadTextAsAdmin(storagePath);

      return c.json({
        article,
        content,
        draft: extractWritingArticleDraft(content),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not read writing result.';
      const status = message === 'Not authenticated.' ? 401 : error instanceof Error && error.name === 'InvalidWritingResultPathError' ? 400 : 500;

      return c.json({ error: 'Could not read writing result.', message }, status);
    }
  })
  .delete('/writing-results', zValidator('json', writingResultPathSchema), async (c) => {
    const request = c.req.valid('json');

    try {
      const { user } = await requirePaperAccess(c);
      const articles = await removeWritingArticleRecord(user.id, request.storagePath);

      return c.json({ articles });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not delete writing result.';
      const status = message === 'Not authenticated.' ? 401 : error instanceof Error && error.name === 'InvalidWritingResultPathError' ? 400 : 500;

      return c.json({ error: 'Could not delete writing result.', message }, status);
    }
  })
  .post('/write-introduction', zValidator('json', writingRequestSchema), async (c) => {
    const request = c.req.valid('json');
    let userId = '';

    try {
      const { user } = await requirePaperAccess(c);
      userId = user.id;
      await ensurePositiveTokenBalance(user.id);

      const result = await generateWritingIntroduction(user.id, request);
      const baseBillableTokens = getUsageBillableTokens(result, result.model);
      const billableTokens = baseBillableTokens * WRITING_BILLING_MULTIPLIER;
      const tokenAccount = await recordUserTokenUsage({
        userId: user.id,
        paperId: `writing:${sanitizeWritingTitle(request.topic)}`,
        action: 'writing:introduction',
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        billableTokens,
        metadata: {
          topic: request.topic,
          outputLanguage: request.outputLanguage,
          selectedPaperCount: result.sourceCount,
          storagePath: result.storagePath,
          billingMultiplier: WRITING_BILLING_MULTIPLIER,
          baseBillableTokens,
        },
      });
      const article: WritingArticleRecord = {
        id: result.storagePath,
        topic: request.topic,
        outputLanguage: request.outputLanguage,
        storagePath: result.storagePath,
        savedAt: result.savedAt,
        kind: 'introduction',
        selectedPaperCount: result.sourceCount,
        billableTokens,
      };
      await appendWritingArticleRecord(user.id, article);

      return c.json({
        draft: result.draft,
        references: result.references,
        storagePath: result.storagePath,
        savedAt: result.savedAt,
        article,
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          baseBillableTokens,
          billableTokens,
          billingMultiplier: WRITING_BILLING_MULTIPLIER,
        },
        tokenAccount,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Writing mode failed.';
      if (userId && error instanceof Error && error.name === 'MissingWritingSummaryError') {
        const jobs = await startMissingWritingSummaryJobs(userId, request);
        const missingTitles = jobs.map((job) => job.title);
        const draft = jobs.length
          ? `## 正在自动生成读书笔记\n\n以下文献还没有已保存读书笔记，系统已经开始自动生成。读书笔记完成后，请再次点击“生成 Introduction”。\n\n${missingTitles.map((title, index) => `${index + 1}. ${title}`).join('\n')}\n\n生成过程会按普通论文摘要规则计费；本次还没有开始写作模式的 1.5 倍计费。`
          : `## 正在等待读书笔记\n\n部分选中文献还没有已保存读书笔记。请稍后再次点击“生成 Introduction”。\n\n${message}`;

        return c.json({
          draft,
          references: [],
          storagePath: '',
          savedAt: new Date().toISOString(),
          processing: true,
          missingSummaries: missingTitles,
          jobs,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            baseBillableTokens: 0,
            billableTokens: 0,
            billingMultiplier: WRITING_BILLING_MULTIPLIER,
          },
          tokenAccount: await getUserTokenAccount(userId),
        }, 202);
      }
      const status =
        message === 'Not authenticated.'
          ? 401
          : error instanceof Error && error.name === 'ForbiddenWritingPaperError'
            ? 403
            : isInsufficientTokenBalanceError(error)
              ? 402
              : error instanceof Error && error.name === 'MissingWritingSummaryError'
                ? 409
                : error instanceof Error && error.name === 'MissingWritingMaterialsError'
                  ? 409
                  : 500;

      console.error('[reader-agent:writing] request failed', {
        topic: request.topic,
        selectedPapers: request.selectedPapers.length,
        status,
        message,
      });

      return c.json({ error: 'Writing mode failed.', message }, status);
    }
  })
  .post('/write-introduction/follow-up', zValidator('json', writingFollowUpRequestSchema), async (c) => {
    const request = c.req.valid('json');

    try {
      const { user } = await requirePaperAccess(c);
      await ensurePositiveTokenBalance(user.id);

      const result = await generateWritingFollowUp(user.id, request);
      const baseBillableTokens = result.baseBillableTokens ?? getUsageBillableTokens(result, result.model);
      const billableTokens = baseBillableTokens * WRITING_BILLING_MULTIPLIER;
      const tokenAccount = await recordUserTokenUsage({
        userId: user.id,
        paperId: `writing:${sanitizeWritingTitle(request.topic)}`,
        action: result.needsSupplementalReading ? 'writing:follow-up-triage' : 'writing:follow-up',
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        billableTokens,
        metadata: {
          topic: request.topic,
          outputLanguage: request.outputLanguage,
          selectedPaperCount: result.sourceCount,
          storagePath: result.storagePath || undefined,
          needsSupplementalReading: result.needsSupplementalReading,
          strategy: result.strategy,
          billingMultiplier: WRITING_BILLING_MULTIPLIER,
          baseBillableTokens,
        },
      });
      const article: WritingArticleRecord | null = result.storagePath
        ? {
            id: result.storagePath,
            topic: request.topic,
            outputLanguage: request.outputLanguage,
            storagePath: result.storagePath,
            savedAt: result.savedAt,
            kind: 'follow-up',
            selectedPaperCount: result.sourceCount,
            billableTokens,
          }
        : null;
      if (article) await appendWritingArticleRecord(user.id, article);

      return c.json({
        draft: result.answer,
        references: result.references,
        storagePath: result.storagePath,
        savedAt: result.savedAt,
        article,
        needsSupplementalReading: result.needsSupplementalReading,
        strategy: result.strategy,
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          baseBillableTokens,
          billableTokens,
          billingMultiplier: WRITING_BILLING_MULTIPLIER,
        },
        tokenAccount,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Writing follow-up failed.';
      const status =
        message === 'Not authenticated.'
          ? 401
          : error instanceof Error && error.name === 'ForbiddenWritingPaperError'
            ? 403
            : isInsufficientTokenBalanceError(error)
              ? 402
              : error instanceof Error && error.name === 'MissingWritingSummaryError'
                ? 409
                : error instanceof Error && error.name === 'MissingWritingMaterialsError'
                  ? 409
                  : 500;

      console.error('[reader-agent:writing-follow-up] request failed', {
        topic: request.topic,
        selectedPapers: request.selectedPapers.length,
        status,
        message,
      });

      return c.json({ error: 'Writing follow-up failed.', message }, status);
    }
  })
  .post('/ask', zValidator('json', readerRequestSchema), async (c) => {
    const request = c.req.valid('json');

    try {
      const { user, storagePath } = await requirePaperAccess(c, request.pdfUrl);
      if (isIdentityQuestion(request.prompt)) {
        return c.json({
          answer: identityAnswerChinese,
          citations: [],
          sources: [],
          scope: request.scope,
          paperId: request.paperId,
          routedBy: 'cheap-context',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            billableTokens: 0,
          },
          tokenAccount: await getUserTokenAccount(user.id),
        });
      }

      await ensurePositiveTokenBalance(user.id);

      const hasPaperContext = Boolean(request.pdfUrl || request.selectedText || request.paperContextSummary);

      if (!hasPaperContext || request.paperId === 'general-chat') {
        const result = await askGeneralChat(request);
        const billableTokens = getUsageBillableTokens(result, result.model);
        const tokenAccount = await recordUserTokenUsage({
          userId: user.id,
          paperId: request.paperId,
          action: 'ask:general-chat',
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          billableTokens,
          metadata: {
            routedBy: 'general-chat',
          },
        });

        return c.json({
          answer: result.answer,
          citations: [],
          sources: [],
          scope: request.scope,
          paperId: request.paperId,
          routedBy: 'cheap-context',
          usage: {
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            billableTokens,
          },
          tokenAccount,
        });
      }

      const paperKey = getPaperIdentitySlug(request);
      const summaryStoragePath = getPaperSummaryStoragePath(request, resolveUploadedPdfStoragePath(request.pdfUrl));
      const cachedSummary = (await downloadTextIfExists(summaryStoragePath)) ?? '';
      const storedHistory = await loadDialogHistory(user.id, paperKey);

      if (request.scope === 'figure') {
        const pageNumbers = normalizeRequestedPageNumbers(request.pageNumbers, request.pageNumber);
        const figureCachePath = getFigureReadingStoragePath({ ...request, pageNumbers, pageNumber: pageNumbers[0] });
        const cachedFigureReading = await loadFigureReadingIfExists(figureCachePath);

        if (cachedFigureReading?.answer.trim()) {
          const now = new Date().toISOString();

          await appendDialogTurns(user.id, paperKey, [
            { role: 'user', content: request.prompt, createdAt: now, readingMode: getReadingMode(request) },
            {
              role: 'assistant',
              content: cachedFigureReading.answer,
              createdAt: now,
              model: cachedFigureReading.model ?? 'saved-figure-reading',
              routedBy: 'expensive-reader',
              inputTokens: 0,
              outputTokens: 0,
              readingMode: getReadingMode(request),
              modePrompt: request.modePrompt,
              answerChinese: cachedFigureReading.answer,
            },
          ]);

          return c.json({
            answer: cachedFigureReading.answer,
            citations: [],
            sources: [],
            scope: request.scope,
            paperId: request.paperId,
            routedBy: 'expensive-reader',
            cached: true,
            cachePath: figureCachePath,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              billableTokens: 0,
            },
            tokenAccount: await getUserTokenAccount(user.id),
          });
        }

        const now = new Date().toISOString();
        const result = await askClaude(
          {
            ...request,
            pageNumber: pageNumbers[0] ?? request.pageNumber,
            pageNumbers,
            paperContextSummary: [cachedSummary, request.paperContextSummary].filter(Boolean).join('\n\n'),
            conversationHistory: storedHistory.slice(-8).map((turn) => ({ role: turn.role, content: turn.content })),
          },
          selectReaderModel(request),
          'chinese',
        );
        const billableTokens = getUsageBillableTokens(result, result.model);
        const tokenAccount = await recordUserTokenUsage({
          userId: user.id,
          paperId: request.paperId,
          action: 'ask:figure-reader',
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          billableTokens,
          metadata: {
            routedBy: 'expensive-reader',
            readingMode: getReadingMode(request),
            pageNumber: request.pageNumber,
            pageNumbers: request.pageNumbers,
          },
        });

        await appendDialogTurns(user.id, paperKey, [
          { role: 'user', content: request.prompt, createdAt: now, readingMode: getReadingMode(request) },
          {
            role: 'assistant',
            content: result.answer,
            createdAt: now,
            model: result.model,
            routedBy: 'expensive-reader',
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            readingMode: getReadingMode(request),
            modePrompt: request.modePrompt,
            answerChinese: result.answer,
          },
        ]);
        await appendSharedPaperDialogTurns(paperKey, [
          {
            role: 'user',
            content: request.prompt,
            createdAt: now,
            readingMode: getReadingMode(request),
            modePrompt: request.modePrompt,
          },
          {
            role: 'assistant',
            content: result.answer,
            createdAt: now,
            model: result.model,
            routedBy: 'expensive-reader',
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            readingMode: getReadingMode(request),
            modePrompt: request.modePrompt,
            answerChinese: result.answer,
          },
        ]);
        await saveFigureReading(figureCachePath, {
          answer: result.answer,
          createdAt: now,
          model: result.model,
          pageNumbers,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });

        return c.json({
          answer: result.answer,
          citations: [],
          sources: result.webSearchResults.map((item) => ({
            title: item.title,
            url: item.url,
            publishedDate: item.publishedDate,
          })),
          scope: request.scope,
          paperId: request.paperId,
          routedBy: 'expensive-reader',
          cached: false,
          cachePath: figureCachePath,
          usage: {
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            billableTokens,
          },
          tokenAccount,
        });
      }

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

      const sourceLanguage = await detectSourceLanguageForAsk(request, storagePath);
      const shouldUseTranslationPipeline = isQualityReadingMode(request) && sourceLanguage === 'english';
      const shouldAskExpensiveReaderInChinese = !shouldUseTranslationPipeline;
      const translatedPrompt = shouldAskExpensiveReaderInChinese
        ? { text: request.prompt, model: 'source-language-direct', inputTokens: 0, outputTokens: 0 }
        : await translateUserQuestionToEnglish(request);
      const nowForTranslatedPipeline = new Date().toISOString();
      let memoryResult;

      console.log('[reader-agent:ask] source language routing', {
        paperId: request.paperId,
        sourceLanguage,
        readingMode: getReadingMode(request),
        translationPipeline: shouldUseTranslationPipeline,
        expensiveReaderLanguage: shouldAskExpensiveReaderInChinese ? 'chinese' : 'english',
      });

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

      const expensiveReaderLanguage = shouldAskExpensiveReaderInChinese ? 'chinese' : 'english';
      const expensiveSystemPrompt = buildReaderSystemPrompt(true, false, request.modePrompt, expensiveReaderLanguage);
      const expensiveContext = [
        cachedSummary ? `Cached paper brief:\n${cachedSummary.slice(0, 12000)}` : null,
        memoryResult.result.contextSummary ? `Cheap retrieval context:\n${memoryResult.result.contextSummary}` : null,
        externalEvaluations.length ? `External evaluations by other papers:\n${formatExternalReferenceEvaluations(externalEvaluations).slice(0, 12000)}` : null,
      ]
        .filter(Boolean)
        .join('\n\n');
      const expensiveModelSelection = isExpertReviewPrompt(request.prompt) ? selectExpertReviewModel() : selectExpensiveReaderModel();
      const expensiveTranslatedResult = await askClaude(
        {
          ...request,
          prompt: memoryResult.result.expensivePrompt?.trim() || translatedPrompt.text,
          paperContextSummary: expensiveContext,
          conversationHistory: [],
        },
        expensiveModelSelection,
        expensiveReaderLanguage,
      );
      const translatedAnswer = shouldAskExpensiveReaderInChinese
        ? { text: expensiveTranslatedResult.answer, model: 'source-language-direct', inputTokens: 0, outputTokens: 0 }
        : await translateReaderAnswerToChinese(expensiveTranslatedResult.answer, request);
      const translatedInputTokens = memoryInputTokens + expensiveTranslatedResult.inputTokens + translatedAnswer.inputTokens;
      const translatedOutputTokens = memoryOutputTokens + expensiveTranslatedResult.outputTokens + translatedAnswer.outputTokens;
      const translatedBillableTokens =
        getBillableTokens(memoryInputTokens, memoryOutputTokens, memoryResult.model) +
        getUsageBillableTokens(expensiveTranslatedResult, expensiveTranslatedResult.model) +
        getUsageBillableTokens(translatedAnswer, translatedAnswer.model);
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
      const status = message === 'Not authenticated.' ? 401 : message === 'You do not have access to this PDF.' ? 403 : isInsufficientTokenBalanceError(error) ? 402 : 500;

      return c.json({ error: 'Reader agent failed.', message }, status);
    }
  })
  .post('/image', zValidator('json', imageRequestSchema), async (c) => {
    const request = c.req.valid('json');

    try {
      const { user } = await requirePaperAccess(c);
      await ensurePositiveTokenBalance(user.id);

      const result = await generateImage(request);
      const billableTokens = getUsageBillableTokens(result, result.model);
      const tokenAccount = await recordUserTokenUsage({
        userId: user.id,
        paperId: request.paperId,
        action: 'image:generate',
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        billableTokens,
        metadata: {
          hasTitle: Boolean(request.title),
          hasSelectedText: Boolean(request.selectedText),
        },
      });

      return c.json({
        ...result,
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          billableTokens,
        },
        tokenAccount,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Image generation failed.';
      const status = message === 'Not authenticated.' ? 401 : isInsufficientTokenBalanceError(error) ? 402 : 500;

      return c.json({ error: 'Image generation failed.', message }, status);
    }
  })
  .post('/financial-analysis', zValidator('json', financialAnalysisRequestSchema), async (c) => {
    const request = c.req.valid('json');

    try {
      const user = await getCurrentUser(getCookie(c, sessionCookieName));
      if (!user) return c.json({ error: 'Not authenticated.' }, 401);
      if (!(await isFinancialAnalysisEnabled(user))) return c.json({ error: 'Financial analysis is not enabled.', message: '財務分析功能需要單獨開通。' }, 403);

      await ensurePositiveTokenBalance(user.id);

      const result = await buildFinancialAnalysis(user, request);
      const baseBillableTokens = getUsageBillableTokens(result, result.model);
      const billableTokens = baseBillableTokens * FINANCIAL_ANALYSIS_BILLING_MULTIPLIER;
      const tokenAccount = await recordUserTokenUsage({
        userId: user.id,
        paperId: `financial:${request.stock.code}:${Date.now()}`,
        action: 'financial:analysis',
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        billableTokens,
        metadata: {
          topic: request.topic,
          stock: request.stock,
          analysisMode: request.analysisMode ?? 'normal',
          cacheCreationInputTokens: result.cacheCreationInputTokens,
          cacheReadInputTokens: result.cacheReadInputTokens,
          baseBillableTokens,
          billingMultiplier: FINANCIAL_ANALYSIS_BILLING_MULTIPLIER,
        },
      });
      await appendFinancialStockArchive(user.id, request.stock, {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        question: request.topic?.trim() || '請綜合分析上傳的財務報告、走勢圖、K 線和盤口材料。',
        answer: result.answer,
        model: result.model,
        materialNames: [],
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          baseBillableTokens,
          billableTokens,
          billingMultiplier: FINANCIAL_ANALYSIS_BILLING_MULTIPLIER,
        },
      });
      const now = new Date().toISOString();
      await appendFinancialDialogTurns(user.id, request.stock, [
        {
          role: 'user',
          content: request.topic?.trim() || '請綜合分析上傳的財務報告、走勢圖、K 線和盤口材料。',
          createdAt: now,
        },
        {
          role: 'assistant',
          content: result.answer,
          createdAt: now,
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
      ]);
      await recordFinancialAnalysisReport({
        userId: user.id,
        stockName: request.stock.name,
        stockCode: request.stock.code,
        stockMarket: request.stock.market,
        question: request.topic?.trim() || '請綜合分析上傳的財務報告、走勢圖、K 線和盤口材料。',
        answer: result.answer,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        baseBillableTokens,
        billableTokens,
        billingMultiplier: FINANCIAL_ANALYSIS_BILLING_MULTIPLIER,
      });

      return c.json({
        answer: result.answer,
        model: result.model,
        files: result.files,
        stock: request.stock,
        archiveEntryCount: result.archiveEntryCount + 1,
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheCreationInputTokens: result.cacheCreationInputTokens,
          cacheReadInputTokens: result.cacheReadInputTokens,
          baseBillableTokens,
          billableTokens,
          billingMultiplier: FINANCIAL_ANALYSIS_BILLING_MULTIPLIER,
        },
        tokenAccount,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Financial analysis failed.';
      const status = message === 'Not authenticated.' ? 401 : message === '財務分析功能需要單獨開通。' ? 403 : isInsufficientTokenBalanceError(error) ? 402 : 500;

      console.error('[reader-agent:financial-analysis] request failed', { message });
      return c.json({ error: 'Financial analysis failed.', message }, status);
    }
  })
  .get('/financial-analysis/history', async (c) => {
    try {
      const user = await getCurrentUser(getCookie(c, sessionCookieName));
      if (!user) return c.json({ error: 'Not authenticated.' }, 401);

      const name = c.req.query('name')?.trim();
      const code = c.req.query('code')?.trim();
      if (!name || !code) return c.json({ error: 'Missing stock.', message: '请先选择股票。' }, 400);

      const history = await loadFinancialDialogHistory(user.id, { name, code });

      return c.json({ history });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Financial history failed.';

      console.error('[reader-agent:financial-analysis-history] request failed', { message });
      return c.json({ error: 'Financial history failed.', message }, 500);
    }
  })
  .get('/financial-analysis/reports', async (c) => {
    try {
      const user = await getCurrentUser(getCookie(c, sessionCookieName));
      if (!user) return c.json({ error: 'Not authenticated.' }, 401);

      const rows = await listFinancialAnalysisReports(user.id, 60);
      const reports = rows.map((row) => ({
        id: row.id,
        stock: {
          name: row.stock_name,
          code: row.stock_code,
          market: row.stock_market,
        },
        question: row.question,
        answer: row.answer,
        model: row.model,
        createdAt: row.created_at,
        usage: {
          inputTokens: Number(row.input_tokens),
          outputTokens: Number(row.output_tokens),
          baseBillableTokens: Number(row.base_billable_tokens),
          billableTokens: Number(row.billable_tokens),
          billingMultiplier: Number(row.billing_multiplier),
        },
      }));

      return c.json({ reports });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Financial reports failed.';

      console.error('[reader-agent:financial-analysis-reports] request failed', { message });
      return c.json({ error: 'Financial reports failed.', message }, 500);
    }
  })
  .post('/stock-quotes', zValidator('json', stockQuotesRequestSchema), async (c) => {
    const request = c.req.valid('json');

    try {
      const user = await getCurrentUser(getCookie(c, sessionCookieName));
      if (!user) return c.json({ error: 'Not authenticated.' }, 401);

      const quotes = await fetchStockQuotes(request.watchlist);

      return c.json({ quotes, updatedAt: new Date().toISOString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Stock quotes failed.';

      console.error('[reader-agent:stock-quotes] request failed', { message });
      return c.json({ error: 'Stock quotes failed.', message }, 500);
    }
  })
  .post('/summarize', zValidator('json', readerRequestSchema), async (c) => {
    const request = c.req.valid('json');

    try {
      const { user } = await requirePaperAccess(c, request.pdfUrl);
      await ensurePositiveTokenBalance(user.id);

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
        const citedCachedSummary = withIeeeCitationPreface(cachedSummary, request);
        const shouldUpdateCachedSummaryCitation = citedCachedSummary !== cachedSummary.trim();
        let freshness;

        try {
          freshness = await checkSummaryFreshnessWithCheapModel(request, citedCachedSummary);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Cheap summary freshness check failed.';

          console.error('[reader-agent:summarize] cheap freshness check failed; reusing cached summary', {
            paperId: request.paperId,
            message,
          });

          return c.json({
            summary: citedCachedSummary,
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

          if (shouldUpdateCachedSummaryCitation) {
            await uploadTextAsAdmin(citedCachedSummary, summaryStoragePath);
          }

          return c.json({
            summary: citedCachedSummary,
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
          summary: citedCachedSummary,
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
        const summary = withIeeeCitationPreface(translatedSummary.text, request);

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
          `请用中文生成一份精简的跨学科论文阅读报告。只包含：核心技术机制、关键结�?参数/方法�?-6个最重要数值、证据强度、主要局限。不要逐段复述，不要逐图逐公式展开，不要列可追问索引。输�?Markdown，尽量控制在1000字以内。`,
        paperContextSummary: '',
        conversationHistory: [],
      }, selectExpensiveReaderModel(), 'english');
      const translatedSummary = await translateReaderAnswerToChinese(result.answer, request);
      const summary = withIeeeCitationPreface(translatedSummary.text, request);

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
      const status = message === 'Not authenticated.' ? 401 : message === 'You do not have access to this PDF.' ? 403 : isInsufficientTokenBalanceError(error) ? 402 : 500;

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



