import { describe, it, expect, vi } from 'vitest';

const files = new Map<string, string>();
vi.mock('ugly-app/native', () => ({
  native: {
    fs: {
      mkdir: () => Promise.resolve(),
      writeFile: (p: string, s: string) => {
        files.set(p, s);
        return Promise.resolve();
      },
      readFile: (p: string) =>
        files.has(p)
          ? Promise.resolve(files.get(p)!)
          : Promise.reject(new Error('ENOENT')),
    },
  },
}));

import { makeFsSessionStore } from '../../../client/studio/agent/fsSessionStore';

describe('fsSessionStore', () => {
  it('appends rows and lists them in seq order (excluding compacted by default)', async () => {
    files.clear();
    const store = makeFsSessionStore('/root');
    await store.appendMessage({
      sessionId: 's1',
      seq: 0,
      role: 'user',
      content: '"hi"',
    });
    await store.appendMessage({
      sessionId: 's1',
      seq: 1,
      role: 'assistant',
      content: '{"content":[]}',
    });
    const listed = await store.listMessages({ sessionId: 's1' });
    expect(listed?.messages.map((m) => m.seq)).toEqual([0, 1]);
    expect(files.has('/root/s1/messages.jsonl')).toBe(true);
  });

  it('compact marks dropped rows and appends a summary row', async () => {
    files.clear();
    const store = makeFsSessionStore('/root');
    await store.appendMessage({
      sessionId: 's1',
      seq: 0,
      role: 'user',
      content: '"a"',
    });
    await store.appendMessage({
      sessionId: 's1',
      seq: 1,
      role: 'assistant',
      content: '{"content":[]}',
    });
    await store.compact({
      sessionId: 's1',
      droppedIds: ['s1:0'],
      summaryId: 's1:summary:0',
      summarySeq: 0,
      summaryText: 'sum',
    });
    const normal = await store.listMessages({ sessionId: 's1' });
    const all = await store.listMessages({
      sessionId: 's1',
      includeCompacted: true,
    });
    expect(
      normal?.messages.find((m) => m.seq === 0 && m.kind === 'summary'),
    ).toBeTruthy();
    expect(all?.messages.some((m) => m.compacted)).toBe(true);
  });

  it('serializes concurrent appends without losing rows (read-modify-write race)', async () => {
    files.clear();
    const store = makeFsSessionStore('/root');
    // Fire 8 appends concurrently — a naive read-modify-write would clobber most.
    await Promise.all(
      Array.from({ length: 8 }, (_, seq) =>
        store.appendMessage({
          sessionId: 's1',
          seq,
          role: 'user',
          content: `"${seq}"`,
        }),
      ),
    );
    const listed = await store.listMessages({ sessionId: 's1' });
    expect(listed?.messages.map((m) => m.seq)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it('upsert writes metadata.json', async () => {
    files.clear();
    const store = makeFsSessionStore('/root');
    await store.upsert({
      sessionId: 's1',
      projectId: 'p',
      title: 'T',
      model: 'glm_5_2',
    });
    expect(
      (JSON.parse(files.get('/root/s1/metadata.json')!) as { title: string })
        .title,
    ).toBe('T');
  });
});
