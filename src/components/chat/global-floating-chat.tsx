'use client';

import { useEffect, useState } from 'react';

import { FloatingChatBox } from '@/components/chat/floating-chat-box';
import { useFloatingChat } from '@/components/chat/floating-chat-context';

export const GlobalFloatingChat = () => {
  const { paper, selectedText } = useFloatingChat();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isSessionLoading, setIsSessionLoading] = useState(true);

  useEffect(() => {
    const loadSession = async () => {
      try {
        const response = await fetch('/api/auth/me');
        const result = await response.json();
        setIsAuthenticated(Boolean(response.ok && result.user));
      } catch {
        setIsAuthenticated(false);
      } finally {
        setIsSessionLoading(false);
      }
    };

    void loadSession();
  }, []);

  if (isSessionLoading || !isAuthenticated) return null;

  return <FloatingChatBox paper={paper ?? undefined} selectedText={selectedText} />;
};
