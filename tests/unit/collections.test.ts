import { describe, expect, it } from 'vitest';
import { TodoSchema, ConversationSchema, MessageSchema, RecentProjectSchema, collections } from '../../shared/collections';

describe('Collection schemas', () => {
  it('TodoSchema validates a valid todo', () => {
    const result = TodoSchema.safeParse({
      userId: 'user-1',
      text: 'Buy groceries',
      done: false,
    });
    expect(result.success).toBe(true);
  });

  it('TodoSchema rejects a todo with missing fields', () => {
    const result = TodoSchema.safeParse({ userId: 'user-1' });
    expect(result.success).toBe(false);
  });

  it('all collections have a schema and meta defined', () => {
    for (const [name, col] of Object.entries(collections)) {
      expect(col.schema, `${name} should have a schema`).toBeDefined();
      expect(col.meta, `${name} should have meta`).toBeDefined();
    }
  });

  it('RecentProjectSchema validates a stamped recent project', () => {
    const result = RecentProjectSchema.safeParse({
      userId: 'user-1',
      deviceId: 'device-abc',
      deviceLabel: 'MacBook Pro',
      path: '/Users/me/projects/foo',
      name: 'foo',
      lastOpened: 1_700_000_000_000,
    });
    expect(result.success).toBe(true);
  });

  it('recentProject collection syncs per-user via trackKeys', () => {
    // trackable + trackKeys:['userId'] is what makes the list live-sync across
    // every device/session of the same user (dbkey.recentProject.userId.<id>).
    expect(collections.recentProject.meta.trackable).toBe(true);
    expect(collections.recentProject.meta.trackKeys).toEqual(['userId']);
  });
});
