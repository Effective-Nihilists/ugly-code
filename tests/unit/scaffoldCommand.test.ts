import { describe, expect, it } from 'vitest';
import {
  buildScaffoldCommand,
  parseScaffoldResult,
  normalizeScaffoldPath,
} from '../../client/studio/panels/scaffoldCommand';

describe('buildScaffoldCommand', () => {
  it('expands a leading ~ to $HOME and quotes name + parent', () => {
    const cmd = buildScaffoldCommand('my-app', '~/Documents/Ugly Studio');
    expect(cmd).toContain('mkdir -p "$HOME/Documents/Ugly Studio"');
    expect(cmd).toContain('cd "$HOME/Documents/Ugly Studio"');
    expect(cmd).toContain('npx -y ugly-app@latest init "my-app"');
    expect(cmd).toContain('cd "my-app" && pwd');
  });

  it('defaults an empty/whitespace parent to $HOME', () => {
    expect(buildScaffoldCommand('a', '   ')).toContain('mkdir -p "$HOME"');
  });

  it('escapes embedded double quotes in the name', () => {
    expect(buildScaffoldCommand('a"b', '~')).toContain('init "a\\"b"');
  });

  it('omits --with when no features are selected', () => {
    expect(buildScaffoldCommand('a', '~')).not.toContain('--with');
  });

  it('appends --with for selected features', () => {
    expect(buildScaffoldCommand('a', '~', ['todo', 'chat'])).toContain(
      'init "a" --with todo,chat',
    );
  });

  it('drops malformed feature ids (only [a-z] allowed)', () => {
    expect(buildScaffoldCommand('a', '~', ['todo', 'bad;rm -rf'])).toContain(
      '--with todo',
    );
    expect(
      buildScaffoldCommand('a', '~', ['todo', 'bad;rm -rf']),
    ).not.toContain('rm -rf');
  });
});

describe('parseScaffoldResult', () => {
  it('returns the last non-empty line as path on exit 0', () => {
    expect(
      parseScaffoldResult('[ugly-app] Creating…\n/Users/x/proj\n\n', 0),
    ).toEqual({ ok: true, path: '/Users/x/proj' });
  });

  it('reports failure on non-zero exit', () => {
    expect(parseScaffoldResult('boom', 1)).toEqual({ ok: false, code: 1 });
  });

  it('is ok with an empty path when there is no output', () => {
    expect(parseScaffoldResult('', 0)).toEqual({ ok: true, path: '' });
  });
});

describe('normalizeScaffoldPath', () => {
  it('maps an MSYS/Git-Bash pwd path to native Windows (the C:\\c\\ bug)', () => {
    // Git-Bash `pwd` prints /c/Users/...; Node path.resolve would otherwise
    // mangle it to C:\c\Users\... (drive-root-relative).
    expect(
      normalizeScaffoldPath('/c/Users/theju/Documents/Ugly Studio/test', true),
    ).toBe('C:\\Users\\theju\\Documents\\Ugly Studio\\test');
  });

  it('normalizes a forward-slash drive path (pwd -W style) to backslashes', () => {
    expect(normalizeScaffoldPath('C:/Users/theju/proj', true)).toBe(
      'C:\\Users\\theju\\proj',
    );
  });

  it('leaves an already-native Windows path unchanged', () => {
    expect(normalizeScaffoldPath('C:\\Users\\theju\\proj', true)).toBe(
      'C:\\Users\\theju\\proj',
    );
  });

  it('is a no-op on non-Windows (POSIX paths pass through)', () => {
    expect(normalizeScaffoldPath('/c/Users/x', false)).toBe('/c/Users/x');
    expect(normalizeScaffoldPath('/Users/x/proj', false)).toBe('/Users/x/proj');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeScaffoldPath('  /Users/x/proj \n', false)).toBe(
      '/Users/x/proj',
    );
  });
});
