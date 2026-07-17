import { describe, expect, it } from 'vitest';
import {
  isMobileWidth,
  MOBILE_MAX_WIDTH,
} from '../../client/studio/hooks/useIsMobile';

// The repo's vitest env is `node` (no DOM), so we test the pure predicate that
// backs useIsMobile(). The hook's reactive resize behavior is covered by the
// 390px e2e in tests/e2e/mobile-layout.spec.ts.
describe('isMobileWidth', () => {
  it('is true at/below the default 768px breakpoint', () => {
    expect(isMobileWidth(390)).toBe(true);
    expect(isMobileWidth(MOBILE_MAX_WIDTH)).toBe(true);
  });

  it('is false above the breakpoint', () => {
    expect(isMobileWidth(769)).toBe(false);
    expect(isMobileWidth(1024)).toBe(false);
  });

  it('honors a custom threshold', () => {
    expect(isMobileWidth(800, 900)).toBe(true);
    expect(isMobileWidth(950, 900)).toBe(false);
  });
});
