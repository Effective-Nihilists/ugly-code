import type { query as pgQuery } from 'ugly-app/server';

// Schema migration: create collection "userSettings"
// (per-user coding-agent settings; one row per user, _id = userId).
// Hand-authored to match the schema-gen output for the userSettings collection
// added in shared/collections.ts — `db:schema-gen` reconciles it in dev.

export async function up(query: typeof pgQuery): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS "userSettings" (
    _id      TEXT PRIMARY KEY,
    data     JSONB NOT NULL,
    created  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated  TIMESTAMPTZ NOT NULL DEFAULT now(),
    version  INTEGER NOT NULL DEFAULT 1
  )`);
  await query(`CREATE INDEX IF NOT EXISTS "idx_userSettings_data" ON "userSettings" USING GIN (data)`);
}
