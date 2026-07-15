import type { query as pgQuery } from 'ugly-app/server';

// Schema migration: conversation
// Detected changes (ugly-app 0.1.855 template upgrade):
//   - BREAKING: field-added "type" (required string)
//   - BREAKING: field-removed "userPrivateId" (was required string)
//   - BREAKING: index-removed "index(userPrivateId)"
//
// `conversation` is a legacy chat collection; the coding agent uses
// codingSession/codingSessionMessage instead. The local dev DB has no real
// conversation rows (first-run baseline), so the required-field default is a
// benign placeholder and the removals are confirmed. No production migration is
// implied — re-author against live data before deploying.

export async function up(query: typeof pgQuery): Promise<void> {
  // Field "type" added (required string). No existing rows carry it; backfill a
  // benign default so any pre-existing row satisfies the NOT-NULL schema.
  await query(
    `UPDATE "conversation" SET data = jsonb_set(data, '{type}', $1) WHERE data->>'type' IS NULL`,
    [JSON.stringify('chat')],
  );

  // Field "userPrivateId" removed — intentional (replaced by the owner scoping
  // the new schema brings). Drop it from any legacy row.
  await query(`UPDATE "conversation" SET data = data - 'userPrivateId'`);

  // Index removed: index on userPrivateId. The column is gone; drop the index.
  await query('DROP INDEX IF EXISTS "idx_conversation_index(userPrivateId)"');
}
