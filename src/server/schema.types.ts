export interface UserRecord {
  id: string;
  name: string | null;
  email: string;
  image?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaperRecord {
  id: string;
  userId: string;
  title: string;
  authors?: string | null;
  abstract?: string | null;
  storageUrl: string;
  pageCount?: number | null;
  status: 'uploaded' | 'processing' | 'indexed' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

export interface PaperChunkRecord {
  id: string;
  paperId: string;
  pageNumber: number;
  chunkIndex: number;
  content: string;
  embedding?: number[];
  createdAt: Date;
}

export interface ConversationRecord {
  id: string;
  userId: string;
  paperId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  context: Record<string, unknown> | null;
  createdAt: Date;
}

export interface ApiUsageRecord {
  id: string;
  userId: string;
  provider: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  cost?: string;
  status: 'success' | 'failed';
  createdAt: Date;
}

export interface UserBalanceRecord {
  userId: string;
  availableAmount: string;
  frozenAmount: string;
  currency: 'USD' | 'CNY';
  updatedAt: Date;
}
