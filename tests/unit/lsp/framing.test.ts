// Task 2 — JSON-RPC Content-Length framing over the native.process stdout
// stream. `native.process.onStdout` delivers DECODED STRINGS (not Buffers), so
// the client accumulates a string and splits it with the pure `parseMessages`
// helper. These tests exercise that helper without a real language server.

import { describe, it, expect } from 'vitest';
import { parseMessages } from '../../../client/studio/agent/lsp/client';

/** Frame a value the way an LSP peer does: byte-accurate Content-Length header
 *  + CRLFCRLF + JSON body. */
function frame(obj: unknown): string {
  const body = JSON.stringify(obj);
  const len = new TextEncoder().encode(body).length;
  return `Content-Length: ${len}\r\n\r\n${body}`;
}

describe('parseMessages (LSP Content-Length framing)', () => {
  it('parses two concatenated messages delivered in one chunk', () => {
    const a = { jsonrpc: '2.0', id: 1, result: { ok: true } };
    const b = {
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: 'file:///x.ts', diagnostics: [] },
    };
    const { messages, rest } = parseMessages(frame(a) + frame(b));
    expect(messages).toHaveLength(2);
    expect(JSON.parse(messages[0])).toEqual(a);
    expect(JSON.parse(messages[1])).toEqual(b);
    expect(rest).toBe('');
  });

  it('keeps an incomplete trailing message in `rest` for the next chunk', () => {
    const a = { jsonrpc: '2.0', id: 1, result: 1 };
    const partial = frame({ jsonrpc: '2.0', id: 2, result: 2 });
    const truncated = partial.slice(0, partial.length - 5);
    const { messages, rest } = parseMessages(frame(a) + truncated);
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0])).toEqual(a);
    expect(rest).toBe(truncated);
  });

  it('returns the whole buffer as `rest` when the header is not yet complete', () => {
    const { messages, rest } = parseMessages('Content-Length: 10\r\n');
    expect(messages).toHaveLength(0);
    expect(rest).toBe('Content-Length: 10\r\n');
  });

  it('skips a framed message with a malformed (Content-Length-less) header', () => {
    const good = { jsonrpc: '2.0', id: 7, result: 'ok' };
    const buffer = `X-Nonsense: 1\r\n\r\n${frame(good)}`;
    const { messages, rest } = parseMessages(buffer);
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0])).toEqual(good);
    expect(rest).toBe('');
  });
});
