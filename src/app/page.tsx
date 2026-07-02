'use client';

import { ArrowRight, BarChart3, Check, FileText, Gift, Loader2, ShieldCheck, Sparkles, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { LanguageToggle, useLanguage, type AppLanguage } from '@/components/language/language-context';

type AuthMode = 'login' | 'signup';
type AuthUser = { id: string; email: string };
type TokenAccount = { tokenBalance: number; tokenUsed: number; tokenAvailable: number };

const copy = {
  en: {
    login: 'Log in', signup: 'Chat without signup', badge: 'Research-first AI reading copilot',
    headline: 'Deep understanding for physics papers and financial reports',
    intro: 'SCIReader goes beyond summarization. Uncover physics from first principles, interrogate the business logic behind financial reports, and keep exploring without the tiny daily token quotas common on free AI sites.',
    benefits: ['Reconstruct physical principles, assumptions, and causal chains', 'Connect financial figures to business drivers, risks, and management claims', 'Resolve precise questions through a few rounds of grounded dialogue', 'Escape restrictive daily token quotas at an extremely low usage cost'],
    chips: ['Physics reasoning', 'Financial insight', 'Low-cost access', 'Generous token quota', 'No phone required'],
    tokenOffer: 'Free account · 200,000 tokens', createTitle: 'Create your free account', loginTitle: 'Log in to SCIReader',
    accountHint: 'Bring a paper and help shape a research tool built for deep understanding.', password: 'Password (at least 8 characters)',
    code: '6-digit email code', sendCode: 'Send code', sending: 'Sending', create: 'Create account',
    noPhone: 'No phone number required', noPhoneDetail: 'Register with your email only — no phone verification, no SMS code, and no credit card required.',
    already: 'Already have an account?', newHere: 'New to SCIReader?', welcome: 'Welcome back', account: 'My account', available: 'tokens available', logout: 'Log out',
    workspaceTitle: 'Two domains, one standard: deep understanding', workspaceHint: 'Research remains the lead experience, with equally serious reasoning for financial reports.', included: 'Included on the free plan',
    workspaces: [
      { href: '/research', title: 'Research Papers', description: 'Upload PDF papers, generate reading notes, ask literature questions, and draft your Introduction in writing mode.', icon: FileText },
      { href: '/financial-analysis', title: 'Financial Analysis', description: 'Upload financial reports, K-line charts, and order-book screenshots for stock analysis in a floating chat window.', icon: BarChart3 },
    ],
    ctaTitle: 'Understand more, without hitting a daily wall', ctaText: 'Go deep on difficult papers and financial reports with 1,000,000 starter tokens — a low-cost alternative to the tight daily limits of many free AI sites.', ctaButton: 'Join early access',
    codeSent: 'Verification code sent. Please check your email.', codeFailed: 'Could not send the verification code.', actionFailed: 'Something went wrong. Please try again.', signupSuccess: 'Account created successfully.', loginSuccess: 'Logged in successfully.',
  },
  zh: {
    login: '登录', signup: '免注册对话', badge: '科研优先的深度理解助手', headline: '深刻理解物理原理，也读透每一份财报',
    intro: 'SCIReader 不止生成摘要。它能从第一性原理拆解物理机制，追问财报背后的业务逻辑，还让你不再被常见免费 AI 网站短促的每日 token 配额打断。',
    benefits: ['还原物理原理、关键假设与完整因果链条', '把财务数字与业务驱动、风险和管理层判断相互印证', '通过几轮有原文依据的对话，精准解决具体困惑', '以极低使用成本，摆脱常见免费 AI 网站的每日 token 限制'],
    chips: ['物理推理', '财报洞察', '低成本使用', '充足 token 配额', '无需手机号'],
    tokenOffer: '免费账号 · 20 万 tokens', createTitle: '创建免费账号', loginTitle: '登录 SCIReader', accountHint: '带上一篇论文，一起打磨一款真正追求深度理解的科研工具。',
    password: '密码（至少 8 位）', code: '6 位邮箱验证码', sendCode: '发送验证码', sending: '发送中', create: '注册账号',
    noPhone: '无需手机号，仅用邮箱注册', noPhoneDetail: '无需手机验证、无需短信验证码、无需信用卡，填写邮箱即可开始使用。', already: '已有账号？', newHere: '还没有账号？',
    welcome: '欢迎回来', account: '我的账户', available: '可用 tokens', logout: '退出登录', workspaceTitle: '两个领域，同一种标准：深度理解', workspaceHint: '科研体验依然优先，同时以同样严谨的方式深入解读财务报告。', included: '免费套餐已包含',
    workspaces: [
      { href: '/research', title: '科研论文', description: '上传 PDF 论文、生成读书笔记、进行文献问答，并在写作模式中整理 Introduction。', icon: FileText },
      { href: '/financial-analysis', title: '财务分析', description: '上传财报 PDF、K 线图和盘口截图，在浮动聊天窗中进行股票分析。', icon: BarChart3 },
    ],
    ctaTitle: '深入理解，不再每天撞上限额', ctaText: '用 100 万初始 tokens 深入追问论文和财报。相比许多免费 AI 网站紧张的每日配额，SCIReader 让持续探索的成本降到极低。', ctaButton: '加入早期体验',
    codeSent: '验证码已发送，请查看邮箱。', codeFailed: '验证码发送失败。', actionFailed: '操作失败，请稍后再试。', signupSuccess: '账号创建成功。', loginSuccess: '登录成功。',
  },
} satisfies Record<AppLanguage, {
  login: string;
  signup: string;
  badge: string;
  headline: string;
  intro: string;
  benefits: readonly string[];
  chips: readonly string[];
  tokenOffer: string;
  createTitle: string;
  loginTitle: string;
  accountHint: string;
  password: string;
  code: string;
  sendCode: string;
  sending: string;
  create: string;
  noPhone: string;
  noPhoneDetail: string;
  already: string;
  newHere: string;
  welcome: string;
  account: string;
  available: string;
  logout: string;
  workspaceTitle: string;
  workspaceHint: string;
  included: string;
  workspaces: readonly { href: string; title: string; description: string; icon: LucideIcon }[];
  ctaTitle: string;
  ctaText: string;
  ctaButton: string;
  codeSent: string;
  codeFailed: string;
  actionFailed: string;
  signupSuccess: string;
  loginSuccess: string;
}>;

const ScienceWaterRipples = () => (
  <div aria-hidden="true" className="science-water-ripples">
    <svg className="science-water-ripple-art" viewBox="0 0 1200 620" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="wave-highlight" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#f1f8ff" stopOpacity=".95" />
          <stop offset="1" stopColor="#9fc3f5" stopOpacity=".25" />
        </linearGradient>
        <linearGradient id="beacon-light" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#52f0a4" stopOpacity=".72" />
          <stop offset=".55" stopColor="#52f0a4" stopOpacity=".18" />
          <stop offset="1" stopColor="#52f0a4" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="tower-blue" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#79a9e7" />
          <stop offset="1" stopColor="#326dbb" />
        </linearGradient>
      </defs>
      <path className="lighthouse-beam" d="M405 135 L1190 36 L1190 252 Z" fill="url(#beacon-light)" />
      {Array.from({ length: 8 }, (_, index) => (
        <g className={`water-ring water-ring-${index + 1}`} key={index}>
          <ellipse className="water-ring-highlight" cx="405" cy="263" rx="82" ry="24" vectorEffect="non-scaling-stroke" />
        </g>
      ))}
      <ellipse className="water-center-light" cx="405" cy="263" rx="32" ry="7" />
      <g className="minimal-lighthouse">
        <path d="M372 270 L389 156 H421 L438 270 Z" fill="url(#tower-blue)" />
        <path d="M378 220 H432 M384 181 H426" fill="none" stroke="#275fa9" strokeOpacity=".48" strokeWidth="3" />
        <rect x="399" y="238" width="12" height="32" rx="3" fill="#245b9f" />
        <path d="M365 156 H445" stroke="#2b65ad" strokeLinecap="round" strokeWidth="6" />
        <path d="M375 156 V139 M390 156 V139 M420 156 V139 M435 156 V139" stroke="#4f8bd5" strokeWidth="2.5" />
        <rect x="384" y="115" width="42" height="29" rx="4" fill="#3976c2" />
        <path d="M378 115 L405 96 L432 115 Z" fill="#3976c2" />
        <path d="M405 96 V74" stroke="#4e87cf" strokeLinecap="round" strokeWidth="3" />
        <circle cx="405" cy="72" r="4" fill="#65a0e4" />
        <path d="M365 270 H445" stroke="#5e94d8" strokeLinecap="round" strokeWidth="7" />
      </g>
    </svg>
  </div>
);

const HomePage = () => {
  const { language } = useLanguage();
  const [authMode, setAuthMode] = useState<AuthMode>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [tokenAccount, setTokenAccount] = useState<TokenAccount | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [isSendingCode, setIsSendingCode] = useState(false);
  const t = copy[language];

  useEffect(() => {
    const loadSession = async () => {
      try {
        const response = await fetch('/api/auth/me');
        const result = await response.json();
        if (response.ok && result.user) { setAuthUser(result.user); setTokenAccount(result.tokenAccount ?? null); }
      } catch { setAuthUser(null); }
    };
    void loadSession();
  }, []);

  const handleAuth = async () => {
    setIsAuthLoading(true); setAuthMessage(null);
    try {
      const response = await fetch(`/api/auth/${authMode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(authMode === 'signup' ? { email, password, verificationCode } : { email, password }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? result.message ?? t.actionFailed);
      setAuthUser(result.user); setTokenAccount(result.tokenAccount ?? null); setAuthMessage(authMode === 'signup' ? t.signupSuccess : t.loginSuccess); setPassword('');
    } catch (error) { setAuthMessage(error instanceof Error ? error.message : t.actionFailed); }
    finally { setIsAuthLoading(false); }
  };

  const handleSendCode = async () => {
    setIsSendingCode(true); setAuthMessage(null);
    try {
      const response = await fetch('/api/auth/send-verification-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? result.message ?? t.codeFailed);
      setAuthMessage(t.codeSent);
    } catch (error) { setAuthMessage(error instanceof Error ? error.message : t.codeFailed); }
    finally { setIsSendingCode(false); }
  };

  const handleLogout = () => {
    setAuthUser(null);
    setTokenAccount(null);
    setAuthMessage(null);
    setPassword('');
    setVerificationCode('');
    void fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
  };
  const scrollToAccount = () => document.getElementById('account')?.scrollIntoView({ behavior: 'smooth' });
  const selectMode = (mode: AuthMode) => { setAuthMode(mode); scrollToAccount(); };
  const openGuestChat = () => window.dispatchEvent(new Event('scireader-open-chat'));

  return (
    <main className="landing-background min-h-screen text-[#091329]">
      <ScienceWaterRipples />
      <div className="relative z-10 mx-auto w-full max-w-[1130px] px-4 pb-28 pt-4 sm:px-8 sm:pb-8 sm:pt-6 lg:px-12">
        <header className="flex items-center justify-between">
          <Link className="flex items-center gap-2 font-bold tracking-tight sm:gap-3" href="/"><span className="flex size-9 items-center justify-center rounded-[10px] bg-[#0d8278] text-white"><FileText className="size-[19px]" /></span><span className="text-[17px] sm:text-[19px]">SCIReader</span></Link>
          <nav className="flex items-center gap-2 text-xs font-medium">
            <LanguageToggle className="hidden sm:flex" />
            {authUser ? <>
              <button className="rounded-lg border border-[#dce2ec] bg-white px-3 py-2 sm:px-4" onClick={scrollToAccount} type="button">{t.account}</button>
              <button className="rounded-lg bg-[#0d8278] px-3 py-2 text-white sm:px-4" onClick={handleLogout} type="button">{t.logout}</button>
            </> : <>
              <button className="rounded-lg border border-[#dce2ec] bg-white px-3 py-2 sm:px-4" onClick={() => selectMode('login')} type="button">{t.login}</button>
              <button className="rounded-lg bg-[#0d8278] px-3 py-2 text-white sm:px-4" onClick={openGuestChat} type="button">{t.signup}</button>
            </>}
          </nav>
        </header>

        <section className="grid gap-6 pb-9 pt-8 sm:gap-10 sm:pb-16 sm:pt-16 lg:grid-cols-[1.35fr_0.85fr] lg:items-center lg:gap-16 lg:pb-20">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-[#dfeeed] px-3 py-1.5 text-xs font-semibold text-[#08746c]"><Sparkles className="size-3.5" />{t.badge}</div>
            <h1 className="mt-5 max-w-[620px] text-[36px] font-black leading-[1.08] tracking-[-0.04em] sm:text-[50px] sm:leading-[1.05]">{t.headline}</h1>
            <p className="mt-5 max-w-[590px] text-[15px] leading-7 text-[#62708a]">{t.intro}</p>
            <ul className="mt-6 space-y-3 text-[14px] text-[#34425c]">{t.benefits.map((item) => <li className="flex items-center gap-3" key={item}><span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-[#dceeed] text-[#0d8278]"><Check className="size-3.5" strokeWidth={3} /></span>{item}</li>)}</ul>
            <div className="mt-7 flex flex-wrap gap-2">{t.chips.map((item, index) => <span className={index === t.chips.length - 1 ? 'inline-flex w-full items-center justify-center rounded-2xl border-2 border-[#79bdb6] bg-[#def2ef] px-6 py-4 text-[24px] font-black leading-tight text-[#066b64] shadow-sm sm:w-auto sm:text-[27px]' : 'rounded-full border border-[#dbe1eb] bg-white px-3 py-1.5 text-xs font-medium text-[#42506a]'} key={item}><span className="mr-3 text-[#0d8278]">●</span>{item}</span>)}</div>
          </div>

          <div className="rounded-[18px] border border-[#e0e5ed] bg-white p-4 shadow-[0_12px_32px_rgba(29,45,68,0.12)] sm:rounded-[22px] sm:p-7 sm:shadow-[0_18px_45px_rgba(29,45,68,0.14)]" id="account">
            {authUser ? <div className="py-1 text-center sm:py-5"><span className="mx-auto flex size-10 items-center justify-center rounded-full bg-[#dfeeed] text-[#0d8278] sm:size-12"><Check className="size-5 sm:size-6" /></span><h2 className="mt-2 text-lg font-bold sm:mt-4 sm:text-xl">{t.welcome}</h2><p className="mt-1 truncate text-xs text-[#71809b] sm:mt-2 sm:text-sm">{authUser.email}</p><p className="mt-3 text-[28px] font-black leading-none text-[#0d8278] sm:mt-5 sm:text-3xl">{tokenAccount?.tokenAvailable.toLocaleString() ?? '200,000'}</p><p className="mt-1 text-xs text-[#71809b]">{t.available}</p><button className="mt-3 text-sm font-semibold text-[#0d8278] sm:mt-6" onClick={handleLogout} type="button">{t.logout}</button></div> : <>
              <div className="inline-flex items-center gap-2 rounded-full bg-[#dfeeed] px-3 py-1.5 text-xs font-bold text-[#08746c]"><Gift className="size-3.5" />{t.tokenOffer}</div>
              <h2 className="mt-5 text-[22px] font-black">{authMode === 'signup' ? t.createTitle : t.loginTitle}</h2><p className="mt-1 text-xs text-[#8290a8]">{t.accountHint}</p>
              <div className="mt-5 space-y-3"><input className="h-12 w-full rounded-xl border bg-[#fafbfd] px-4 text-sm outline-none focus:border-[#0d8278]" onChange={(e) => setEmail(e.target.value)} placeholder="you@university.edu" type="email" value={email} /><input className="h-12 w-full rounded-xl border bg-[#fafbfd] px-4 text-sm outline-none focus:border-[#0d8278]" onChange={(e) => setPassword(e.target.value)} placeholder={t.password} type="password" value={password} />
                {authMode === 'signup' ? <div className="flex flex-col gap-2 sm:flex-row"><input className="h-12 min-w-0 flex-1 rounded-xl border bg-[#fafbfd] px-4 text-sm outline-none focus:border-[#0d8278]" inputMode="numeric" maxLength={6} onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder={t.code} value={verificationCode} /><button className="h-11 rounded-xl border border-[#b9d9d6] px-3 text-xs font-bold text-[#08746c] disabled:opacity-50 sm:h-auto" disabled={!email || isSendingCode} onClick={() => void handleSendCode()} type="button">{isSendingCode ? t.sending : t.sendCode}</button></div> : null}
                <button className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#0d8278] text-sm font-bold text-white disabled:opacity-60" disabled={isAuthLoading || !email || !password || (authMode === 'signup' && verificationCode.length !== 6)} onClick={() => void handleAuth()} type="button">{isAuthLoading ? <Loader2 className="size-4 animate-spin" /> : null}{authMode === 'signup' ? t.create : t.login}<ArrowRight className="size-4" /></button>
              </div>
              <div className="mt-4 flex gap-4 rounded-xl border-2 border-[#9bcfc9] bg-[#e5f2f1] p-4"><span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-white text-[#0d8278] shadow-sm"><ShieldCheck className="size-6" /></span><div><p className="text-[22px] font-black leading-7 text-[#075f59]">{t.noPhone}</p><p className="mt-1 text-[14px] leading-5 text-[#526f7d]">{t.noPhoneDetail}</p></div></div>
              {authMessage ? <p className="mt-3 text-center text-xs text-rose-600">{authMessage}</p> : null}
              <p className="mt-5 text-center text-[15px] text-[#65738b]">{authMode === 'signup' ? t.already : t.newHere}{' '}<button className="ml-1 font-extrabold text-[#08746c] hover:underline" onClick={() => setAuthMode(authMode === 'signup' ? 'login' : 'signup')} type="button">{authMode === 'signup' ? t.login : t.signup}</button></p>
            </>}
          </div>
        </section>

        <section className="pb-9 sm:pb-16"><h2 className="text-[21px] font-black leading-tight tracking-tight sm:text-2xl">{t.workspaceTitle}</h2><p className="mt-2 text-[13px] leading-5 text-[#7b88a0] sm:text-sm">{t.workspaceHint}</p><div className="mt-4 grid gap-3 sm:mt-6 sm:gap-5 md:grid-cols-2">{t.workspaces.map((workspace) => { const Icon = workspace.icon; return <Link className="group rounded-[16px] border border-[#dde3ec] bg-white p-4 transition hover:-translate-y-0.5 hover:border-[#9ccbc7] hover:shadow-lg sm:rounded-[18px] sm:p-8" href={workspace.href} key={workspace.href}><span className="flex size-10 items-center justify-center rounded-xl bg-[#e1efee] text-[#0d8278] sm:size-12"><Icon className="size-5 sm:size-6" /></span><h3 className="mt-3 text-lg font-black sm:mt-5 sm:text-xl">{workspace.title}</h3><p className="mt-2 text-[13px] leading-5 text-[#58677f] sm:mt-3 sm:min-h-12 sm:text-sm sm:leading-6">{workspace.description}</p><span className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-[#b9d9d6] bg-[#f4faf9] px-3 py-1.5 text-xs font-bold text-[#08746c] sm:mt-6"><Check className="size-3.5" />{t.included}</span></Link>; })}</div></section>
      </div>
    </main>
  );
};

export default HomePage;
