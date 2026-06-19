import type { ChatMessage } from '@/types/paper';

export const mockMessages: ChatMessage[] = [
  {
    id: 'assistant-welcome',
    role: 'assistant',
    content:
      'Select text in the PDF or ask about the whole paper. I can summarize sections, explain methods, compare claims, and help reason about figures.',
  },
];
