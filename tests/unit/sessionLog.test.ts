import { beforeEach, describe, expect, it } from 'vitest';
import { SessionLog, type SessionLogEntry } from '../../client/studio/agent/sessionLog';
import { mockCalls, mockFiles, resetMock } from '../helpers/uglyNativeMock';

// SessionLog is the COMPLETE, uncompacted on-disk audit trail (the artifact used
// to analyze a reported issue + the canonical resume record). It writes through
// the real `native.fs` facade, so these tests run it against the in-memory
// UglyNative mock — the same protocol production uses.

/** Let the fire-and-forget `void flush()` settle (mkdir + writeFile resolve). */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

const entry = (type: SessionLogEntry['type'], extra: Record<string, unknown> = {}): SessionLogEntry => ({
  ts: 1,
  type,
  ...extra,
});

describe('SessionLog', () => {
  beforeEach(() => resetMock());

  it('writes the JSONL under <project>/.ugly-studio/sessions and reports its path', async () => {
    const log = new SessionLog('sess-1', '/proj');
    expect(log.path()).toBe('/proj/.ugly-studio/sessions/sess-1.jsonl');

    log.append(entry('session_start', { model: 'claude_sonnet_4_6' }));
    await settle();

    const written = mockFiles().get('/proj/.ugly-studio/sessions/sess-1.jsonl');
    expect(written).toBeDefined();
    expect(JSON.parse(written!.trim())).toMatchObject({ type: 'session_start', model: 'claude_sonnet_4_6' });
  });

  it('rewrites the FULL log on every append (native.fs has no append)', async () => {
    const log = new SessionLog('s', '/proj');
    log.append(entry('user', { text: 'hi' }));
    log.append(entry('assistant', { content: [] }));
    log.append(entry('finish', { reason: 'done' }));
    await settle();

    const file = mockFiles().get('/proj/.ugly-studio/sessions/s.jsonl')!;
    const lines = file.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(['user', 'assistant', 'finish']);
    expect(file.endsWith('\n')).toBe(true);
  });

  it('creates the sessions dir exactly once (ensured guard), not per append', async () => {
    const log = new SessionLog('s', '/proj');
    log.append(entry('user', { text: 'a' }));
    await settle();
    log.append(entry('user', { text: 'b' }));
    await settle();

    const mkdirs = mockCalls().filter((c) => c.channel === 'fs.mkdir');
    expect(mkdirs).toHaveLength(1);
    expect(mkdirs[0]!.payload).toMatchObject({ path: '/proj/.ugly-studio/sessions' });
  });

  it('sanitizes composite/unsafe sessionIds into a safe filename', () => {
    const log = new SessionLog('proj:abc/def\\ghi', '/proj');
    expect(log.path()).toBe('/proj/.ugly-studio/sessions/proj_abc_def_ghi.jsonl');
  });

  it('is a silent no-op (no FS writes, null path) when there is no project path', async () => {
    const log = new SessionLog('s', null);
    expect(log.path()).toBeNull();
    log.append(entry('user', { text: 'hi' }));
    await settle();
    expect(mockCalls().filter((c) => c.channel === 'fs.writeFile')).toHaveLength(0);
    expect(mockCalls().filter((c) => c.channel === 'fs.mkdir')).toHaveLength(0);
  });
});
