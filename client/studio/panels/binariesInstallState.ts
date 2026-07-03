// Pure decision logic for BinariesInstallOverlay — extracted so the event→state
// transitions can be unit-tested without a DOM. Given the per-tool phases the
// shell reports (download → extract → done, or failed), decide whether the page
// should be blocked and what state to show.

export interface ToolState {
  phase: string;
  pct: number;
}

export interface OverlayState {
  /** Any tool still downloading/extracting (not done, not failed). */
  installing: boolean;
  /** Any tool ended in failure. */
  failed: boolean;
  /** Every known tool finished successfully (→ auto-clear). */
  allDone: boolean;
  /** The blocking overlay should be shown. */
  visible: boolean;
}

export function computeInstallOverlay(
  tools: Record<string, ToolState>,
  dismissed: boolean,
): OverlayState {
  const entries = Object.values(tools);
  const failed = entries.some((t) => t.phase === 'failed');
  const installing = entries.some((t) => t.phase !== 'done' && t.phase !== 'failed');
  const allDone = entries.length > 0 && entries.every((t) => t.phase === 'done');
  const visible = !dismissed && (installing || failed);
  return { installing, failed, allDone, visible };
}
