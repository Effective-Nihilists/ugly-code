import { describe, expect, it } from 'vitest';
import { TodoSchema, ConversationSchema, MessageSchema, collections } from '../../shared/collections';

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
});
