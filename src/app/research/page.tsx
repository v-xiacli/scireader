'use client';

import { ArrowLeft, ArrowRight, Loader2, PenLine, Trash2, WalletCards } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { LanguageToggle, localizeBilingualText, useLanguage } from '@/components/language/language-context';
import type { PaperReadingMode, PaperSummary } from '@/types/paper';

type AuthMode = 'login' | 'signup';
type AuthUser = { id: string; email: string };
type TokenEstimate = { inputTokens: number; billableTokens?: number; tokenWeight?: number; model: string };
type TokenAccount = { tokenBalance: number; tokenUsed: number; tokenAvailable: number };
type WritingLanguage = 'chinese' | 'english';
type WritingResult = {
  draft: string;
  references: string[];
  storagePath: string;
  savedAt: string;
  article?: WritingArticle | null;
  processing?: boolean;
  missingSummaries?: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    baseBillableTokens: number;
    billableTokens: number;
    billingMultiplier: number;
  };
};
type WritingArticle = {
  id: string;
  topic: string;
  outputLanguage: WritingLanguage;
  storagePath: string;
  savedAt: string;
  kind: 'introduction' | 'follow-up';
  selectedPaperCount: number;
  billableTokens?: number;
};
type ViewerPreferences = {
  readingMode?: PaperReadingMode;
  detailedReport?: boolean;
};
type ExtractedPaperMetadata = {
  paperKey: string;
  title?: string;
  authors?: string[];
  journal?: string;
  year?: string;
};

const readingModes: Array<{ id: PaperReadingMode; label: string; description: string }> = [
  { id: 'quality', label: 'High Quality / 高质量', description: 'Highest-quality reading; English materials are read in English first, then converted to Chinese output. / 最高质量解读；英文材料会先走英文精读，再转为中文输出。' },
  { id: 'detailed', label: 'Detailed / 详细', description: 'Generate a full Chinese report directly without an extra translation route. / 直接用中文生成完整报告，不额外走翻译链路。' },
  { id: 'simple', label: 'Simple / 简单', description: 'Generate a concise Chinese overview directly for quick understanding. / 直接用中文生成精简速览，适合快速了解。' },
];

const taskModes: Array<{ id: 'read' | 'review'; label: string; description: string }> = [
  { id: 'read', label: 'Read / 阅读', description: 'Read and explain the paper. / 阅读并解释论文。' },
  { id: 'review', label: 'Review / 审稿', description: 'Ask for a target journal first, then generate reviewer-style analysis and English review comments. / 先询问目标期刊，再生成审稿式分析和英文审稿意见。' },
];

const normalizeResearchReadingMode = (mode?: PaperReadingMode): PaperReadingMode => {
  if (mode === 'quality' || mode === 'detailed' || mode === 'simple') return mode;
  if (mode === 'reviewer') return 'detailed';
  if (mode === 'reader') return 'simple';

  return 'detailed';
};

const getResearchReadingModeLabel = (mode: PaperReadingMode) => {
  const normalizedMode = normalizeResearchReadingMode(mode);

  return readingModes.find((item) => item.id === normalizedMode)?.label ?? 'Detailed / 详细';
};

const normalizeDownloadUrl = (downloadUrl: string) => {
  const trimmed = downloadUrl.trim();

  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) return trimmed;
  if (trimmed.startsWith('api/')) return `/${trimmed}`;

  return `https://${trimmed}`;
};

