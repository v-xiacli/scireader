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
    title: 'Financial Analysis / 财务分析',
    description: 'Upload financial reports, K-line charts, order-book screenshots, and trend images for stock analysis in the floating chat window. / 上传财报 PDF、K 线图、盘口截图和走势图，通过浮动聊天窗进行股票分析。',
    icon: BarChart3,
  },
  {
    href: '/research',
    title: 'Research Papers / 科研论文',
    description: 'Upload PDF papers, generate reading notes, ask literature questions, and prepare Introduction drafts in writing mode. / 上传 PDF 论文、生成读书笔记、进行文献问答，并使用写作模式整理 Introduction。',
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

      if (!response.ok) throw new Error(result.error ?? result.message ?? 'Login failed. / 登录失败。');

      setAuthUser(result.user);
      setTokenAccount(result.tokenAccount ?? null);
      setAuthMessage(`${authMode === 'signup' ? 'Account created / 账号已建立' : 'Signed in / 已登录'}: ${result.user.email}`);
      setPassword('');
      setVerificationCode('');
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : 'Login failed. / 登录失败。');
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

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Could not send verification code. / 无法发送验证码。');

      setAuthMessage('Verification code sent. Please check your email. / 验证码已发送，请查看邮箱。');
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : 'Could not send verification code. / 无法发送验证码。');
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
    setAuthMessage('Signed out. / 已登出。');
  };

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-6">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-4xl flex-col justify-center">
        <header className="mb-6">
          <p className="text-sm font-medium text-primary">SCIReader</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-normal text-slate-950">Choose a Workspace / 选择工作模块</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Sign in or create an account here, then enter Research Papers or Financial Analysis. / 先在主页登录或注册，再进入科研论文或财务分析工作区。
          </p>
        </header>

        <section className="mb-5 rounded-2xl border bg-white p-5 shadow-sm">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px] lg:items-start">
            <div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-xl font-semibold">Account / 账号</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {isSessionLoading ? 'Checking sign-in status... / 正在检查登录状态...' : authUser ? `Current account / 当前账号: ${authUser.email}` : 'Sign in or create an account to use SCIReader. / 登录或注册后即可使用 SCIReader。'}
                  </p>
                </div>
                {authUser ? (
                  <button
                    className="rounded-xl border px-4 py-2 text-sm font-medium"
                    onClick={() => void handleLogout()}
                    type="button"
                  >
                    Sign out / 登出
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
                      Sign in / 登录
                    </button>
                    <button
                      className={`rounded-lg px-3 py-1.5 text-sm ${authMode === 'signup' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                      onClick={() => setAuthMode('signup')}
                      type="button"
                    >
                      Sign up / 注册
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
                    {isAuthLoading ? 'Please wait... / 请稍候...' : authMode === 'signup' ? 'Sign up / 注册' : 'Sign in / 登录'}
                  </button>
                  {authMode === 'signup' && isSignupVerificationEnabled ? (
                    <div className="md:col-span-4 flex flex-col gap-2 sm:flex-row">
                      <input
                        className="min-w-0 rounded-xl border px-4 py-2 text-sm sm:w-48"
                        inputMode="numeric"
                        maxLength={6}
                        onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="6-digit code / 6 位验证码"
                        value={verificationCode}
                      />
                      <button
                        className="rounded-xl border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-70"
                        disabled={isSendingVerificationCode || !email}
                        onClick={() => void handleSendVerificationCode()}
                        type="button"
                      >
                        {isSendingVerificationCode ? 'Sending... / 发送中...' : 'Send code / 发送验证码'}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {authMessage ? <p className="mt-3 text-sm text-muted-foreground">{authMessage}</p> : null}
            </div>

            <div className="rounded-2xl border bg-slate-50 p-4 text-right">
              <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
                <WalletCards className="size-4" /> Token Balance / Token 余额
              </div>
              <p className="mt-2 text-3xl font-semibold">{tokenAccount ? tokenAccount.tokenAvailable.toLocaleString() : '200,000'}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {tokenAccount ? `${tokenAccount.tokenUsed.toLocaleString()} used / 已用 · ${tokenAccount.tokenBalance.toLocaleString()} total / 总额` : 'Default account quota / 预设账号额度'}
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
