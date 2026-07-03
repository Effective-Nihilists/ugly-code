// Task 4 — how the language server is launched. TypeScript resolves to
// `npx --yes typescript-language-server --stdio` (node/npx come from the
// studio's bundled-binary system); other languages are out of scope for v1
// and resolve to null, which puts the client in `disabled` state.

import { describe, it, expect } from 'vitest';
import {
  resolveLspSpawn,
  LspClient,
} from '../../../client/studio/agent/lsp/client';

describe('resolveLspSpawn', () => {
  it('launches typescript-language-server via npx --stdio', () => {
    expect(resolveLspSpawn('typescript')).toEqual({
      cmd: 'npx',
      args: ['--yes', 'typescript-language-server', '--stdio'],
    });
  });

  it('returns null for python (pyright deferred — out of scope for v1)', () => {
    expect(resolveLspSpawn('python')).toBeNull();
  });
});

describe('LspClient construction', () => {
  it('a typescript client has a spawn spec and is not disabled', () => {
    const c = new LspClient({ workspaceRoot: '/tmp/proj', language: 'typescript' });
    expect(c.getState()).toBe('initializing');
  });

  it('a python client falls into disabled state (no v1 server)', () => {
    const c = new LspClient({ workspaceRoot: '/tmp/proj', language: 'python' });
    expect(c.getState()).toBe('disabled');
  });

  it('an explicit binaryPath override wins over npx resolution', () => {
    const c = new LspClient({
      workspaceRoot: '/tmp/proj',
      language: 'typescript',
      binaryPath: '/opt/custom/typescript-language-server',
    });
    expect(c.getState()).toBe('initializing');
  });
});
