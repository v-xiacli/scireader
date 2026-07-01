import type { Metadata } from 'next';

import { SeoLanguagePage } from '@/components/language/seo-language-page';

export const metadata: Metadata = {
  title: 'AI 财报分析 | AI 股票分析、年报阅读与 K 线材料解读',
  description:
    'SCIReader 财务分析支持 AI 读年报、AI 读财报、A 股与港股股票分析、K 线图、盘口截图和财报 PDF 材料分析。',
  keywords: [
    'AI炒股',
    'AI股票分析',
    'AI读年报',
    'AI读财报',
    'AI财报分析',
    'AI年报分析',
    'A股AI分析',
    '港股AI分析',
    'K线AI分析',
    'AI盘口分析',
    'AI stock analysis',
    'AI financial report analysis',
  ],
  alternates: {
    canonical: '/ai-stock-analysis',
  },
};

const keywords = [
  'AI股票分析',
  'AI读年报',
  'AI读财报',
  'AI财报分析',
  'AI年报分析',
  'A股AI分析',
  '港股AI分析',
  'K线AI分析',
  '盘口截图分析',
  'financial report AI',
];

const AiStockAnalysisPage = () => (
  <SeoLanguagePage
    copy={{
      en: {
        eyebrow: 'SCIReader Financial Analysis',
        title: 'AI stock and financial-report analysis',
        description: 'Upload annual reports, financial-report PDFs, K-line charts, order-book screenshots, and trend images. SCIReader analyzes business drivers, financial signals, risk factors, and market context from a research perspective.',
        cards: [
          { title: 'Read annual reports', description: 'Extract revenue, profit, cash flow, debt, operating quality, and management discussion.' },
          { title: 'Analyze financial materials', description: 'Combine PDFs, announcements, screenshots, and trend materials into one stock-research view.' },
          { title: 'Market-context reasoning', description: 'Use K-line charts, volume-price signals, and order-book screenshots for analysis, not investment advice.' },
        ],
        keywords,
        note: 'Risk notice: this feature is for research analysis only and does not constitute investment advice or a promise of returns.',
        cta: 'Open AI financial analysis',
        href: '/financial-analysis',
      },
      zh: {
        eyebrow: 'SCIReader 财务分析',
        title: 'AI 股票分析、年报阅读与财报材料解读',
        description: '上传年报 PDF、财报 PDF、K 线图、盘口截图和走势图，SCIReader 会从研究视角梳理业务驱动、财务信号、风险因素和市场上下文。',
        cards: [
          { title: 'AI 读年报', description: '提取收入、利润、现金流、负债、经营质量和管理层表述。' },
          { title: 'AI 读财报', description: '结合财报 PDF、公告、截图和趋势材料，形成股票研究视角。' },
          { title: '盘面与趋势分析', description: '结合 K 线、量价、盘口和风险因素进行研究分析，不构成投资建议。' },
        ],
        keywords,
        note: '风险提示：以下功能仅用于研究分析，不构成投资建议，也不承诺任何收益。',
        cta: '开始 AI 财务分析',
        href: '/financial-analysis',
      },
    }}
  />
);

export default AiStockAnalysisPage;
