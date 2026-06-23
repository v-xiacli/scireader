import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'AI炒股 | AI讀年報、AI讀財報與股票分析工具',
  description:
    'SCIReader 財務分析支援 AI 炒股研究、AI 讀年報、AI 讀財報、A 股和港股股票分析、K 線圖、盤口截圖和財報 PDF 材料分析。',
  keywords: [
    'AI炒股',
    'AI股票分析',
    'AI讀年報',
    'AI读年报',
    'AI讀財報',
    'AI读财报',
    'AI財報分析',
    'AI财报分析',
    'AI年報分析',
    'AI年报分析',
    'A股AI分析',
    '港股AI分析',
    'K線AI分析',
    'K线AI分析',
    'AI盤口分析',
    'AI盘口分析',
  ],
  alternates: {
    canonical: '/ai-stock-analysis',
  },
};

const keywords = [
  'AI炒股',
  'AI股票分析',
  'AI讀年報',
  'AI读年报',
  'AI讀財報',
  'AI读财报',
  'AI財報分析',
  'AI财报分析',
  'A股AI分析',
  '港股AI分析',
  'K線AI分析',
  '盤口截圖分析',
];

const AiStockAnalysisPage = () => (
  <main className="min-h-screen bg-slate-50 px-4 py-10 sm:px-6">
    <section className="mx-auto max-w-4xl rounded-3xl bg-white p-6 shadow-sm sm:p-8">
      <p className="text-sm font-medium text-primary">SCIReader Financial Analysis</p>
      <h1 className="mt-3 text-3xl font-semibold text-slate-950">AI炒股研究：AI讀年報、AI讀財報與股票分析</h1>
      <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
        SCIReader 財務分析可以上傳年報 PDF、財報 PDF、K 線圖、盤口截圖和走勢圖，使用 AI 從交易員視角整理基本面、
        技術面、資金行為、風險和後續觀察清單。系統支援 A 股、港股和自選股行情，並可按股票保存歷史分析。
      </p>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border bg-slate-50 p-4">
          <h2 className="font-semibold text-slate-950">AI讀年報</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">提煉收入、利潤、現金流、負債、經營質量和管理層表述。</p>
        </div>
        <div className="rounded-2xl border bg-slate-50 p-4">
          <h2 className="font-semibold text-slate-950">AI讀財報</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">分析財報 PDF、公告、截圖和走勢材料，形成股票研究記錄。</p>
        </div>
        <div className="rounded-2xl border bg-slate-50 p-4">
          <h2 className="font-semibold text-slate-950">AI炒股分析</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">結合 K 線、量價、盤口和風險反證，生成研究分析而非投資建議。</p>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        {keywords.map((keyword) => (
          <span className="rounded-full border bg-white px-3 py-1 text-sm text-slate-600" key={keyword}>
            {keyword}
          </span>
        ))}
      </div>
      <p className="mt-6 text-sm leading-6 text-amber-700">
        風險提示：以下功能僅用於研究分析，不構成投資建議，也不承諾任何收益。
      </p>
      <Link className="mt-7 inline-flex rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground" href="/financial-analysis">
        開始 AI 財務分析
      </Link>
    </section>
  </main>
);

export default AiStockAnalysisPage;
