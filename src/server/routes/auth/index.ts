import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

import { zValidator } from '@hono/zod-validator';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';

import { ensureAuthTables, getSql, getUserTokenAccount } from '@/server/db';
import { downloadTextAsAdmin, uploadTextAsAdmin } from '@/lib/firebase/server/storage-admin';

const scrypt = promisify(scryptCallback);
export const sessionCookieName = 'sci_session';
const sessionMaxAgeSeconds = 60 * 60 * 24 * 30;

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
};

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
});

const viewerPreferencesSchema = z.object({
  pdfZoom: z.number().min(25).max(500).optional(),
  chatPosition: z.object({ x: z.number(), y: z.number() }).optional(),
  chatSize: z.object({ width: z.number(), height: z.number() }).optional(),
  chatFontSize: z.enum(['xs', 'small', 'medium', 'large', 'xl']).optional(),
  readingMode: z.enum(['reviewer', 'reader']).optional(),
  detailedReport: z.boolean().optional(),
});

const uploadedPaperSchema = z.object({
  id: z.string(),
  title: z.string(),
  authors: z.string(),
  pages: z.number(),
  status: z.literal('uploaded'),
  abstract: z.string(),
  pdfUrl: z.string(),
  filePath: z.string(),
  journal: z.string().optional(),
  year: z.string().optional(),
  readingMode: z.enum(['reviewer', 'reader']).optional(),
  detailedReport: z.boolean().optional(),
});

const uploadedPapersSchema = z.array(uploadedPaperSchema);

const removeUploadedPaperSchema = z.object({
  filePath: z.string().min(1),
});

const hashPassword = async (password: string) => {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;

  return `scrypt:${salt}:${derivedKey.toString('hex')}`;
};

const verifyPassword = async (password: string, storedHash: string) => {
  const [algorithm, salt, key] = storedHash.split(':');
  if (algorithm !== 'scrypt' || !salt || !key) return false;

  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  const storedKey = Buffer.from(key, 'hex');

  return storedKey.length === derivedKey.length && timingSafeEqual(storedKey, derivedKey);
};

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const getPreferencePath = (userId: string) => `user-preferences/${userId}.md`;
const getUploadedPapersPath = (userId: string) => `user-papers/${userId}.md`;

const parseJsonBlock = (content: string) => {
  const match = content.match(/```json\n([\s\S]*?)\n```/);

  return match ? JSON.parse(match[1]) : null;
};

const loadViewerPreferences = async (userId: string) => {
  try {
    return viewerPreferencesSchema.parse(parseJsonBlock(await downloadTextAsAdmin(getPreferencePath(userId))));
  } catch {
    return null;
  }
};

const saveViewerPreferences = async (userId: string, preferences: z.infer<typeof viewerPreferencesSchema>) => {
  const currentPreferences = (await loadViewerPreferences(userId)) ?? {};
  const nextPreferences = { ...currentPreferences, ...preferences };

  await uploadTextAsAdmin(
    `# Viewer preferences\n\n\`\`\`json\n${JSON.stringify(nextPreferences, null, 2)}\n\`\`\`\n`,
    getPreferencePath(userId),
  );

  return nextPreferences;
};

export const loadUploadedPapers = async (userId: string) => {
  try {
    return uploadedPapersSchema.parse(parseJsonBlock(await downloadTextAsAdmin(getUploadedPapersPath(userId))) ?? []);
  } catch {
    return [];
  }
};

const cleanPaperIdentityPart = (part?: string) => part?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';

const getUploadedPaperIdentity = (paper: z.infer<typeof uploadedPaperSchema>) => {
  const title = cleanPaperIdentityPart(paper.title || paper.id);
  const journal = cleanPaperIdentityPart(paper.journal);
  const year = cleanPaperIdentityPart(paper.year);
  const authors = paper.authors
    .split(/\s*(?:,|;|\band\b|&|，|；)\s*/i)
    .slice(0, 2)
    .map(cleanPaperIdentityPart)
    .join('');

  return [title, authors, journal, year].filter(Boolean).join('') || cleanPaperIdentityPart(paper.id) || cleanPaperIdentityPart(paper.filePath);
};

const saveUploadedPapers = async (userId: string, papers: z.infer<typeof uploadedPapersSchema>) => {
  const seenIdentities = new Set<string>();
  const seenFilePaths = new Set<string>();
  const dedupedPapers = papers.filter((paper) => {
    const identity = getUploadedPaperIdentity(paper);

    if (seenIdentities.has(identity) || seenFilePaths.has(paper.filePath)) return false;

    seenIdentities.add(identity);
    seenFilePaths.add(paper.filePath);

    return true;
  });

  await uploadTextAsAdmin(
    `# Uploaded papers\n\n\`\`\`json\n${JSON.stringify(dedupedPapers, null, 2)}\n\`\`\`\n`,
    getUploadedPapersPath(userId),
  );

  return dedupedPapers;
};

const saveUploadedPaper = async (userId: string, paper: z.infer<typeof uploadedPaperSchema>) => {
  const currentPapers = await loadUploadedPapers(userId);
  const paperIdentity = getUploadedPaperIdentity(paper);
  const nextPapers = [
    paper,
    ...currentPapers.filter((currentPaper) => getUploadedPaperIdentity(currentPaper) !== paperIdentity && currentPaper.filePath !== paper.filePath),
  ];

  return saveUploadedPapers(userId, nextPapers);
};

