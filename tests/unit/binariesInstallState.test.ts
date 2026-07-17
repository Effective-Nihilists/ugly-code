import { describe, it, expect } from 'vitest';
import {
  computeInstallOverlay,
  type ToolState,
} from '../../client/studio/panels/binariesInstallState';

const t = (phase: string, pct = 0): ToolState => ({ phase, pct });

describe('computeInstallOverlay — page-blocking decision from tool progress', () => {
  it('no tools → not visible (page not blocked)', () => {
    expect(computeInstallOverlay({}, false).visible).toBe(false);
  });
  it('a tool downloading → installing + visible (page blocked)', () => {
    expect(
      computeInstallOverlay({ node: t('download', 0) }, false),
    ).toMatchObject({
      installing: true,
      failed: false,
      allDone: false,
      visible: true,
    });
  });
  it('stays blocked while any tool is still extracting', () => {
    expect(
      computeInstallOverlay(
        { node: t('done', 100), pnpm: t('extract', 50) },
        false,
      ),
    ).toMatchObject({ installing: true, visible: true, allDone: false });
  });
  it('all tools done → allDone, not visible (unblocks)', () => {
    expect(
      computeInstallOverlay(
        { node: t('done', 100), pnpm: t('done', 100) },
        false,
      ),
    ).toMatchObject({
      installing: false,
      failed: false,
      allDone: true,
      visible: false,
    });
  });
  it('a failed tool → failed + visible even if others are done', () => {
    expect(
      computeInstallOverlay(
        { node: t('done', 100), git: t('failed', 0) },
        false,
      ),
    ).toMatchObject({ failed: true, visible: true, allDone: false });
  });
  it('dismiss hides the overlay even on failure', () => {
    const s = computeInstallOverlay({ git: t('failed', 0) }, true);
    expect(s.failed).toBe(true);
    expect(s.visible).toBe(false);
  });
  it('realistic sequence blocks then unblocks', () => {
    expect(computeInstallOverlay({ node: t('download') }, false).visible).toBe(
      true,
    );
    expect(
      computeInstallOverlay(
        { node: t('extract', 50), pnpm: t('download') },
        false,
      ).visible,
    ).toBe(true);
    expect(
      computeInstallOverlay(
        { node: t('done', 100), pnpm: t('done', 100) },
        false,
      ).visible,
    ).toBe(false);
  });
});
