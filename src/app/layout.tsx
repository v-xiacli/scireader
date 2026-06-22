import type { PropsWithChildren } from 'react';

import { Providers } from '@/components/providers';
import 'katex/dist/katex.min.css';
import './globals.css';

export const metadata = {
  title: {
    default: 'SCIReader | AI PDF 論文閱讀與財務分析工具',
    template: '%s | SCIReader',
  },
  description: 'SCIReader 是 AI 論文閱讀、PDF 文獻分析、學術寫作輔助與股票財務分析工具，支援科研文獻總結、PDF 問答、K 線與財報材料分析。',
  keywords: [
    'SCIReader',
    'AI PDF reader',
    'AI論文閱讀',
    'PDF文獻分析',
    '科研文獻總結',
    'paper summary',
    'academic writing assistant',
    '論文問答',
    '財務分析',
    '股票分析',
    'A股分析',
    '港股分析',
    'K線分析',
    '財報分析',
    'AI stock analysis',
  ],
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    title: 'SCIReader | AI PDF 論文閱讀與財務分析工具',
    description: '用 AI 閱讀 PDF 論文、生成文獻摘要、輔助學術寫作，並支援股票財報與 K 線材料分析。',
    siteName: 'SCIReader',
    type: 'website',
  },
};

const RootLayout = ({ children }: PropsWithChildren) => {
  return (
    <html lang="zh-Hant">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
};

export default RootLayout;