const fallbackPaperKey = (fileName: string) => fileName.replace(/\.pdf$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'uploadedpaper';

const getUploadedFileTitle = (fileName: string) => fileName.replace(/\.pdf$/i, '').trim() || 'Uploaded paper';

const getUploadedFileTitleFromPath = (filePath?: string) => {
  const fileName = filePath?.split('/').pop()?.replace(/^\d+-/, '') ?? '';

  return getUploadedFileTitle(fileName);
};

const shouldPreferUploadedFileTitle = (metadataTitle: string | undefined, fileTitle: string) => {
  const normalizedMetadataTitle = metadataTitle?.trim().toLowerCase() ?? '';

  if (!normalizedMetadataTitle) return true;
  if (/^microsoft word\s*-/i.test(normalizedMetadataTitle)) return true;
  if (/^[a-z]*v\d+[a-z0-9_-]*$/i.test(normalizedMetadataTitle)) return true;

  return false;
};

const shouldRepairUploadedPaperMetadata = (paper: PaperSummary) => {
  const title = paper.title.trim();
  const fileTitle = getUploadedFileTitleFromPath(paper.filePath);

  return (
    Boolean(paper.filePath && paper.pdfUrl) &&
    (/^microsoft word\s*-/i.test(title) ||
      title === fileTitle ||
      /^[a-z]*v\d+[a-z0-9_-]*$/i.test(title) ||
      !paper.authors ||
      paper.authors === 'Uploaded paper')
  );
};

const getUploadedPaperId = (baseId: string, filePath: string) => {
  const filePart = filePath.split('/').pop()?.replace(/\.pdf$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);

  return [baseId, filePart].filter(Boolean).join('-') || baseId;
};

const normalizeUploadedPaperForDisplay = (paper: PaperSummary): PaperSummary => {
  if (!paper.filePath) return paper;

  const fileTitle = getUploadedFileTitleFromPath(paper.filePath);
  const title = shouldPreferUploadedFileTitle(paper.title, fileTitle) ? fileTitle : paper.title;
  const id = getUploadedPaperId(paper.id || fallbackPaperKey(fileTitle), paper.filePath);

  return { ...paper, id, title };
};

const getBillingModeLabel = (model?: string) => {
  const normalizedModel = model?.toLowerCase() ?? '';

  if (normalizedModel.includes('5.5')) return 'pro';
  if (normalizedModel.includes('5.4-mini')) return 'min';
  if (normalizedModel.includes('5.4')) return 'normal';

  return 'normal';
};

const formatArticleDate = (value: string) => {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const HomePage = () => {
  const router = useRouter();
  const { language } = useLanguage();
  const b = (value: string) => localizeBilingualText(value, language);
  const l = (en: string, zh: string) => language === 'zh' ? zh : en;
  const isSignupVerificationEnabled = true;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const estimatedPaperIdRef = useRef<string | null>(null);
  const metadataRepairAttemptedRef = useRef(new Set<string>());
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [isIntroductionWritingEnabled, setIsIntroductionWritingEnabled] = useState(false);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [isSendingVerificationCode, setIsSendingVerificationCode] = useState(false);
  const [isSessionLoading, setIsSessionLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadedPapers, setUploadedPapers] = useState<PaperSummary[]>([]);
  const [deletingFilePath, setDeletingFilePath] = useState<string | null>(null);
  const [tokenEstimate, setTokenEstimate] = useState<TokenEstimate | null>(null);
  const [tokenEstimateMessage, setTokenEstimateMessage] = useState('Upload a PDF to estimate tokens. / 上传 PDF 后估算 token。');
  const [tokenAccount, setTokenAccount] = useState<TokenAccount | null>(null);
  const [readingMode, setReadingMode] = useState<PaperReadingMode>('detailed');
  const [paperTaskMode, setPaperTaskMode] = useState<'read' | 'review'>('read');
  const [detailedReport, setDetailedReport] = useState(false);
  const [selectedPaperKey, setSelectedPaperKey] = useState('');
  const [writingTopic, setWritingTopic] = useState('');
  const [writingLanguage, setWritingLanguage] = useState<WritingLanguage>('chinese');
  const [writingSelectedPaperKeys, setWritingSelectedPaperKeys] = useState<string[]>([]);
  const [isWriting, setIsWriting] = useState(false);
  const [writingMessage, setWritingMessage] = useState<string | null>(null);
  const [writingResult, setWritingResult] = useState<WritingResult | null>(null);
  const [writingFollowUp, setWritingFollowUp] = useState('');
  const [isWritingFollowUp, setIsWritingFollowUp] = useState(false);
  const [writingArticles, setWritingArticles] = useState<WritingArticle[]>([]);
  const [writingSelectedArticlePaths, setWritingSelectedArticlePaths] = useState<string[]>([]);
  const [deletingWritingPath, setDeletingWritingPath] = useState<string | null>(null);
  const [loadingWritingPath, setLoadingWritingPath] = useState<string | null>(null);

  const isLoggedIn = Boolean(authUser);
  const papers = uploadedPapers;
  const getWritingPaperKey = (paper: PaperSummary) => paper.filePath ?? paper.id;
  const selectedPaper = papers.find((paper) => getWritingPaperKey(paper) === selectedPaperKey) ?? papers.find((paper) => paper.filePath) ?? null;
  const selectedWritingPapers = uploadedPapers.filter((paper) => writingSelectedPaperKeys.includes(getWritingPaperKey(paper)));
  const selectedWritingArticles = writingArticles.filter((article) => writingSelectedArticlePaths.includes(article.storagePath));
  const selectedWritingMaterialCount = selectedWritingPapers.length + selectedWritingArticles.length;

  const applyViewerPreferences = (preferences?: ViewerPreferences | null) => {
    if (preferences?.readingMode) setReadingMode(normalizeResearchReadingMode(preferences.readingMode));
    if (typeof preferences?.detailedReport === 'boolean') setDetailedReport(preferences.detailedReport);
  };

  const loadViewerPreferences = async () => {
    try {
      const response = await fetch('/api/auth/viewer-preferences');
      const result = await response.json();

      if (response.ok) applyViewerPreferences(result.preferences);
    } catch {}
  };

  const saveReadingPreferences = (next: { readingMode?: PaperReadingMode; detailedReport?: boolean }) => {
    if (!isLoggedIn) return;

    void fetch('/api/auth/viewer-preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
  };

  const loadUploadedPapers = async () => {
    try {
      const response = await fetch('/api/auth/uploaded-papers');
      const result = await response.json();
      const papers = response.ok ? (result.papers as PaperSummary[]).map(normalizeUploadedPaperForDisplay) : [];
      setUploadedPapers(papers);
      setSelectedPaperKey((current) => current || papers.find((paper: PaperSummary) => paper.filePath)?.filePath || '');
      if (!papers.some((paper: PaperSummary) => paper.filePath)) setTokenEstimateMessage('Upload a PDF to estimate tokens. / 上传 PDF 后估算 token。');
    } catch {
      setUploadedPapers([]);
      setTokenEstimateMessage('Upload a PDF to estimate tokens. / 上传 PDF 后估算 token。');
    }
  };

  const loadWritingArticles = async () => {
    try {
      const response = await fetch('/api/reader-agent/writing-results');
      const result = await response.json();

      setWritingArticles(response.ok ? result.articles : []);
    } catch {
      setWritingArticles([]);
    }
  };

  const loadTokenAccount = async () => {
    try {
      const response = await fetch('/api/auth/token-account');
      const result = await response.json();

      if (response.ok) setTokenAccount(result.tokenAccount);
      else setTokenAccount(null);
    } catch {
      setTokenAccount(null);
    }
  };

  useEffect(() => {
    const loadSession = async () => {
      try {
        const response = await fetch('/api/auth/me');
        const result = await response.json();

        if (response.ok && result.user) {
          setAuthUser(result.user);
          setIsIntroductionWritingEnabled(Boolean(result.introductionWritingEnabled));
          if (result.tokenAccount) setTokenAccount(result.tokenAccount);
          await loadViewerPreferences();
          await loadUploadedPapers();
          await loadWritingArticles();
        }
      } catch {
        setAuthUser(null);
        setIsIntroductionWritingEnabled(false);
      } finally {
        setIsSessionLoading(false);
      }
    };

    void loadSession();
  }, []);

  useEffect(() => {
    const newestUploadedPaper = uploadedPapers.find((paper) => paper.filePath);

    if (!newestUploadedPaper) {
      setTokenEstimate(null);
      setTokenEstimateMessage('Upload a PDF to estimate tokens. / 上传 PDF 后估算 token。');
      return;
    }

    if (estimatedPaperIdRef.current === newestUploadedPaper.id) return;

    estimatedPaperIdRef.current = newestUploadedPaper.id;
    setTokenEstimateMessage('Estimating latest uploaded PDF... / 正在估算最新上传的 PDF...');
    void estimateTokenConsumption(newestUploadedPaper);
  }, [uploadedPapers]);

  useEffect(() => {
    if (!isLoggedIn) return;

    const papersToRepair = uploadedPapers.filter(shouldRepairUploadedPaperMetadata).slice(0, 3);
    if (!papersToRepair.length) return;

    void Promise.all(papersToRepair.map((paper) => repairUploadedPaperMetadata(paper)));
  }, [isLoggedIn, uploadedPapers]);

  const handleAuth = async () => {
    setIsAuthLoading(true);
    setAuthMessage(null);

    try {
      const response = await fetch(`/api/auth/${authMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authMode === 'signup' && isSignupVerificationEnabled ? { email, password, verificationCode } : { email, password }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.error ?? result.message ?? 'Authentication failed.');

      setAuthUser(result.user);
      setIsIntroductionWritingEnabled(Boolean(result.introductionWritingEnabled));
      if (result.tokenAccount) setTokenAccount(result.tokenAccount);
      else await loadTokenAccount();
      await loadViewerPreferences();
      await loadUploadedPapers();
      await loadWritingArticles();
      setAuthMessage(`${authMode === 'signup' ? 'Account created' : 'Logged in'} as ${result.user.email}.`);
      setPassword('');
      setVerificationCode('');
      setUploadMessage(null);
    } catch (error) {
      if (authMode === 'login') {
        window.alert('please sign up');
      }

      setAuthMessage(error instanceof Error ? error.message : 'Authentication failed.');
    } finally {
      setIsAuthLoading(false);
    }
  };

  const handleSendVerificationCode = async () => {
    setIsSendingVerificationCode(true);
    setAuthMessage(null);

    try {
      const response = await fetch('/api/auth/send-verification-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Could not send verification code.');

      setAuthMessage('Verification code sent. Please check your email.');
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : 'Could not send verification code.');
    } finally {
      setIsSendingVerificationCode(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setAuthUser(null);
    setIsIntroductionWritingEnabled(false);
    setTokenAccount(null);
    setUploadedPapers([]);
    setWritingArticles([]);
    setWritingSelectedPaperKeys([]);
    setWritingSelectedArticlePaths([]);
    setAuthMessage('Logged out.');
  };

  const estimateTokenConsumption = async (paper: PaperSummary) => {
    if (!paper.filePath) return;

    setTokenEstimate(null);
    setTokenEstimateMessage('Calculating PDF input tokens... / 正在计算 PDF 输入 token...');

    try {
      const response = await fetch('/api/reader-agent/count-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paperId: paper.id,
          pdfUrl: paper.pdfUrl,
          title: paper.title,
          journal: paper.journal,
          year: paper.year,
          prompt: 'Please summarize this document. / 请总结这篇文档。',
        }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Token estimate failed.');

      setTokenEstimate({ inputTokens: result.inputTokens, billableTokens: result.billableTokens, tokenWeight: result.tokenWeight, model: result.model });
      setTokenEstimateMessage('Estimated before AI analysis. / AI 分析前预估。');
    } catch (error) {
      setTokenEstimateMessage(error instanceof Error ? error.message : 'Token estimate failed.');
    }
  };

  const extractPaperMetadata = async (pdfUrl: string, fallbackTitle: string): Promise<ExtractedPaperMetadata> => {
    const response = await fetch('/api/reader-agent/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfUrl, fallbackTitle }),
    });
    const result = await response.json();

    if (!response.ok) throw new Error(result.message ?? result.error ?? 'PDF metadata extraction failed.');

    return result;
  };

  const repairUploadedPaperMetadata = async (paper: PaperSummary) => {
    if (!paper.filePath || !paper.pdfUrl || metadataRepairAttemptedRef.current.has(paper.filePath)) return;

    metadataRepairAttemptedRef.current.add(paper.filePath);

    try {
      const fallbackTitle = getUploadedFileTitleFromPath(paper.filePath);
      const metadata = await extractPaperMetadata(paper.pdfUrl, fallbackTitle);
      const metadataTitle = metadata.title?.trim();
      const title = shouldPreferUploadedFileTitle(metadataTitle, fallbackTitle) ? fallbackTitle : metadataTitle ?? fallbackTitle;
      const authors = metadata.authors?.filter(Boolean).join(', ') || paper.authors;
      const repairedPaper: PaperSummary = normalizeUploadedPaperForDisplay({
        ...paper,
        id: getUploadedPaperId(metadata.paperKey || paper.id || fallbackPaperKey(fallbackTitle), paper.filePath),
        title,
        authors,
        journal: metadata.journal?.trim() || paper.journal,
        year: metadata.year?.trim() || paper.year,
      });

      if (
        repairedPaper.title === paper.title &&
        repairedPaper.authors === paper.authors &&
        repairedPaper.journal === paper.journal &&
        repairedPaper.year === paper.year
      ) return;

      setUploadedPapers((current) => current.map((item) => item.filePath === paper.filePath ? repairedPaper : item));

      await fetch('/api/auth/uploaded-papers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(repairedPaper),
      });
    } catch {
      // Metadata repair is best-effort; uploading and reading should still work if it fails.
    }
  };

  const handleUpload = async (file: File) => {
    if (!isLoggedIn) {
      setUploadMessage('Please log in before uploading a paper. / 请先登录再上传论文。');
      return;
    }

    if (file.type !== 'application/pdf') {
      setUploadMessage('Please choose a PDF file. / 请选择 PDF 文件。');
      return;
    }

    setIsUploading(true);
    setUploadMessage(null);

    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-');

      const formData = new FormData();
      formData.append('file', file);
      formData.append('filePath', `${Date.now()}-${safeName}`);

      const response = await fetch('/api/storage/upload/private', {
        method: 'POST',
        body: formData,
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Upload failed.');

      const fallbackTitle = getUploadedFileTitle(file.name);
      const metadata = await extractPaperMetadata(normalizeDownloadUrl(result.downloadUrl), fallbackTitle);
      const metadataTitle = metadata.title?.trim();
      const paperTitleValue = shouldPreferUploadedFileTitle(metadataTitle, fallbackTitle) ? fallbackTitle : metadataTitle ?? fallbackTitle;
      const authorNames = metadata.authors?.filter(Boolean) ?? [];
      const paperId = getUploadedPaperId(metadata.paperKey || fallbackPaperKey(file.name), result.filePath);
      const uploadedPaper: PaperSummary = {
        id: paperId,
        title: paperTitleValue,
        authors: authorNames.length ? authorNames.join(', ') : 'Uploaded paper',
        pages: 0,
        status: 'uploaded',
        abstract: 'Uploaded PDF ready for reading and chat.',
        pdfUrl: normalizeDownloadUrl(result.downloadUrl),
        filePath: result.filePath,
        journal: metadata.journal?.trim(),
        year: metadata.year?.trim(),
        readingMode,
        detailedReport: readingMode !== 'simple',
      };

      const saveResponse = await fetch('/api/auth/uploaded-papers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(uploadedPaper),
      });
      const saveResult = await saveResponse.json();

      if (saveResponse.ok) {
        setUploadedPapers((saveResult.papers as PaperSummary[]).map(normalizeUploadedPaperForDisplay));
        setSelectedPaperKey(uploadedPaper.filePath ?? uploadedPaper.id);
      }

      void estimateTokenConsumption(uploadedPaper);
      setUploadMessage('Paper uploaded. Select a paper and mode from the list, then click Read. / 论文已上传。请在列表中选定论文和模式，再点击解读。');
    } catch (error) {
      setUploadMessage(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  const startPaperReading = (paper: PaperSummary | null = selectedPaper, taskModeOverride?: 'read' | 'review') => {
    if (!paper?.filePath) {
      setUploadMessage('Please select one uploaded paper first. / 请先选定一篇已上传论文。');
      return;
    }

    const normalizedDepth = normalizeResearchReadingMode(readingMode);
    const selectedTaskMode = taskModeOverride ?? paperTaskMode;
    const requestMode: PaperReadingMode = selectedTaskMode === 'review' ? 'reviewer' : normalizedDepth;
    const nextDetailedReport = normalizedDepth !== 'simple';

    saveReadingPreferences({ readingMode: normalizedDepth, detailedReport: nextDetailedReport });
    router.push(`/papers/${encodeURIComponent(paper.id)}?pdfUrl=${encodeURIComponent(paper.pdfUrl)}&filePath=${encodeURIComponent(paper.filePath)}&title=${encodeURIComponent(paper.title)}&authors=${encodeURIComponent(paper.authors)}&journal=${encodeURIComponent(paper.journal ?? '')}&year=${encodeURIComponent(paper.year ?? '')}&readingMode=${requestMode}&detailedReport=${nextDetailedReport ? '1' : '0'}&start=1`);
  };

  const handleRemovePaper = async (paper: PaperSummary) => {
    if (!paper.filePath || deletingFilePath) return;

    setDeletingFilePath(paper.filePath);
    setUploadMessage(null);

    try {
      const response = await fetch('/api/auth/uploaded-papers', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: paper.filePath }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Could not remove paper.');

      setUploadedPapers((result.papers as PaperSummary[]).map(normalizeUploadedPaperForDisplay));
      setWritingSelectedPaperKeys((current) => current.filter((key) => key !== getWritingPaperKey(paper)));
      setUploadMessage('Removed. / 已移除。');
    } catch (error) {
      setUploadMessage(error instanceof Error ? error.message : 'Could not remove paper.');
    } finally {
      setDeletingFilePath(null);
    }
  };

  const toggleWritingPaper = (paper: PaperSummary) => {
    const key = getWritingPaperKey(paper);

    setWritingSelectedPaperKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  };

  const toggleWritingArticle = (article: WritingArticle) => {
    setWritingSelectedArticlePaths((current) =>
      current.includes(article.storagePath)
        ? current.filter((item) => item !== article.storagePath)
        : [...current, article.storagePath],
    );
  };

  const handleGenerateWriting = async () => {
    if (!isIntroductionWritingEnabled) {
      setWritingMessage('Introduction writing is not enabled for this account. / 当前账号尚未开通 Introduction 写作权限。');
      return;
    }
    if (!isLoggedIn) {
      setWritingMessage('Please log in before using writing mode. / 请先登录再使用写作模式。');
      return;
    }

    if (!writingTopic.trim()) {
      setWritingMessage('Please enter a writing topic or direction. / 请输入写作题目或方向。');
      return;
    }

    if (!selectedWritingMaterialCount) {
      setWritingMessage('Please select at least one read file or generated article. / 请选择至少一篇已读文件或已生成文章。');
      return;
    }

    setIsWriting(true);
    setWritingMessage(null);

    try {
      const response = await fetch('/api/reader-agent/write-introduction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: writingTopic.trim(),
          outputLanguage: writingLanguage,
          selectedPapers: selectedWritingPapers.map((paper) => ({
            paperId: paper.id,
            title: paper.title,
            authors: paper.authors,
            journal: paper.journal,
            year: paper.year,
            pdfUrl: paper.pdfUrl,
            filePath: paper.filePath,
          })),
          selectedArticles: selectedWritingArticles.map((article) => ({
            topic: article.topic,
            storagePath: article.storagePath,
            outputLanguage: article.outputLanguage,
            kind: article.kind,
          })),
        }),
      });
      const result = await response.json();

      if (!response.ok) {
        const message = result.message ?? result.error ?? 'Writing mode failed.';
        setWritingResult({
          draft: `## Writing mode is temporarily unavailable / 写作模式暂时无法生成\n\n${message}`,
          references: [],
          storagePath: '',
          savedAt: new Date().toISOString(),
        });
        throw new Error(message);
      }

      setWritingResult(result);
      if (result.article) setWritingArticles((current) => [result.article, ...current.filter((article) => article.storagePath !== result.article.storagePath)]);
      if (result.tokenAccount) setTokenAccount(result.tokenAccount);
      setWritingMessage(result.processing ? 'Missing reading notes are being generated automatically. Please generate the Introduction again after it finishes. / 正在自动生成缺失的读书笔记，完成后请再次生成 Introduction。' : `Generated and saved / 已生成并保存：${result.storagePath}`);
    } catch (error) {
      setWritingResult((current) => current ?? {
        draft: `## Writing mode is temporarily unavailable / 写作模式暂时无法生成\n\n${error instanceof Error ? error.message : 'Writing mode failed.'}`,
        references: [],
        storagePath: '',
        savedAt: new Date().toISOString(),
      });
      setWritingMessage(error instanceof Error ? error.message : 'Writing mode failed.');
    } finally {
      setIsWriting(false);
    }
  };

  const handleWritingFollowUp = async () => {
    if (!isIntroductionWritingEnabled) {
      setWritingMessage('Introduction writing is not enabled for this account. / 当前账号尚未开通 Introduction 写作权限。');
      return;
    }
    if (!writingResult || !writingFollowUp.trim()) return;

    setIsWritingFollowUp(true);
    setWritingMessage(null);

    try {
      const response = await fetch('/api/reader-agent/write-introduction/follow-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: writingTopic.trim(),
          outputLanguage: writingLanguage,
          question: writingFollowUp.trim(),
          currentDraft: writingResult.draft,
          selectedPapers: selectedWritingPapers.map((paper) => ({
            paperId: paper.id,
            title: paper.title,
            authors: paper.authors,
            journal: paper.journal,
            year: paper.year,
            pdfUrl: paper.pdfUrl,
            filePath: paper.filePath,
          })),
          selectedArticles: selectedWritingArticles.map((article) => ({
            topic: article.topic,
            storagePath: article.storagePath,
            outputLanguage: article.outputLanguage,
            kind: article.kind,
          })),
        }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Writing follow-up failed.');

      if (!result.needsSupplementalReading) {
        setWritingResult(result);
        if (result.article) setWritingArticles((current) => [result.article, ...current.filter((article) => article.storagePath !== result.article.storagePath)]);
      }
      if (result.tokenAccount) setTokenAccount(result.tokenAccount);
      setWritingFollowUp('');
      setWritingMessage(result.needsSupplementalReading ? result.draft : `Updated and saved / 已更新并保存：${result.storagePath}`);
    } catch (error) {
      setWritingMessage(error instanceof Error ? error.message : 'Writing follow-up failed.');
    } finally {
      setIsWritingFollowUp(false);
    }
  };

  const handleOpenWritingArticle = async (article: WritingArticle) => {
    if (loadingWritingPath) return;

    setLoadingWritingPath(article.storagePath);
    setWritingMessage(null);

    try {
      const response = await fetch('/api/reader-agent/writing-results/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storagePath: article.storagePath }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Could not open article.');

      setWritingResult({
        draft: result.draft,
        references: [],
        storagePath: article.storagePath,
        savedAt: article.savedAt,
        article,
      });
      setWritingTopic(article.topic);
      setWritingLanguage(article.outputLanguage);
      setWritingSelectedArticlePaths((current) =>
        current.includes(article.storagePath) ? current : [...current, article.storagePath],
      );
      setWritingMessage(`Opened saved writing / 已打开历史写作：${article.topic}`);
    } catch (error) {
      setWritingMessage(error instanceof Error ? error.message : 'Could not open article.');
    } finally {
      setLoadingWritingPath(null);
    }
  };

  const handleRemoveWritingArticle = async (article: WritingArticle) => {
    if (deletingWritingPath) return;

    setDeletingWritingPath(article.storagePath);
    setWritingMessage(null);

    try {
      const response = await fetch('/api/reader-agent/writing-results', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storagePath: article.storagePath }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Could not delete article.');

      setWritingArticles(result.articles);
      setWritingSelectedArticlePaths((current) => current.filter((item) => item !== article.storagePath));
      if (writingResult?.storagePath === article.storagePath) setWritingResult(null);
      setWritingMessage('Article removed.');
    } catch (error) {
      setWritingMessage(error instanceof Error ? error.message : 'Could not delete article.');
    } finally {
      setDeletingWritingPath(null);
    }
  };

  return (
    <main className="research-responsive-page min-h-screen w-full max-w-full overflow-x-hidden px-3 py-3 sm:px-8 sm:py-6">
      <section className="mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-5 sm:gap-8">
        <header className="min-w-0 rounded-2xl bg-white p-4 shadow-sm sm:rounded-3xl sm:p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <Link
                  className="inline-flex items-center gap-2 rounded-xl border bg-white px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-primary/40 hover:text-primary"
                  href="/"
                >
                  <ArrowLeft className="size-4" />
                  {b('Back to Home / 回到主页')}
                </Link>
                <LanguageToggle className="hidden sm:flex" />
                <p className="text-sm font-medium uppercase tracking-wide text-primary">SCIReader</p>
              </div>
              <h1 className="mt-2 text-3xl font-semibold">{b('Read Papers with AI / AI 阅读论文')}</h1>
              <p className="mt-2 max-w-2xl text-muted-foreground">
                {b('Upload a PDF, read it on the left, and ask questions in the chat on the right. / 上传 PDF，在左侧阅读，并在右侧聊天窗口提问。')}
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row lg:justify-end">
              <div className="rounded-2xl border bg-slate-50 p-4 text-right">
                <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
                  <WalletCards className="size-4" /> {b('Token Estimate / Token 预估')}
                </div>
                <p className="mt-2 text-2xl font-semibold">
                  {tokenEstimate ? (tokenEstimate.billableTokens ?? tokenEstimate.inputTokens).toLocaleString() : '--'}
                </p>
                <p className="mt-1 max-w-44 text-xs text-muted-foreground">
                  {tokenEstimate
                    ? `${tokenEstimate.inputTokens.toLocaleString()} raw · ${getBillingModeLabel(tokenEstimate.model)}`
                    : b(tokenEstimateMessage)}
                </p>
              </div>
              <div className="rounded-2xl border bg-slate-50 p-4 text-right">
                <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
                  <WalletCards className="size-4" /> {b('Token Balance / Token 余额')}
                </div>
                <p className="mt-2 text-2xl font-semibold">{tokenAccount ? tokenAccount.tokenAvailable.toLocaleString() : '200,000'}</p>
                <p className="mt-1 max-w-44 text-xs text-muted-foreground">
                  {tokenAccount ? `${tokenAccount.tokenUsed.toLocaleString()} ${l('used', '已用')} · ${tokenAccount.tokenBalance.toLocaleString()} ${l('total', '总额')}` : b('Default account quota / 预设账号额度')}
                </p>
              </div>
            </div>
          </div>
          <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            {b('This website is not available to users in Mainland China and is intended only for overseas Chinese users. / 本网站不面向中国内地用户开放，仅针对海外华人。')}
          </div>
          <div className="mt-5 grid gap-3 border-t pt-4 text-sm md:grid-cols-3">
            <div>
              <p className="font-medium">{b('Top-up Reference / 充值参考')}</p>
              <p className="mt-1 text-muted-foreground">
                {language === 'zh' ? '仅接受美元充值；US$1 ≈ 2,000,000 token，首登赠送 200,000 token。需要购买更多 token，请发邮件至' : 'USD top-ups only; US$1 ≈ 2,000,000 tokens, and new accounts receive 200,000 tokens. Need more tokens? Email'}{' '}
                <a className="font-medium text-primary underline-offset-4 hover:underline" href="mailto:sanbangzi@mailfence.com">
                  sci reader &lt;sanbangzi@mailfence.com&gt;
                </a>
                {language === 'zh' ? '。' : '.'}
              </p>
            </div>
            <div>
              <p className="font-medium">{b('Billing Rules / 扣费规则')}</p>
              <p className="mt-1 text-muted-foreground">{b('Calculated from actual model input/output prices; input price is about 1/6 of output price. / 按模型实际输入/输出单价折算；输入价格约为输出价格的 1/6。')}</p>
            </div>
            <div>
              <p className="font-medium">{b('Reading Estimate / 阅读估算')}</p>
              <p className="mt-1 text-muted-foreground">{b('US$1 can deeply read about 80-160 English papers of 5,000 words; very long papers are billed by actual token usage. / US$1 约可精读 80-160 篇 5000 words 英文文献，超长论文按实际 token 扣费。')}</p>
            </div>
          </div>
        </header>

        <section className="order-2 rounded-3xl bg-white p-4 shadow-sm sm:p-6">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <PenLine className="size-5 text-primary" />
              <h2 className="text-xl font-semibold">{b('Writing Mode / 写作模式')}</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              {b('Organize an Introduction from saved reading notes and generate citation numbers by first appearance; Writing Mode is billed at 1.5x tokens. / 基于已保存的读书笔记组织 Introduction，并按首次出现顺序生成引用编号；写作模式按 1.5 倍 token 计费。')}
            </p>
          </div>

          {!isIntroductionWritingEnabled ? (
            <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
              <p className="font-semibold text-amber-950">{b('Introduction writing is not enabled / Introduction 写作功能尚未开通')}</p>
              <p className="mt-1 text-sm leading-6 text-amber-800">
                {b('This feature is available only to accounts enabled by an administrator. Please contact the administrator if you need access. / 此功能仅对管理员授权的账号开放。如需使用，请联系管理员开通。')}
              </p>
            </div>
          ) : <>
          <div className="mt-5 grid gap-4">
            <div className="space-y-4">
              <label className="block">
                <span className="text-sm font-medium">{b('Writing Topic or Direction / 写作题目或方向')}</span>
                <textarea
                  className="mt-2 min-h-24 w-full rounded-xl border px-4 py-3 text-sm outline-none transition focus:border-primary"
                  onChange={(event) => setWritingTopic(event.target.value)}
                  placeholder={b('Example: multimodal fusion for complex-environment perception / 例如：面向复杂环境感知的多模态融合方法研究')}
                  value={writingTopic}
                />
              </label>

              <div>
                <p className="text-sm font-medium">{b('Output Language / 输出语言')}</p>
                <div className="mt-2 inline-flex rounded-xl border p-1">
                  {([
                    ['chinese', 'Chinese / 中文'],
                    ['english', 'English'],
                  ] as const).map(([id, label]) => (
                    <button
                      className={`rounded-lg px-3 py-1.5 text-sm transition ${writingLanguage === id ? 'bg-primary text-primary-foreground' : 'text-slate-600 hover:bg-slate-50'}`}
                      key={id}
                      onClick={() => setWritingLanguage(id)}
                      type="button"
                    >
                      {b(label)}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-sm font-medium">{b('Selected Materials / 已选素材')}</p>
                <div className="mt-2 min-h-20 rounded-xl border p-3">
                  {selectedWritingMaterialCount ? (
                    <div className="flex flex-wrap gap-2">
                      {selectedWritingPapers.map((paper) => (
                        <button
                          className="max-w-full rounded-lg border bg-slate-50 px-3 py-2 text-left text-sm transition hover:border-primary hover:bg-white"
                          key={getWritingPaperKey(paper)}
                          onClick={() => toggleWritingPaper(paper)}
                          title={b('Remove selection / 取消选择')}
                          type="button"
                        >
                          <span className="block truncate font-medium">{paper.title}</span>
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {[paper.journal, paper.year].filter(Boolean).join(' · ') || paper.authors}
                          </span>
                        </button>
                      ))}
                      {selectedWritingArticles.map((article) => (
                        <button
                          className="max-w-full rounded-lg border bg-indigo-50 px-3 py-2 text-left text-sm transition hover:border-primary hover:bg-white"
                          key={article.storagePath}
                          onClick={() => toggleWritingArticle(article)}
                          title={b('Remove selection / 取消选择')}
                          type="button"
                        >
                          <span className="block truncate font-medium">{article.topic}</span>
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            Article · {article.kind === 'follow-up' ? 'Follow-up' : 'Introduction'} · {formatArticleDate(article.savedAt)}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{b('Select writing materials from the Your Papers or Your Articles lists below. / 请在下面的 Your Papers 或 Your Articles 列表里勾选要用于写作的素材。')}</p>
                  )}
                </div>
              </div>

              <button
                className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-70"
                disabled={isWriting || !isLoggedIn || !writingTopic.trim() || !selectedWritingMaterialCount}
                onClick={() => void handleGenerateWriting()}
                type="button"
              >
                {isWriting ? <Loader2 className="size-4 animate-spin" /> : <PenLine className="size-4" />}
                {isWriting ? b('Generating... / 正在生成...') : b('Generate Introduction / 生成 Introduction')}
              </button>
              {writingMessage ? <p className="text-sm text-muted-foreground">{b(writingMessage)}</p> : null}
            </div>
          </div>

          {writingResult ? (
            <div className="mt-5 rounded-2xl border bg-slate-50 p-4">
              <div className="flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                <span>{writingResult.storagePath ? `${l('Saved', '已保存')}: ${writingResult.storagePath}` : writingResult.processing ? l('Status: generating missing reading notes', '状态：正在生成缺失的读书笔记') : l('Status: not saved', '状态：未保存')}</span>
                {writingResult.usage ? (
                  <span>
                    {writingResult.usage.billableTokens.toLocaleString()} billable · x{writingResult.usage.billingMultiplier}
                  </span>
                ) : null}
              </div>
              <div className="mt-4 max-h-[520px] overflow-auto whitespace-pre-wrap rounded-xl bg-white p-4 text-sm leading-7">
                {writingResult.draft}
              </div>
              {!writingResult.processing ? <div className="mt-4 flex flex-col gap-2 md:flex-row">
                <input
                  className="min-w-0 flex-1 rounded-xl border px-4 py-2 text-sm outline-none transition focus:border-primary"
                  onChange={(event) => setWritingFollowUp(event.target.value)}
                  placeholder={b('Ask a follow-up or request edits; if more reading is needed, I will check first and will not reread automatically. / 继续追问或提出修改要求；需要补读时会先判断，不会自动重读')}
                  value={writingFollowUp}
                />
                <button
                  className="inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-70"
                  disabled={isWritingFollowUp || !writingFollowUp.trim() || !selectedWritingMaterialCount}
                  onClick={() => void handleWritingFollowUp()}
                  type="button"
                >
                  {isWritingFollowUp ? <Loader2 className="size-4 animate-spin" /> : null}
                  {isWritingFollowUp ? b('Processing... / 处理中...') : b('Follow up / Edit / 追问/修改')}
                </button>
              </div> : null}
            </div>
          ) : null}
          </>}
        </section>

        <section className="order-3 rounded-3xl bg-white p-4 shadow-sm sm:p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold">{l('Your articles', '你的文章')}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{b('Introductions and revisions generated in Writing Mode are saved here. / 写作模式生成的 Introduction 和修改稿会保存在这里。')}</p>
            </div>
          </div>

          <div className="mt-5 grid gap-3">
            {writingArticles.length ? writingArticles.map((article) => {
              const isSelectedForWriting = isIntroductionWritingEnabled && writingSelectedArticlePaths.includes(article.storagePath);

              return (
                <div
                  className="flex flex-col gap-3 rounded-2xl border p-4 transition hover:border-primary hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between"
                  key={article.storagePath}
                >
                  <label
                    className={`flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-sm transition ${isIntroductionWritingEnabled ? 'cursor-pointer hover:border-primary hover:bg-white' : 'cursor-not-allowed bg-slate-50 text-slate-400'}`}
                    title={isIntroductionWritingEnabled ? (isSelectedForWriting ? b('Remove from Writing Mode / 取消加入写作模式') : b('Add to Writing Mode / 加入写作模式')) : b('Introduction writing is not enabled / Introduction 写作功能尚未开通')}
                  >
                    <input
                      checked={isSelectedForWriting}
                      className="size-4"
                      disabled={!isIntroductionWritingEnabled}
                      onChange={() => toggleWritingArticle(article)}
                      type="checkbox"
                    />
                    <span className="hidden sm:inline">{b('Writing / 写作')}</span>
                  </label>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold">{article.topic}</h3>
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
                        {article.kind === 'follow-up' ? l('Follow-up', '追问修改') : 'Introduction'}
                      </span>
                      <span className="rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                        {article.outputLanguage === 'english' ? 'English' : '中文'}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {formatArticleDate(article.savedAt)} · {article.selectedPaperCount} {l('papers', '篇论文')}
                      {article.billableTokens ? ` · ${article.billableTokens.toLocaleString()} billable` : ''}
                    </p>
                    <p className="mt-2 truncate text-xs text-muted-foreground">{article.storagePath}</p>
                  </div>
                  <div className="flex items-center gap-2 sm:self-center">
                    <button
                      className="inline-flex items-center justify-center gap-2 rounded-xl border p-2 text-slate-500 transition hover:border-primary hover:bg-white hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={loadingWritingPath === article.storagePath}
                      onClick={() => void handleOpenWritingArticle(article)}
                      title={l('Open in writing output', '在写作输出中打开')}
                      type="button"
                    >
                      {loadingWritingPath === article.storagePath ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
                    </button>
                    <button
                      className="inline-flex items-center justify-center gap-2 rounded-xl border p-2 text-slate-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={deletingWritingPath === article.storagePath}
                      onClick={() => void handleRemoveWritingArticle(article)}
                      title={l('Remove from list', '从列表移除')}
                      type="button"
                    >
                      {deletingWritingPath === article.storagePath ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                    </button>
                  </div>
                </div>
              );
            }) : (
              <div className="rounded-2xl border bg-slate-50 p-4 text-sm text-muted-foreground">
                {b('No writing results yet. Generated Introductions will appear here automatically. / 还没有写作结果。生成 Introduction 后会自动出现在这里。')}
              </div>
            )}
          </div>
        </section>

        <section className="order-1 rounded-3xl bg-white p-4 shadow-sm sm:p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center">
            <div className="flex max-w-full flex-wrap items-center gap-3">
              <input
                accept="application/pdf"
                className="hidden"
                disabled={isUploading || !isLoggedIn || isSessionLoading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleUpload(file);
                  event.target.value = '';
                }}
                ref={fileInputRef}
                type="file"
              />
              <button
                className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-70"
                disabled={isUploading || !isLoggedIn || isSessionLoading}
                onClick={() => {
                  if (!isLoggedIn) {
                    setUploadMessage('Please log in before uploading a paper. / 请先登录再上传论文。');
                    return;
                  }

                  fileInputRef.current?.click();
                }}
                type="button"
              >
                {isUploading ? <Loader2 className="size-4 animate-spin" /> : null}
                {isUploading ? b('Uploading... / 上传中...') : isLoggedIn ? b('Upload Paper / 上传论文') : b('Sign in to Upload / 登录后上传')}
              </button>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex max-w-full flex-wrap rounded-xl border p-1" title={b('Depth / 深度')}>
                  {readingModes.map((mode) => (
                    <button
                      className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition ${normalizeResearchReadingMode(readingMode) === mode.id ? 'bg-primary text-primary-foreground' : 'text-slate-600 hover:bg-slate-50'}`}
                      key={mode.id}
                      onClick={() => {
                        setReadingMode(mode.id);
                        setDetailedReport(mode.id !== 'simple');
                        saveReadingPreferences({ readingMode: mode.id, detailedReport: mode.id !== 'simple' });
                      }}
                      title={b(mode.description)}
                      type="button"
                    >
                      {b(mode.label)}
                    </button>
                  ))}
                </div>
                <div className="flex max-w-full flex-wrap rounded-xl border p-1" title={b('Mode / 模式')}>
                  {taskModes.map((mode) => (
                    <button
                      className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition ${paperTaskMode === mode.id ? 'bg-primary text-primary-foreground' : 'text-slate-600 hover:bg-slate-50'}`}
                      key={mode.id}
                      onClick={() => setPaperTaskMode(mode.id)}
                      title={b(mode.description)}
                      type="button"
                    >
                      {b(mode.label)}
                    </button>
                  ))}
                </div>
              </div>
              <button
                className="whitespace-nowrap rounded-xl border px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary hover:text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!selectedPaper?.filePath}
                onClick={() => startPaperReading()}
                title={selectedPaper ? `${paperTaskMode === 'review' ? b('Review / 审稿') : b('Read / 解读')} ${selectedPaper.title}` : b('Please select a paper first / 请先选定论文')}
                type="button"
              >
                {paperTaskMode === 'review' ? b('Review Selected Paper / 审稿选定论文') : b('Read Selected Paper / 解读选定论文')}
              </button>
              {uploadMessage ? <p className="text-sm text-muted-foreground">{b(uploadMessage)}</p> : null}
            </div>
            <div>
              <h2 className="text-xl font-semibold">{b('Your Papers / 你的论文')}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {selectedPaper ? `${b('Selected / 已选定')}：${selectedPaper.title} · ${b(getResearchReadingModeLabel(readingMode))} · ${paperTaskMode === 'review' ? b('Review / 审稿') : b('Read / 阅读')}` : b('Please upload and select one paper first. / 请先上传并选定一篇论文。')}
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-4">
            {papers.map((paper) => {
              const paperKey = getWritingPaperKey(paper);
              const isSelectedForReading = paperKey === selectedPaperKey || (!selectedPaperKey && paper.filePath && selectedPaper?.filePath === paper.filePath);
              const canSelectForWriting = Boolean(isLoggedIn && isIntroductionWritingEnabled && paper.filePath);
              const isSelectedForWriting = canSelectForWriting && writingSelectedPaperKeys.includes(getWritingPaperKey(paper));
              const writingSelectControl = (
                <label
                  className={`flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl border px-3 text-sm transition ${
                    canSelectForWriting ? 'cursor-pointer hover:border-primary hover:bg-white' : 'cursor-not-allowed bg-slate-50 text-slate-400'
                  }`}
                  onClick={(event) => event.stopPropagation()}
                  title={canSelectForWriting ? (isSelectedForWriting ? b('Remove from Writing Mode / 取消加入写作模式') : b('Add to Writing Mode / 加入写作模式')) : b('Sign in and upload a paper before adding it to Writing Mode / 登录并上传论文后可加入写作模式')}
                >
                  <input
                    checked={isSelectedForWriting}
                    className="size-4"
                    disabled={!canSelectForWriting}
                    onChange={() => {
                      if (canSelectForWriting) toggleWritingPaper(paper);
                    }}
                    type="checkbox"
                  />
                  <span className="hidden sm:inline">{b('Writing / 写作')}</span>
                </label>
              );
              const content = (
                <>
                  <div className="min-w-0 flex-1">
                    <h3 className="break-words text-[15px] font-semibold leading-5 sm:text-base sm:leading-6">{paper.title}</h3>
                    <p className="mt-1 break-words text-xs leading-5 text-muted-foreground sm:text-sm">{paper.journal ? [paper.journal, paper.year].filter(Boolean).join(' · ') : paper.authors}</p>
                    <p className="mt-2 text-xs uppercase tracking-wide text-muted-foreground">
                      {paper.pages ? `${paper.pages} pages · ` : ''}{paper.status}
                    </p>
                  </div>
                  <span className={`shrink-0 self-start rounded-full px-2.5 py-1 text-xs font-medium ${isSelectedForReading ? 'bg-primary text-primary-foreground' : 'bg-slate-100 text-slate-600'}`}>
                    {isSelectedForReading ? b('Selected / 已选定') : b('Pending / 待选定')}
                  </span>
                </>
              );

              return isLoggedIn ? (
                <div
                  className={`group flex flex-col gap-3 rounded-2xl border p-3 text-left transition hover:border-primary hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between sm:p-4 ${isSelectedForReading ? 'border-primary bg-primary/5 ring-1 ring-primary' : ''}`}
                  key={`${paper.id}-${paper.filePath ?? 'sample'}`}
                  onClick={() => setSelectedPaperKey(paperKey)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="flex min-w-0 w-full items-start justify-between gap-3 sm:flex-1 sm:items-center">
                    {content}
                  </div>
                  <div className="flex w-full items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
                    {writingSelectControl}
                    {paper.filePath ? (
                    <div className="flex min-w-0 flex-1 gap-2 sm:flex-none">
                      <button
                        className="flex h-11 min-w-0 flex-1 items-center justify-center rounded-xl border bg-white px-4 text-sm font-semibold text-primary transition hover:bg-primary hover:text-primary-foreground sm:flex-none"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedPaperKey(paperKey);
                          startPaperReading(paper, 'read');
                        }}
                        type="button"
                      >
                        {b('Read / 解读')}
                      </button>
                      <button
                        className="flex h-11 min-w-0 flex-1 items-center justify-center rounded-xl border border-blue-200 bg-blue-50 px-4 text-sm font-semibold text-blue-700 transition hover:bg-blue-100 sm:flex-none"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedPaperKey(paperKey);
                          startPaperReading(paper, 'review');
                        }}
                        type="button"
                      >
                        {b('Review / 审稿')}
                      </button>
                    </div>
                    ) : null}
                    {paper.filePath ? (
                    <button
                      className="flex size-11 shrink-0 items-center justify-center rounded-xl border text-slate-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={deletingFilePath === paper.filePath}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleRemovePaper(paper);
                      }}
                      title={l('Remove from my account only', '仅从我的账户移除')}
                      type="button"
                    >
                      {deletingFilePath === paper.filePath ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                    </button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div
                  className="flex cursor-not-allowed items-center justify-between rounded-2xl border bg-slate-50 p-4 opacity-60"
                  key={paper.id}
                  title={l('Log in to open papers', '登录后打开论文')}
                >
                  {writingSelectControl}
                  {content}
                </div>
              );
            })}
          </div>
        </section>
      </section>
    </main>
  );
};

export default HomePage;
