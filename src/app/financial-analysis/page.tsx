'use client';

import { ArrowLeft, BarChart3, Loader2, Trash2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { useFloatingChat } from '@/components/chat/floating-chat-context';

type AuthUser = { id: string; email: string };

type FinancialMaterial = {
  name: string;
  storagePath: string;
  contentType: string;
  size: number;
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

const formatDate = (value: string) => {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const formatStockWatchlistText = (watchlist: StockWatchlistItem[]) =>
  watchlist.map((item) => `${item.name},${item.code},${item.market ?? 'A'}`).join('\n');

const parseStockWatchlistText = (text: string): StockWatchlistItem[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = '', code = '', market = 'A'] = line.split(/[,\s，]+/).map((part) => part.trim()).filter(Boolean);
      const normalizedMarket = ['A', 'US', 'HK', 'FX'].includes(market.toUpperCase()) ? (market.toUpperCase() as StockWatchlistItem['market']) : 'A';

      return { name, code: code.toUpperCase(), market: normalizedMarket };
    })
    .filter((item) => item.name && item.code)
    .slice(0, 80);

const FinancialAnalysisPage = () => {
  const { setFinancialContext } = useFloatingChat();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [isSessionLoading, setIsSessionLoading] = useState(true);
  const [materials, setMaterials] = useState<FinancialMaterial[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [stockWatchlist, setStockWatchlist] = useState<StockWatchlistItem[]>([]);
  const [stockWatchlistText, setStockWatchlistText] = useState('');
  const [stockQuotes, setStockQuotes] = useState<StockQuote[]>([]);
  const [stockMessage, setStockMessage] = useState<string | null>(null);
  const [isQuotesLoading, setIsQuotesLoading] = useState(false);
  const [isWatchlistEditing, setIsWatchlistEditing] = useState(false);
  const [quotesUpdatedAt, setQuotesUpdatedAt] = useState<string | null>(null);
  const [selectedStockKey, setSelectedStockKey] = useState('');

  const isLoggedIn = Boolean(authUser);
  const selectedStock = stockWatchlist.find((stock) => `${stock.market ?? 'A'}:${stock.code}` === selectedStockKey) ?? stockWatchlist[0] ?? null;

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
      if (watchlist.length) setSelectedStockKey((current) => current || `${watchlist[0].market ?? 'A'}:${watchlist[0].code}`);
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
      if (result.watchlist.length) setSelectedStockKey(`${result.watchlist[0].market ?? 'A'}:${result.watchlist[0].code}`);
      setIsWatchlistEditing(false);
      void refreshStockQuotes(result.watchlist);
    } catch (error) {
      setStockMessage(error instanceof Error ? error.message : 'Could not save watchlist.');
    }
  };

  useEffect(() => {
    const loadSession = async () => {
      try {
        const response = await fetch('/api/auth/me');
        const result = await response.json();

        if (response.ok && result.user) {
          setAuthUser(result.user);
          await loadStockWatchlist();
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
      active: true,
      materials,
      selectedStock,
      billingMultiplier: 3,
    });
  }, [materials, selectedStock, setFinancialContext]);

  useEffect(() => () => setFinancialContext(null), [setFinancialContext]);

  const handleUpload = async (files: FileList | File[]) => {
    const selectedFiles = Array.from(files).slice(0, Math.max(0, 12 - materials.length));
    if (!isLoggedIn) {
      setMessage('請先登入再上傳財務材料。');
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
        });
      }

      setMaterials((current) => [...current, ...uploaded].slice(-12));
      setMessage(`已上傳 ${uploaded.length} 個材料。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Financial material upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-4 sm:px-6">
        <header className="flex flex-col gap-3 border-b bg-slate-50 pb-4 sm:flex-row sm:items-center sm:justify-between">
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
          <button
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-70"
            disabled={isUploading || !isLoggedIn || materials.length >= 12}
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            {isUploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            {isUploading ? '上傳中...' : '上傳材料'}
          </button>
        </header>

        <section className="mt-4 rounded-2xl border bg-white p-3 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm font-medium">自選股即時價格</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {quotesUpdatedAt ? `最近更新 ${formatDate(quotesUpdatedAt)}` : '進入頁面後自動重新整理；每 60 秒更新一次。'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="rounded-xl border bg-white px-3 py-2 text-sm outline-none focus:border-primary"
                disabled={!stockWatchlist.length}
                onChange={(event) => setSelectedStockKey(event.target.value)}
                value={selectedStockKey}
              >
                {stockWatchlist.length ? stockWatchlist.map((stock) => (
                  <option key={`${stock.market ?? 'A'}:${stock.code}`} value={`${stock.market ?? 'A'}:${stock.code}`}>
                    分析：{stock.name} {stock.code}
                  </option>
                )) : (
                  <option value="">請選擇股票</option>
                )}
              </select>
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

          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {stockQuotes.length ? stockQuotes.map((quote) => {
              const colorClass = quote.changePct > 0 ? 'text-red-600' : quote.changePct < 0 ? 'text-emerald-600' : 'text-slate-600';
              const sign = quote.changePct > 0 ? '+' : '';
              const quoteKey = `${quote.market ?? 'A'}:${quote.code}`;
              const isSelected = quoteKey === selectedStockKey;

              return (
                <button
                  className={`min-w-44 rounded-xl border px-3 py-2 text-left transition ${isSelected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'bg-slate-50 hover:border-primary/40'}`}
                  key={`${quote.market}-${quote.code}`}
                  onClick={() => setSelectedStockKey(quoteKey)}
                  type="button"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{quote.name}</p>
                      <p className="text-xs text-muted-foreground">{quote.code} · {quote.market ?? 'A'}</p>
                    </div>
                    <span className="text-xs text-muted-foreground">{quote.currency}</span>
                  </div>
                  <p className={`mt-2 text-lg font-semibold ${colorClass}`}>
                    {quote.price === null ? '--' : `${quote.currency}${quote.price.toFixed(2)}`}
                  </p>
                  <p className={`text-xs font-medium ${colorClass}`}>
                    {sign}{quote.change.toFixed(2)} / {sign}{quote.changePct.toFixed(2)}%
                  </p>
                </button>
              );
            }) : (
              <p className="text-sm text-muted-foreground">{isLoggedIn ? '暫無行情。請重新整理或編輯自選股列表。' : '登入後顯示你的自選股即時價格。'}</p>
            )}
          </div>
        </section>

        <div className="mt-4 grid max-w-xl gap-4">
          <aside className="rounded-2xl border bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">已上傳材料</h2>
              {materials.length ? (
                <button
                  className="text-sm font-medium text-slate-500 hover:text-red-600"
                  onClick={() => setMaterials([])}
                  type="button"
                >
                  清空
                </button>
              ) : null}
            </div>
            {message ? <p className="mt-2 text-sm text-muted-foreground">{message}</p> : null}
            <input
              accept="application/pdf,image/*"
              className="hidden"
              disabled={isUploading || !isLoggedIn}
              multiple
              onChange={(event) => {
                const files = event.target.files;
                if (files) void handleUpload(files);
                event.target.value = '';
              }}
              ref={fileInputRef}
              type="file"
            />
            <div className="mt-4 grid gap-2">
              {materials.length ? materials.map((file) => (
                <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2 text-sm" key={file.storagePath}>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{file.name}</p>
                    <p className="text-xs text-muted-foreground">{file.contentType} · {(file.size / 1024 / 1024).toFixed(2)} MB</p>
                  </div>
                  <button
                    className="rounded-lg border bg-white p-2 text-slate-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                    onClick={() => setMaterials((current) => current.filter((item) => item.storagePath !== file.storagePath))}
                    title="移除材料"
                    type="button"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              )) : (
                <div className="rounded-xl border border-dashed bg-slate-50 p-4 text-sm text-muted-foreground">
                  支援多個 PDF、K 線圖、盤口截圖和走勢圖圖片。
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
};

export default FinancialAnalysisPage;
