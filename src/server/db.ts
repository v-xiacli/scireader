import { neon } from '@neondatabase/serverless';

let client: ReturnType<typeof neon> | null = null;
let initialized = false;

export const getSql = () => {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not configured.');
  }

  client ??= neon(databaseUrl);
  return client;
};

export const ensureAuthTables = async () => {
  if (initialized) return;

  await getSql()`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await getSql()`
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await getSql()`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_balance BIGINT NOT NULL DEFAULT 1000000`;
  await getSql()`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_used BIGINT NOT NULL DEFAULT 0`;

  await getSql()`
    CREATE TABLE IF NOT EXISTS token_usage_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      paper_id TEXT,
      action TEXT NOT NULL,
      model TEXT,
      input_tokens BIGINT NOT NULL DEFAULT 0,
      output_tokens BIGINT NOT NULL DEFAULT 0,
      billable_tokens BIGINT NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  initialized = true;
};

export const getUserTokenAccount = async (userId: string) => {
  await ensureAuthTables();

  const rows = (await getSql()`
    SELECT token_balance, token_used
    FROM users
    WHERE id = ${userId}
    LIMIT 1
  `) as Array<{ token_balance: string | number; token_used: string | number }>;
  const row = rows[0];
  const balance = Number(row?.token_balance ?? 1_000_000);
  const used = Number(row?.token_used ?? 0);

  return {
    tokenBalance: balance,
    tokenUsed: used,
    tokenAvailable: Math.max(balance - used, 0),
  };
};

export const recordUserTokenUsage = async (event: {
  userId: string;
  paperId?: string;
  action: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  billableTokens: number;
  metadata?: Record<string, unknown>;
}) => {
  await ensureAuthTables();

  const metadata = JSON.stringify(event.metadata ?? {});

  await getSql()`
    INSERT INTO token_usage_events (
      user_id,
      paper_id,
      action,
      model,
      input_tokens,
      output_tokens,
      billable_tokens,
      metadata
    )
    VALUES (
      ${event.userId},
      ${event.paperId ?? null},
      ${event.action},
      ${event.model ?? null},
      ${Math.max(0, Math.ceil(event.inputTokens))},
      ${Math.max(0, Math.ceil(event.outputTokens))},
      ${Math.max(0, Math.ceil(event.billableTokens))},
      ${metadata}::jsonb
    )
  `;

  await getSql()`
    UPDATE users
    SET token_used = token_used + ${Math.max(0, Math.ceil(event.billableTokens))},
        updated_at = now()
    WHERE id = ${event.userId}
  `;

  return getUserTokenAccount(event.userId);
};
