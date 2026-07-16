import type { query as pgQuery } from 'ugly-app/server';

// Schema migration: create collection "codingRunRequest"

export async function up(query: typeof pgQuery): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS "codingRunRequest" (
    _id      TEXT PRIMARY KEY,
    data     JSONB NOT NULL,
    created  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated  TIMESTAMPTZ NOT NULL DEFAULT now(),
    version  INTEGER NOT NULL DEFAULT 1
  )`);
  await query(`CREATE INDEX IF NOT EXISTS "idx_codingRunRequest_data" ON "codingRunRequest" USING GIN (data)`);
  await query(`CREATE INDEX IF NOT EXISTS "idx_codingRunRequest_userId_status" ON "codingRunRequest" ((data->>'userId'), (data->>'status'))`);
}
