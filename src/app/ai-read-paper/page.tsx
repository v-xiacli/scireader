import type { Metadata } from 'next';

import { SeoLanguagePage } from '@/components/language/seo-language-page';

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
  <SeoLanguagePage
    copy={{
      en: {
        eyebrow: 'SCIReader',
        title: 'AI Read Paper: read academic PDFs with AI',
        description: 'SCIReader is an AI paper reader for academic PDFs. Upload a research paper, choose a reading mode, and ask questions about methods, experiments, figures, equations, limitations, and conclusions.',
        cards: [
          { title: 'Read papers with AI', description: 'Summarize academic papers and extract key findings, methods, data, and conclusions.' },
          { title: 'Ask about PDFs', description: 'Chat with a paper, selected text, figures, tables, and saved reading history.' },
          { title: 'Chinese output', description: 'High-quality mode can read English materials first and produce a Simplified Chinese research report.' },
        ],
        keywords: relatedQueries,
        cta: 'Open AI paper reader',
        href: '/research',
      },
      zh: {
        eyebrow: 'SCIReader',
        title: 'AI 读论文：深度理解科研 PDF',
        description: 'SCIReader 可以上传论文 PDF，选择阅读模式，并围绕方法、实验、图表、公式、局限和结论继续追问。它更强调对物理原理、证据链和研究逻辑的深刻理解。',
        cards: [
          { title: 'AI 精读论文', description: '提取核心发现、方法、数据和结论，不只停留在摘要层面。' },
          { title: '围绕 PDF 追问', description: '可以结合整篇论文、选中文本、图表页面和历史读书笔记继续对话。' },
          { title: '英文论文中文解读', description: '高质量模式可先按英文链路阅读，再输出简体中文研究报告。' },
        ],
        keywords: relatedQueries,
        cta: '打开 AI 论文阅读器',
        href: '/research',
      },
    }}
  />
);

export default AiReadPaperPage;
