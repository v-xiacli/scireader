'use client';

import { ArrowRight, FileText, Loader2, MessageSquareText, WalletCards } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { mockPapers, mockUserAccount } from '@/features/papers/mock-data';

type AuthMode = 'login' | 'signup';
type AuthUser = { id: string; email: string };

const HomePage = () => {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [isSessionLoading, setIsSessionLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);

  const isLoggedIn = Boolean(authUser);

  useEffect(() => {
    const loadSession = async () => {
      try {
        const response = await fetch('/api/auth/me');
        const result = await response.json();

        if (response.ok && result.user) setAuthUser(result.user);
      } catch {
        setAuthUser(null);
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
        body: JSON.stringify({ email, password }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.error ?? result.message ?? 'Authentication failed.');

      setAuthUser(result.user);
      setAuthMessage(`${authMode === 'signup' ? 'Account created' : 'Logged in'} as ${result.user.email}.`);
      setPassword('');
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

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setAuthUser(null);
    setAuthMessage('Logged out.');
  };

  const handleUpload = async (file: File) => {
    if (!isLoggedIn) {
      setUploadMessage('Please log in before uploading a paper.');
      return;
    }

    if (file.type !== 'application/pdf') {
      setUploadMessage('Please choose a PDF file.');
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

      const paperId = encodeURIComponent(file.name.replace(/\.pdf$/i, '') || 'uploaded-paper');
      router.push(`/papers/${paperId}?pdfUrl=${encodeURIComponent(result.downloadUrl)}&filePath=${encodeURIComponent(result.filePath)}&title=${encodeURIComponent(file.name)}`);
    } catch (error) {
      setUploadMessage(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <main className="min-h-screen px-8 py-6">
      <section className="mx-auto flex max-w-7xl flex-col gap-8">
        <header className="flex items-center justify-between rounded-3xl bg-white p-6 shadow-sm">
          <div>
            <p className="text-sm font-medium uppercase tracking-wide text-primary">SCIReader</p>
            <h1 className="mt-2 text-3xl font-semibold">Paper library</h1>
            <p className="mt-2 max-w-2xl text-muted-foreground">
              Read scientific papers with PDF text selection, persistent conversations, and routed LLM assistants.
            </p>
          </div>
          <div className="rounded-2xl border bg-slate-50 p-4 text-right">
            <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
              <WalletCards className="size-4" /> Manual balance
            </div>
            <p className="mt-2 text-2xl font-semibold">{mockUserAccount.balance}</p>
          </div>
        </header>

        <section className="rounded-3xl bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-end">
            <div className="flex-1">
              <h2 className="text-xl font-semibold">Account</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {authUser ? `Signed in as ${authUser.email}` : 'Log in or create an account to use SCIReader.'}
              </p>
            </div>
            {!authUser ? (
              <>
                <div className="flex rounded-xl border p-1">
                  <button
                    className={`rounded-lg px-3 py-1.5 text-sm ${authMode === 'login' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                    onClick={() => setAuthMode('login')}
                    type="button"
                  >
                    Login
                  </button>
                  <button
                    className={`rounded-lg px-3 py-1.5 text-sm ${authMode === 'signup' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                    onClick={() => setAuthMode('signup')}
                    type="button"
                  >
                    Sign up
                  </button>
                </div>
                <input
                  className="rounded-xl border px-4 py-2 text-sm md:w-64"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="Email"
                  type="email"
                  value={email}
                />
                <input
                  className="rounded-xl border px-4 py-2 text-sm md:w-64"
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Password"
                  type="password"
                  value={password}
                />
                <button
                  className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-70"
                  disabled={isAuthLoading || !email || !password}
                  onClick={() => void handleAuth()}
                  type="button"
                >
                  {isAuthLoading ? 'Please wait...' : authMode === 'signup' ? 'Sign up' : 'Login'}
                </button>
              </>
            ) : (
              <button
                className="rounded-xl border px-4 py-2 text-sm font-medium"
                onClick={() => void handleLogout()}
                type="button"
              >
                Logout
              </button>
            )}
          </div>
          {authMessage ? <p className="mt-3 text-sm text-muted-foreground">{authMessage}</p> : null}
        </section>

        <div className="grid gap-5 md:grid-cols-3">
          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <FileText className="size-6 text-primary" />
            <h2 className="mt-4 font-semibold">PDF-first workspace</h2>
            <p className="mt-2 text-sm text-muted-foreground">Canvas editing is removed; the main surface is a paper reader.</p>
          </div>
          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <MessageSquareText className="size-6 text-primary" />
            <h2 className="mt-4 font-semibold">Large AI chat</h2>
            <p className="mt-2 text-sm text-muted-foreground">Chat can use whole paper, current page, selected text, or figure context.</p>
          </div>
          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <WalletCards className="size-6 text-primary" />
            <h2 className="mt-4 font-semibold">Manual account balance</h2>
            <p className="mt-2 text-sm text-muted-foreground">No online billing; admins maintain credits outside the checkout flow.</p>
          </div>
        </div>

        <section className="rounded-3xl bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold">Recent papers</h2>
              <p className="text-sm text-muted-foreground">Each paper keeps its own PDF state, chat history, and extracted context.</p>
            </div>
            <div className="flex items-center gap-3">
              {uploadMessage ? <p className="text-sm text-muted-foreground">{uploadMessage}</p> : null}
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
                    setUploadMessage('Please log in before uploading a paper.');
                    return;
                  }

                  fileInputRef.current?.click();
                }}
                type="button"
              >
                {isUploading ? <Loader2 className="size-4 animate-spin" /> : null}
                {isUploading ? 'Uploading...' : isLoggedIn ? 'Upload paper' : 'Login to upload'}
              </button>
            </div>
          </div>

          <div className="mt-6 grid gap-4">
            {mockPapers.map((paper) => {
              const content = (
                <>
                  <div>
                    <h3 className="font-semibold">{paper.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{paper.authors}</p>
                    <p className="mt-2 text-xs uppercase tracking-wide text-muted-foreground">
                      {paper.pages} pages · {paper.status}
                    </p>
                  </div>
                  <ArrowRight className="size-5 text-muted-foreground transition group-hover:translate-x-1 group-hover:text-primary" />
                </>
              );

              return isLoggedIn ? (
                <Link
                  className="group flex items-center justify-between rounded-2xl border p-4 transition hover:border-primary hover:bg-slate-50"
                  href={`/papers/${paper.id}`}
                  key={paper.id}
                >
                  {content}
                </Link>
              ) : (
                <div
                  className="flex cursor-not-allowed items-center justify-between rounded-2xl border bg-slate-50 p-4 opacity-60"
                  key={paper.id}
                  title="Log in to open papers"
                >
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

