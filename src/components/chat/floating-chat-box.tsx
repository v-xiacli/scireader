'use client';

import { Bot, CornerDownLeft, FileSearch, ImageIcon, Loader2, Quote } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import ReactMarkdown from 'react-markdown';

import { mockMessages } from '@/features/papers/mock-data';
import type { ChatMessage, PaperSelection, PaperSummary } from '@/types/paper';

interface FloatingChatBoxProps {
  paper?: PaperSummary | null;
  selectedText?: PaperSelection | null;
}

const defaultPosition = { x: 28, y: 96 };
const defaultSize = { width: 560, height: 620 };
const minSize = { width: 380, height: 420 };
const edgePadding = 8;

type ResizeHandle = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
type ConversationTurn = Pick<ChatMessage, 'role' | 'content'>;

const compactPaperSummaryPrompt =
  '请用中文为这篇论文生成高密度速记，适合显示在窄聊天框里：1 行主题；6-10 条核心要点，每条不超过 28 个汉字；再给出方法/数据/实验/结论/局限各一条短句。不要客套话。';

const buildConversationHistory = (messages: ChatMessage[]): ConversationTurn[] =>
  messages
    .filter((message) => message.content && message.contextLabel !== 'Paper brief' && !message.imageBase64 && !message.imageUrl && message.content !== 'Analyzing...' && message.content !== 'Generating image...')
    .slice(-8)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, 2000),
    }));

