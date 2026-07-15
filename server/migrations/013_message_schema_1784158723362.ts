import type { query as pgQuery } from 'ugly-app/server';

// Schema migration: message
// Detected changes (ugly-app 0.1.855 template upgrade):
//   - BREAKING: field-removed "role", "toolCalls", "userPrivateId"
//   - BREAKING: field-added "userId" (required string)
//   - BREAKING: index-removed "index(conversationId, userPrivateId, role)"
//
// `message` is a legacy chat collection; the coding agent uses
// codingSessionMessage instead. The local dev DB has no real message rows
// (first-run baseline), so the required-field default is a benign placeholder
// and the removals are confirmed. Re-author against live data before deploying.

export async function up(query: typeof pgQuery): Promise<void> {
  // Removed fields — drop from any legacy row (intentional; the new schema
  // scopes ownership via userId and carries content directly).
  await query(`UPDATE "message" SET data = data - 'role'`);
  await query(`UPDATE "message" SET data = data - 'toolCalls'`);
  await query(`UPDATE "message" SET data = data - 'userPrivateId'`);

  // Field "userId" added (required string). No existing rows carry it; backfill
  // a benign default so any pre-existing row satisfies the NOT-NULL schema.
  await query(
    `UPDATE "message" SET data = jsonb_set(data, '{userId}', $1) WHERE data->>'userId' IS NULL`,
    [JSON.stringify('__migrated__')],
  );

  // Index removed: index on (conversationId, userPrivateId, role). The columns
  // are gone; drop the index.
  await query(
    'DROP INDEX IF EXISTS "idx_message_index(conversationId, userPrivateId, role)"',
  );
}
