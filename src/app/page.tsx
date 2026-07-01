'use client';

import { ArrowRight, BarChart3, Check, FileText, Gift, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

type AuthMode = 'login' | 'signup';
type Language = 'en' | 'zh';
type AuthUser = { id: string; email: string };
type TokenAccount = { tokenBalance: number; tokenUsed: number; tokenAvailable: number };

const copy = {
  en: {
    login: 'Log in', signup: 'Join early access', badge: 'Research-first AI reading copilot',
    headline: 'Go from reading a paper to truly understanding it',
    intro: 'Upload a research paper and talk through it. In a few focused exchanges, SCIReader helps you unpack the physics, challenge the reasoning, and resolve the questions blocking real understanding. Financial reports are supported too.',
    benefits: ['Explain physical principles from first principles, not just summarize them', 'Answer precise questions with evidence traced back to the paper', 'Turn a few rounds of dialogue into a connected mental model'],
    chips: ['Grounded citations', 'Physics reasoning', 'PDF-native', 'Research-led'],
    tokenOffer: 'Early access · 1,000,000 tokens free', createTitle: 'Join the early access group', loginTitle: 'Log in to SCIReader',
    accountHint: 'Bring a paper and help shape a research tool built for deep understanding.', password: 'Password (at least 8 characters)',
    code: '6-digit email code', sendCode: 'Send code', sending: 'Sending', create: 'Join early access',
    noPhone: 'Built with early researchers', noPhoneDetail: 'We are early and do not have polished testimonials yet. Early users get a direct line to the founder and a real voice in what we build next.',
    already: 'Already have an account?', newHere: 'New to SCIReader?', welcome: 'Welcome back', available: 'tokens available', logout: 'Log out',
    workspaceTitle: 'Research first, with finance when you need it', workspaceHint: 'One account includes both workspaces. The research experience leads the way.', included: 'Included on the free plan',
    workspaces: [
      { href: '/research', title: 'Research Papers', description: 'Upload PDF papers, generate reading notes, ask literature questions, and draft your Introduction in writing mode.', icon: FileText },
      { href: '/financial-analysis', title: 'Financial Analysis', description: 'Upload financial reports, K-line charts, and order-book screenshots for stock analysis in a floating chat window.', icon: BarChart3 },
    ],
    ctaTitle: 'Bring the paper you cannot quite crack', ctaText: 'Join the early users shaping SCIReader. Ask the hard question, follow the physics, and leave with a deeper understanding — not another shallow summary.', ctaButton: 'Join early access',
    codeSent: 'Verification code sent. Please check your email.', codeFailed: 'Could not send the verification code.', actionFailed: 'Something went wrong. Please try again.', signupSuccess: 'Account created successfully.', loginSuccess: 'Logged in successfully.',
  },
  zh: {
    login: '登录', signup: '加入早期体验', badge: '科研优先的 AI 阅读助手', headline: '不止读完论文，而是真正读懂它',
    intro: '上传一篇科研论文，和 SCIReader 一起把它聊透。只需几轮聚焦的对话，逐层拆解物理原理、检验推理过程，并解决那些真正阻碍理解的困惑。财务报告同样支持。',
    benefits: ['从第一性原理解释物理机制，而不只是复述摘要', '精准回答具体困惑，并将依据定位回论文原文', '通过几轮连续追问，建立完整、相互关联的理解'],
    chips: ['原文引用', '物理推理', '原生 PDF', '科研优先'],
    tokenOffer: '早期体验 · 100 万 tokens 免费', createTitle: '加入早期体验用户', loginTitle: '登录 SCIReader', accountHint: '带上一篇论文，一起打磨一款真正追求深度理解的科研工具。',
    password: '密码（至少 8 位）', code: '6 位邮箱验证码', sendCode: '发送验证码', sending: '发送中', create: '加入早期体验',
    noPhone: '和早期科研用户一起打磨', noPhoneDetail: '我们还在早期，暂时没有漂亮的用户评价。早期用户可以直接联系创始人，并真正影响 SCIReader 接下来怎么做。', already: '已有账号？', newHere: '还没有账号？',
    welcome: '欢迎回来', available: '可用 tokens', logout: '退出登录', workspaceTitle: '科研优先，需要时也能分析财务', workspaceHint: '一个账号包含两个工作区，核心体验首先为科研阅读而打造。', included: '免费套餐已包含',
    workspaces: [
      { href: '/research', title: '科研论文', description: '上传 PDF 论文、生成读书笔记、进行文献问答，并在写作模式中整理 Introduction。', icon: FileText },
      { href: '/financial-analysis', title: '财务分析', description: '上传财报 PDF、K 线图和盘口截图，在浮动聊天窗中进行股票分析。', icon: BarChart3 },
    ],
    ctaTitle: '带上那篇你还没真正读懂的论文', ctaText: '加入 SCIReader 的早期用户。提出最难的问题，顺着物理原理追问到底，带走真正深入的理解，而不是又一份浅层摘要。', ctaButton: '加入早期体验',
    codeSent: '验证码已发送，请查看邮箱。', codeFailed: '验证码发送失败。', actionFailed: '操作失败，请稍后再试。', signupSuccess: '账号创建成功。', loginSuccess: '登录成功。',
  },
} as const;

const HomePage = () => {
  const [language, setLanguage] = useState<Language>('en');
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

  const handleLogout = async () => { await fetch('/api/auth/logout', { method: 'POST' }); setAuthUser(null); setTokenAccount(null); setAuthMessage(null); };
  const scrollToAccount = () => document.getElementById('account')?.scrollIntoView({ behavior: 'smooth' });
  const selectMode = (mode: AuthMode) => { setAuthMode(mode); scrollToAccount(); };

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-[#091329]">
      <div className="mx-auto w-full max-w-[1130px] px-5 pb-8 pt-6 sm:px-8 lg:px-12">
        <header className="flex items-center justify-between">
          <Link className="flex items-center gap-3 font-bold tracking-tight" href="/"><span className="flex size-9 items-center justify-center rounded-[10px] bg-[#0d8278] text-white"><FileText className="size-[19px]" /></span><span className="text-[19px]">SCIReader</span></Link>
          <nav className="flex items-center gap-2 text-xs font-medium">
            <div className="hidden rounded-xl bg-[#edf0f6] p-1 sm:flex">
              {(['en', 'zh'] as const).map((lang) => <button aria-pressed={language === lang} className={language === lang ? 'rounded-lg bg-white px-3 py-1.5 font-semibold text-[#0a6f68] shadow-sm' : 'px-3 py-1.5 text-slate-500'} key={lang} onClick={() => setLanguage(lang)} type="button">{lang === 'en' ? 'EN' : '中文'}</button>)}
            </div>
            <button className="rounded-lg border border-[#dce2ec] bg-white px-4 py-2" onClick={() => selectMode('login')} type="button">{t.login}</button>
            <button className="rounded-lg bg-[#0d8278] px-4 py-2 text-white" onClick={() => selectMode('signup')} type="button">{t.signup}</button>
          </nav>
        </header>

        <section className="grid gap-10 pb-16 pt-16 lg:grid-cols-[1.35fr_0.85fr] lg:items-center lg:gap-16 lg:pb-20">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-[#dfeeed] px-3 py-1.5 text-xs font-semibold text-[#08746c]"><Sparkles className="size-3.5" />{t.badge}</div>
            <h1 className="mt-5 max-w-[620px] text-[40px] font-black leading-[1.05] tracking-[-0.045em] sm:text-[50px]">{t.headline}</h1>
            <p className="mt-5 max-w-[590px] text-[15px] leading-7 text-[#62708a]">{t.intro}</p>
            <ul className="mt-6 space-y-3 text-[14px] text-[#34425c]">{t.benefits.map((item) => <li className="flex items-center gap-3" key={item}><span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-[#dceeed] text-[#0d8278]"><Check className="size-3.5" strokeWidth={3} /></span>{item}</li>)}</ul>
            <div className="mt-7 flex flex-wrap gap-2">{t.chips.map((item) => <span className="rounded-full border border-[#dbe1eb] bg-white px-3 py-1.5 text-xs font-medium text-[#42506a]" key={item}><span className="mr-2 text-[#0d8278]">●</span>{item}</span>)}</div>
          </div>

          <div className="rounded-[22px] border border-[#e0e5ed] bg-white p-7 shadow-[0_18px_45px_rgba(29,45,68,0.14)]" id="account">
            {authUser ? <div className="py-5 text-center"><span className="mx-auto flex size-12 items-center justify-center rounded-full bg-[#dfeeed] text-[#0d8278]"><Check /></span><h2 className="mt-4 text-xl font-bold">{t.welcome}</h2><p className="mt-2 text-sm text-[#71809b]">{authUser.email}</p><p className="mt-5 text-3xl font-black text-[#0d8278]">{tokenAccount?.tokenAvailable.toLocaleString() ?? '200,000'}</p><p className="mt-1 text-xs text-[#71809b]">{t.available}</p><button className="mt-6 text-sm font-semibold text-[#0d8278]" onClick={() => void handleLogout()} type="button">{t.logout}</button></div> : <>
              <div className="inline-flex items-center gap-2 rounded-full bg-[#dfeeed] px-3 py-1.5 text-xs font-bold text-[#08746c]"><Gift className="size-3.5" />{t.tokenOffer}</div>
              <h2 className="mt-5 text-[22px] font-black">{authMode === 'signup' ? t.createTitle : t.loginTitle}</h2><p className="mt-1 text-xs text-[#8290a8]">{t.accountHint}</p>
              <div className="mt-5 space-y-3"><input className="h-12 w-full rounded-xl border bg-[#fafbfd] px-4 text-sm outline-none focus:border-[#0d8278]" onChange={(e) => setEmail(e.target.value)} placeholder="you@university.edu" type="email" value={email} /><input className="h-12 w-full rounded-xl border bg-[#fafbfd] px-4 text-sm outline-none focus:border-[#0d8278]" onChange={(e) => setPassword(e.target.value)} placeholder={t.password} type="password" value={password} />
                {authMode === 'signup' ? <div className="flex gap-2"><input className="h-12 min-w-0 flex-1 rounded-xl border bg-[#fafbfd] px-4 text-sm outline-none focus:border-[#0d8278]" inputMode="numeric" maxLength={6} onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder={t.code} value={verificationCode} /><button className="rounded-xl border border-[#b9d9d6] px-3 text-xs font-bold text-[#08746c] disabled:opacity-50" disabled={!email || isSendingCode} onClick={() => void handleSendCode()} type="button">{isSendingCode ? t.sending : t.sendCode}</button></div> : null}
                <button className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#0d8278] text-sm font-bold text-white disabled:opacity-60" disabled={isAuthLoading || !email || !password || (authMode === 'signup' && verificationCode.length !== 6)} onClick={() => void handleAuth()} type="button">{isAuthLoading ? <Loader2 className="size-4 animate-spin" /> : null}{authMode === 'signup' ? t.create : t.login}<ArrowRight className="size-4" /></button>
              </div>
              <div className="mt-4 flex gap-3 rounded-xl border border-[#bcdad7] bg-[#e5f2f1] p-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white text-[#0d8278]"><ShieldCheck className="size-4" /></span><div><p className="text-xs font-bold">{t.noPhone}</p><p className="mt-0.5 text-[11px] leading-4 text-[#60778a]">{t.noPhoneDetail}</p></div></div>
              {authMessage ? <p className="mt-3 text-center text-xs text-rose-600">{authMessage}</p> : null}
              <p className="mt-4 text-center text-xs text-[#73819a]">{authMode === 'signup' ? t.already : t.newHere}{' '}<button className="font-bold text-[#08746c]" onClick={() => setAuthMode(authMode === 'signup' ? 'login' : 'signup')} type="button">{authMode === 'signup' ? t.login : t.signup}</button></p>
            </>}
          </div>
        </section>

        <section className="pb-16"><h2 className="text-2xl font-black tracking-tight">{t.workspaceTitle}</h2><p className="mt-2 text-sm text-[#7b88a0]">{t.workspaceHint}</p><div className="mt-6 grid gap-5 md:grid-cols-2">{t.workspaces.map((workspace) => { const Icon = workspace.icon; return <Link className="group rounded-[18px] border border-[#dde3ec] bg-white p-8 transition hover:-translate-y-0.5 hover:border-[#9ccbc7] hover:shadow-lg" href={workspace.href} key={workspace.href}><span className="flex size-12 items-center justify-center rounded-xl bg-[#e1efee] text-[#0d8278]"><Icon className="size-6" /></span><h3 className="mt-5 text-xl font-black">{workspace.title}</h3><p className="mt-3 min-h-12 text-sm leading-6 text-[#58677f]">{workspace.description}</p><span className="mt-6 inline-flex items-center gap-1.5 rounded-full border border-[#b9d9d6] bg-[#f4faf9] px-3 py-1.5 text-xs font-bold text-[#08746c]"><Check className="size-3.5" />{t.included}</span></Link>; })}</div></section>
        <section className="flex flex-col gap-6 rounded-[22px] bg-[#0c6e66] px-9 py-9 text-white sm:flex-row sm:items-center sm:justify-between sm:px-11"><div><h2 className="text-2xl font-black">{t.ctaTitle}</h2><p className="mt-2 max-w-[520px] text-sm leading-5 text-[#d7eeeb]">{t.ctaText}</p></div><button className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-bold text-[#086b64]" onClick={() => selectMode('signup')} type="button">{t.ctaButton}<ArrowRight className="size-4" /></button></section>
      </div>
    </main>
  );
};

export default HomePage;
