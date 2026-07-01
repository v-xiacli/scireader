'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type AppLanguage = 'en' | 'zh';

type LanguageContextValue = {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
};

const languageStorageKey = 'scireader-language';
const LanguageContext = createContext<LanguageContextValue | null>(null);

export const localizeBilingualText = (value: string, language: AppLanguage) => {
  const separator = ' / ';
  const separatorIndex = value.lastIndexOf(separator);

  if (separatorIndex === -1) return value;

  return language === 'zh'
    ? value.slice(separatorIndex + separator.length).trim()
    : value.slice(0, separatorIndex).trim();
};

export const pickLanguage = <T,>(language: AppLanguage, values: Record<AppLanguage, T>) => values[language];

export const LanguageProvider = ({ children }: { children: ReactNode }) => {
  const [language, setLanguageState] = useState<AppLanguage>('zh');

  useEffect(() => {
    const storedLanguage = window.localStorage.getItem(languageStorageKey);
    if (storedLanguage === 'en' || storedLanguage === 'zh') setLanguageState(storedLanguage);
  }, []);

  const setLanguage = (nextLanguage: AppLanguage) => {
    setLanguageState(nextLanguage);
    window.localStorage.setItem(languageStorageKey, nextLanguage);
  };

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  }, [language]);

  const value = useMemo(() => ({ language, setLanguage }), [language]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
};

export const useLanguage = () => {
  const value = useContext(LanguageContext);

  if (!value) throw new Error('useLanguage must be used inside LanguageProvider.');

  return value;
};

export const LanguageToggle = ({ className = '' }: { className?: string }) => {
  const { language, setLanguage } = useLanguage();

  return (
    <div className={`rounded-xl bg-[#edf0f6] p-1 ${className}`}>
      {(['en', 'zh'] as const).map((item) => (
        <button
          aria-pressed={language === item}
          className={language === item ? 'rounded-lg bg-white px-3 py-1.5 font-semibold text-[#0a6f68] shadow-sm' : 'px-3 py-1.5 text-slate-500'}
          key={item}
          onClick={() => setLanguage(item)}
          type="button"
        >
          {item === 'en' ? 'EN' : '中文'}
        </button>
      ))}
    </div>
  );
};
