import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { downloadFileAsAdmin, uploadFileAsAdmin } from '@/lib/firebase/server/storage-admin';

type ExtractedPdfPage = {
  pageNumber: number;
  text: string;
};

type ExtractedPdf = {
  pages: ExtractedPdfPage[];
  text: string;
  figureCaptions: string[];
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
  paperContextSummary: z.string().optional(),
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

const getPdfjsStandardFontDataUrl = () => {
  const pdfjsDistDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist');
  const standardFontsDir = path.join(pdfjsDistDir, 'standard_fonts');

  return pathToFileURL(`${standardFontsDir}${path.sep}`).href;
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

const extractPdfText = async (localPdfPath: string): Promise<ExtractedPdf> => {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await fs.readFile(localPdfPath));
  const pdf = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true, standardFontDataUrl: getPdfjsStandardFontDataUrl() }).promise;
  const pages: ExtractedPdfPage[] = [];

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

  return {
    pages,
    text,
    figureCaptions: extractFigureCaptions(fullText),
  };
};

const renderPdfPageImages = async (localPdfPath: string, pageNumbers?: number[]): Promise<PdfPageImage[]> => {
  const canvas = await ensurePdfCanvasPolyfills();
  const pdfjs = await loadPdfjs();

  const data = new Uint8Array(await fs.readFile(localPdfPath));
  const pdf = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true, standardFontDataUrl: getPdfjsStandardFontDataUrl() }).promise;
  const pagesToRender = (pageNumbers?.length ? pageNumbers : Array.from({ length: Math.min(pdf.numPages, MAX_PAGE_IMAGES) }, (_, index) => index + 1))
    .filter((pageNumber) => pageNumber >= 1 && pageNumber <= pdf.numPages)
    .slice(0, MAX_PAGE_IMAGES);
  const images: PdfPageImage[] = [];

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

const materializePdfToTempFile = async (storagePath: string) => {
  const { buffer } = await downloadFileAsAdmin(storagePath);
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scireader-pdf-'));
  const localPdfPath = path.join(outputDir, 'paper.pdf');

  await fs.writeFile(localPdfPath, buffer);

  return { localPdfPath, outputDir, buffer };
};

const getPaperSummaryStoragePath = (pdfStoragePath: string) => `${pdfStoragePath}.reader-summary.deep-v1.md`;

const downloadTextIfExists = async (filePath: string) => {
  try {
    const { buffer } = await downloadFileAsAdmin(filePath);

    return buffer.toString('utf8');
  } catch {
    return null;
  }
};

const buildSystemPrompt = (hasPdfContext: boolean, hasWebSearch: boolean) => {
  const basePrompt = hasPdfContext
    ? `你是 SCIReader 的论文阅读助手。请用中文回答用户问题。
重点能力：翻译论文标题、摘要、结论；提取公式并给出 LaTeX；解释图表；总结创新点、不足、相关前人工作。
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

const buildReaderSystemPrompt = (hasPdfContext: boolean, hasWebSearch: boolean) => {
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
};

const askClaude = async (request: z.infer<typeof readerRequestSchema>) => {
  const storagePath = resolveUploadedPdfStoragePath(request.pdfUrl);
  const tempPdf = storagePath ? await materializePdfToTempFile(storagePath) : null;
  const localPdfPath = tempPdf?.localPdfPath;

  try {
    const extractedPdf = localPdfPath ? await extractPdfText(localPdfPath) : undefined;
    const webSearchResults = await searchWebForPrompt(request.prompt);
    const hasWebSearch = webSearchResults.length > 0;
    let pageImages: PdfPageImage[] = [];

    if (localPdfPath) {
      try {
        pageImages = await renderPdfPageImages(localPdfPath, request.scope === 'current-page' && request.pageNumber ? [request.pageNumber] : undefined);
      } catch (error) {
        console.error('PDF page rendering failed.', error);
      }
    }

    const modelSelection = selectReaderModel(request);
    const client = createAnthropicClient(modelSelection.target);
    const content: Anthropic.MessageParam['content'] = [{ type: 'text', text: buildReaderUserPrompt(request, extractedPdf, webSearchResults) }];

    for (const image of pageImages) {
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
      system: buildReaderSystemPrompt(Boolean(localPdfPath || extractedPdf || request.selectedText || request.paperContextSummary), hasWebSearch),
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

const app = new Hono()
  .post('/ask', zValidator('json', readerRequestSchema), async (c) => {
    const request = c.req.valid('json');

    try {
      const result = await askClaude(request);

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
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Reader agent failed.';

      return c.json({ error: 'Reader agent failed.', message }, 500);
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
    const storagePath = resolveUploadedPdfStoragePath(request.pdfUrl);
    const summaryStoragePath = storagePath ? getPaperSummaryStoragePath(storagePath) : null;

    try {
      const cachedSummary = summaryStoragePath ? await downloadTextIfExists(summaryStoragePath) : null;

      if (cachedSummary?.trim()) {
        return c.json({
          summary: cachedSummary,
          cached: true,
          scope: request.scope,
          paperId: request.paperId,
        });
      }

      const result = await askClaude({
        ...request,
        scope: 'whole-paper',
        prompt:
          request.prompt ||
          `请用中文生成一份深度论文阅读笔记，不要短摘要。请展开分析背景、方法、实验、结果、局限；逐图说明每个 Figure/Table 的含义；逐公式或逐关键参数解释变量、指标和工程意义；保留关键数值证据；最后列出可追问索引。输出 Markdown。`,
      });
      const summary = result.answer;

      if (summaryStoragePath && summary.trim()) {
        await uploadFileAsAdmin(Buffer.from(summary, 'utf8'), summaryStoragePath, 'text/markdown; charset=utf-8');
      }

      return c.json({
        summary,
        cached: false,
        scope: request.scope,
        paperId: request.paperId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Paper summary failed.';

      return c.json({ error: 'Paper summary failed.', message }, 500);
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
