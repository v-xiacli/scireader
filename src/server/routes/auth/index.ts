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

const signupSchema = credentialsSchema.extend({
  verificationCode: z.string().trim().regex(/^\d{6}$/),
});

const emailVerificationRequestSchema = z.object({
  email: z.string().trim().email().max(254),
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

const stockWatchlistItemSchema = z.object({
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().min(1).max(24),
  market: z.enum(['A', 'US', 'HK', 'FX']).optional(),
});

const stockWatchlistSchema = z.array(stockWatchlistItemSchema).max(80);

const defaultStockWatchlist: z.infer<typeof stockWatchlistSchema> = [
  { name: '北方华创', code: '002371', market: 'A' },
  { name: '茂莱光学', code: '688502', market: 'A' },
  { name: '南大光电', code: '300346', market: 'A' },
  { name: '中国海油', code: '600938', market: 'A' },
  { name: '招商轮船', code: '601872', market: 'A' },
];

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

const getVerificationCodeHash = (email: string, code: string, purpose = 'signup') => hashToken(`${purpose}:${email}:${code}`);
const createVerificationCode = () => String(100000 + (randomBytes(4).readUInt32BE(0) % 900000));
const verificationCodeMaxAgeSeconds = 10 * 60;
const verificationCodeMaxAttempts = 5;

const sendVerificationEmail = async (email: string, code: string) => {
  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  const configuredFrom = process.env.EMAIL_FROM?.trim() || process.env.RESEND_FROM_EMAIL?.trim();
  const from = configuredFrom || 'SCIReader <onboarding@resend.dev>';

  if (!resendApiKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Email service is not configured.');
    }

    console.warn('[auth:email-verification] RESEND_API_KEY not configured; development verification code', { email, code });
    return;
  }

  if (!configuredFrom && process.env.NODE_ENV === 'production') {
    throw new Error('Email sender is not configured.');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: 'SCIReader verification code',
      text: `Your SCIReader verification code is ${code}. It expires in 10 minutes.`,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Could not send verification email: ${response.status} ${body}`.trim());
  }
};

const verifySignupCode = async (email: string, code: string) => {
  const rows = (await getSql()`
    SELECT id, code_hash, attempts
    FROM email_verification_codes
    WHERE email = ${email}
      AND purpose = 'signup'
      AND consumed_at IS NULL
      AND expires_at > now()
    ORDER BY created_at DESC
    LIMIT 1
  `) as Array<{ id: string; code_hash: string; attempts: number }>;
  const latest = rows[0];

  if (!latest) throw new Error('Verification code is missing or expired.');
  if (Number(latest.attempts) >= verificationCodeMaxAttempts) throw new Error('Too many verification attempts. Please request a new code.');

  const expected = Buffer.from(latest.code_hash, 'hex');
  const received = Buffer.from(getVerificationCodeHash(email, code), 'hex');
  const matched = expected.length === received.length && timingSafeEqual(expected, received);

  if (!matched) {
    await getSql()`
      UPDATE email_verification_codes
      SET attempts = attempts + 1
      WHERE id = ${latest.id}
    `;
    throw new Error('Invalid verification code.');
  }

  await getSql()`
    UPDATE email_verification_codes
    SET consumed_at = now()
    WHERE id = ${latest.id}
  `;
};

const getPreferencePath = (userId: string) => `user-preferences/${userId}.md`;
const getUploadedPapersPath = (userId: string) => `user-papers/${userId}.md`;
const getStockWatchlistPath = (userId: string) => `user-watchlists/${userId}.stocks.md`;

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

const loadStockWatchlist = async (userId: string) => {
  try {
    return stockWatchlistSchema.parse(parseJsonBlock(await downloadTextAsAdmin(getStockWatchlistPath(userId))) ?? defaultStockWatchlist);
  } catch {
    return defaultStockWatchlist;
  }
};

const saveStockWatchlist = async (userId: string, watchlist: z.infer<typeof stockWatchlistSchema>) => {
  const normalized = watchlist.map((item) => ({
    name: item.name.trim(),
    code: item.code.trim().toUpperCase(),
    market: item.market,
  }));

  await uploadTextAsAdmin(
    `# Stock watchlist\n\n\`\`\`json\n${JSON.stringify(normalized, null, 2)}\n\`\`\`\n`,
    getStockWatchlistPath(userId),
  );

  return normalized;
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
  .get('/stock-watchlist', async (c) => {
    const user = await getCurrentUser(getCookie(c, sessionCookieName));
    if (!user) return c.json({ error: 'Not authenticated.' }, 401);

    return c.json({ watchlist: await loadStockWatchlist(user.id) });
  })
  .put('/stock-watchlist', zValidator('json', z.object({ watchlist: stockWatchlistSchema })), async (c) => {
    const user = await getCurrentUser(getCookie(c, sessionCookieName));
    if (!user) return c.json({ error: 'Not authenticated.' }, 401);

    return c.json({ watchlist: await saveStockWatchlist(user.id, c.req.valid('json').watchlist) });
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
  .post('/send-verification-code', zValidator('json', emailVerificationRequestSchema), async (c) => {
    const { email } = c.req.valid('json');
    const normalizedEmail = email.toLowerCase();
    let verificationCodeId: string | null = null;

    try {
      await ensureAuthTables();

      const existingUsers = (await getSql()`
        SELECT id
        FROM users
        WHERE email = ${normalizedEmail}
        LIMIT 1
      `) as Array<{ id: string }>;

      if (existingUsers[0]) {
        return c.json({ error: 'An account with this email already exists.' }, 409);
      }

      const recentCodes = (await getSql()`
        SELECT COUNT(*)::int AS count
        FROM email_verification_codes
        WHERE email = ${normalizedEmail}
          AND purpose = 'signup'
          AND created_at > now() - INTERVAL '60 seconds'
      `) as Array<{ count: number }>;

      if (Number(recentCodes[0]?.count ?? 0) > 0) {
        return c.json({ error: 'Please wait before requesting another verification code.' }, 429);
      }

      const code = createVerificationCode();
      const expiresAt = new Date(Date.now() + verificationCodeMaxAgeSeconds * 1000);

      const insertedCodes = (await getSql()`
        INSERT INTO email_verification_codes (email, purpose, code_hash, expires_at)
        VALUES (${normalizedEmail}, 'signup', ${getVerificationCodeHash(normalizedEmail, code)}, ${expiresAt.toISOString()})
        RETURNING id
      `) as Array<{ id: string }>;
      verificationCodeId = insertedCodes[0]?.id ?? null;

      await sendVerificationEmail(normalizedEmail, code);

      return c.json({ sent: true, expiresInSeconds: verificationCodeMaxAgeSeconds });
    } catch (error) {
      if (verificationCodeId) {
        await getSql()`
          DELETE FROM email_verification_codes
          WHERE id = ${verificationCodeId}
        `;
      }

      const message = error instanceof Error ? error.message : 'Could not send verification code.';
      console.error('[auth:email-verification] send failed', { email: normalizedEmail, message });
      return c.json({ error: 'Could not send verification code.', message }, 500);
    }
  })
  .post('/signup', zValidator('json', signupSchema), async (c) => {
    const { email, password, verificationCode } = c.req.valid('json');
    const normalizedEmail = email.toLowerCase();

    try {
      await ensureAuthTables();
      await verifySignupCode(normalizedEmail, verificationCode);

      const passwordHash = await hashPassword(password);
      const rows = (await getSql()`
        INSERT INTO users (email, password_hash, email_verified)
        VALUES (${normalizedEmail}, ${passwordHash}, true)
        RETURNING id, email, created_at
      `) as Array<{ id: string; email: string; created_at: string }>;
      const token = await createSession(rows[0].id);
      setSessionCookie(c, token);

      return c.json({ user: rows[0], tokenAccount: await getUserTokenAccount(rows[0].id) }, 201);
    } catch (error) {
      if (error instanceof Error && error.message.includes('duplicate key')) {
        return c.json({ error: 'An account with this email already exists.' }, 409);
      }

      if (
        error instanceof Error &&
        ['Verification code is missing or expired.', 'Too many verification attempts. Please request a new code.', 'Invalid verification code.'].includes(error.message)
      ) {
        return c.json({ error: error.message }, 400);
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
