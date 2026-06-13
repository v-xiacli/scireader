'use client';

import { Bot, CornerDownLeft, FileSearch, ImageIcon, Loader2, Quote } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

import { mockMessages } from '@/features/papers/mock-data';
import type { ChatMessage, PaperSelection, PaperSummary } from '@/types/paper';

interface FloatingChatBoxProps {
  paper?: PaperSummary | null;
  selectedText?: PaperSelection | null;
}

const defaultPosition = { x: 28, y: 96 };
const defaultSize = { width: 460, height: 620 };
const minSize = { width: 340, height: 420 };
const edgePadding = 8;

type ResizeHandle = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export const FloatingChatBox = ({ paper = null, selectedText = null }: FloatingChatBoxProps) => {
  const dragOffsetRef = useRef(defaultPosition);
  const resizeStartRef = useRef({ x: 0, y: 0, width: defaultSize.width, height: defaultSize.height, left: defaultPosition.x, top: defaultPosition.y });
  const resizeHandleRef = useRef<ResizeHandle>('bottom-right');
  const hasRequestedAnalysisRef = useRef(false);
  const [messages, setMessages] = useState<ChatMessage[]>(mockMessages);
  const [input, setInput] = useState('');
  const [position, setPosition] = useState(defaultPosition);
  const [size, setSize] = useState(defaultSize);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isImageMode, setIsImageMode] = useState(false);
  const hasPaper = Boolean(paper);

  const askReaderAgent = useCallback(
    async (prompt: string, scope: 'whole-paper' | 'selected-text' = 'whole-paper') => {
      const response = await fetch('/api/reader-agent/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paperId: paper?.id ?? 'general-chat',
          pdfUrl: paper?.pdfUrl,
          title: paper?.title ?? 'SCIReader',
          prompt,
          scope,
          selectedText: selectedText?.text,
          pageNumber: selectedText?.pageNumber,
        }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Reader agent failed.');

      return result.answer as string;
    },
    [paper?.id, paper?.pdfUrl, paper?.title, selectedText],
  );

  const generateImage = useCallback(
    async (prompt: string) => {
      const response = await fetch('/api/reader-agent/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          paperId: paper?.id,
          title: paper?.title,
          selectedText: selectedText?.text,
        }),
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.message ?? result.error ?? 'Image generation failed.');

      return result as { answer: string; imageUrl?: string; imageBase64?: string; prompt: string };
    },
    [paper?.id, paper?.title, selectedText?.text],
  );

  const runInitialAnalysis = useCallback(async () => {
    if (hasRequestedAnalysisRef.current || paper?.status !== 'uploaded' || !paper.pdfUrl) return;

    hasRequestedAnalysisRef.current = true;
    const loadingId = crypto.randomUUID();
    setIsThinking(true);
    setMessages((current) => [
      ...current,
      {
        id: loadingId,
        role: 'assistant',
        content: '正在阅读论文，并生成中文分析：标题、摘要、结论、公式 LaTeX、图表解释、创新点、不足和相关前作...',
      },
    ]);

    try {
      const answer = await askReaderAgent(
        '请完整阅读这篇论文，并用中文输出：1. 标题中文翻译；2. 摘要中文翻译；3. 结论中文翻译；4. 逐条列出每个公式并给出 LaTeX 版本；5. 逐图解释每张图在说明什么；6. 总结论文创新点；7. 总结论文缺陷或不足；8. 总结主要前人工作，并给出论文标题。',
      );
      setMessages((current) => current.map((message) => (message.id === loadingId ? { ...message, content: answer } : message)));
    } catch (error) {
      setMessages((current) =>
        current.map((message) =>
          message.id === loadingId
            ? { ...message, content: error instanceof Error ? error.message : 'Reader agent failed.' }
            : message,
        ),
      );
    } finally {
      setIsThinking(false);
    }
  }, [askReaderAgent, paper?.pdfUrl, paper?.status]);

  useEffect(() => {
    hasRequestedAnalysisRef.current = false;
    setMessages(mockMessages);
  }, [paper?.id]);

  useEffect(() => {
    void runInitialAnalysis();
  }, [runInitialAnalysis]);

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
      { id: loadingId, role: 'assistant', content: isImageMode ? '正在生成图像...' : '正在分析...' },
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
      className="fixed z-50 flex max-w-[calc(100vw-1rem)] flex-col rounded-3xl border bg-white/95 shadow-2xl backdrop-blur"
      style={{ left: position.x, top: position.y, width: size.width, height: size.height }}
    >
      <header
        className={isDragging ? 'cursor-grabbing border-b p-5' : 'cursor-grab border-b p-5'}
        onPointerDown={startDragging}
        onPointerMove={drag}
        onPointerUp={stopDragging}
      >
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium uppercase tracking-wide text-primary">AI reader</p>
            <h2 className="mt-1 text-xl font-semibold">{hasPaper ? 'Paper chat' : 'SCIReader chat'}</h2>
            <p className="mt-1 truncate text-xs text-muted-foreground">{paper?.title ?? 'Ask without opening a paper'}</p>
          </div>
          <div className="rounded-2xl bg-primary/10 p-3 text-primary">
            <Bot className="size-6" />
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
          <button className="rounded-xl border p-2 hover:bg-slate-50" disabled={!hasPaper} type="button"><FileSearch className="mx-auto mb-1 size-4" />Paper</button>
          <button className="rounded-xl border p-2 hover:bg-slate-50" disabled={!selectedText} type="button"><Quote className="mx-auto mb-1 size-4" />Selection</button>
          <button
            className={isImageMode ? 'rounded-xl border border-primary bg-primary/10 p-2 text-primary' : 'rounded-xl border p-2 hover:bg-slate-50'}
            onClick={() => setIsImageMode((current) => !current)}
            type="button"
          >
            <ImageIcon className="mx-auto mb-1 size-4" />Image
          </button>
        </div>
      </header>

      {selectedText && !isImageMode ? (
        <div className="border-b bg-blue-50 p-4 text-sm">
          <p className="font-medium text-blue-900">Selected text context</p>
          <p className="mt-2 line-clamp-4 text-blue-800">{selectedText.text}</p>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
        {messages.map((message) => (
          <div className={message.role === 'user' ? 'ml-auto max-w-[85%] rounded-2xl bg-primary p-4 text-primary-foreground' : 'mr-auto max-w-[85%] rounded-2xl bg-slate-100 p-4'} key={message.id}>
            {message.contextLabel ? <p className="mb-2 text-xs opacity-70">{message.contextLabel}</p> : null}
            {message.imageUrl || message.imageBase64 ? (
              <img alt={message.imageAlt ?? 'Generated image'} className="mb-3 max-h-80 w-full rounded-xl object-contain" src={message.imageUrl ?? message.imageBase64} />
            ) : null}
            <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.content}</p>
          </div>
        ))}
      </div>

      <footer className="border-t p-4">
        <textarea
          className="max-h-64 min-h-28 w-full resize-y rounded-2xl border bg-slate-50 p-3 text-sm outline-none focus:border-primary"
          disabled={isThinking}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void sendMessage();
          }}
          placeholder={isImageMode ? 'Describe the image you want generated...' : 'Ask about the paper, selected text, methods, citations, or figures...'}
          value={input}
        />
        <button
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-70"
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
