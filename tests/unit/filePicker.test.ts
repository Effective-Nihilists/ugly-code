import { describe, expect, it } from 'vitest';
import { parentPath, joinPath, basename, matchesExtension, filterEntries, resolveStart } from '../../client/studio/components/filePickerUtils';
import type { HostDirent } from 'ugly-app/native';

const dir = (name: string): HostDirent => ({ name, isDirectory: true, isFile: false }) as HostDirent;
const file = (name: string): HostDirent => ({ name, isDirectory: false, isFile: true }) as HostDirent;

describe('resolveStart', () => {
  it("passes '~'-based and absolute paths through; empty defaults to home", () => {
    expect(resolveStart('~/Documents/Ugly Studio')).toBe('~/Documents/Ugly Studio');
    expect(resolveStart('~')).toBe('~');
    expect(resolveStart('')).toBe('~');
    expect(resolveStart(undefined)).toBe('~');
    expect(resolveStart('/Users/admin/Documents')).toBe('/Users/admin/Documents');
  });
});

describe('parentPath', () => {
  it('goes up one level, preserving root markers', () => {
    expect(parentPath('/Users/admin/Documents')).toBe('/Users/admin');
    expect(parentPath('/Users')).toBe('/');
    expect(parentPath('/')).toBe('/');
    expect(parentPath('~/Documents/Ugly Studio')).toBe('~/Documents');
    expect(parentPath('~')).toBe('~');
    expect(parentPath('/Users/admin/Documents/')).toBe('/Users/admin'); // trailing slash
  });
});

describe('joinPath / basename', () => {
  it('joins and extracts the last segment', () => {
    expect(joinPath('/Users/admin', 'Documents')).toBe('/Users/admin/Documents');
    expect(joinPath('~/', 'Code')).toBe('~/Code');
    expect(basename('/Users/admin/project')).toBe('project');
    expect(basename('/Users/admin/project/')).toBe('project');
    expect(basename('~')).toBe('~');
  });
});

describe('matchesExtension', () => {
  it('matches with or without leading dot; empty = all', () => {
    expect(matchesExtension('a.ts', ['.ts'])).toBe(true);
    expect(matchesExtension('a.TS', ['ts'])).toBe(true); // case-insensitive, no dot
    expect(matchesExtension('a.json', ['.ts', '.json'])).toBe(true);
    expect(matchesExtension('a.png', ['.ts'])).toBe(false);
    expect(matchesExtension('anything', [])).toBe(true);
    expect(matchesExtension('anything', undefined)).toBe(true);
  });
});

describe('filterEntries', () => {
  const entries = [file('z.ts'), dir('src'), file('.hidden'), dir('.git'), file('readme.md'), dir('assets')];

  it('folder mode: only folders, sorted, no files, hidden dropped', () => {
    expect(filterEntries(entries, 'folder', undefined, false)).toEqual([
      { name: 'assets', isDirectory: true },
      { name: 'src', isDirectory: true },
    ]);
  });

  it('both mode: folders first then files, extension-filtered', () => {
    expect(filterEntries(entries, 'both', ['.ts'], false)).toEqual([
      { name: 'assets', isDirectory: true },
      { name: 'src', isDirectory: true },
      { name: 'z.ts', isDirectory: false },
    ]);
  });

  it('file mode: folders still shown (navigable) + matching files', () => {
    const r = filterEntries(entries, 'file', ['.md'], false);
    expect(r).toEqual([
      { name: 'assets', isDirectory: true },
      { name: 'src', isDirectory: true },
      { name: 'readme.md', isDirectory: false },
    ]);
  });

  it('showHidden includes dot entries', () => {
    const names = filterEntries(entries, 'both', undefined, true).map((e) => e.name);
    expect(names).toContain('.git');
    expect(names).toContain('.hidden');
  });
});
