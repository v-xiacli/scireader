export interface LlmProviderRequest {
  provider: 'claude' | 'openai' | 'uniapi';
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
}

export interface ReaderAgentRequest {
  paperId: string;
  prompt: string;
  scope: 'whole-paper' | 'current-page' | 'selected-text' | 'figure';
  selectedText?: string;
  pageNumber?: number;
  figureId?: string;
  model?: string;
}

export interface ManualBalance {
  userId: string;
  availableAmount: string;
  currency: 'USD' | 'CNY';
  updatedAt: string;
}
