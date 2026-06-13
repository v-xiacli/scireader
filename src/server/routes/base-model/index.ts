import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';

const requestSchema = z.object({
  provider: z.enum(['claude', 'openai', 'uniapi']),
  model: z.string().min(1),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string().min(1),
    }),
  ),
});

const app = new Hono()
  .post('/chat', zValidator('json', requestSchema), async (c) => {
    const request = c.req.valid('json');

    return c.json({
      provider: request.provider,
      model: request.model,
      message:
        'Provider adapter placeholder. Wire this route to Claude/OpenAI/UniAPI SDKs while preserving this base-model contract.',
    });
  })
  .get('/models', (c) =>
    c.json({
      models: [
        { provider: 'claude', id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
        { provider: 'openai', id: 'gpt-4.1', label: 'OpenAI GPT-4.1' },
        { provider: 'uniapi', id: 'default-reader', label: 'UniAPI Reader Model' },
      ],
    }),
  );

export default app;
