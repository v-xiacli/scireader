'use client';

import { ArrowLeft, BarChart3, Loader2, Trash2, Upload, WalletCards } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { useFloatingChat } from '@/components/chat/floating-chat-context';
import { LanguageToggle, localizeBilingualText, useLanguage, type AppLanguage } from '@/components/language/language-context';

type AuthUser = { id: string; email: string };
type TokenAccount = { tokenBalance: number; tokenUsed: number; tokenAvailable: number };

type FinancialMaterial = {
  name: string;
  storagePath: string;
  contentType: string;
  size: number;
  url?: string;
  addedAt?: string;
};

type FinancialReport = {
  id: string;
  stock: {
    name: string;
    code: string;
    market?: string | null;
  };
  question: string;
  answer: string;
  model?: string | null;
  createdAt: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    baseBillableTokens: number;
    billableTokens: number;
    billingMultiplier: number;
  };
};

type StockWatchlistItem = {
  name: string;
  code: string;
  market?: 'A' | 'US' | 'HK' | 'FX';
};

type StockQuote = StockWatchlistItem & {
  price: number | null;
  prevClose: number | null;
  change: number;
  changePct: number;
  currency: string;
};

type FinancialAnalysisMode = 'quality' | 'normal';

const financialAnalysisModes: Array<{ id: FinancialAnalysisMode; label: string; description: string }> = [
  { id: 'quality', label: 'High Quality / 高质量', description: 'Use a stronger analysis route for formal reports and complex market signals. / 使用更强的分析链路，适合正式财报和复杂盘面。' },
  { id: 'normal', label: 'Normal / 一般', description: 'Analyze the current materials directly for a quick judgement. / 直接分析材料，适合快速判断。' },
];

const formatDate = (value: string) => {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const formatMaterialSize = (bytes: number) => {
  if (!bytes) return '0 MB';

  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

const mergeFinancialMaterials = (current: FinancialMaterial[], incoming: FinancialMaterial[], limit = 80) => {
  const byPath = new Map(current.map((material) => [material.storagePath, material]));

  for (const material of incoming) {
    byPath.set(material.storagePath, { ...byPath.get(material.storagePath), ...material });
  }

  return Array.from(byPath.values()).slice(-limit);
};

const describeMaterialSize = (material: FinancialMaterial, language: AppLanguage) =>
  material.url ? localizeBilingualText('Web link / 网页链接', language) : `${formatMaterialSize(material.size)}`;

const formatStockWatchlistText = (watchlist: StockWatchlistItem[]) =>
  watchlist.map((item) => `${item.name},${item.code},${item.market ?? 'A'}`).join('\n');

const normalizeStockCode = (code: string, market?: StockWatchlistItem['market']) => {
  const normalizedCode = code.trim().toUpperCase().replace(/\s+/g, '');
  const prefixedHongKongCode = normalizedCode.match(/^HK\.?(\d{1,5})$/);

  if ((market === 'HK' || prefixedHongKongCode) && /^\d{1,5}$/.test(prefixedHongKongCode?.[1] ?? normalizedCode)) {
    return (prefixedHongKongCode?.[1] ?? normalizedCode).padStart(5, '0');
  }

  return normalizedCode;
};

const inferInputMarket = (code: string, explicitMarket?: string): StockWatchlistItem['market'] => {
  const normalizedMarket = explicitMarket?.toUpperCase();
  const normalizedCode = code.trim().toUpperCase().replace(/\s+/g, '');

  if (normalizedMarket && ['A', 'US', 'HK', 'FX'].includes(normalizedMarket)) return normalizedMarket as StockWatchlistItem['market'];
  if (/^HK\.?\d{1,5}$/i.test(normalizedCode)) return 'HK';
  if (/^\d{1,5}$/.test(normalizedCode)) return 'HK';
  if (/^[A-Z]+$/.test(normalizedCode)) return 'US';
  if (normalizedCode.toLowerCase().startsWith('hf_')) return 'FX';

  return 'A';
};

const parseStockWatchlistText = (text: string): StockWatchlistItem[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[,\s，]+/).map((part) => part.trim()).filter(Boolean);
      const singleCodeOnly = parts.length === 1;
      const rawName = singleCodeOnly ? parts[0] : parts[0] ?? '';
      const rawCode = singleCodeOnly ? parts[0] : parts[1] ?? '';
      const rawMarket = singleCodeOnly ? undefined : parts[2];
      const normalizedMarket = inferInputMarket(rawCode, rawMarket);
      const normalizedCode = normalizeStockCode(rawCode, normalizedMarket);

      return { name: rawName || normalizedCode, code: normalizedCode, market: normalizedMarket };
    })
    .filter((item) => item.name && item.code)
    .slice(0, 80);

