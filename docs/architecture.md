# SCIReader Architecture

SCIReader is a TypeScript subproject created from the canva-like app's architectural direction, but targeted at scientific paper reading instead of graphic design.

## Product decisions

## Kept

- TypeScript and React/Next.js app structure.
- Hono-style API routing through `src/app/api/[[...route]]/route.ts`.
- Typed API client pattern.
- Full authentication-ready product direction.
- Dashboard/project concept, renamed around papers.
- AI assistant/chat features, with a large chat workspace.
- Multi-provider LLM routing through a base-model layer.
- Higher-level agent routes above the provider layer.
- Database concepts for users, papers, chunks, conversations, messages, usage logs, and manual balance.
- Storage concept for uploaded PDFs and extracted assets.

## Removed

- Fabric.js canvas editor.
- Canva templates.
- Image editing/generation/upscale/matting/poster agents.
- Unsplash/template image search.
- Online Stripe checkout and subscription management.

## Replaced concepts

| canva-like | SCIReader |
| --- | --- |
| Project | Paper |
| Canvas editor | PDF reader |
| Canvas object selection | PDF text/page/figure selection |
| Image/poster agents | Reader agents |
| Template cards | Paper library cards |
| Online billing | Manual balance display |

## Initial UI

- `/` shows the paper library, manual balance, and recent paper cards.
- `/papers/[paperId]` shows a PDF-reader workspace with a large right-side chat panel.
- The first PDF reader implementation is a placeholder surface that captures browser text selection. It is structured so a real PDF.js viewer can replace the page body without changing the chat contract.

## API structure

- `/api/health` confirms service availability.
- `/api/base-model/models` lists configured model options.
- `/api/base-model/chat` is the provider adapter boundary for Claude/OpenAI/UniAPI-style calls.
- `/api/reader-agent/ask` answers questions over paper context.
- `/api/reader-agent/summarize` summarizes paper/page/selection/figure scope.
- `/api/reader-agent/explain-selection` explains selected text.
- `/api/reader-agent/figure` reserves the figure-aware workflow.

## Planned data model

- `users` — authenticated account data.
- `papers` — uploaded PDF metadata and storage location.
- `paper_chunks` — extracted page/chunk text and optional embeddings.
- `conversations` — per-paper chat threads.
- `messages` — user/assistant/system messages with context metadata.
- `api_usage` — provider/model/token/cost/status accounting.
- `user_balance` — manually maintained account balance shown in the UI.

## Next implementation milestones

1. Install dependencies inside `SCIReader`.
2. Replace the PDF placeholder with a real PDF.js viewer.
3. Add Auth.js configuration and protected routes.
4. Add database schema/migrations for papers and chat.
5. Add PDF upload and storage handling.
6. Add PDF text extraction and chunking.
7. Wire reader-agent routes to real LLM providers.
8. Add persistent conversation history and manual balance retrieval.
