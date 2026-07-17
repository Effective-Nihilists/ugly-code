// The exit taxonomy the user drew: a coding-task child that dies from an internal
// fault is an ERROR (surface it in chat + flip the session to ERROR); one the host
// deliberately killed for a version/build mismatch — or that exited cleanly — is NOT.
// codingExitCrashText encodes exactly that decision.
import { describe, it, expect } from 'vitest';
import { codingExitCrashText } from '../../client/studio/hooks/useSocket';

describe('codingExitCrashText — crash vs expected teardown', () => {
  it('clean exit (code 0) is not a crash', () => {
    expect(
      codingExitCrashText({ code: 0, signal: null, intentional: false }),
    ).toBeNull();
  });

  it('code:null with no signal is a normal exit, not a crash', () => {
    expect(codingExitCrashText({ code: null, signal: null })).toBeNull();
  });

  it('a deliberate kill (intentional) is never a crash — even with a signal', () => {
    // ensure-replace on a build mismatch / user Stop → SIGTERM, tagged intentional.
    expect(
      codingExitCrashText({ code: null, signal: 'SIGTERM', intentional: true }),
    ).toBeNull();
    expect(
      codingExitCrashText({ code: 1, signal: null, intentional: true }),
    ).toBeNull();
  });

  it('a non-zero exit code we did NOT initiate is a crash', () => {
    const text = codingExitCrashText({
      code: 3,
      signal: null,
      intentional: false,
    });
    expect(text).toContain('exited unexpectedly');
    expect(text).toContain('code=3');
  });

  it('a kill signal we did NOT initiate (SIGSEGV/OOM) is a crash', () => {
    const text = codingExitCrashText({
      code: null,
      signal: 'SIGSEGV',
      intentional: false,
    });
    expect(text).toContain('signal=SIGSEGV');
  });
});
