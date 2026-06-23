import type { PropsWithChildren } from 'react';

import type { Metadata, Viewport } from 'next';
import { Providers } from '@/components/providers';
import 'katex/dist/katex.min.css';
import './globals.css';

const siteUrl = (process.env.NEXT_PUBLIC_APP_BASE_URL?.trim() || process.env.APP_BASE_URL?.trim() || 'https://scireader.xyz').replace(/\/$/, '');

export const metadata: Metadata = {
  metadataBase: new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`),
  title: {
    default: 'SCIReader | AI 論文閱讀、PDF 文獻分析與股票財務分析工具',
    template: '%s | SCIReader',
  },
  applicationName: 'SCIReader',
  authors: [{ name: 'SCIReader' }],
  creator: 'SCIReader',
  publisher: 'SCIReader',
  category: 'AI tools',
  description: 'SCIReader 是面向科研與金融研究的 AI 工具，支援 AI 論文閱讀、PDF 文獻分析、英文論文中文解讀、讀書筆記、學術寫作輔助、股票財務分析、A 股與港股 K 線和財報材料分析。',
  keywords: [
    'SCIReader',
    'SCI Reader',
    'AI PDF reader',
    'AI paper reader',
    'AI read paper',
    'read paper AI',
    'AI read academic papers',
    'AI論文閱讀',
    'AI论文阅读',
    'AI讀論文',
    'AI读论文',
    'AI讀文獻',
    'AI读文献',
    'PDF文獻分析',
    'PDF文献分析',
    '科研文獻總結',
    '科研文献总结',
    '英文論文翻譯',
    '英文论文中文解读',
    'paper summary',
    'research paper analysis',
    'academic literature review',
    'academic writing assistant',
    '論文問答',
    '论文问答',
    '文獻問答',
    '文献问答',
    '讀書筆記',
    '读书笔记',
    '財務分析',
    '财务分析',
    '股票分析',
    'A股分析',
    '港股分析',
    'K線分析',
    'K线分析',
    '財報分析',
    '财报分析',
    '盘口分析',
    'AI stock analysis',
  ],
  alternates: {
    canonical: '/',
    languages: {
      'zh-Hant': '/',
      'zh-Hans': '/',
      en: '/',
    },
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  openGraph: {
    title: 'SCIReader | AI 論文閱讀、PDF 文獻分析與股票財務分析工具',
    description: '用 AI 閱讀 PDF 論文、生成文獻摘要、輔助學術寫作，並支援股票財報、A 股、港股與 K 線材料分析。',
    url: '/',
    siteName: 'SCIReader',
    type: 'website',
    locale: 'zh_Hant',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'SCIReader | AI 論文閱讀與財務分析工具',
    description: 'AI PDF 論文閱讀、文獻問答、學術寫作輔助、股票財報與 K 線分析。',
  },
  other: {
    'baidu-site-verification': process.env.BAIDU_SITE_VERIFICATION ?? '',
    'msvalidate.01': process.env.BING_SITE_VERIFICATION ?? '',
    'google-site-verification': process.env.GOOGLE_SITE_VERIFICATION ?? '',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

const structuredData = {
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: 'SCIReader',
  url: /^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`,
  applicationCategory: 'ProductivityApplication',
  operatingSystem: 'Web',
  inLanguage: ['zh-Hant', 'zh-Hans', 'en'],
  description:
    'SCIReader 是 AI 論文閱讀、PDF 文獻分析、學術寫作輔助與股票財務分析工具，支援英文論文中文解讀、科研文獻問答、A 股與港股財報和 K 線分析。',
  featureList: [
    'AI PDF 論文閱讀',
    'AI read paper',
    'read paper AI',
    'AI paper reader',
    'AI讀論文',
    'AI读论文',
    'AI讀文獻',
    'AI读文献',
    '英文論文中文解讀',
    '科研文獻摘要與問答',
    '學術寫作輔助',
    '股票財務分析',
    'A 股與港股 K 線分析',
    '財報 PDF 與圖片材料分析',
  ],
  offers: {
    '@type': 'Offer',
    priceCurrency: 'USD',
    availability: 'https://schema.org/OnlineOnly',
  },
  publisher: {
    '@type': 'Organization',
    name: 'SCIReader',
    url: /^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`,
  },
};

const RootLayout = ({ children }: PropsWithChildren) => {
  return (
    <html lang="zh-Hant">
      <body>
        <script
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
          type="application/ld+json"
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
};

export default RootLayout;
