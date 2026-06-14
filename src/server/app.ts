import { Hono } from 'hono';

import authRoutes from './routes/auth';
import baseModelRoutes from './routes/base-model';
import readerAgentRoutes from './routes/reader-agent';
import storageRoutes from './routes/storage';

export const app = new Hono().basePath('/api');

app.use('*', async (c, next) => {
  const startedAt = Date.now();

  await next();

  console.info('API request', {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - startedAt,
  });
});

app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'SCIReader',
    version: process.env.WEBSITE_SITE_NAME ? 'azure-app-service' : 'local',
    timestamp: new Date().toISOString(),
  }),
);

const routes = app
  .route('/auth', authRoutes)
  .route('/base-model', baseModelRoutes)
  .route('/reader-agent', readerAgentRoutes)
  .route('/storage', storageRoutes);

export type AppType = typeof routes;
