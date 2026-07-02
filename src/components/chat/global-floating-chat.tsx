'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { FloatingChatBox } from '@/components/chat/floating-chat-box';
import { useFloatingChat } from '@/components/chat/floating-chat-context';

type ViewerPreferences = {
  pdfZoom?: number;
  chatPosition?: { x: number; y: number };
  chatSize?: { width: number; height: number };
  chatFontSize?: 'xs' | 'small' | 'medium' | 'large' | 'xl';
};

export const GlobalFloatingChat = () => {
  const { financialContext, paper, selectedText } = useFloatingChat();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isSessionLoading, setIsSessionLoading] = useState(true);
  const [isGuestChatRequested, setIsGuestChatRequested] = useState(false);
  const [guestTokenAvailable, setGuestTokenAvailable] = useState<number | null>(null);
  const [preferences, setPreferences] = useState<ViewerPreferences | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const loadSession = async () => {
      try {
        const response = await fetch('/api/auth/me');
        const result = await response.json();
        const nextIsAuthenticated = Boolean(response.ok && result.user);
        setIsAuthenticated(nextIsAuthenticated);

        if (nextIsAuthenticated) {
          const preferencesResponse = await fetch('/api/auth/viewer-preferences');
          const preferencesResult = await preferencesResponse.json();
          setPreferences(preferencesResponse.ok ? preferencesResult.preferences : null);
        }
      } catch {
        setIsAuthenticated(false);
      } finally {
        setIsSessionLoading(false);
      }
    };

    void loadSession();
  }, []);

  useEffect(() => {
    const openGuestChat = async () => {
      setIsGuestChatRequested(true);

      try {
        const response = await fetch('/api/reader-agent/guest-token-account');
        const result = await response.json();
        setGuestTokenAvailable(response.ok ? Number(result.guestTokenAccount?.tokenAvailable ?? 0) : null);
      } catch {
        setGuestTokenAvailable(null);
      }
    };

    window.addEventListener('scireader-open-chat', openGuestChat);

    return () => window.removeEventListener('scireader-open-chat', openGuestChat);
  }, []);

  useEffect(() => {
    const shouldLockPage = isGuestChatRequested && !isAuthenticated && !paper && !financialContext?.active;
    if (!shouldLockPage) return;

    const scrollY = window.scrollY;
    const previousBodyPosition = document.body.style.position;
    const previousBodyTop = document.body.style.top;
    const previousBodyWidth = document.body.style.width;
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;

    document.documentElement.classList.add('guest-chat-scroll-lock');
    document.documentElement.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';

    return () => {
      document.documentElement.classList.remove('guest-chat-scroll-lock');
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.style.position = previousBodyPosition;
      document.body.style.top = previousBodyTop;
      document.body.style.width = previousBodyWidth;
      document.body.style.overflow = previousBodyOverflow;
      window.scrollTo(0, scrollY);
    };
  }, [financialContext?.active, isAuthenticated, isGuestChatRequested, paper]);

  const saveLayout = useCallback(
    (layout: { position: { x: number; y: number }; size: { width: number; height: number }; fontSize?: 'xs' | 'small' | 'medium' | 'large' | 'xl' }) => {
      if (!isAuthenticated) return;
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

      saveTimeoutRef.current = setTimeout(() => {
        void fetch('/api/auth/viewer-preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatPosition: layout.position, chatSize: layout.size, chatFontSize: layout.fontSize }),
        });
      }, 400);
    },
    [isAuthenticated],
  );

  useEffect(() => {
    console.info('Global floating chat state.', {
      isSessionLoading,
      isAuthenticated,
      hasFinancialContext: Boolean(financialContext?.active),
      hasPaper: Boolean(paper),
      paperId: paper?.id,
      hasPreferences: Boolean(preferences),
      chatPosition: preferences?.chatPosition,
      chatSize: preferences?.chatSize,
      chatFontSize: preferences?.chatFontSize,
    });
  }, [financialContext?.active, isSessionLoading, isAuthenticated, paper, preferences]);

  if (isSessionLoading && !paper && !financialContext?.active) {
    console.info('Global floating chat hidden: session loading and no paper context yet.');
    return null;
  }
  if (!isAuthenticated && !paper && !financialContext?.active && !isGuestChatRequested) return null;
  console.info('Global floating chat rendering.', { paperId: paper?.id, isAuthenticated });

  return (
    <FloatingChatBox
      initialFontSize={preferences?.chatFontSize}
      initialPosition={preferences?.chatPosition}
      initialSize={preferences?.chatSize}
      isAuthenticated={isAuthenticated}
      guestTokenAvailable={guestTokenAvailable}
      openRequested={isGuestChatRequested}
      financialContext={financialContext}
      onLayoutChange={saveLayout}
      paper={paper ?? undefined}
      selectedText={selectedText}
    />
  );
};
