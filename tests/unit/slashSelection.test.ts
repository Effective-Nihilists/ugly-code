import { describe, expect, it } from 'vitest';
import { resolveSlashSelection } from '../../client/studio/hooks/useSlashCommands';

// Regression: picking the built-in `/clear` from the slash popup used to stuff
// "/clear" back into the input, which still matches the slash trigger `^/[\w-]*$`
// — so the popup immediately REOPENED and the user could never "complete" the
// selection. A command must resolve to a direct action the panel runs, never to
// a text insertion. Skills still insert (as a pending pill).

describe('resolveSlashSelection', () => {
  it('resolves a built-in command (kind) to a run-command action', () => {
    expect(
      resolveSlashSelection({
        name: 'clear',
        kind: 'command',
        scope: 'command',
      }),
    ).toEqual({ type: 'run-command', name: 'clear' });
  });

  it('treats scope:"command" as a command even without an explicit kind', () => {
    expect(resolveSlashSelection({ name: 'clear', scope: 'command' })).toEqual({
      type: 'run-command',
      name: 'clear',
    });
  });

  it('resolves a disk skill to an insert-skill action', () => {
    expect(
      resolveSlashSelection({
        name: 'fix-code',
        kind: 'skill',
        scope: 'project',
      }),
    ).toEqual({ type: 'insert-skill', name: 'fix-code' });
  });
});
