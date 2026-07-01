'use client';

import Link from 'next/link';

import { LanguageToggle, useLanguage, type AppLanguage } from '@/components/language/language-context';

type SeoLanguageCopy = {
  eyebrow: string;
  title: string;
  description: string;
  cards: Array<{ title: string; description: string }>;
  keywords: string[];
  cta: string;
  href: string;
  note?: string;
};

export const SeoLanguagePage = ({ copy }: { copy: Record<AppLanguage, SeoLanguageCopy> }) => {
  const { language } = useLanguage();
  const t = copy[language];

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10 sm:px-6">
      <section className="mx-auto max-w-4xl rounded-3xl bg-white p-6 shadow-sm sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium text-primary">{t.eyebrow}</p>
          <LanguageToggle className="flex" />
        </div>
        <h1 className="mt-3 text-3xl font-semibold text-slate-950">{t.title}</h1>
        <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">{t.description}</p>
        <div className={`mt-6 grid gap-4 ${t.cards.length >= 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
          {t.cards.map((card) => (
            <div className="rounded-2xl border bg-slate-50 p-4" key={card.title}>
              <h2 className="font-semibold text-slate-950">{card.title}</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">{card.description}</p>
            </div>
          ))}
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          {t.keywords.map((keyword) => (
            <span className="rounded-full border bg-white px-3 py-1 text-sm text-slate-600" key={keyword}>
              {keyword}
            </span>
          ))}
        </div>
        {t.note ? <p className="mt-6 text-sm leading-6 text-amber-700">{t.note}</p> : null}
        <Link className="mt-7 inline-flex rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground" href={t.href}>
          {t.cta}
        </Link>
      </section>
    </main>
  );
};
