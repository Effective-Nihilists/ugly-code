import { describe, expect, it } from 'vitest';
import { buildScaffoldCommand, parseScaffoldResult } from '../../client/studio/panels/scaffoldCommand';

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
});

describe('parseScaffoldResult', () => {
  it('returns the last non-empty line as path on exit 0', () => {
    expect(parseScaffoldResult('[ugly-app] Creating…\n/Users/x/proj\n\n', 0))
      .toEqual({ ok: true, path: '/Users/x/proj' });
  });

  it('reports failure on non-zero exit', () => {
    expect(parseScaffoldResult('boom', 1)).toEqual({ ok: false, code: 1 });
  });

  it('is ok with an empty path when there is no output', () => {
    expect(parseScaffoldResult('', 0)).toEqual({ ok: true, path: '' });
  });
});
