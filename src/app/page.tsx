'use client';

import { ArrowRight, BarChart3, FileText } from 'lucide-react';
import Link from 'next/link';

const modules = [
  {
    href: '/financial-analysis',
    title: '財務分析',
    description: '上傳財報 PDF、K 線圖、盤口截圖和走勢圖，透過浮動聊天窗進行股票分析。',
    icon: BarChart3,
  },
  {
    href: '/research',
    title: '科研論文',
    description: '上傳 PDF 論文、生成讀書筆記、進行文獻問答，並使用寫作模式整理 Introduction。',
    icon: FileText,
  },
];

const HomePage = () => (
  <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-6">
    <div className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-3xl flex-col justify-center">
      <header className="mb-8">
        <p className="text-sm font-medium text-primary">SCIReader</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-normal text-slate-950">選擇工作模組</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          進入對應工作區後再登入、上傳資料或開啟浮動聊天窗。
        </p>
      </header>

      <div className="grid gap-4">
        {modules.map((item) => {
          const Icon = item.icon;

          return (
            <Link
              className="group flex items-center gap-4 rounded-2xl border bg-white p-5 shadow-sm transition hover:border-primary/40 hover:shadow-md"
              href={item.href}
              key={item.href}
            >
              <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Icon className="size-6" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-xl font-semibold text-slate-950">{item.title}</h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.description}</p>
              </div>
              <ArrowRight className="size-5 shrink-0 text-slate-400 transition group-hover:translate-x-1 group-hover:text-primary" />
            </Link>
          );
        })}
      </div>
    </div>
  </main>
);

export default HomePage;
