import type { query as pgQuery } from 'ugly-app/server';

// Schema migration: create collection "codingInteraction" (doc-driven interactive control —
// ask_user/step_review questions + stop/tool_stop commands bridged to the host).

export async function up(query: typeof pgQuery): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS "codingInteraction" (
    _id      TEXT PRIMARY KEY,
    data     JSONB NOT NULL,
    created  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated  TIMESTAMPTZ NOT NULL DEFAULT now(),
    version  INTEGER NOT NULL DEFAULT 1
  )`);
  await query(`CREATE INDEX IF NOT EXISTS "idx_codingInteraction_data" ON "codingInteraction" USING GIN (data)`);
  await query(`CREATE INDEX IF NOT EXISTS "idx_codingInteraction_userId_sessionId_status" ON "codingInteraction" ((data->>'userId'), (data->>'sessionId'), (data->>'status'))`);
}
