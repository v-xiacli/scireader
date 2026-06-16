import type { ChatMessage, PaperSummary } from '@/types/paper';

export const mockPapers: PaperSummary[] = [
  {
    id: 'paper-transformers',
    title: 'Attention Is All You Need',
    authors: 'Vaswani et al.',
    pages: 15,
    status: 'indexed',
    abstract:
      'A foundational paper introducing the Transformer architecture and self-attention for sequence transduction tasks.',
    pdfUrl: '/sample.pdf',
  },
  {
    id: 'paper-rag',
    title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks',
    authors: 'Lewis et al.',
    pages: 19,
    status: 'indexed',
    abstract:
      'A paper describing retrieval-augmented generation models that combine parametric and non-parametric memory.',
    pdfUrl: '/sample.pdf',
  },
];

export const mockMessages: ChatMessage[] = [
  {
    id: 'assistant-welcome',
    role: 'assistant',
    content:
      'Select text in the PDF or ask about the whole paper. I can summarize sections, explain methods, compare claims, and help reason about figures.',
  },
];

export const getMockPaper = (paperId: string) => mockPapers.find((paper) => paper.id === paperId) ?? mockPapers[0];
