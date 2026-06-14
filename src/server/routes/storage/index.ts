import { getCookie } from 'hono/cookie';
import { Hono } from 'hono';

import {
  buildProxyDownloadUrl,
  downloadFileAsAdmin,
  generateSignedUrl,
  uploadFileAsAdmin,
} from '@/lib/firebase/server/storage-admin';
import { getUserStoragePrefix } from '@/lib/storage-paths';
import { getCurrentUser, sessionCookieName } from '@/server/routes/auth';

const delayedDeleteTimers = new Map<string, ReturnType<typeof setTimeout>>();
const delayedDeleteMs = Number(process.env.UPLOADED_PDF_DELETE_DELAY_MS ?? 24 * 60 * 60 * 1000);

const deleteStoredFile = async (_filePath: string) => ({ message: 'PDF deletion is disabled; stored files are kept for reuse.' });

const scheduleStoredFileDeletion = (filePath: string) => {
  const existingTimer = delayedDeleteTimers.get(filePath);

  if (existingTimer) clearTimeout(existingTimer);

  const timer = setTimeout(() => {
    delayedDeleteTimers.delete(filePath);
    void deleteStoredFile(filePath).catch((error) => {
      console.error('Delayed file deletion failed.', { filePath, error });
    });
  }, delayedDeleteMs);

  delayedDeleteTimers.set(filePath, timer);

  return {
    message: 'File deletion scheduled.',
    deleteAfterMs: delayedDeleteMs,
  };
};

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

      const user = await getCurrentUser(getCookie(c, sessionCookieName));
      if (!user) return c.json({ error: 'Not authenticated.' }, 401);

      const finalPath = `${getUserStoragePrefix({ id: user.id, name: user.email })}${clientFilePath}`;
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
    const filePath = c.req.param('filePath');

    try {
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
    } catch (error) {
      console.error('Storage download failed.', {
        filePath,
        message: error instanceof Error ? error.message : String(error),
      });

      return c.json({ error: 'File not found or could not be downloaded' }, 404);
    }
  })
  .post('/delete-later/:filePath{.+}', async (c) => {
    try {
      const filePath = c.req.param('filePath');

      return c.json(scheduleStoredFileDeletion(filePath));
    } catch {
      return c.json({ error: 'Could not schedule file deletion' }, 500);
    }
  })
  .post('/:filePath{.+}', async (c) => {
    try {
      const filePath = c.req.param('filePath');

      return c.json(await deleteStoredFile(filePath));
    } catch {
      return c.json({ error: 'Could not delete file' }, 500);
    }
  })
  .delete('/:filePath{.+}', async (c) => {
    try {
      const filePath = c.req.param('filePath');

      return c.json(await deleteStoredFile(filePath));
    } catch {
      return c.json({ error: 'Could not delete file' }, 500);
    }
  });

export default app;
