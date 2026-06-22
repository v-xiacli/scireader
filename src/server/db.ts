import { neon } from '@neondatabase/serverless';

let client: ReturnType<typeof neon> | null = null;
let initialized = false;

export const DEFAULT_TOKEN_BALANCE = 10_000;

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

  await getSql()`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_balance BIGINT NOT NULL DEFAULT 10000`;
  await getSql()`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_used BIGINT NOT NULL DEFAULT 0`;
  await getSql()`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false`;
  await getSql()`ALTER TABLE users ADD COLUMN IF NOT EXISTS financial_analysis_enabled BOOLEAN NOT NULL DEFAULT false`;
  await getSql()`ALTER TABLE users ALTER COLUMN token_balance SET DEFAULT 10000`;
  await getSql()`
    UPDATE users
    SET token_balance = 10000,
        updated_at = now()
    WHERE token_balance = 1000000
  `;

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

  await getSql()`
    CREATE TABLE IF NOT EXISTS email_verification_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'signup',
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await getSql()`CREATE INDEX IF NOT EXISTS email_verification_codes_email_idx ON email_verification_codes (email, purpose, created_at DESC)`;

  await getSql()`
    CREATE TABLE IF NOT EXISTS financial_analysis_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stock_name TEXT NOT NULL,
      stock_code TEXT NOT NULL,
      stock_market TEXT,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      model TEXT,
      input_tokens BIGINT NOT NULL DEFAULT 0,
      output_tokens BIGINT NOT NULL DEFAULT 0,
      base_billable_tokens BIGINT NOT NULL DEFAULT 0,
      billable_tokens BIGINT NOT NULL DEFAULT 0,
      billing_multiplier NUMERIC NOT NULL DEFAULT 3,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await getSql()`CREATE INDEX IF NOT EXISTS financial_analysis_reports_user_created_idx ON financial_analysis_reports (user_id, created_at DESC)`;

  initialized = true;
};

export const getUserFinancialAnalysisAccess = async (userId: string) => {
  await ensureAuthTables();

  const rows = (await getSql()`
    SELECT financial_analysis_enabled
    FROM users
    WHERE id = ${userId}
    LIMIT 1
  `) as Array<{ financial_analysis_enabled: boolean }>;

  return Boolean(rows[0]?.financial_analysis_enabled);
};

export const enableUserFinancialAnalysis = async (userId: string) => {
  await ensureAuthTables();

  await getSql()`
    UPDATE users
    SET financial_analysis_enabled = true,
        updated_at = now()
    WHERE id = ${userId}
  `;

  return getUserFinancialAnalysisAccess(userId);
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
  const balance = Number(row?.token_balance ?? DEFAULT_TOKEN_BALANCE);
  const used = Number(row?.token_used ?? 0);

  return {
    tokenBalance: balance,
    tokenUsed: used,
    tokenAvailable: balance - used,
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

export const recordFinancialAnalysisReport = async (report: {
  userId: string;
  stockName: string;
  stockCode: string;
  stockMarket?: string;
  question: string;
  answer: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  baseBillableTokens: number;
  billableTokens: number;
  billingMultiplier: number;
}) => {
  await ensureAuthTables();

  const rows = (await getSql()`
    INSERT INTO financial_analysis_reports (
      user_id,
      stock_name,
      stock_code,
      stock_market,
      question,
      answer,
      model,
      input_tokens,
      output_tokens,
      base_billable_tokens,
      billable_tokens,
      billing_multiplier
    )
    VALUES (
      ${report.userId},
      ${report.stockName},
      ${report.stockCode},
      ${report.stockMarket ?? null},
      ${report.question},
      ${report.answer},
      ${report.model ?? null},
      ${Math.max(0, Math.ceil(report.inputTokens))},
      ${Math.max(0, Math.ceil(report.outputTokens))},
      ${Math.max(0, Math.ceil(report.baseBillableTokens))},
      ${Math.max(0, Math.ceil(report.billableTokens))},
      ${report.billingMultiplier}
    )
    RETURNING id, created_at
  `) as Array<{ id: string; created_at: string }>;

  return rows[0] ?? null;
};

export const listFinancialAnalysisReports = async (userId: string, limit = 50) => {
  await ensureAuthTables();

  return (await getSql()`
    SELECT
      id,
      stock_name,
      stock_code,
      stock_market,
      question,
      answer,
      model,
      input_tokens,
      output_tokens,
      base_billable_tokens,
      billable_tokens,
      billing_multiplier,
      created_at
    FROM financial_analysis_reports
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT ${Math.max(1, Math.min(100, Math.floor(limit)))}
  `) as Array<{
    id: string;
    stock_name: string;
    stock_code: string;
    stock_market: string | null;
    question: string;
    answer: string;
    model: string | null;
    input_tokens: string | number;
    output_tokens: string | number;
    base_billable_tokens: string | number;
    billable_tokens: string | number;
    billing_multiplier: string | number;
    created_at: string;
  }>;
};
