import { describe, expect, it } from 'vitest';
import { frameworkRequests } from 'ugly-app/shared';
import { requests } from '../../shared/api';

describe('API requests', () => {
  it('defines the expected app request keys', () => {
    expect(Object.keys(requests)).toEqual(
      expect.arrayContaining(['createTodo', 'toggleTodo', 'deleteTodo']),
    );
  });

  it('framework defines expected request keys', () => {
    expect(Object.keys(frameworkRequests)).toEqual(
      expect.arrayContaining(['userGet', 'initSession', 'captureEvent']),
    );
  });

  it('initSession accepts a sessionId', () => {
    const schema = frameworkRequests.initSession.inputSchema!;
    const result = schema.safeParse({ sessionId: 'abc123' });
    expect(result.success).toBe(true);
  });

  it('captureEvent accepts a valid event', () => {
    const schema = frameworkRequests.captureEvent.inputSchema!;
    const result = schema.safeParse({ eventName: 'CTA_CLICK', sessionId: 'abc123' });
    expect(result.success).toBe(true);
  });
});
