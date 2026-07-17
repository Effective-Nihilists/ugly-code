import { describe, expect, it } from 'vitest';
import { frameworkRequests } from 'ugly-app/shared';
import { requests } from '../../shared/api';

describe('API requests', () => {
  it('defines the expected app request keys', () => {
    expect(Object.keys(requests)).toEqual(
      expect.arrayContaining([
        'createTodo',
        'toggleTodo',
        'deleteTodo',
        'recordRecentProject',
        'removeRecentProject',
      ]),
    );
  });

  it('recordRecentProject requires a deviceId and path to stamp the host', () => {
    const schema = requests.recordRecentProject.inputSchema!;
    expect(
      schema.safeParse({
        deviceId: 'd1',
        deviceLabel: 'Mac',
        path: '/p',
        name: 'p',
      }).success,
    ).toBe(true);
    // deviceId is what lets a phone reconnect to the right desktop — it's required.
    expect(schema.safeParse({ deviceId: '', path: '/p' }).success).toBe(false);
    expect(schema.safeParse({ path: '/p' }).success).toBe(false);
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
    const result = schema.safeParse({
      eventName: 'CTA_CLICK',
      sessionId: 'abc123',
    });
    expect(result.success).toBe(true);
  });
});
