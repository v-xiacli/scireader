import { Hono } from 'hono';

import {
  buildProxyDownloadUrl,
  deleteFileAsAdmin,
  downloadFileAsAdmin,
  generateSignedUrl,
  uploadFileAsAdmin,
} from '@/lib/firebase/server/storage-admin';
import { getUserStoragePrefix } from '@/lib/storage-paths';

const app = new Hono()
  .post('/upload/private', async (c) => {
    try {
      const formData = await c.req.formData();
      const file = formData.get('file') as File | null;
      const clientFilePath = formData.get('filePath') as string | null;

      if (!file) return c.json({ error: 'No file provided for upload.' }, 400);
      if (!clientFilePath) return c.json({ error: 'No filePath provided.' }, 400);
      if (clientFilePath.includes('..')) return c.json({ error: 'Invalid file path provided.' }, 400);
      if (file.type !== 'application/pdf') return c.json({ error: 'Only PDF uploads are supported.' }, 400);

      const finalPath = `${getUserStoragePrefix(null)}${clientFilePath}`;
      const buffer = Buffer.from(await file.arrayBuffer());

      await uploadFileAsAdmin(buffer, finalPath, file.type);

      return c.json({
        success: true,
        filePath: finalPath,
        downloadUrl: buildProxyDownloadUrl(finalPath),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Private file upload failed.';
      return c.json({ error: 'Private file upload failed.', message }, 500);
    }
  })
  .get('/signed-url/:filePath{.+}', async (c) => {
    try {
      const filePath = c.req.param('filePath');
      const downloadUrl = await generateSignedUrl(filePath, 60);

      return c.json({ downloadUrl });
    } catch {
      return c.json({ error: 'File not found or could not generate URL' }, 404);
    }
  })
  .get('/download/:filePath{.+}', async (c) => {
    try {
      const filePath = c.req.param('filePath');
      const forceDownload = c.req.query('download') === '1';
      const { buffer, contentType } = await downloadFileAsAdmin(filePath);
      const filename = filePath.split('/').pop() || 'paper.pdf';
      const headers = new Headers();

      headers.set('Content-Type', contentType || 'application/pdf');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Cache-Control', 'private, max-age=0, must-revalidate');
      headers.set(
        'Content-Disposition',
        `${forceDownload ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      headers.set('Content-Length', String(buffer.length));

      return new Response(new Uint8Array(buffer), { headers });
    } catch {
      return c.json({ error: 'File not found or could not be downloaded' }, 404);
    }
  })
  .delete('/:filePath{.+}', async (c) => {
    try {
      const filePath = c.req.param('filePath');
      await deleteFileAsAdmin(filePath);

      return c.json({ message: 'File deleted successfully' });
    } catch {
      return c.json({ error: 'Could not delete file' }, 500);
    }
  });

export default app;
