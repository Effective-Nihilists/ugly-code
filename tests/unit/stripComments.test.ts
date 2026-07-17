// The Workers panel offered "Enqueue on Prod" for a worker that only existed in a comment.
import { describe, it, expect } from 'vitest';
import { stripComments } from '../../client/studio/shared/stripComments';

/** The worker-discovery regex from useSocket's workersGetManifest. */
const WORKER_RE = /(\w+)\s*:\s*defineWorker\(\s*\{([\s\S]*?)\}\s*\)/g;
const findWorkers = (src: string): string[] =>
  [...stripComments(src).matchAll(WORKER_RE)].map((m) => m[1]);

describe('stripComments — the fabricated "nightly" worker', () => {
  it('a commented-out defineWorker is NOT a worker', () => {
    // Verbatim shape of the scaffold that produced a phantom prod-enqueueable task.
    const src = `import { defineWorkers, defineWorker } from 'ugly-app/server';

export const cronTasks = defineWorkers({
  // Example:
  //   nightly: defineWorker({ schedule: '0 3 * * *', description: '…' }),
});
`;
    expect(findWorkers(src)).toEqual([]);
  });

  it('a real worker beside a commented one is still found', () => {
    const src = `export const cronTasks = defineWorkers({
  //   nightly: defineWorker({ schedule: '0 3 * * *', description: '…' }),
  digest: defineWorker({ schedule: '0 9 * * 1', description: 'Weekly digest' }),
});`;
    expect(findWorkers(src)).toEqual(['digest']);
  });

  it('block-commented workers are ignored', () => {
    const src = `export const cronTasks = defineWorkers({
  /* old: gone: defineWorker({ schedule: '* * * * *' }), */
  live: defineWorker({ schedule: '0 0 * * *' }),
});`;
    expect(findWorkers(src)).toEqual(['live']);
  });
});

describe('stripComments — literals must survive', () => {
  it('does not treat // inside a string as a comment', () => {
    expect(stripComments(`const u = 'https://x.dev/y'; // drop me`).trim())
      .toBe(`const u = 'https://x.dev/y';`);
  });

  it('handles escaped quotes', () => {
    expect(stripComments(`const s = 'it\\'s // fine'; // gone`).trim())
      .toBe(`const s = 'it\\'s // fine';`);
  });

  it('handles template literals', () => {
    expect(stripComments('const t = `a // b`; // gone').trim()).toBe('const t = `a // b`;');
  });

  it('keeps double-quoted url-ish content', () => {
    expect(stripComments(`const u = "//cdn.example.com";`).trim()).toBe(`const u = "//cdn.example.com";`);
  });

  it('preserves line structure', () => {
    expect(stripComments('a\n// x\nb').split('\n')).toHaveLength(3);
  });

  it('leaves comment-free source untouched', () => {
    const src = 'const a = 1;\nconst b = 2;\n';
    expect(stripComments(src)).toBe(src);
  });
});
