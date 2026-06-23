import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'AI讀論文 | AI讀文獻與 PDF 論文閱讀工具',
  description:
    'SCIReader 支援 AI 讀論文、AI 讀文獻、PDF 論文閱讀、英文文獻中文解讀、文獻摘要、方法和圖表問答、學術寫作輔助。',
  keywords: [
    'AI讀論文',
    'AI读论文',
    'AI讀文獻',
    'AI读文献',
    'AI論文閱讀',
    'AI论文阅读',
    'AI文獻閱讀',
    'AI文献阅读',
    'PDF論文閱讀',
    'PDF论文阅读',
    '英文文獻中文解讀',
    '英文文献中文解读',
    '論文摘要AI',
    '论文摘要AI',
    '文獻問答',
    '文献问答',
  ],
  alternates: {
    canonical: '/ai-paper-reading',
  },
};

const keywords = [
  'AI讀論文',
  'AI读论文',
  'AI讀文獻',
  'AI读文献',
  'AI論文閱讀',
  'AI论文阅读',
  'PDF論文閱讀',
  '英文文獻中文解讀',
  '論文問答',
  '文獻摘要',
];

const AiPaperReadingPage = () => (
  <main className="min-h-screen bg-slate-50 px-4 py-10 sm:px-6">
    <section className="mx-auto max-w-4xl rounded-3xl bg-white p-6 shadow-sm sm:p-8">
      <p className="text-sm font-medium text-primary">SCIReader</p>
      <h1 className="mt-3 text-3xl font-semibold text-slate-950">AI讀論文與 AI讀文獻工具</h1>
      <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
        SCIReader 可以上傳 PDF 論文後進行 AI 閱讀，生成簡單速覽、詳細報告或高質量英文鏈路解讀。你可以直接詢問研究方法、
        實驗數據、圖表、公式、創新性、局限和結論，也可以保存讀書筆記並用於後續學術寫作。
      </p>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border bg-slate-50 p-4">
          <h2 className="font-semibold text-slate-950">適合科研文獻閱讀</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            支援英文論文中文解讀、科研文獻摘要、論文重點提煉、方法學和實驗結果分析。
          </p>
        </div>
        <div className="rounded-2xl border bg-slate-50 p-4">
          <h2 className="font-semibold text-slate-950">適合 PDF 論文問答</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            可針對整篇論文、選中文字、圖表頁面和歷史讀書筆記進行對話式問答。
          </p>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        {keywords.map((keyword) => (
          <span className="rounded-full border bg-white px-3 py-1 text-sm text-slate-600" key={keyword}>
            {keyword}
          </span>
        ))}
      </div>
      <Link className="mt-7 inline-flex rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground" href="/research">
        開始 AI 讀論文
      </Link>
    </section>
  </main>
);

export default AiPaperReadingPage;
