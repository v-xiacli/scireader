'use client';

import { ArrowRight, FileText, Loader2, MessageSquareText, WalletCards } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { mockPapers, mockUserAccount } from '@/features/papers/mock-data';

const HomePage = () => {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);

  const handleUpload = async (file: File) => {
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
      router.push(`/papers/${paperId}?pdfUrl=${encodeURIComponent(result.downloadUrl)}&title=${encodeURIComponent(file.name)}`);
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
                disabled={isUploading}
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
                disabled={isUploading}
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                {isUploading ? <Loader2 className="size-4 animate-spin" /> : null}
                {isUploading ? 'Uploading...' : 'Upload paper'}
              </button>
            </div>
          </div>

          <div className="mt-6 grid gap-4">
            {mockPapers.map((paper) => (
              <Link
                className="group flex items-center justify-between rounded-2xl border p-4 transition hover:border-primary hover:bg-slate-50"
                href={`/papers/${paper.id}`}
                key={paper.id}
              >
                <div>
                  <h3 className="font-semibold">{paper.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{paper.authors}</p>
                  <p className="mt-2 text-xs uppercase tracking-wide text-muted-foreground">
                    {paper.pages} pages · {paper.status}
                  </p>
                </div>
                <ArrowRight className="size-5 text-muted-foreground transition group-hover:translate-x-1 group-hover:text-primary" />
              </Link>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
};

export default HomePage;