export const FloatingChatBox = ({ paper = null, selectedText = null }: FloatingChatBoxProps) => {
  const dragOffsetRef = useRef(defaultPosition);
  const resizeStartRef = useRef({ x: 0, y: 0, width: defaultSize.width, height: defaultSize.height, left: defaultPosition.x, top: defaultPosition.y });
  const resizeHandleRef = useRef<ResizeHandle>('bottom-right');
  const [messages, setMessages] = useState<ChatMessage[]>(mockMessages);
  const [input, setInput] = useState('');
  const [position, setPosition] = useState(defaultPosition);
  const [size, setSize] = useState(defaultSize);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isImageMode, setIsImageMode] = useState(false);
  const [paperContextSummary, setPaperContextSummary] = useState('');
  const hasPaper = Boolean(paper);
  const paperId = paper?.id;
  const paperPdfUrl = paper?.pdfUrl;
  const paperTitle = paper?.title;

  const askReaderAgent = useCallback(
    async (prompt: string, scope: 'whole-paper' | 'selected-text' = 'whole-paper') => {
      const response = await fetch('/api/reader-agent/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paperId: paperId ?? 'general-chat',
          pdfUrl: paperPdfUrl,
          title: paperTitle ?? 'SCIReader',
          prompt,
          scope,
          selectedText: selectedText?.text,
          pageNumber: selectedText?.pageNumber,
          paperContextSummary,
          conversationHistory: buildConversationHistory(messages),
        }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Reader agent failed.');

      return result.answer as string;
    },
    [messages, paperId, paperPdfUrl, paperTitle, paperContextSummary, selectedText],
  );

  const summarizePaper = useCallback(async () => {
    if (!paperId || !paperPdfUrl) return '';

    const response = await fetch('/api/reader-agent/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paperId,
        pdfUrl: paperPdfUrl,
        title: paperTitle,
        prompt: compactPaperSummaryPrompt,
        scope: 'whole-paper',
      }),
    });
    const result = await response.json();

    if (!response.ok) throw new Error(result.message ?? result.error ?? 'Paper summary failed.');

    return result.summary as string;
  }, [paperId, paperPdfUrl, paperTitle]);

  const generateImage = useCallback(
    async (prompt: string) => {
      const response = await fetch('/api/reader-agent/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          paperId,
          title: paperTitle,
          selectedText: selectedText?.text,
        }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Image generation failed.');

      return result as { answer: string; imageUrl?: string; imageBase64?: string; prompt: string };
    },
    [paperId, paperTitle, selectedText?.text],
  );

  useEffect(() => {
    if (!paperId || !paperPdfUrl) {
      setPaperContextSummary('');
      setMessages(mockMessages);
      return;
    }

    let isActive = true;
    const loadingId = crypto.randomUUID();

    setPaperContextSummary('');
    setMessages([
      {
        id: loadingId,
        role: 'assistant',
        content: '正在生成论文要点...',
        contextLabel: 'Paper brief',
      },
    ]);

    summarizePaper()
      .then((summary) => {
        if (!isActive) return;

        setPaperContextSummary(summary);
        setMessages([
          {
            id: loadingId,
            role: 'assistant',
            content: summary,
            contextLabel: 'Paper brief',
          },
        ]);
      })
      .catch((error) => {
        if (!isActive) return;

        setMessages([
          {
            id: loadingId,
            role: 'assistant',
            content: error instanceof Error ? error.message : '论文要点生成失败，可以直接提问，我会读取论文回答。',
            contextLabel: 'Paper brief',
          },
        ]);
      });

    return () => {
      isActive = false;
    };
  }, [paperId, paperPdfUrl, summarizePaper]);

  const startDragging = (event: PointerEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('button')) return;

    dragOffsetRef.current = {
      x: event.clientX - position.x,
      y: event.clientY - position.y,
    };
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const drag = (event: PointerEvent<HTMLElement>) => {
    if (!isDragging) return;

    const maxX = Math.max(0, window.innerWidth - size.width);
    const maxY = Math.max(0, window.innerHeight - size.height);

    setPosition({
      x: Math.min(Math.max(edgePadding, event.clientX - dragOffsetRef.current.x), maxX),
      y: Math.min(Math.max(edgePadding, event.clientY - dragOffsetRef.current.y), maxY),
    });
  };

  const stopDragging = (event: PointerEvent<HTMLElement>) => {
    setIsDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const startResizing = (handle: ResizeHandle) => (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    resizeHandleRef.current = handle;
    resizeStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      width: size.width,
      height: size.height,
      left: position.x,
      top: position.y,
    };
    setIsResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (!isResizing) return;

    const handle = resizeHandleRef.current;
    const start = resizeStartRef.current;
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    const right = start.left + start.width;
    const bottom = start.top + start.height;
    let nextLeft = start.left;
    let nextTop = start.top;
    let nextWidth = handle.includes('left') ? start.width - deltaX : start.width + deltaX;
    let nextHeight = handle.includes('top') ? start.height - deltaY : start.height + deltaY;

    if (handle.includes('left')) {
      nextWidth = Math.min(Math.max(minSize.width, nextWidth), right - edgePadding);
      nextLeft = Math.max(edgePadding, right - nextWidth);
    } else {
      nextWidth = Math.min(Math.max(minSize.width, nextWidth), window.innerWidth - start.left - edgePadding);
    }

    if (handle.includes('top')) {
      nextHeight = Math.min(Math.max(minSize.height, nextHeight), bottom - edgePadding);
      nextTop = Math.max(edgePadding, bottom - nextHeight);
    } else {
      nextHeight = Math.min(Math.max(minSize.height, nextHeight), window.innerHeight - start.top - edgePadding);
    }

    setPosition({ x: nextLeft, y: nextTop });
    setSize({ width: nextWidth, height: nextHeight });
  };

  const stopResizing = (event: PointerEvent<HTMLDivElement>) => {
    setIsResizing(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const sendMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || isThinking) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      contextLabel: isImageMode ? 'Image generation' : selectedText ? `Selection on page ${selectedText.pageNumber ?? '?'}` : hasPaper ? 'Whole paper' : 'General chat',
    };
    const loadingId = crypto.randomUUID();

    setMessages((current) => [
      ...current,
      userMessage,
      { id: loadingId, role: 'assistant', content: isImageMode ? 'Generating image...' : 'Analyzing...' },
    ]);
    setInput('');
    setIsThinking(true);

    try {
      if (isImageMode) {
        const result = await generateImage(trimmed);
        setMessages((current) =>
          current.map((message) =>
            message.id === loadingId
              ? {
                  ...message,
                  content: result.answer,
                  imageUrl: result.imageUrl,
                  imageBase64: result.imageBase64,
                  imageAlt: result.prompt,
                }
              : message,
          ),
        );
      } else {
        const answer = await askReaderAgent(trimmed, selectedText ? 'selected-text' : 'whole-paper');
        setMessages((current) => current.map((message) => (message.id === loadingId ? { ...message, content: answer } : message)));
      }
    } catch (error) {
      setMessages((current) =>
        current.map((message) =>
          message.id === loadingId
            ? { ...message, content: error instanceof Error ? error.message : isImageMode ? 'Image generation failed.' : 'Reader agent failed.' }
            : message,
        ),
      );
    } finally {
      setIsThinking(false);
    }
  };

  return (
    <aside
      className="fixed z-50 flex max-w-[calc(100vw-1rem)] flex-col rounded-2xl border bg-white/95 shadow-2xl backdrop-blur"
      style={{ left: position.x, top: position.y, width: size.width, height: size.height }}
    >
      <header
        className={isDragging ? 'cursor-grabbing border-b p-3' : 'cursor-grab border-b p-3'}
        onPointerDown={startDragging}
        onPointerMove={drag}
        onPointerUp={stopDragging}
      >
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-primary">AI reader</p>
            <h2 className="mt-0.5 text-base font-semibold">{hasPaper ? 'Paper chat' : 'SCIReader chat'}</h2>
            <p className="mt-1 truncate text-xs text-muted-foreground">{paper?.title ?? 'Ask without opening a paper'}</p>
          </div>
          <div className="rounded-xl bg-primary/10 p-2 text-primary">
            <Bot className="size-5" />
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-1.5 text-xs">
          <button className="rounded-lg border p-1.5 hover:bg-slate-50" disabled={!hasPaper} type="button"><FileSearch className="mx-auto mb-0.5 size-4" />Paper</button>
          <button className="rounded-lg border p-1.5 hover:bg-slate-50" disabled={!selectedText} type="button"><Quote className="mx-auto mb-0.5 size-4" />Selection</button>
          <button
            className={isImageMode ? 'rounded-lg border border-primary bg-primary/10 p-1.5 text-primary' : 'rounded-lg border p-1.5 hover:bg-slate-50'}
            onClick={() => setIsImageMode((current) => !current)}
            type="button"
          >
            <ImageIcon className="mx-auto mb-0.5 size-4" />Image
          </button>
        </div>
      </header>

      {selectedText && !isImageMode ? (
        <div className="border-b bg-blue-50 p-3 text-xs">
          <p className="font-medium text-blue-900">Selected text context</p>
          <p className="mt-1 line-clamp-3 text-blue-800">{selectedText.text}</p>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
        {messages.map((message) => (
          <div className={message.role === 'user' ? 'ml-auto max-w-[92%] rounded-xl bg-primary p-2.5 text-primary-foreground' : 'mr-auto max-w-[96%] rounded-xl bg-slate-100 p-2.5'} key={message.id}>
            {message.contextLabel ? <p className="mb-1 text-[11px] opacity-70">{message.contextLabel}</p> : null}
            {message.imageUrl || message.imageBase64 ? (
              <img alt={message.imageAlt ?? 'Generated image'} className="mb-2 max-h-80 w-full rounded-lg object-contain" src={message.imageUrl ?? message.imageBase64} />
            ) : null}
            <div className="max-w-none break-words text-xs leading-5">
              <ReactMarkdown
                components={{
                  p: ({ children }) => <p className="my-1 whitespace-pre-wrap">{children}</p>,
                  li: ({ children }) => <li className="my-0.5 pl-0">{children}</li>,
                  ul: ({ children }) => <ul className="my-1 list-disc space-y-0 pl-4">{children}</ul>,
                  ol: ({ children }) => <ol className="my-1 list-decimal space-y-0 pl-4">{children}</ol>,
                  h1: ({ children }) => <h1 className="my-1 text-sm font-semibold">{children}</h1>,
                  h2: ({ children }) => <h2 className="my-1 text-sm font-semibold">{children}</h2>,
                  h3: ({ children }) => <h3 className="my-1 text-xs font-semibold">{children}</h3>,
                  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          </div>
        ))}
      </div>

      <footer className="border-t p-3">
        <textarea
          className="max-h-48 min-h-20 w-full resize-y rounded-xl border bg-slate-50 p-2.5 text-sm outline-none focus:border-primary"
          disabled={isThinking}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void sendMessage();
          }}
          placeholder={isImageMode ? 'Describe the image you want generated...' : 'Ask about the paper, selected text, methods, or citations...'}
          value={input}
        />
        <button
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-70"
          disabled={isThinking}
          onClick={() => void sendMessage()}
          type="button"
        >
          {isThinking ? <Loader2 className="size-4 animate-spin" /> : <CornerDownLeft className="size-4" />}
          {isThinking ? (isImageMode ? 'Image agent is working...' : 'Reader agent is working...') : isImageMode ? 'Generate image' : 'Send to reader agent'}
        </button>
      </footer>
      {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as ResizeHandle[]).map((handle) => {
        const vertical = handle.startsWith('top') ? 'top-2' : 'bottom-2';
        const horizontal = handle.endsWith('left') ? 'left-2' : 'right-2';
        const cursor = handle === 'top-left' || handle === 'bottom-right' ? 'cursor-nwse-resize' : 'cursor-nesw-resize';
        const borders = {
          'top-left': 'rounded-tl-2xl border-l-2 border-t-2',
          'top-right': 'rounded-tr-2xl border-r-2 border-t-2',
          'bottom-left': 'rounded-bl-2xl border-b-2 border-l-2',
          'bottom-right': 'rounded-br-2xl border-b-2 border-r-2',
        }[handle];

        return (
          <div
            aria-label={`Resize chat box from ${handle}`}
            className={`absolute ${vertical} ${horizontal} size-5 ${cursor} ${borders} ${isResizing && resizeHandleRef.current === handle ? 'border-primary' : 'border-slate-400 hover:border-primary'}`}
            key={handle}
            onPointerDown={startResizing(handle)}
            onPointerMove={resize}
            onPointerUp={stopResizing}
            role="separator"
          />
        );
      })}
    </aside>
  );
};




