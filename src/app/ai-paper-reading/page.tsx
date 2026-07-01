import type { Metadata } from 'next';

import { SeoLanguagePage } from '@/components/language/seo-language-page';

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
  <SeoLanguagePage
    copy={{
      en: {
        eyebrow: 'SCIReader',
        title: 'AI paper reading and literature Q&A',
        description: 'Upload a PDF paper, generate a concise overview or detailed report, ask about methods and figures, and save reading notes for later academic writing.',
        cards: [
          { title: 'For research papers', description: 'Read English papers with Chinese output, summarize literature, and analyze methods and experimental results.' },
          { title: 'For PDF Q&A', description: 'Ask questions about the whole paper, selected text, figure pages, and saved reading notes.' },
        ],
        keywords,
        cta: 'Start AI paper reading',
        href: '/research',
      },
      zh: {
        eyebrow: 'SCIReader',
        title: 'AI 读论文与 AI 读文献工具',
        description: '上传 PDF 论文后进行 AI 阅读，生成简单速览、详细报告或高质量英文链路解读。你可以直接询问研究方法、实验数据、图表、公式、创新性、局限和结论。',
        cards: [
          { title: '适合科研文献阅读', description: '支持英文论文中文解读、科研文献摘要、论文重点提炼、方法学和实验结果分析。' },
          { title: '适合 PDF 论文问答', description: '可针对整篇论文、选中文字、图表页面和历史读书笔记进行对话式问答。' },
        ],
        keywords,
        cta: '开始 AI 读论文',
        href: '/research',
      },
    }}
  />
);

export default AiPaperReadingPage;
