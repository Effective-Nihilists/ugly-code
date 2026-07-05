// Cross-platform path resolution for the agent file tools. The Windows cases
// guard the regression where a `C:\Users\...` base produced mixed-separator or
// corrupt paths (misclassified `C:\...` as relative), which broke native.fs
// writes + codebase.update freshness for Windows Ugly Studio testers.
import { describe, it, expect } from 'vitest';
import { resolvePath, relativizePath } from '../../../client/agent/tools';
import type { ToolContext } from '../../../client/agent/tools';

const posix: ToolContext = { projectDir: '/Users/theju/proj' };
const win: ToolContext = { projectDir: 'C:\\Users\\theju\\Documents\\Ugly Studio\\test3' };

describe('resolvePath — POSIX', () => {
  it('joins a relative path onto the project dir', () => {
    expect(resolvePath(posix, 'src/foo.ts')).toBe('/Users/theju/proj/src/foo.ts');
  });
  it('passes an absolute path through (normalized)', () => {
    expect(resolvePath(posix, '/etc/hosts')).toBe('/etc/hosts');
  });
  it('collapses ./ and ../ segments', () => {
    expect(resolvePath(posix, './a/../b/c.ts')).toBe('/Users/theju/proj/b/c.ts');
  });
  it('expands ~ to the derived home', () => {
    expect(resolvePath(posix, '~/notes.md')).toBe('/Users/theju/notes.md');
  });
});

describe('resolvePath — Windows', () => {
  it('joins a relative path with backslashes onto a drive-letter base', () => {
    expect(resolvePath(win, 'src/foo.ts')).toBe(
      'C:\\Users\\theju\\Documents\\Ugly Studio\\test3\\src\\foo.ts',
    );
  });
  it('keeps a Windows-absolute drive path all-backslash (not treated as relative)', () => {
    expect(resolvePath(win, 'C:\\Windows\\System32\\drivers')).toBe(
      'C:\\Windows\\System32\\drivers',
    );
  });
  it('normalizes a mixed-separator absolute path', () => {
    expect(resolvePath(win, 'C:/Temp/x/../y.ts')).toBe('C:\\Temp\\y.ts');
  });
  it('expands ~ to the derived Windows home', () => {
    expect(resolvePath(win, '~/notes.md')).toBe('C:\\Users\\theju\\notes.md');
  });
  it('does not climb past the drive root with ..', () => {
    expect(resolvePath(win, 'C:\\a\\..\\..\\b')).toBe('C:\\b');
  });
});

describe('relativizePath', () => {
  it('strips the POSIX base', () => {
    expect(relativizePath(posix, '/Users/theju/proj/src/a.ts')).toBe('src/a.ts');
  });
  it('strips the Windows base (separator- and case-insensitive)', () => {
    expect(
      relativizePath(win, 'C:\\Users\\theju\\Documents\\Ugly Studio\\test3\\src\\a.ts'),
    ).toBe('src\\a.ts');
  });
  it('returns paths outside the base unchanged', () => {
    expect(relativizePath(win, 'D:\\other\\a.ts')).toBe('D:\\other\\a.ts');
  });
});
