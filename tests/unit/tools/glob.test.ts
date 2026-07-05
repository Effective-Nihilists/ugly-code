// Task B1.4 — glob (file-name finding via `rg --files -g`).
import { describe, it, expect, beforeEach } from 'vitest';
import { resetMock, mockCalls } from '../../helpers/uglyNativeMock';
import { globTool, buildGlobArgs, parseGlobignore } from '../../../client/agent/tools/glob';

describe('glob buildGlobArgs', () => {
  it('lists files matching the glob', () => {
    const a = buildGlobArgs({ pattern: '**/*.ts' });
    expect(a).toContain('--files');
    expect(a).toContain('-g');
    expect(a).toContain('**/*.ts');
  });
  it('includes ignored files when requested', () => {
    expect(buildGlobArgs({ pattern: '*.ts', include_ignored: true })).toContain('--no-ignore');
  });
});

describe('glob hard excludes', () => {
  it('always excludes .git and node_modules, even with include_ignored', () => {
    const a = buildGlobArgs({ pattern: '*', include_ignored: true });
    expect(a).toContain('--no-ignore');
    expect(a).toContain('!.git');
    expect(a).toContain('!node_modules');
  });
  it('appends .globignore patterns as negative globs', () => {
    const a = buildGlobArgs({ pattern: '**/*' }, ['coverage', 'tmp']);
    expect(a).toContain('!coverage');
    expect(a).toContain('!tmp');
  });
});

describe('parseGlobignore', () => {
  it('keeps patterns, drops blanks and # comments', () => {
    expect(parseGlobignore('# a comment\n\ncoverage\n  logs/  \n')).toEqual(['coverage', 'logs/']);
  });
});

describe('glob run', () => {
  beforeEach(() =>
    resetMock({
      proc: (cmd, args) => ({
        stdout: cmd === 'rg' && args.includes('--files') ? 'src/a.ts\nsrc/b.ts\n' : '',
        code: 0,
      }),
    }),
  );
  it('returns the matched file list', async () => {
    const out = await globTool.run({ pattern: '**/*.ts' }, { projectDir: '/proj' });
    expect(out).toContain('src/a.ts');
    expect(out).toContain('src/b.ts');
    expect(mockCalls().some((c) => c.channel === 'process.spawn')).toBe(true);
  });
  it('reports no matches cleanly', async () => {
    resetMock({ proc: () => ({ stdout: '', code: 1 }) });
    const out = await globTool.run({ pattern: '**/*.xyz' }, { projectDir: '/proj' });
    expect(out).toMatch(/no files|no match/i);
  });
});
