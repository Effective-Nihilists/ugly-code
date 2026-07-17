// Renderer-side startup-timing instrumentation. Captures `t0` at the
// very first import (this module is loaded from main.tsx before React),
// so every later `bootMark(label)` logs the wall-clock ms since the
// renderer's initial paint started. Logs are mirrored to the sidecar
// via consoleCapture, so the timeline survives a full app close + log
// pull. Flip BOOT_TIMING to false before commit to silence the noise.

const BOOT_TIMING = true;

const t0 =
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guard against runtimes exposing `performance` without `now`
  typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();

export function bootMark(label: string, extra?: Record<string, unknown>): void {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- BOOT_TIMING is a manual compile-time toggle (flipped to false before commit)
  if (!BOOT_TIMING) return;
  const delta = (
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
  ).toFixed(1);
  if (extra) {
    console.log(`[startup-timing] T+${delta}ms ${label}`, extra);
  } else {
    console.log(`[startup-timing] T+${delta}ms ${label}`);
  }
}

export function bootEnabled(): boolean {
  return BOOT_TIMING;
}
