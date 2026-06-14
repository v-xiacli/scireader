import { Hono } from 'hono';

import authRoutes from './routes/auth';
import baseModelRoutes from './routes/base-model';
import readerAgentRoutes from './routes/reader-agent';
import storageRoutes from './routes/storage';

export const app = new Hono().basePath('/api');

app.get('/health', (c) => c.json({ ok: true, service: 'SCIReader' }));

const routes = app
  .route('/auth', authRoutes)
  .route('/base-model', baseModelRoutes)
  .route('/reader-agent', readerAgentRoutes)
  .route('/storage', storageRoutes);

export type AppType = typeof routes;
