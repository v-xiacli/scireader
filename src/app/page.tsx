'use client';

'use client';

import { ArrowRight, BarChart3, FileText, Loader2, WalletCards } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

type AuthMode = 'login' | 'signup';
type AuthUser = { id: string; email: string };
type TokenAccount = { tokenBalance: number; tokenUsed: number; tokenAvailable: number };

const modules = [
  {
    href: '/financial-analysis',
    title: '財務分析',
    description: '上傳財報 PDF、K 線圖、盤口截圖和走勢圖，透過浮動聊天窗進行股票分析。',
    icon: BarChart3,
  },
  {
    href: '/research',
    title: '科研論文',
    description: '上傳 PDF 論文、生成讀書筆記、進行文獻問答，並使用寫作模式整理 Introduction。',
    icon: FileText,
  },
];

const HomePage = () => {
  const isSignupVerificationEnabled = true;
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [tokenAccount, setTokenAccount] = useState<TokenAccount | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [isSendingVerificationCode, setIsSendingVerificationCode] = useState(false);
  const [isSessionLoading, setIsSessionLoading] = useState(true);

  useEffect(() => {
    const loadSession = async () => {
      try {
        const response = await fetch('/api/auth/me');
        const result = await response.json();

        if (response.ok && result.user) {
          setAuthUser(result.user);
          setTokenAccount(result.tokenAccount ?? null);
        }
      } catch {
        setAuthUser(null);
        setTokenAccount(null);
      } finally {
        setIsSessionLoading(false);
      }
    };

    void loadSession();
  }, []);

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

      if (!response.ok) throw new Error(result.error ?? result.message ?? '登入失敗。');

      setAuthUser(result.user);
      setTokenAccount(result.tokenAccount ?? null);
      setAuthMessage(`${authMode === 'signup' ? '帳戶已建立' : '已登入'}：${result.user.email}`);
      setPassword('');
      setVerificationCode('');
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : '登入失敗。');
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

      if (!response.ok) throw new Error(result.message ?? result.error ?? '無法發送驗證碼。');

      setAuthMessage('驗證碼已發送，請查看郵箱。');
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : '無法發送驗證碼。');
    } finally {
      setIsSendingVerificationCode(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setAuthUser(null);
    setTokenAccount(null);
    setPassword('');
    setVerificationCode('');
    setAuthMessage('已登出。');
  };

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-6">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-4xl flex-col justify-center">
        <header className="mb-6">
          <p className="text-sm font-medium text-primary">SCIReader</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-normal text-slate-950">選擇工作模組</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            先在主頁登入或註冊，再進入科研論文或財務分析工作區。
          </p>
        </header>

        <section className="mb-5 rounded-2xl border bg-white p-5 shadow-sm">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px] lg:items-start">
            <div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-xl font-semibold">帳戶</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {isSessionLoading ? '正在檢查登入狀態...' : authUser ? `目前帳戶：${authUser.email}` : '登入或註冊後即可使用 SCIReader。'}
                  </p>
                </div>
                {authUser ? (
                  <button
                    className="rounded-xl border px-4 py-2 text-sm font-medium"
                    onClick={() => void handleLogout()}
                    type="button"
                  >
                    登出
                  </button>
                ) : null}
              </div>

              {!authUser ? (
                <div className="mt-4 grid gap-3 md:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center">
                  <div className="flex rounded-xl border p-1">
                    <button
                      className={`rounded-lg px-3 py-1.5 text-sm ${authMode === 'login' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                      onClick={() => setAuthMode('login')}
                      type="button"
                    >
                      登入
                    </button>
                    <button
                      className={`rounded-lg px-3 py-1.5 text-sm ${authMode === 'signup' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                      onClick={() => setAuthMode('signup')}
                      type="button"
                    >
                      註冊
                    </button>
                  </div>
                  <input
                    className="rounded-xl border px-4 py-2 text-sm"
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="Email"
                    type="email"
                    value={email}
                  />
                  <input
                    className="rounded-xl border px-4 py-2 text-sm"
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Password"
                    type="password"
                    value={password}
                  />
                  <button
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-70"
                    disabled={isAuthLoading || !email || !password || (authMode === 'signup' && isSignupVerificationEnabled && verificationCode.length !== 6)}
                    onClick={() => void handleAuth()}
                    type="button"
                  >
                    {isAuthLoading ? <Loader2 className="size-4 animate-spin" /> : null}
                    {isAuthLoading ? '請稍候...' : authMode === 'signup' ? '註冊' : '登入'}
                  </button>
                  {authMode === 'signup' && isSignupVerificationEnabled ? (
                    <div className="md:col-span-4 flex flex-col gap-2 sm:flex-row">
                      <input
                        className="min-w-0 rounded-xl border px-4 py-2 text-sm sm:w-48"
                        inputMode="numeric"
                        maxLength={6}
                        onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="6 位驗證碼"
                        value={verificationCode}
                      />
                      <button
                        className="rounded-xl border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-70"
                        disabled={isSendingVerificationCode || !email}
                        onClick={() => void handleSendVerificationCode()}
                        type="button"
                      >
                        {isSendingVerificationCode ? '發送中...' : '發送驗證碼'}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {authMessage ? <p className="mt-3 text-sm text-muted-foreground">{authMessage}</p> : null}
            </div>

            <div className="rounded-2xl border bg-slate-50 p-4 text-right">
              <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
                <WalletCards className="size-4" /> Token 餘額
              </div>
              <p className="mt-2 text-3xl font-semibold">{tokenAccount ? tokenAccount.tokenAvailable.toLocaleString() : '200,000'}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {tokenAccount ? `${tokenAccount.tokenUsed.toLocaleString()} 已用 / ${tokenAccount.tokenBalance.toLocaleString()} 總額` : '預設帳戶額度'}
              </p>
            </div>
          </div>
        </section>

        <div className="grid gap-4">
          {modules.map((item) => {
            const Icon = item.icon;

            return (
              <Link
                className="group flex items-center gap-4 rounded-2xl border bg-white p-5 shadow-sm transition hover:border-primary/40 hover:shadow-md"
                href={item.href}
                key={item.href}
              >
                <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Icon className="size-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-xl font-semibold text-slate-950">{item.title}</h2>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.description}</p>
                </div>
                <ArrowRight className="size-5 shrink-0 text-slate-400 transition group-hover:translate-x-1 group-hover:text-primary" />
              </Link>
            );
          })}
        </div>
      </div>
    </main>
  );
};

export default HomePage;
