'use client';

import { ArrowRight, FileText, Loader2, MessageSquareText, WalletCards } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { mockPapers, mockUserAccount } from '@/features/papers/mock-data';
import type { PaperSummary } from '@/types/paper';

type AuthMode = 'login' | 'signup';
type AuthUser = { id: string; email: string };

const normalizeDownloadUrl = (downloadUrl: string) => {
  const trimmed = downloadUrl.trim();

  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) return trimmed;
  if (trimmed.startsWith('api/')) return `/${trimmed}`;

  return `https://${trimmed}`;
};

const buildPaperId = (title: string, journal: string, year: string, volume: string) =>
  [title, journal, year, volume]
    .map((part) => part.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    .filter(Boolean)
    .join('-') || 'uploaded-paper';

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
  const [paperTitle, setPaperTitle] = useState('');
  const [paperJournal, setPaperJournal] = useState('');
  const [paperYear, setPaperYear] = useState('');
  const [paperVolume, setPaperVolume] = useState('');
  const [uploadedPapers, setUploadedPapers] = useState<PaperSummary[]>([]);

  const isLoggedIn = Boolean(authUser);
  const papers = [...uploadedPapers, ...mockPapers];

  const loadUploadedPapers = async () => {
    try {
      const response = await fetch('/api/auth/uploaded-papers');
      const result = await response.json();
      setUploadedPapers(response.ok ? result.papers : []);
    } catch {
      setUploadedPapers([]);
    }
  };

  useEffect(() => {
    const loadSession = async () => {
      try {
        const response = await fetch('/api/auth/me');
        const result = await response.json();

        if (response.ok && result.user) {
          setAuthUser(result.user);
          await loadUploadedPapers();
        }
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
      await loadUploadedPapers();
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
    setUploadedPapers([]);
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

      const paperTitleValue = paperTitle.trim() || file.name.replace(/\.pdf$/i, '') || 'Uploaded paper';
      const paperId = buildPaperId(paperTitleValue, paperJournal, paperYear, paperVolume);
      const uploadedPaper: PaperSummary = {
        id: paperId,
        title: paperTitleValue,
        authors: paperJournal.trim() ? paperJournal.trim() : 'Uploaded paper',
        pages: 0,
        status: 'uploaded',
        abstract: 'Uploaded PDF ready for reading and chat.',
        pdfUrl: normalizeDownloadUrl(result.downloadUrl),
        filePath: result.filePath,
        journal: paperJournal.trim(),
        year: paperYear.trim(),
        volume: paperVolume.trim(),
      };

      const saveResponse = await fetch('/api/auth/uploaded-papers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(uploadedPaper),
      });
      const saveResult = await saveResponse.json();

      if (saveResponse.ok) setUploadedPapers(saveResult.papers);

      setPaperTitle('');
      setPaperJournal('');
      setPaperYear('');
      setPaperVolume('');

      router.push(`/papers/${encodeURIComponent(paperId)}?pdfUrl=${encodeURIComponent(uploadedPaper.pdfUrl)}&filePath=${encodeURIComponent(uploadedPaper.filePath ?? '')}&title=${encodeURIComponent(uploadedPaper.title)}&journal=${encodeURIComponent(uploadedPaper.journal ?? '')}&year=${encodeURIComponent(uploadedPaper.year ?? '')}&volume=${encodeURIComponent(uploadedPaper.volume ?? '')}`);
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
            <h1 className="mt-2 text-3xl font-semibold">Read papers with AI</h1>
            <p className="mt-2 max-w-2xl text-muted-foreground">
              Upload a PDF, read it on the left, and ask questions in the chat on the right.
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
            <h2 className="mt-4 font-semibold">Read PDFs</h2>
            <p className="mt-2 text-sm text-muted-foreground">Open papers in a clean PDF reader.</p>
          </div>
          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <MessageSquareText className="size-6 text-primary" />
            <h2 className="mt-4 font-semibold">Ask AI</h2>
            <p className="mt-2 text-sm text-muted-foreground">Ask questions about the paper or selected text.</p>
          </div>
          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <WalletCards className="size-6 text-primary" />
            <h2 className="mt-4 font-semibold">Your account</h2>
            <p className="mt-2 text-sm text-muted-foreground">Check your credits before using AI features.</p>
          </div>
        </div>

        <section className="rounded-3xl bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center">
            <div className="grid gap-3 md:grid-cols-5">
              <input
                className="rounded-xl border px-3 py-2 text-sm"
                onChange={(event) => setPaperTitle(event.target.value)}
                placeholder="Paper title"
                value={paperTitle}
              />
              <input
                className="rounded-xl border px-3 py-2 text-sm"
                onChange={(event) => setPaperJournal(event.target.value)}
                placeholder="Journal"
                value={paperJournal}
              />
              <input
                className="rounded-xl border px-3 py-2 text-sm"
                onChange={(event) => setPaperYear(event.target.value)}
                placeholder="Year"
                value={paperYear}
              />
              <input
                className="rounded-xl border px-3 py-2 text-sm"
                onChange={(event) => setPaperVolume(event.target.value)}
                placeholder="Volume"
                value={paperVolume}
              />
              <div className="flex items-center gap-3">
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
              {uploadMessage ? <p className="text-sm text-muted-foreground">{uploadMessage}</p> : null}
              </div>
            </div>
            <div>
              <h2 className="text-xl font-semibold">Your papers</h2>
              <p className="text-sm text-muted-foreground">Choose a paper to read, or upload a new PDF.</p>
            </div>
          </div>

          <div className="mt-6 grid gap-4">
            {papers.map((paper) => {
              const content = (
                <>
                  <div>
                    <h3 className="font-semibold">{paper.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{paper.journal ? [paper.journal, paper.year, paper.volume].filter(Boolean).join(' · ') : paper.authors}</p>
                    <p className="mt-2 text-xs uppercase tracking-wide text-muted-foreground">
                      {paper.pages ? `${paper.pages} pages · ` : ''}{paper.status}
                    </p>
                  </div>
                  <ArrowRight className="size-5 text-muted-foreground transition group-hover:translate-x-1 group-hover:text-primary" />
                </>
              );

              return isLoggedIn ? (
                <Link
                  className="group flex items-center justify-between rounded-2xl border p-4 transition hover:border-primary hover:bg-slate-50"
                  href={
                    paper.filePath
                      ? `/papers/${encodeURIComponent(paper.id)}?pdfUrl=${encodeURIComponent(paper.pdfUrl)}&filePath=${encodeURIComponent(paper.filePath)}&title=${encodeURIComponent(paper.title)}&journal=${encodeURIComponent(paper.journal ?? '')}&year=${encodeURIComponent(paper.year ?? '')}&volume=${encodeURIComponent(paper.volume ?? '')}`
                      : `/papers/${paper.id}`
                  }
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

