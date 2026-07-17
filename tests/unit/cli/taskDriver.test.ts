import { describe, it, expect, vi } from 'vitest';

const { runClientAgentTurn, setSessionStore } = vi.hoisted(() => ({
  runClientAgentTurn: vi.fn(
    async (_s: string, _t: string, emit: (m: unknown) => void) => {
      emit({ type: 'x' });
    },
  ),
  setSessionStore: vi.fn(),
}));
vi.mock('../../../client/studio/agent/clientAgent', () => ({
  runClientAgentTurn,
}));
vi.mock('../../../client/studio/projectPath', () => ({
  setActiveProjectPath: vi.fn(),
}));
const { permsRequest } = vi.hoisted(() => ({
  permsRequest: vi.fn(async () => ({})),
}));
vi.mock('ugly-app/native', () => ({
  createNodeUglyNative: () => ({}),
  permissions: { request: permsRequest },
  native: { fs: {} },
}));
vi.mock('../../../client/studio/agent/sessionStore', () => ({
  setSessionStore,
}));
vi.mock('../../../client/studio/agent/fsSessionStore', () => ({
  makeFsSessionStore: () => ({ tag: 'fs' }),
}));

import { bootDriver, runTurn } from '../../../client/cli/taskDriver';

describe('taskDriver', () => {
  it('installs the fs store on boot and forwards turn messages', async () => {
    await bootDriver({
      projectPath: '/p',
      sessionId: 's',
      origin: 'https://x',
      token: 'T',
      storeRoot: '/root',
    });
    expect(setSessionStore).toHaveBeenCalledWith({ tag: 'fs' });
    expect(permsRequest.mock.calls[0][0]).toMatchObject({
      fs: 'full',
      process: 'full',
    });
    const msgs: unknown[] = [];
    await runTurn('s', 'hi', (m) => msgs.push(m));
    expect(runClientAgentTurn).toHaveBeenCalledWith(
      's',
      'hi',
      expect.any(Function),
      undefined,
    );
    expect(msgs).toEqual([{ type: 'x' }]);
  });

  it('fetch shim absolutizes /api paths against the origin with the auth cookie', async () => {
    const realFetch = vi.fn(async () => new Response('{}'));
    (globalThis as { fetch: typeof fetch }).fetch =
      realFetch as unknown as typeof fetch;
    await bootDriver({
      projectPath: '/p',
      sessionId: 's',
      origin: 'https://api.example',
      token: 'TOK',
      storeRoot: '/root',
    });
    await globalThis.fetch('/api/agentStep', { method: 'POST' });
    const [url, init] = realFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example/api/agentStep');
    expect(new Headers(init.headers).get('Cookie')).toContain('auth_token=');
  });
});
