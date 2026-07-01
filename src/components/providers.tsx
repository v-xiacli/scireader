'use client';

import { QueryClient, QueryClientProvider, isServer } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';

import { FloatingChatProvider } from '@/components/chat/floating-chat-context';
import { GlobalFloatingChat } from '@/components/chat/global-floating-chat';
import { LanguageProvider } from '@/components/language/language-context';

const makeQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
      },
    },
  });

let browserQueryClient: QueryClient | undefined;

const getQueryClient = () => {
  if (isServer) return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
};

export const Providers = ({ children }: PropsWithChildren) => {
  return (
    <QueryClientProvider client={getQueryClient()}>
      <LanguageProvider>
        <FloatingChatProvider>
          {children}
          <GlobalFloatingChat />
        </FloatingChatProvider>
      </LanguageProvider>
    </QueryClientProvider>
  );
};
