/**
 * The spawn spec for booting a project's dev server on a given port. Pure + exported so the
 * Preview "Start app" command + port wiring is unit-testable in the node test env (no render).
 * `pnpm dev` runs the project's dev script (`ugly-app dev --watch`); PORT makes it bind the
 * session's preview port. NO_COLOR/FORCE_COLOR keep the captured boot log free of ANSI.
 */
export function devServerSpawn(port: number): { cmd: string; args: string[]; env: Record<string, string> } {
  return {
    cmd: 'bash',
    args: ['-lc', 'pnpm dev'],
    env: { PORT: String(port), FORCE_COLOR: '0', NO_COLOR: '1' },
  };
}
