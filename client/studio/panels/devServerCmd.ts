/**
 * The spawn spec for booting a project's dev server on a given port. Pure + exported so the
 * Preview "Start app" command + port wiring is unit-testable in the node test env (no render).
 * `pnpm dev` runs the project's dev script (`ugly-app dev --watch`); PORT makes it bind the
 * session's preview port. NO_COLOR/FORCE_COLOR keep the captured boot log free of ANSI.
 */
export function devServerSpawn(port: number): { cmd: string; args: string[]; env: Record<string, string> } {
  // Install deps first when the project was never set up (node_modules missing),
  // THEN run the dev script — otherwise `pnpm dev` → `ugly-app dev` fails with
  // `ugly-app: command not found` (the CLI lives in node_modules/.bin). Done inside
  // the shell command so it needs no imports / bundle changes (a JS-side provision
  // pulled Node modules into the browser build). Picks the manager from the lockfile.
  const ensureDeps =
    '[ -d node_modules ] || { echo "Installing dependencies…"; ' +
    'if [ -f pnpm-lock.yaml ]; then pnpm install; ' +
    'elif [ -f yarn.lock ]; then yarn install; ' +
    'elif [ -f package.json ]; then npm install; fi; }';
  return {
    cmd: 'bash',
    args: ['-lc', `${ensureDeps}; pnpm dev`],
    env: { PORT: String(port), FORCE_COLOR: '0', NO_COLOR: '1' },
  };
}
