import { describe, it, expect, vi } from 'vitest';

vi.mock('ugly-app/native', () => ({ native: { fs: {} } }));

import {
  setSessionStore,
  getSessionStore,
  type SessionStore,
} from '../../../client/studio/agent/sessionStore';
import { sessionApi } from '../../../client/studio/agent/serverSessionApi';

describe('sessionApi delegates to the active store', () => {
  it('routes appendMessage to the injected store', async () => {
    const appendMessage = vi.fn(async () => ({ ok: true }));
    const fake = { appendMessage } as unknown as SessionStore;
    const prev = getSessionStore();
    setSessionStore(fake);
    await sessionApi.appendMessage({
      sessionId: 's',
      seq: 0,
      role: 'user',
      content: '"hi"',
    });
    expect(appendMessage).toHaveBeenCalledWith({
      sessionId: 's',
      seq: 0,
      role: 'user',
      content: '"hi"',
    });
    setSessionStore(prev);
  });
});
