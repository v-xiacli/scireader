'use client';

import { FloatingChatBox } from '@/components/chat/floating-chat-box';
import { useFloatingChat } from '@/components/chat/floating-chat-context';

export const GlobalFloatingChat = () => {
  const { paper, selectedText } = useFloatingChat();

  return <FloatingChatBox paper={paper ?? undefined} selectedText={selectedText} />;
};
