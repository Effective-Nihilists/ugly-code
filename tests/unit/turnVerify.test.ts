// R7-6: the "unverified" banner fires when the model marks todos done but the run's latest
// typecheck still has errors. These lock the detection logic (see turnVerify.ts).
import { describe, it, expect } from 'vitest';
import {
  findTurnVerifyFailed,
  turnStartIndex,
  type VerifyScanMsg,
} from '../../client/studio/panels/turnVerify';

const user = (): VerifyScanMsg => ({ role: 'user', toolUses: [] });
const typecheck = (result: string, status = 'done'): VerifyScanMsg => ({
  role: 'assistant',
  toolUses: [
    {
      name: 'grep',
      input: JSON.stringify({ mode: 'lsp-diagnostics' }),
      result,
      status,
    },
  ],
});
const scan = (msgs: VerifyScanMsg[]) =>
  findTurnVerifyFailed(msgs, turnStartIndex(msgs), msgs.length - 1);

describe('findTurnVerifyFailed', () => {
  it('true when the turn’s typecheck reported diagnostics', () => {
    expect(
      scan([user(), typecheck('bad.ts:3:1 - error TS2322: not assignable')]),
    ).toBe(true);
  });

  it('false when the typecheck was clean', () => {
    expect(scan([user(), typecheck('(no diagnostics)')])).toBe(false);
    expect(scan([user(), typecheck('(no diagnostics for bad.ts)')])).toBe(
      false,
    );
  });

  it('only the LATEST typecheck counts — a later clean run clears an earlier failure', () => {
    expect(
      scan([user(), typecheck('error TS2322'), typecheck('(no diagnostics)')]),
    ).toBe(false);
    expect(
      scan([user(), typecheck('(no diagnostics)'), typecheck('error TS2322')]),
    ).toBe(true);
  });

  it('ignores an in-flight / errored typecheck (the tool broke, not a failed verification)', () => {
    expect(scan([user(), typecheck('error TS2322', 'error')])).toBe(false);
    expect(scan([user(), typecheck('', 'executing')])).toBe(false);
  });

  it('scopes to the CURRENT turn — a prior turn’s failure does not carry over', () => {
    expect(
      scan([
        user(),
        typecheck('error TS2322'),
        user(),
        typecheck('(no diagnostics)'),
      ]),
    ).toBe(false);
  });

  it('ignores non-typecheck greps and other tools', () => {
    expect(
      scan([
        user(),
        {
          role: 'assistant',
          toolUses: [
            {
              name: 'grep',
              input: JSON.stringify({ mode: 'exact' }),
              result: 'a.ts:1 hit',
              status: 'done',
            },
            {
              name: 'edit',
              input: '{}',
              result: 'Edited a.ts',
              status: 'done',
            },
          ],
        },
      ]),
    ).toBe(false);
  });
});
