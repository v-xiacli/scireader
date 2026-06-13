export interface PaperSummary {
  id: string;
  title: string;
  authors: string;
  pages: number;
  status: 'indexed' | 'processing' | 'uploaded';
  abstract: string;
  pdfUrl: string;
}

export interface UserAccountSummary {
  id: string;
  name: string;
  balance: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  contextLabel?: string;
  imageUrl?: string;
  imageBase64?: string;
  imageAlt?: string;
}

export interface PaperSelection {
  text: string;
  pageNumber?: number;
}
