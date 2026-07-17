// Task 6 — the chat-header LSP indicator. The editor client's lsp_event
// envelopes fold into an LspStatusSnapshot via the pure `statusFromEvent`, and
// `subscribeEditorLspStatus` fires the current snapshot on subscribe.

import { describe, it, expect } from 'vitest';
import {
  statusFromEvent,
  subscribeEditorLspStatus,
} from '../../../client/studio/agent/lsp/registry';
import type { LspEventEnvelope } from '../../../client/studio/agent/lsp/client';

function envelope(
  payload: LspEventEnvelope['payload']['payload'],
  type: LspEventEnvelope['payload']['type'] = 'updated',
): LspEventEnvelope {
  return { type: 'lsp_event', payload: { type, payload } };
}

describe('statusFromEvent', () => {
  it('maps a ready event with diagnostic totals', () => {
    const s = statusFromEvent(
      envelope({ state: 'ready', totalErrors: 2, totalWarnings: 1 }),
      1234,
    );
    expect(s).toEqual({
      state: 'ready',
      errors: 2,
      warnings: 1,
      lastUpdatedAt: 1234,
    });
  });

  it('carries a lastMessage on an error event and defaults missing totals to 0', () => {
    const s = statusFromEvent(
      envelope(
        { state: 'error', message: 'LSP exited with code 1' },
        'updated',
      ),
      99,
    );
    expect(s).toEqual({
      state: 'error',
      errors: 0,
      warnings: 0,
      lastUpdatedAt: 99,
      lastMessage: 'LSP exited with code 1',
    });
  });
});

describe('subscribeEditorLspStatus', () => {
  it('emits the current snapshot immediately and unsubscribes cleanly', () => {
    const seen: string[] = [];
    const unsub = subscribeEditorLspStatus((s) => seen.push(s.state));
    // idle by default (no editor client spawned in this test)
    expect(seen).toEqual(['idle']);
    unsub();
  });
});
