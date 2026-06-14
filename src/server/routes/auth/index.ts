import { randomBytes, scrypt as scryptCallback } from 'crypto';
import { promisify } from 'util';

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { ensureUserTable, getSql } from '@/server/db';

const scrypt = promisify(scryptCallback);

const signupSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
});

const hashPassword = async (password: string) => {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;

  return `scrypt:${salt}:${derivedKey.toString('hex')}`;
};

const app = new Hono().post('/signup', zValidator('json', signupSchema), async (c) => {
  const { email, password } = c.req.valid('json');
  const normalizedEmail = email.toLowerCase();

  try {
    await ensureUserTable();

    const passwordHash = await hashPassword(password);
    const rows = await getSql()`
      INSERT INTO users (email, password_hash)
      VALUES (${normalizedEmail}, ${passwordHash})
      RETURNING id, email, created_at
    `;

    return c.json({ user: rows[0] }, 201);
  } catch (error) {
    if (error instanceof Error && error.message.includes('duplicate key')) {
      return c.json({ error: 'An account with this email already exists.' }, 409);
    }

    const message = error instanceof Error ? error.message : 'Signup failed.';
    return c.json({ error: 'Signup failed.', message }, 500);
  }
});

export default app;
