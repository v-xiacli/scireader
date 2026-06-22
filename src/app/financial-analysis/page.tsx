'use client';

import { ArrowLeft, BarChart3, Loader2, Paperclip, Send, Trash2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

type AuthUser = { id: string; email: string };

type FinancialMaterial = {
  name: string;
  storagePath: string;
  contentType: string;
  size: number;
};

type FinancialAnalysisResult = {
  answer: string;
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    baseBillableTokens?: number;
    billableTokens: number;
    billingMultiplier?: number;
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

type FinancialChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  usage?: FinancialAnalysisResult['usage'];
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [isSessionLoading, setIsSessionLoading] = useState(true);
  const [materials, setMaterials] = useState<FinancialMaterial[]>([]);
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<FinancialChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: '上传财报 PDF、K线图、盘口截图或走势图后，直接在下面提问。我会按交易员视角，把材料、行情和风险点一起分析。',
    },
  ]);
  const [message, setMessage] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
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
      setStockMessage('请至少保留一只自选股。');
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
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isAnalyzing]);

  const handleUpload = async (files: FileList | File[]) => {
    const selectedFiles = Array.from(files).slice(0, Math.max(0, 12 - materials.length));
    if (!isLoggedIn) {
      setMessage('请先登录再上传财务材料。');
      return;
    }

    const unsupported = selectedFiles.find((file) => file.type !== 'application/pdf' && !file.type.startsWith('image/'));
    if (unsupported) {
      setMessage(`不支持的文件类型：${unsupported.name}`);
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
      setMessage(`已上传 ${uploaded.length} 个材料。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Financial material upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleSend = async () => {
    const topic = prompt.trim();

    if (!isLoggedIn) {
      setMessage('请先登录再使用财务分析。');
      return;
    }

    if (!materials.length) {
      setMessage('请先上传财务报告、走势图或盘口图片。');
      return;
    }

    if (!topic) {
      setMessage('请输入你想分析的问题。');
      return;
    }

    if (!selectedStock) {
      setMessage('请先在自选股里选择本次要分析的股票。');
      return;
    }

    const userMessage: FinancialChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: `【${selectedStock.name} ${selectedStock.code}】${topic}`,
    };

    setMessages((current) => [...current, userMessage]);
    setPrompt('');
    setIsAnalyzing(true);
    setMessage(null);

    try {
      const response = await fetch('/api/reader-agent/financial-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, files: materials, stock: selectedStock }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Financial analysis failed.');

      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: result.answer,
          usage: result.usage,
        },
      ]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Financial analysis failed.');
    } finally {
      setIsAnalyzing(false);
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
                <h1 className="text-xl font-semibold">财务分析</h1>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {authUser ? `当前账户：${authUser.email}` : isSessionLoading ? '正在检查登录状态...' : '请先回到主页登录后使用。'}
              </p>
              <p className="mt-1 text-xs font-medium text-amber-700">该功能需要单独开通；token 使用费按正常分析的 3 倍计算。</p>
            </div>
          </div>
          <button
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-70"
            disabled={isUploading || !isLoggedIn || materials.length >= 12}
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            {isUploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            {isUploading ? '上传中...' : '上传材料'}
          </button>
        </header>

        <section className="mt-4 rounded-2xl border bg-white p-3 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm font-medium">自选股实时价格</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {quotesUpdatedAt ? `最近更新 ${formatDate(quotesUpdatedAt)}` : '进入页面后自动刷新；每 60 秒更新一次。'}
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
                  <option value="">请选择股票</option>
                )}
              </select>
              <button
                className="rounded-xl border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-70"
                disabled={isQuotesLoading || !stockWatchlist.length}
                onClick={() => void refreshStockQuotes()}
                type="button"
              >
                {isQuotesLoading ? '刷新中...' : '刷新'}
              </button>
              <button
                className="rounded-xl border px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                onClick={() => setIsWatchlistEditing((current) => !current)}
                type="button"
              >
                {isWatchlistEditing ? '收起编辑' : '编辑自选股'}
              </button>
            </div>
          </div>

          {isWatchlistEditing ? (
            <div className="mt-3 grid gap-2">
              <textarea
                className="min-h-28 w-full rounded-xl border bg-white px-3 py-2 text-sm outline-none transition focus:border-primary"
                onChange={(event) => setStockWatchlistText(event.target.value)}
                placeholder={'每行一只：名称,代码,市场\n例如：北方华创,002371,A\n英伟达,NVDA,US'}
                value={stockWatchlistText}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                  onClick={() => void saveStockWatchlist()}
                  type="button"
                >
                  保存自选股
                </button>
                <span className="self-center text-xs text-muted-foreground">市场支持 A / US / HK / FX。</span>
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
              <p className="text-sm text-muted-foreground">{isLoggedIn ? '暂无行情。请刷新或编辑自选股列表。' : '登录后显示你的自选股实时价格。'}</p>
            )}
          </div>
        </section>

        <div className="mt-4 grid min-h-0 flex-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="rounded-2xl border bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">已上传材料</h2>
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
                  支持多个 PDF、K线图、盘口截图和走势图图片。
                </div>
              )}
            </div>
          </aside>

          <section className="flex min-h-[560px] flex-col rounded-2xl border bg-white shadow-sm">
            <div className="min-h-0 flex-1 overflow-auto p-4">
              <div className="mx-auto flex max-w-3xl flex-col gap-4">
                {messages.map((item) => (
                  <div className={`flex ${item.role === 'user' ? 'justify-end' : 'justify-start'}`} key={item.id}>
                    <div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-7 shadow-sm ${item.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-slate-50 text-slate-900'}`}>
                      <div className="whitespace-pre-wrap">{item.content}</div>
                      {item.usage ? (
                        <p className={`mt-3 text-xs ${item.role === 'user' ? 'text-primary-foreground/75' : 'text-muted-foreground'}`}>
                          input {item.usage.inputTokens.toLocaleString()} / output {item.usage.outputTokens.toLocaleString()} / billable {item.usage.billableTokens.toLocaleString()}
                          {item.usage.billingMultiplier ? ` / ${item.usage.billingMultiplier}x` : ''}
                          {item.usage.baseBillableTokens ? ` / base ${item.usage.baseBillableTokens.toLocaleString()}` : ''}
                          {item.usage.cacheReadInputTokens ? ` / cache read ${item.usage.cacheReadInputTokens.toLocaleString()}` : ''}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ))}
                {isAnalyzing ? (
                  <div className="flex justify-start">
                    <div className="inline-flex items-center gap-2 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-muted-foreground shadow-sm">
                      <Loader2 className="size-4 animate-spin" />
                      正在分析材料...
                    </div>
                  </div>
                ) : null}
                <div ref={chatBottomRef} />
              </div>
            </div>

            <div className="border-t p-3">
              {message ? <p className="mb-2 text-sm text-muted-foreground">{message}</p> : null}
              <div className="mx-auto flex max-w-3xl items-end gap-2">
                <button
                  className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl border text-slate-600 disabled:cursor-not-allowed disabled:opacity-70"
                  disabled={isUploading || !isLoggedIn || materials.length >= 12}
                  onClick={() => fileInputRef.current?.click()}
                  title="上传材料"
                  type="button"
                >
                  {isUploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
                </button>
                <textarea
                  className="max-h-40 min-h-11 flex-1 resize-none rounded-xl border px-4 py-3 text-sm outline-none transition focus:border-primary"
                  disabled={isAnalyzing || !isLoggedIn}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void handleSend();
                    }
                  }}
                  placeholder="例如：结合这些财报和盘口截图，判断短线资金是否有异动，中线基本面风险在哪里。"
                  value={prompt}
                />
                <button
                  className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground disabled:cursor-not-allowed disabled:opacity-70"
                  disabled={isAnalyzing || !isLoggedIn || !materials.length || !prompt.trim() || !selectedStock}
                  onClick={() => void handleSend()}
                  title="发送"
                  type="button"
                >
                  {isAnalyzing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
};

export default FinancialAnalysisPage;
