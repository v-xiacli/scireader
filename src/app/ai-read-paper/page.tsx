import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'AI Read Paper | AI Paper Reader for Academic PDFs',
  description:
    'SCIReader helps researchers read academic papers with AI, summarize PDF papers, ask questions about methods and figures, and turn English papers into Chinese reading notes.',
  keywords: [
    'AI read paper',
    'read paper AI',
    'AI paper reader',
    'AI academic paper reader',
    'AI read academic papers',
    'AI PDF paper reader',
    'paper summary AI',
    'research paper AI',
    'academic paper summary',
    'AI讀論文',
    'AI读论文',
    'AI讀文獻',
    'AI读文献',
    'AI論文閱讀',
    'AI论文阅读',
  ],
  alternates: {
    canonical: '/ai-read-paper',
  },
};

const relatedQueries = [
  'AI read paper',
  'read paper AI',
  'AI paper reader',
  'AI read academic papers',
  'AI讀文獻',
  'AI读文献',
  'AI讀論文',
  'AI读论文',
  'AI論文閱讀',
  'AI论文阅读',
];

const AiReadPaperPage = () => (
  <main className="min-h-screen bg-slate-50 px-4 py-10 sm:px-6">
    <section className="mx-auto max-w-4xl rounded-3xl bg-white p-6 shadow-sm sm:p-8">
      <p className="text-sm font-medium text-primary">SCIReader</p>
      <h1 className="mt-3 text-3xl font-semibold text-slate-950">AI Read Paper: read academic PDFs with AI</h1>
      <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
        SCIReader is an AI paper reader for academic PDFs. Upload a research paper, choose a reading mode, and ask questions about
        methods, experiments, figures, equations, limitations, and conclusions. It supports English paper reading with Chinese output,
        concise summaries, detailed reviews, and reusable research notes.
      </p>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border bg-slate-50 p-4">
          <h2 className="font-semibold text-slate-950">Read papers with AI</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">Summarize academic papers and extract key findings, methods, data, and conclusions.</p>
        </div>
        <div className="rounded-2xl border bg-slate-50 p-4">
          <h2 className="font-semibold text-slate-950">Ask about PDFs</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">Chat with a paper, selected text, figures, tables, and saved reading history.</p>
        </div>
        <div className="rounded-2xl border bg-slate-50 p-4">
          <h2 className="font-semibold text-slate-950">中文解讀英文論文</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">高質量模式使用英文閱讀鏈路，最後輸出簡體中文閱讀報告。</p>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        {relatedQueries.map((query) => (
          <span className="rounded-full border bg-white px-3 py-1 text-sm text-slate-600" key={query}>
            {query}
          </span>
        ))}
      </div>
      <Link className="mt-7 inline-flex rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground" href="/research">
        Open AI paper reader
      </Link>
    </section>
  </main>
);

export default AiReadPaperPage;
