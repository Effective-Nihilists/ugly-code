import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import {
  appendRunHistory,
  listRunHistory,
  deleteRunFromHistory,
  type RunHistoryEntry,
} from '../../../client/studio/evals/history';

function entry(over: Partial<RunHistoryEntry>): RunHistoryEntry {
  return {
    taskName: 't',
    projectName: 'p',
    projectPath: '/p',
    sessionId: 's',
    createdAt: '2026-07-05',
    ...over,
  };
}

describe('eval history ledger', () => {
  beforeEach(() => files.clear());

  it('appends and lists newest-first', async () => {
    await appendRunHistory(entry({ projectName: 'a', createdAt: '1' }));
    await appendRunHistory(entry({ projectName: 'b', createdAt: '2' }));
    const { runs } = await listRunHistory();
    expect(runs.map((r) => r.projectName)).toEqual(['b', 'a']);
  });

  it('serializes concurrent appends without losing entries', async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        appendRunHistory(entry({ projectName: `p${i}` })),
      ),
    );
    const { runs } = await listRunHistory();
    expect(runs).toHaveLength(6);
  });

  it('empty ledger → []', async () => {
    expect((await listRunHistory()).runs).toEqual([]);
  });

  it('delete removes a run by projectName', async () => {
    await appendRunHistory(entry({ projectName: 'keep' }));
    await appendRunHistory(entry({ projectName: 'drop' }));
    await deleteRunFromHistory('drop');
    const { runs } = await listRunHistory();
    expect(runs.map((r) => r.projectName)).toEqual(['keep']);
  });
});