const parseAnalysisTarget = (text: string): StockWatchlistItem | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/[,\s，]+/).map((part) => part.trim()).filter(Boolean);
  const rawCode = parts.find((part) => /^HK\.?\d{1,5}$/i.test(part) || /^\d{1,6}$/.test(part) || /^[A-Z]{1,8}$/i.test(part) || /^hf_/i.test(part));
  const rawMarket = parts.find((part) => ['A', 'US', 'HK', 'FX'].includes(part.toUpperCase()));
  const market = inferInputMarket(rawCode ?? trimmed, rawMarket);
  const code = rawCode ? normalizeStockCode(rawCode, market) : trimmed.slice(0, 24);
  const name = rawCode
    ? parts.filter((part) => part !== rawCode && part !== rawMarket).join(' ').trim() || code
    : trimmed;

  return { name, code, market };
};

const FinancialAnalysisPage = () => {
  const { setFinancialContext } = useFloatingChat();
  const { language } = useLanguage();
  const b = (value: string) => localizeBilingualText(value, language);
  const l = (en: string, zh: string) => language === 'zh' ? zh : en;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [tokenAccount, setTokenAccount] = useState<TokenAccount | null>(null);
  const [isSessionLoading, setIsSessionLoading] = useState(true);
  const [isFinancialEnabled, setIsFinancialEnabled] = useState(false);
  const [isActivatingFinancial, setIsActivatingFinancial] = useState(false);
  const [financialAccessMessage, setFinancialAccessMessage] = useState<string | null>(null);
  const [materials, setMaterials] = useState<FinancialMaterial[]>([]);
  const [materialLibrary, setMaterialLibrary] = useState<FinancialMaterial[]>([]);
  const [materialUrl, setMaterialUrl] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [stockWatchlist, setStockWatchlist] = useState<StockWatchlistItem[]>([]);
  const [stockWatchlistText, setStockWatchlistText] = useState('');
  const [stockQuotes, setStockQuotes] = useState<StockQuote[]>([]);
  const [stockMessage, setStockMessage] = useState<string | null>(null);
  const [isQuotesLoading, setIsQuotesLoading] = useState(false);
  const [isWatchlistEditing, setIsWatchlistEditing] = useState(false);
  const [quotesUpdatedAt, setQuotesUpdatedAt] = useState<string | null>(null);
  const [analysisTargetText, setAnalysisTargetText] = useState('');
  const [financialAnalysisMode, setFinancialAnalysisMode] = useState<FinancialAnalysisMode>('normal');
  const [reports, setReports] = useState<FinancialReport[]>([]);
  const [reportsMessage, setReportsMessage] = useState<string | null>(null);

  const isLoggedIn = Boolean(authUser);
  const displayStocks = stockWatchlist.map((stock) => {
    const quote = stockQuotes.find((item) => `${item.market ?? 'A'}:${item.code}` === `${stock.market ?? 'A'}:${stock.code}`);

    return quote ? { ...stock, name: quote.name } : stock;
  });
  const selectedStock = parseAnalysisTarget(analysisTargetText);
  const materialSizeTotal = materials.reduce((total, file) => total + file.size, 0);

  const loadFinancialAccess = async () => {
    try {
      const response = await fetch('/api/auth/financial-analysis-access');
      const result = await response.json();

      setIsFinancialEnabled(Boolean(response.ok && result.enabled));
    } catch {
      setIsFinancialEnabled(false);
    }
  };

  const loadReports = async () => {
    try {
      const response = await fetch('/api/reader-agent/financial-analysis/reports');
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Financial reports failed.');

      setReports(result.reports ?? []);
      setReportsMessage(null);
    } catch (error) {
      setReports([]);
      setReportsMessage(error instanceof Error ? error.message : 'Financial reports failed.');
    }
  };

  const loadTokenAccount = async () => {
    try {
      const response = await fetch('/api/auth/token-account');
      const result = await response.json();

      setTokenAccount(response.ok ? result.tokenAccount : null);
    } catch {
      setTokenAccount(null);
    }
  };

  const activateFinancialAnalysis = async () => {
    if (!isLoggedIn) {
      setFinancialAccessMessage('Please sign in before enabling Financial Analysis. / 请先登录后再开通财务分析。');
      return;
    }

    setIsActivatingFinancial(true);
    setFinancialAccessMessage(null);

    try {
      const response = await fetch('/api/auth/financial-analysis-access', { method: 'POST' });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Financial analysis access failed.');

      setIsFinancialEnabled(Boolean(result.enabled));
      setFinancialAccessMessage('Financial Analysis is enabled. / 财务分析已开通。');
      void loadReports();
    } catch (error) {
      setFinancialAccessMessage(error instanceof Error ? error.message : 'Financial analysis access failed.');
    } finally {
      setIsActivatingFinancial(false);
    }
  };

  const refreshStockQuotes = async (watchlist = stockWatchlist) => {
    if (!watchlist.length) return;

    setIsQuotesLoading(true);
    setStockMessage(null);

    try {
      const response = await fetch('/api/reader-agent/stock-quotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ watchlist }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Stock quotes failed.');

      setStockQuotes(result.quotes ?? []);
      setQuotesUpdatedAt(result.updatedAt ?? new Date().toISOString());
    } catch (error) {
      setStockMessage(error instanceof Error ? error.message : 'Stock quotes failed.');
    } finally {
      setIsQuotesLoading(false);
    }
  };

  const loadStockWatchlist = async () => {
    try {
      const response = await fetch('/api/auth/stock-watchlist');
      const result = await response.json();
      const watchlist = response.ok ? result.watchlist as StockWatchlistItem[] : [];

      setStockWatchlist(watchlist);
      setStockWatchlistText(formatStockWatchlistText(watchlist));
      if (watchlist.length) void refreshStockQuotes(watchlist);
    } catch {
      setStockWatchlist([]);
      setStockWatchlistText('');
    }
  };

  const saveStockWatchlist = async () => {
    const watchlist = parseStockWatchlistText(stockWatchlistText);
    if (!watchlist.length) {
      setStockMessage('Please keep at least one watchlist stock. / 请至少保留一只自选股。');
      return;
    }

    try {
      const response = await fetch('/api/auth/stock-watchlist', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ watchlist }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Could not save watchlist.');

      setStockWatchlist(result.watchlist);
      setStockWatchlistText(formatStockWatchlistText(result.watchlist));
      setIsWatchlistEditing(false);
      void refreshStockQuotes(result.watchlist);
    } catch (error) {
      setStockMessage(error instanceof Error ? error.message : 'Could not save watchlist.');
    }
  };

  const loadFinancialMaterials = async () => {
    try {
      const response = await fetch('/api/auth/financial-materials');
      const result = await response.json();
      const storedMaterials = response.ok ? result.materials as FinancialMaterial[] : [];

      setMaterialLibrary(storedMaterials);
    } catch {
      setMaterialLibrary([]);
    }
  };

  const persistFinancialMaterials = async (nextMaterials: FinancialMaterial[]) => {
    const response = await fetch('/api/auth/financial-materials', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ materials: nextMaterials }),
    });
    const result = await response.json();

    if (!response.ok) throw new Error(result.message ?? result.error ?? 'Could not save financial materials.');

    const savedMaterials = result.materials as FinancialMaterial[];
    setMaterialLibrary(savedMaterials);

    return savedMaterials;
  };

  const addCurrentMaterials = (incoming: FinancialMaterial[]) => {
    setMaterials((current) => mergeFinancialMaterials(current, incoming, 12));
  };

  const saveMaterialsToLibrary = async (incoming: FinancialMaterial[]) => {
    const nextLibrary = mergeFinancialMaterials(materialLibrary, incoming, 80);

    setMaterialLibrary(nextLibrary);
    await persistFinancialMaterials(nextLibrary);

    return nextLibrary;
  };

  const addLinkMaterial = async () => {
    if (!isLoggedIn) {
      setMessage('Please sign in before adding a web link. / 请先登录再加入网页链接。');
      return;
    }

    if (!isFinancialEnabled) {
      setFinancialAccessMessage('Please enable Financial Analysis first. / 请先开通财务分析功能。');
      return;
    }

    try {
      const url = new URL(materialUrl.trim());
      const pathName = url.pathname === '/' ? '' : url.pathname;
      const name = `${url.hostname}${pathName}`.slice(0, 120);
      const material: FinancialMaterial = {
        name: name || url.href,
        storagePath: `url:${url.href}`,
        contentType: 'text/html',
        size: 0,
        url: url.href,
        addedAt: new Date().toISOString(),
      };

      addCurrentMaterials([material]);
      await saveMaterialsToLibrary([material]);
      setMaterialUrl('');
      setMessage('Web link added. This analysis will try to read the page text. / 已加入网页链接，本次分析会尝试读取正文。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Please enter a valid web link. / 请输入有效的网页链接。');
    }
  };

  const addMaterialFromLibrary = (storagePath: string) => {
    const material = materialLibrary.find((item) => item.storagePath === storagePath);

    if (!material) return;
    addCurrentMaterials([material]);
  };

  const removeMaterialFromLibrary = async (storagePath: string) => {
    const nextLibrary = materialLibrary.filter((item) => item.storagePath !== storagePath);

    setMaterialLibrary(nextLibrary);
    setMaterials((current) => current.filter((item) => item.storagePath !== storagePath));

    try {
      await persistFinancialMaterials(nextLibrary);
      setMessage('Removed from saved materials. / 已从历史资料移除。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save financial materials.');
      void loadFinancialMaterials();
    }
  };

  useEffect(() => {
    const loadSession = async () => {
      try {
        const response = await fetch('/api/auth/me');
        const result = await response.json();

        if (response.ok && result.user) {
          setAuthUser(result.user);
          if (result.tokenAccount) setTokenAccount(result.tokenAccount);
          setIsFinancialEnabled(Boolean(result.financialAnalysisEnabled));
          await loadStockWatchlist();
          await loadFinancialAccess();
          await loadFinancialMaterials();
          await loadReports();
          await loadTokenAccount();
        }
      } catch {
        setAuthUser(null);
      } finally {
        setIsSessionLoading(false);
      }
    };

    void loadSession();
  }, []);

  useEffect(() => {
    if (!isLoggedIn || !stockWatchlist.length) return;

    void refreshStockQuotes(stockWatchlist);

    const timer = window.setInterval(() => {
      void refreshStockQuotes(stockWatchlist);
    }, 60_000);

    return () => window.clearInterval(timer);
  }, [isLoggedIn, stockWatchlist]);

  useEffect(() => {
    setFinancialContext({
      active: isFinancialEnabled,
      materials,
      selectedStock,
      analysisMode: financialAnalysisMode,
      billingMultiplier: 3,
    });
  }, [financialAnalysisMode, isFinancialEnabled, materials, selectedStock, setFinancialContext]);

  useEffect(() => () => setFinancialContext(null), [setFinancialContext]);

  useEffect(() => {
    const refreshReports = () => {
      void loadReports();
    };

    window.addEventListener('financial-analysis-report-created', refreshReports);

    return () => window.removeEventListener('financial-analysis-report-created', refreshReports);
  }, []);

  const handleUpload = async (files: FileList | File[]) => {
    if (!isLoggedIn) {
      setMessage('Please sign in before uploading financial materials. / 请先登录再上传财务材料。');
      return;
    }

    const selectedFiles = Array.from(files).slice(0, Math.max(0, 12 - materials.length));
    if (!selectedFiles.length) {
      setMessage('Current materials have reached the 12-item limit. / 本次资料已达 12 份上限。');
      return;
    }

    const unsupported = selectedFiles.find((file) => file.type !== 'application/pdf' && !file.type.startsWith('image/'));
    if (unsupported) {
      setMessage(`不支援的檔案類型：${unsupported.name}`);
      return;
    }

    setIsUploading(true);
    setMessage(null);

    try {
      const uploaded: FinancialMaterial[] = [];

      for (const file of selectedFiles) {
        const formData = new FormData();
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        formData.append('file', file);
        formData.append('filePath', `financial/${Date.now()}-${safeName}`);

        const response = await fetch('/api/storage/upload/private', {
          method: 'POST',
          body: formData,
        });
        const result = await response.json();

        if (!response.ok) throw new Error(result.message ?? result.error ?? `Upload failed: ${file.name}`);

        uploaded.push({
          name: file.name,
          storagePath: result.filePath,
          contentType: file.type,
          size: file.size,
          addedAt: new Date().toISOString(),
        });
      }

      addCurrentMaterials(uploaded);
      await saveMaterialsToLibrary(uploaded);
      setMessage(`Uploaded ${uploaded.length} material(s) and added them to this analysis. / 已上传 ${uploaded.length} 个材料，并加入本次分析。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Financial material upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  const startFinancialAnalysis = () => {
    if (!isLoggedIn) {
      setMessage('Please sign in before using Financial Analysis. / 请先登录再使用财务分析。');
      return;
    }

    if (!isFinancialEnabled) {
      setFinancialAccessMessage('Please enable Financial Analysis first. / 请先开通财务分析功能。');
      return;
    }

    if (!selectedStock) {
      setStockMessage('Please enter the sector or stock to analyze. / 请先输入拟分析板块或股票。');
      return;
    }

    if (!materials.length) {
      setMessage('Please upload a financial report, K-line chart, order-book screenshot, or trend image first. / 请先上传财报、K 线图、盘口截图或走势图。');
      return;
    }

    window.dispatchEvent(new CustomEvent('financial-analysis-start', {
      detail: {
        prompt: `请综合分析 ${selectedStock.name}（${selectedStock.code}）的本次上传材料，并结合该分析对象的历史档案给出交易员视角的判断。`,
      },
    }));
  };

  return (
    <main className="financial-glass-page min-h-screen w-full max-w-full overflow-x-hidden">
      <div className="relative z-[1] mx-auto flex min-h-screen w-full min-w-0 max-w-6xl flex-col px-3 pb-28 pt-3 sm:px-5 sm:pt-4">
        <header className="financial-glass-nav z-30 flex min-w-0 flex-col gap-4 rounded-2xl px-3 py-3 sm:px-4 lg:sticky lg:top-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Link className="inline-flex shrink-0 items-center gap-2 rounded-xl border bg-white px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-primary/40 hover:text-primary" href="/">
              <ArrowLeft className="size-5" />
              <span className="hidden sm:inline">{b('Back to Home / 回到主页')}</span>
            </Link>
            <LanguageToggle className="hidden sm:flex" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <BarChart3 className="size-5 text-primary" />
                <h1 className="truncate text-lg font-semibold sm:text-xl">{b('Financial Analysis / 财务分析')}</h1>
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground sm:text-sm">
                {authUser ? `${b('Current account / 当前账号')}: ${authUser.email}` : isSessionLoading ? b('Checking sign-in status... / 正在检查登录状态...') : b('Please return to the home page and sign in first. / 请先回到主页登录后使用。')}
              </p>
              <p className="mt-1 text-xs font-medium text-amber-700">{b('This feature must be enabled separately; token usage is billed at 3x the normal analysis rate. / 该功能需要单独开通；token 使用费按正常分析的 3 倍计算。')}</p>
            </div>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row lg:items-center lg:justify-end">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="financial-token-chip rounded-xl px-3 py-2 text-right">
                <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
                  <WalletCards className="size-4" /> {b('Token Estimate / Token 预估')}
                </div>
                <p className="mt-2 text-2xl font-semibold">{materials.length ? `${materials.length} ${l('items', '份')}` : '--'}</p>
                <p className="mt-1 max-w-44 text-xs text-muted-foreground">
                  {materials.length ? `${formatMaterialSize(materialSizeTotal)} ${b('materials; billed by actual usage ×3 / 材料；提交后按实际消耗 ×3')}` : b('Upload reports or images to start. / 上传财报或图片后开始分析。')}
                </p>
              </div>
              <div className="financial-token-chip rounded-xl px-3 py-2 text-right">
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
        </header>

        <section className="financial-glass-panel mt-4 rounded-2xl p-4">
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            {b('This website is not available to users in Mainland China and is intended only for overseas Chinese users. / 本网站不面向中国内地用户开放，仅针对海外华人。')}
          </div>
          <div className="mt-4 grid gap-3 border-t pt-4 text-sm md:grid-cols-3">
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
              <p className="font-medium">{b('Financial Billing / 财务扣费')}</p>
              <p className="mt-1 text-muted-foreground">{b('Financial Analysis is calculated from actual model input/output usage, then billed at 3x the normal analysis rate. / 财务分析按模型实际输入/输出折算后，再按正常分析的 3 倍扣费。')}</p>
            </div>
            <div>
              <p className="font-medium">{b('Materials / 材料说明')}</p>
              <p className="mt-1 text-muted-foreground">{b('Upload financial report PDFs, K-line charts, order-book screenshots, trend images, or web links; saved materials and current materials are managed separately. / 可上传多份财报 PDF、K 线图、盘口截图、走势图，也可贴网页链接；历史资料和本次资料分开管理。')}</p>
            </div>
          </div>
        </section>

        {!isSessionLoading && !isLoggedIn ? (
          <section className="mt-4 rounded-2xl border border-blue-200 bg-blue-50 p-4 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-semibold text-blue-950">{b('Please Sign In / 请先登录')}</h2>
                <p className="mt-1 text-sm text-blue-900">{b('Financial Analysis requires a signed-in account. The sign-in panel is now on the home page; after signing in, return here to view your watchlist, saved materials, and reports. / 财务分析需要登录账号后使用；登录窗口已移到主页，登录后再进入本页即可看到自选股、历史资料和报告。')}</p>
              </div>
              <Link
                className="inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                href="/"
              >
                {b('Back to Sign In / 回主页登录')}
              </Link>
            </div>
          </section>
        ) : null}

        {!isFinancialEnabled ? (
          <section className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="font-semibold text-amber-950">{b('Enable Financial Analysis / 开通财务分析')}</h2>
                <p className="mt-1 text-sm leading-6 text-amber-900">
                  {b('Financial Analysis reads reports, K-line charts, order-book screenshots, and trend images, then saves reports by analysis target for this user. It must be enabled separately, and token usage is billed at 3x the normal analysis rate. / 财务分析会读取财报、K 线图、盘口截图和走势图，并按分析对象保存本用户的历史报告。使用前需单独开通，token 使用量按正常分析的 3 倍计算。')}
                </p>
              </div>
              <button
                className="inline-flex items-center justify-center rounded-xl bg-amber-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-70"
                disabled={isActivatingFinancial || !isLoggedIn}
                onClick={() => void activateFinancialAnalysis()}
                type="button"
              >
                {isActivatingFinancial ? b('Enabling... / 开通中...') : b('Confirm Enable / 确认开通')}
              </button>
            </div>
            {financialAccessMessage ? <p className="mt-2 text-sm text-amber-900">{b(financialAccessMessage)}</p> : null}
          </section>
        ) : null}

        <section className="financial-glass-panel financial-analysis-hero mt-4 rounded-[22px] p-4 sm:p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm font-medium">{b('Watchlist Live Prices / 自选股实时价格')}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {quotesUpdatedAt ? `${b('Last updated / 最近更新')} ${formatDate(quotesUpdatedAt)}` : b('Refreshes automatically after entering this page; updates every 60 seconds. / 进入页面后自动刷新；每 60 秒更新一次。')}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="w-full min-w-0 rounded-xl border bg-white px-3 py-2 text-sm outline-none focus:border-primary sm:w-auto sm:min-w-64"
                onChange={(event) => setAnalysisTargetText(event.target.value)}
                placeholder={b('Sector or stock to analyze, e.g. optical equipment, Alibaba 09988 / 拟分析板块或股票，例如：光伏设备、阿里巴巴 09988')}
                value={analysisTargetText}
              />
              <div className="flex rounded-xl border p-1">
                {financialAnalysisModes.map((mode) => (
                  <button
                    className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition ${financialAnalysisMode === mode.id ? 'bg-primary text-primary-foreground' : 'text-slate-600 hover:bg-slate-50'}`}
                    key={mode.id}
                    onClick={() => setFinancialAnalysisMode(mode.id)}
                    title={b(mode.description)}
                    type="button"
                  >
                    {b(mode.label)}
                  </button>
                ))}
              </div>
              <button
                className="rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-70"
                disabled={!isLoggedIn || !isFinancialEnabled || !analysisTargetText.trim() || !materials.length}
                onClick={startFinancialAnalysis}
                type="button"
              >
                {b('Start Analysis / 开始分析')}
              </button>
              <button
                className="rounded-xl border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-70"
                disabled={isQuotesLoading || !stockWatchlist.length}
                onClick={() => void refreshStockQuotes()}
                type="button"
              >
                {isQuotesLoading ? b('Refreshing... / 刷新中...') : b('Refresh / 刷新')}
              </button>
              <button
                className="rounded-xl border px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                onClick={() => setIsWatchlistEditing((current) => !current)}
                type="button"
              >
                {isWatchlistEditing ? b('Collapse Edit / 收起编辑') : b('Edit Watchlist / 编辑自选股')}
              </button>
            </div>
          </div>

          {isWatchlistEditing ? (
            <div className="mt-3 grid gap-2">
              <textarea
                className="min-h-28 w-full rounded-xl border bg-white px-3 py-2 text-sm outline-none transition focus:border-primary"
                onChange={(event) => setStockWatchlistText(event.target.value)}
                placeholder={language === 'zh' ? '每行一只：名称,代码,市场\n例如：北方华创,002371,A\n英伟达,NVDA,US' : 'One stock per line: name,code,market\nExample: North Huachuang,002371,A\nNVIDIA,NVDA,US'}
                value={stockWatchlistText}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                  onClick={() => void saveStockWatchlist()}
                  type="button"
                >
                  {b('Save Watchlist / 保存自选股')}
                </button>
                <span className="self-center text-xs text-muted-foreground">{b('Supported markets: A / US / HK / FX. / 支持市场：A / US / HK / FX。')}</span>
              </div>
            </div>
          ) : null}

          {stockMessage ? <p className="mt-2 text-sm text-red-600">{b(stockMessage)}</p> : null}

          <div className="mt-3 flex flex-wrap gap-2">
            {stockQuotes.length ? stockQuotes.map((quote) => {
              const colorClass = quote.changePct > 0 ? 'text-red-600' : quote.changePct < 0 ? 'text-emerald-600' : 'text-slate-600';
              const sign = quote.changePct > 0 ? '+' : '';
              const quoteKey = `${quote.market ?? 'A'}:${quote.code}`;
              const targetKey = selectedStock ? `${selectedStock.market ?? 'A'}:${selectedStock.code}` : '';
              const isSelected = quoteKey === targetKey;
              const targetText = `${quote.name} ${quote.code}`;

              return (
                <button
                  className={`financial-quote-card min-h-24 w-[calc((100%-1rem)/3)] rounded-xl border px-2 py-2 text-left transition sm:min-h-28 sm:w-28 ${isSelected ? 'border-primary bg-primary/10 ring-1 ring-primary' : 'hover:border-primary/40'}`}
                  key={`${quote.market}-${quote.code}`}
                  onClick={() => setAnalysisTargetText(targetText)}
                  type="button"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold">{quote.name}</p>
                      <p className="text-xs text-muted-foreground">{quote.code} · {quote.market ?? 'A'}</p>
                    </div>
                    <span className="text-xs text-muted-foreground">{quote.currency}</span>
                  </div>
                  <p className={`mt-2 truncate text-base font-semibold ${colorClass}`}>
                    {quote.price === null ? '--' : `${quote.currency}${quote.price.toFixed(2)}`}
                  </p>
                  <p className={`truncate text-[11px] font-medium ${colorClass}`}>
                    {sign}{quote.change.toFixed(2)} / {sign}{quote.changePct.toFixed(2)}%
                  </p>
                </button>
              );
            }) : (
              <p className="text-sm text-muted-foreground">{isLoggedIn ? b('No quotes yet. Please refresh or edit your watchlist. / 暂无行情。请刷新或编辑自选股列表。') : b('Sign in to show your watchlist live prices. / 登录后显示你的自选股实时价格。')}</p>
            )}
          </div>
        </section>

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(280px,420px)_minmax(0,1fr)]">
          <aside className="financial-glass-panel rounded-[22px] p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="font-semibold">{b('Current Materials / 本次资料')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{b('Only these materials will be analyzed; drag from saved materials or tap to add. / 只会分析这里的资料；可从历史资料拖入或点击加入。')}</p>
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <button
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-70"
                  disabled={isUploading || !isLoggedIn || !isFinancialEnabled || materials.length >= 12}
                  onClick={() => fileInputRef.current?.click()}
                  type="button"
                >
                  {isUploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                  {isUploading ? b('Uploading... / 上传中...') : b('Upload Materials / 上传材料')}
                </button>
                {materials.length ? (
                <button
                  className="rounded-xl border px-3 py-2 text-sm font-medium text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                  onClick={() => setMaterials([])}
                  type="button"
                >
                  {b('Clear Current / 清空本次')}
                </button>
                ) : null}
              </div>
            </div>
            {message ? <p className="mt-2 text-sm text-muted-foreground">{b(message)}</p> : null}
            <input
              accept="application/pdf,image/*"
              className="hidden"
              disabled={isUploading || !isLoggedIn || !isFinancialEnabled}
              multiple
              onChange={(event) => {
                const files = event.target.files;
                if (files) void handleUpload(files);
                event.target.value = '';
              }}
              ref={fileInputRef}
              type="file"
            />
            <div
              className="mt-4 grid min-h-24 gap-2 rounded-xl border border-dashed border-slate-200 p-2"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                addMaterialFromLibrary(event.dataTransfer.getData('text/plain'));
              }}
            >
              {materials.length ? materials.map((file) => (
                <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2 text-sm" key={file.storagePath}>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{file.name}</p>
                    <p className="text-xs text-muted-foreground">{file.contentType} · {describeMaterialSize(file, language)}</p>
                  </div>
                  <button
                    className="rounded-lg border bg-white p-2 text-slate-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                    onClick={() => setMaterials((current) => current.filter((item) => item.storagePath !== file.storagePath))}
                    title={b('Remove from current materials / 移出本次资料')}
                    type="button"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              )) : (
                <div className="rounded-xl border border-dashed bg-slate-50 p-4 text-sm text-muted-foreground">
                  {b('Drag in saved materials, or upload PDFs, K-line charts, order-book screenshots, and trend images. / 拖入历史资料，或上传 PDF、K 线图、盘口截图、走势图图片。')}
                </div>
              )}
            </div>

            <div className="mt-4 border-t pt-4">
              <h3 className="text-sm font-semibold">{b('Add Web Link / 加入网页链接')}</h3>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                  className="min-w-0 flex-1 rounded-xl border bg-white px-3 py-2 text-sm outline-none focus:border-primary"
                  onChange={(event) => setMaterialUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void addLinkMaterial();
                  }}
                  placeholder={b('Paste an annual report, announcement, or web link / 粘贴年报、公告或网页链接')}
                  value={materialUrl}
                />
                <button
                  className="rounded-xl border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-70"
                  disabled={!materialUrl.trim() || !isLoggedIn || !isFinancialEnabled}
                  onClick={() => void addLinkMaterial()}
                  type="button"
                >
                  {b('Add Link / 加入链接')}
                </button>
              </div>
            </div>

            <div className="mt-4 border-t pt-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">{b('Saved Materials / 历史资料')}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{b('The material index is saved after sign-in; drag or tap to add to current materials. / 登录后保存资料索引；拖动或点击可加入本次。')}</p>
                </div>
              </div>
              <div className="mt-3 grid max-h-[28rem] gap-2 overflow-y-auto pr-1">
                {materialLibrary.length ? materialLibrary.map((file) => {
                  const isCurrent = materials.some((item) => item.storagePath === file.storagePath);

                  return (
                    <div
                      className={`rounded-xl border px-3 py-2 text-sm ${isCurrent ? 'border-primary/40 bg-primary/5' : 'bg-slate-50'}`}
                      draggable
                      key={file.storagePath}
                      onDragStart={(event) => {
                        event.dataTransfer.setData('text/plain', file.storagePath);
                        event.dataTransfer.effectAllowed = 'copy';
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{file.name}</p>
                          <p className="text-xs text-muted-foreground">{file.contentType} · {describeMaterialSize(file, language)}</p>
                        </div>
                        <button
                          className="rounded-lg border bg-white p-2 text-slate-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                          onClick={() => void removeMaterialFromLibrary(file.storagePath)}
                          title={b('Remove from saved materials / 从历史资料移除')}
                          type="button"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                      <button
                        className="mt-2 w-full rounded-lg border bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={isCurrent || materials.length >= 12}
                        onClick={() => addMaterialFromLibrary(file.storagePath)}
                        type="button"
                      >
                        {isCurrent ? b('Already Current / 已在本次资料') : b('Add to Current / 加入本次资料')}
                      </button>
                    </div>
                  );
                }) : (
                  <div className="rounded-xl border border-dashed bg-slate-50 p-4 text-sm text-muted-foreground">
                    {b('No saved materials yet. Upload files or add web links to save them here. / 暂无历史资料。上传文件或加入网页链接后会保存在这里。')}
                  </div>
                )}
              </div>
            </div>
          </aside>

          <section className="financial-glass-panel rounded-[22px] p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-semibold">{b('Saved Reports / 历史报告')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{b("Only this user's analysis targets, questions, answers, and token records are saved; historical uploaded files are not stored in reports. / 只保存本用户的分析对象、问题、回答和 token 记录；不在报告中保存历史上传资料。")}</p>
              </div>
              <button
                className="rounded-xl border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-70"
                disabled={!isLoggedIn || !isFinancialEnabled}
                onClick={() => void loadReports()}
                type="button"
              >
                {b('Refresh / 刷新')}
              </button>
            </div>
            {reportsMessage ? <p className="mt-2 text-sm text-red-600">{b(reportsMessage)}</p> : null}
            <div className="mt-4 grid gap-3">
              {reports.length ? reports.map((report) => {
                return (
                  <button
                    className="rounded-xl border bg-slate-50 p-3 text-left transition hover:border-primary/40 hover:bg-primary/5"
                    key={report.id}
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent('financial-analysis-open-report', { detail: { report } }));
                    }}
                    type="button"
                  >
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <p className="font-medium">{report.stock.name} {report.stock.code}</p>
                      <p className="text-xs text-muted-foreground">{formatDate(report.createdAt)}</p>
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm text-slate-700">{report.question}</p>
                    {report.usage ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {report.usage.billableTokens.toLocaleString()} billable · {report.usage.billingMultiplier}x
                      </p>
                    ) : null}
                  </button>
                );
              }) : (
                <div className="rounded-xl border border-dashed bg-slate-50 p-4 text-sm text-muted-foreground">
                  {b('No saved reports yet. After enabling the feature and completing analysis in the floating chat window, reports will appear here automatically. / 尚无历史报告。开通后在浮动聊天窗完成分析，报告会自动出现在这里。')}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
};

export default FinancialAnalysisPage;