const removeUploadedPaper = async (userId: string, filePath: string) => {
  const currentPapers = await loadUploadedPapers(userId);
  const nextPapers = currentPapers.filter((paper) => paper.filePath !== filePath);

  return saveUploadedPapers(userId, nextPapers);
};

const createSession = async (userId: string) => {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + sessionMaxAgeSeconds * 1000);

  await getSql()`
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${userId}, ${hashToken(token)}, ${expiresAt.toISOString()})
  `;

  return token;
};

const setSessionCookie = (c: Context, token: string) => {
  setCookie(c, sessionCookieName, token, {
    httpOnly: true,
    maxAge: sessionMaxAgeSeconds,
    path: '/',
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
  });
};

export const getCurrentUser = async (token: string | undefined) => {
  if (!token) return null;

  await ensureAuthTables();

  const rows = (await getSql()`
    SELECT users.id, users.email, users.created_at
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ${hashToken(token)}
      AND sessions.expires_at > now()
    LIMIT 1
  `) as Array<{ id: string; email: string; created_at: string }>;

  return rows[0] ?? null;
};

const app = new Hono()
  .get('/me', async (c) => {
    try {
      const user = await getCurrentUser(getCookie(c, sessionCookieName));
      return c.json({ user, tokenAccount: user ? await getUserTokenAccount(user.id) : null });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not load session.';
      return c.json({ error: 'Could not load session.', message }, 500);
    }
  })
  .get('/token-account', async (c) => {
    const user = await getCurrentUser(getCookie(c, sessionCookieName));
    if (!user) return c.json({ error: 'Not authenticated.' }, 401);

    return c.json({ tokenAccount: await getUserTokenAccount(user.id) });
  })
  .get('/viewer-preferences', async (c) => {
    const user = await getCurrentUser(getCookie(c, sessionCookieName));
    if (!user) return c.json({ error: 'Not authenticated.' }, 401);

    return c.json({ preferences: await loadViewerPreferences(user.id) });
  })
  .put('/viewer-preferences', zValidator('json', viewerPreferencesSchema), async (c) => {
    const user = await getCurrentUser(getCookie(c, sessionCookieName));
    if (!user) return c.json({ error: 'Not authenticated.' }, 401);

    const preferences = c.req.valid('json');
    return c.json({ preferences: await saveViewerPreferences(user.id, preferences) });
  })
  .get('/uploaded-papers', async (c) => {
    const user = await getCurrentUser(getCookie(c, sessionCookieName));
    if (!user) return c.json({ error: 'Not authenticated.' }, 401);

    return c.json({ papers: await saveUploadedPapers(user.id, await loadUploadedPapers(user.id)) });
  })
  .post('/uploaded-papers', zValidator('json', uploadedPaperSchema), async (c) => {
    const user = await getCurrentUser(getCookie(c, sessionCookieName));
    if (!user) return c.json({ error: 'Not authenticated.' }, 401);

    return c.json({ papers: await saveUploadedPaper(user.id, c.req.valid('json')) }, 201);
  })
  .delete('/uploaded-papers', zValidator('json', removeUploadedPaperSchema), async (c) => {
    const user = await getCurrentUser(getCookie(c, sessionCookieName));
    if (!user) return c.json({ error: 'Not authenticated.' }, 401);

    return c.json({ papers: await removeUploadedPaper(user.id, c.req.valid('json').filePath) });
  })
  .post('/signup', zValidator('json', credentialsSchema), async (c) => {
    const { email, password } = c.req.valid('json');
    const normalizedEmail = email.toLowerCase();

    try {
      await ensureAuthTables();

      const passwordHash = await hashPassword(password);
      const rows = (await getSql()`
        INSERT INTO users (email, password_hash)
        VALUES (${normalizedEmail}, ${passwordHash})
        RETURNING id, email, created_at
      `) as Array<{ id: string; email: string; created_at: string }>;
      const token = await createSession(rows[0].id);
      setSessionCookie(c, token);

      return c.json({ user: rows[0], tokenAccount: await getUserTokenAccount(rows[0].id) }, 201);
    } catch (error) {
      if (error instanceof Error && error.message.includes('duplicate key')) {
        return c.json({ error: 'An account with this email already exists.' }, 409);
      }

      const message = error instanceof Error ? error.message : 'Signup failed.';
      return c.json({ error: 'Signup failed.', message }, 500);
    }
  })
  .post('/login', zValidator('json', credentialsSchema), async (c) => {
    const { email, password } = c.req.valid('json');
    const normalizedEmail = email.toLowerCase();

    try {
      await ensureAuthTables();

      const rows = (await getSql()`
        SELECT id, email, password_hash, created_at
        FROM users
        WHERE email = ${normalizedEmail}
        LIMIT 1
      `) as UserRow[];
      const user = rows[0];

      if (!user || !(await verifyPassword(password, user.password_hash))) {
        return c.json({ error: 'Invalid email or password.' }, 401);
      }

      const token = await createSession(user.id);
      setSessionCookie(c, token);

      return c.json({ user: { id: user.id, email: user.email, created_at: user.created_at }, tokenAccount: await getUserTokenAccount(user.id) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed.';
      return c.json({ error: 'Login failed.', message }, 500);
    }
  })
  .post('/logout', async (c) => {
    const token = getCookie(c, sessionCookieName);

    if (token) {
      try {
        await ensureAuthTables();
        await getSql()`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
      } catch {}
    }

    deleteCookie(c, sessionCookieName, { path: '/' });
    return c.json({ success: true });
  });

export default app;
