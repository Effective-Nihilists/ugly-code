import type { query as pgQuery } from 'ugly-app/server';

// Schema migration: create collection "authMagicLink"

export async function up(query: typeof pgQuery): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS "authMagicLink" (
    _id      TEXT PRIMARY KEY,
    data     JSONB NOT NULL,
    created  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated  TIMESTAMPTZ NOT NULL DEFAULT now(),
    version  INTEGER NOT NULL DEFAULT 1
  )`);
  await query(`CREATE INDEX IF NOT EXISTS "idx_authMagicLink_data" ON "authMagicLink" USING GIN (data)`);
  await query(`CREATE INDEX IF NOT EXISTS "idx_authMagicLink_expiresAt" ON "authMagicLink" ((data->>'expiresAt'))`);
}
