'use client';

import { ArrowLeft, BarChart3, Loader2, Trash2, Upload, WalletCards } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { useFloatingChat } from '@/components/chat/floating-chat-context';

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
  { id: 'quality', label: '高質量', description: '使用更強的分析鏈路，適合正式財報和複雜盤面。' },
  { id: 'normal', label: '一般', description: '直接分析材料，適合快速判斷。' },
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

const describeMaterialSize = (material: FinancialMaterial) =>
  material.url ? '網頁連結' : `${formatMaterialSize(material.size)}`;

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
      setFinancialAccessMessage('請先登入後再開通財務分析。');
      return;
    }

    setIsActivatingFinancial(true);
    setFinancialAccessMessage(null);

    try {
      const response = await fetch('/api/auth/financial-analysis-access', { method: 'POST' });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Financial analysis access failed.');

      setIsFinancialEnabled(Boolean(result.enabled));
      setFinancialAccessMessage('財務分析已開通。');
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
      setStockMessage('請至少保留一隻自選股。');
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
      setMessage('請先登入再加入網頁連結。');
      return;
    }

    if (!isFinancialEnabled) {
      setFinancialAccessMessage('請先開通財務分析功能。');
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
      setMessage('已加入網頁連結，本次分析會嘗試讀取正文。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '請輸入有效的網頁連結。');
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
      setMessage('已從歷史資料移除。');
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
      setMessage('請先登入再上傳財務材料。');
      return;
    }

    const selectedFiles = Array.from(files).slice(0, Math.max(0, 12 - materials.length));
    if (!selectedFiles.length) {
      setMessage('本次資料已達 12 份上限。');
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
      setMessage(`已上傳 ${uploaded.length} 個材料，並加入本次分析。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Financial material upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  const startFinancialAnalysis = () => {
    if (!isLoggedIn) {
      setMessage('請先登入再使用財務分析。');
      return;
    }

    if (!isFinancialEnabled) {
      setFinancialAccessMessage('請先開通財務分析功能。');
      return;
    }

    if (!selectedStock) {
      setStockMessage('請先輸入擬分析板塊或股票。');
      return;
    }

    if (!materials.length) {
      setMessage('請先上傳財報、K 線圖、盤口截圖或走勢圖。');
      return;
    }

    window.dispatchEvent(new CustomEvent('financial-analysis-start', {
      detail: {
        prompt: `请综合分析 ${selectedStock.name}（${selectedStock.code}）的本次上传材料，并结合该分析对象的历史档案给出交易员视角的判断。`,
      },
    }));
  };

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-4 sm:px-6">
        <header className="flex flex-col gap-4 border-b bg-slate-50 pb-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <Link className="inline-flex size-10 items-center justify-center rounded-xl border bg-white text-slate-600 hover:text-primary" href="/">
              <ArrowLeft className="size-5" />
            </Link>
            <div>
              <div className="flex items-center gap-2">
                <BarChart3 className="size-5 text-primary" />
                <h1 className="text-xl font-semibold">財務分析</h1>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {authUser ? `當前帳戶：${authUser.email}` : isSessionLoading ? '正在檢查登入狀態...' : '請先回到首頁登入後使用。'}
              </p>
              <p className="mt-1 text-xs font-medium text-amber-700">該功能需要單獨開通；token 使用費按正常分析的 3 倍計算。</p>
            </div>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row lg:items-center lg:justify-end">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border bg-white p-4 text-right shadow-sm">
                <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
                  <WalletCards className="size-4" /> Token 預估
                </div>
                <p className="mt-2 text-2xl font-semibold">{materials.length ? `${materials.length} 份` : '--'}</p>
                <p className="mt-1 max-w-44 text-xs text-muted-foreground">
                  {materials.length ? `${formatMaterialSize(materialSizeTotal)} 材料；提交後按實際消耗 ×3` : '上傳財報或圖片後開始分析。'}
                </p>
              </div>
              <div className="rounded-2xl border bg-white p-4 text-right shadow-sm">
                <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
                  <WalletCards className="size-4" /> Token 餘額
                </div>
                <p className="mt-2 text-2xl font-semibold">{tokenAccount ? tokenAccount.tokenAvailable.toLocaleString() : '10,000'}</p>
                <p className="mt-1 max-w-44 text-xs text-muted-foreground">
                  {tokenAccount ? `${tokenAccount.tokenUsed.toLocaleString()} 已用 / ${tokenAccount.tokenBalance.toLocaleString()} 總額` : '預設帳戶額度'}
                </p>
              </div>
            </div>
          </div>
        </header>

        <section className="mt-4 rounded-2xl border bg-white p-4 shadow-sm">
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            本網站不面向中國大陸用戶開放。
          </div>
          <div className="mt-4 grid gap-3 border-t pt-4 text-sm md:grid-cols-3">
            <div>
              <p className="font-medium">充值參考</p>
              <p className="mt-1 text-muted-foreground">
                僅接受美元充值；US$1 ≈ 2,000,000 token，首登贈送 10,000 token。需要購買更多 token，請發郵件至{' '}
                <a className="font-medium text-primary underline-offset-4 hover:underline" href="mailto:sanbangzi@mailfence.com">
                  sci reader &lt;sanbangzi@mailfence.com&gt;
                </a>
                。
              </p>
            </div>
            <div>
              <p className="font-medium">財務扣費</p>
              <p className="mt-1 text-muted-foreground">財務分析按模型實際輸入/輸出折算後，再按正常分析的 3 倍扣費。</p>
            </div>
            <div>
              <p className="font-medium">材料說明</p>
              <p className="mt-1 text-muted-foreground">可上傳多份財報 PDF、K 線圖、盤口截圖、走勢圖，也可貼網頁連結；歷史資料和本次資料分開管理。</p>
            </div>
          </div>
        </section>

        {!isFinancialEnabled ? (
          <section className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="font-semibold text-amber-950">開通財務分析</h2>
                <p className="mt-1 text-sm leading-6 text-amber-900">
                  財務分析會讀取財報、K 線圖、盤口截圖和走勢圖，並按分析對象保存本用戶的歷史報告。使用前需單獨開通，token 使用量按正常分析的 3 倍計算。
                </p>
              </div>
              <button
                className="inline-flex items-center justify-center rounded-xl bg-amber-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-70"
                disabled={isActivatingFinancial || !isLoggedIn}
                onClick={() => void activateFinancialAnalysis()}
                type="button"
              >
                {isActivatingFinancial ? '開通中...' : '確認開通'}
              </button>
            </div>
            {financialAccessMessage ? <p className="mt-2 text-sm text-amber-900">{financialAccessMessage}</p> : null}
          </section>
        ) : null}

        <section className="mt-4 rounded-2xl border bg-white p-3 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm font-medium">自選股即時價格</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {quotesUpdatedAt ? `最近更新 ${formatDate(quotesUpdatedAt)}` : '進入頁面後自動重新整理；每 60 秒更新一次。'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="min-w-64 rounded-xl border bg-white px-3 py-2 text-sm outline-none focus:border-primary"
                onChange={(event) => setAnalysisTargetText(event.target.value)}
                placeholder="擬分析板塊或股票，例如：光伏設備、阿里巴巴 09988"
                value={analysisTargetText}
              />
              <div className="flex rounded-xl border p-1">
                {financialAnalysisModes.map((mode) => (
                  <button
                    className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition ${financialAnalysisMode === mode.id ? 'bg-primary text-primary-foreground' : 'text-slate-600 hover:bg-slate-50'}`}
                    key={mode.id}
                    onClick={() => setFinancialAnalysisMode(mode.id)}
                    title={mode.description}
                    type="button"
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
              <button
                className="rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-70"
                disabled={!isLoggedIn || !isFinancialEnabled || !analysisTargetText.trim() || !materials.length}
                onClick={startFinancialAnalysis}
                type="button"
              >
                開始分析
              </button>
              <button
                className="rounded-xl border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-70"
                disabled={isQuotesLoading || !stockWatchlist.length}
                onClick={() => void refreshStockQuotes()}
                type="button"
              >
                {isQuotesLoading ? '重新整理中...' : '重新整理'}
              </button>
              <button
                className="rounded-xl border px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                onClick={() => setIsWatchlistEditing((current) => !current)}
                type="button"
              >
                {isWatchlistEditing ? '收起編輯' : '編輯自選股'}
              </button>
            </div>
          </div>

          {isWatchlistEditing ? (
            <div className="mt-3 grid gap-2">
              <textarea
                className="min-h-28 w-full rounded-xl border bg-white px-3 py-2 text-sm outline-none transition focus:border-primary"
                onChange={(event) => setStockWatchlistText(event.target.value)}
                placeholder={'每行一隻：名稱,代碼,市場\n例如：北方華創,002371,A\n英偉達,NVDA,US'}
                value={stockWatchlistText}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                  onClick={() => void saveStockWatchlist()}
                  type="button"
                >
                  儲存自選股
                </button>
                <span className="self-center text-xs text-muted-foreground">市場支援 A / US / HK / FX。</span>
              </div>
            </div>
          ) : null}

          {stockMessage ? <p className="mt-2 text-sm text-red-600">{stockMessage}</p> : null}

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
                  className={`min-h-24 w-[calc((100%-1rem)/3)] rounded-xl border px-2 py-2 text-left transition sm:min-h-28 sm:w-28 ${isSelected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'bg-slate-50 hover:border-primary/40'}`}
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
              <p className="text-sm text-muted-foreground">{isLoggedIn ? '暫無行情。請重新整理或編輯自選股列表。' : '登入後顯示你的自選股即時價格。'}</p>
            )}
          </div>
        </section>

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(280px,420px)_minmax(0,1fr)]">
          <aside className="rounded-2xl border bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="font-semibold">本次資料</h2>
                <p className="mt-1 text-sm text-muted-foreground">只會分析這裡的資料；可從歷史資料拖入或點擊加入。</p>
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <button
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-70"
                  disabled={isUploading || !isLoggedIn || !isFinancialEnabled || materials.length >= 12}
                  onClick={() => fileInputRef.current?.click()}
                  type="button"
                >
                  {isUploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                  {isUploading ? '上傳中...' : '上傳材料'}
                </button>
                {materials.length ? (
                <button
                  className="rounded-xl border px-3 py-2 text-sm font-medium text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                  onClick={() => setMaterials([])}
                  type="button"
                >
                  清空本次
                </button>
                ) : null}
              </div>
            </div>
            {message ? <p className="mt-2 text-sm text-muted-foreground">{message}</p> : null}
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
                    <p className="text-xs text-muted-foreground">{file.contentType} · {describeMaterialSize(file)}</p>
                  </div>
                  <button
                    className="rounded-lg border bg-white p-2 text-slate-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                    onClick={() => setMaterials((current) => current.filter((item) => item.storagePath !== file.storagePath))}
                    title="移出本次資料"
                    type="button"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              )) : (
                <div className="rounded-xl border border-dashed bg-slate-50 p-4 text-sm text-muted-foreground">
                  拖入歷史資料，或上傳 PDF、K 線圖、盤口截圖、走勢圖圖片。
                </div>
              )}
            </div>

            <div className="mt-4 border-t pt-4">
              <h3 className="text-sm font-semibold">加入網頁連結</h3>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                  className="min-w-0 flex-1 rounded-xl border bg-white px-3 py-2 text-sm outline-none focus:border-primary"
                  onChange={(event) => setMaterialUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void addLinkMaterial();
                  }}
                  placeholder="貼上年報、公告或網頁連結"
                  value={materialUrl}
                />
                <button
                  className="rounded-xl border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-70"
                  disabled={!materialUrl.trim() || !isLoggedIn || !isFinancialEnabled}
                  onClick={() => void addLinkMaterial()}
                  type="button"
                >
                  加入連結
                </button>
              </div>
            </div>

            <div className="mt-4 border-t pt-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">歷史資料</h3>
                  <p className="mt-1 text-xs text-muted-foreground">登入後保存資料索引；拖動或點擊可加入本次。</p>
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
                          <p className="text-xs text-muted-foreground">{file.contentType} · {describeMaterialSize(file)}</p>
                        </div>
                        <button
                          className="rounded-lg border bg-white p-2 text-slate-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                          onClick={() => void removeMaterialFromLibrary(file.storagePath)}
                          title="從歷史資料移除"
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
                        {isCurrent ? '已在本次資料' : '加入本次資料'}
                      </button>
                    </div>
                  );
                }) : (
                  <div className="rounded-xl border border-dashed bg-slate-50 p-4 text-sm text-muted-foreground">
                    暫無歷史資料。上傳文件或加入網頁連結後會保存在這裡。
                  </div>
                )}
              </div>
            </div>
          </aside>

          <section className="rounded-2xl border bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-semibold">歷史報告</h2>
                <p className="mt-1 text-sm text-muted-foreground">只保存本用戶的分析對象、問題、回答和 token 記錄；不保存歷史上傳資料。</p>
              </div>
              <button
                className="rounded-xl border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-70"
                disabled={!isLoggedIn || !isFinancialEnabled}
                onClick={() => void loadReports()}
                type="button"
              >
                重新整理
              </button>
            </div>
            {reportsMessage ? <p className="mt-2 text-sm text-red-600">{reportsMessage}</p> : null}
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
                  尚無歷史報告。開通後在浮動聊天窗完成分析，報告會自動出現在這裡。
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
