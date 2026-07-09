/**
 * The spawn spec for booting a project's dev server on a given port. Pure + exported so the
 * Preview "Start app" command + port wiring is unit-testable in the node test env (no render).
 * `pnpm dev` runs the project's dev script (`ugly-app dev --watch`); PORT makes it bind the
 * session's preview port. NO_COLOR/FORCE_COLOR keep the captured boot log free of ANSI.
 */
export function devServerSpawn(port: number, databaseUrl?: string): { cmd: string; args: string[]; env: Record<string, string> } {
  const p = String(port);
  // Install deps first when the project was never set up (node_modules missing),
  // THEN run the dev script — otherwise `pnpm dev` → `ugly-app dev` fails with
  // `ugly-app: command not found` (the CLI lives in node_modules/.bin). Done inside
  // the shell command so it needs no imports / bundle changes (a JS-side provision
  // pulled Node modules into the browser build). Picks the manager from the lockfile.
  const ensureDeps =
    '[ -d node_modules ] || { echo "Installing dependencies\u2026"; ' +
    'if [ -f pnpm-lock.yaml ]; then pnpm install; ' +
    'elif [ -f yarn.lock ]; then yarn install; ' +
    'elif [ -f package.json ]; then npm install; fi; }';
  // Free the port first: after a client reload the panel loses its handle to a
  // still-running dev server (the process survives on the host), so a fresh start
  // otherwise collides \u2014 `Port <n> is already in use` \u2192 the dev server exits and
  // the preview blanks. Best-effort SIGTERM to whatever holds the port (lets
  // ugly-app dev tear down its tunnel/vite children), then a beat for release.
  // Tries lsof (macOS), fuser (Linux), and netstat+taskkill (Windows/Cygwin).
  const freePort =
    // MacOS (lsof)
    `command -v lsof >/dev/null 2>&1 && ` +
    `{ lsof -ti tcp:${p} 2>/dev/null | xargs -I{} kill {} 2>/dev/null; sleep 0.5; }` +
    // Linux (fuser)
    ` || command -v fuser >/dev/null 2>&1 && ` +
    `{ fuser -k ${p}/tcp 2>/dev/null; sleep 0.5; }` +
    // Windows/Cygwin (netstat + taskkill)
    ` || command -v netstat >/dev/null 2>&1 && ` +
    `command -v taskkill >/dev/null 2>&1 && ` +
    `{ netstat -ano 2>/dev/null | grep ":${p} " | awk '{print $NF}' | sort -u | xargs -I{} taskkill /F /PID {} 2>/dev/null; sleep 0.5; }` +
    ` || true`;
  // Inject the SAME bundled-postgres DATABASE_URL the Database panel + agent use
  // (the session workspace's `databaseUrl`). Without it, `ugly-app dev` finds no
  // connection string, so its startup `runMigrations()` no-ops (initPg returns
  // early) \u2014 tables are never created, and the Database panel (which DOES boot the
  // bundled pg) then reads an empty database. Passing it makes the dev server init
  // its schema in the exact db the panel inspects, so "start dev \u2192 data appears".
  return {
    cmd: 'bash',
    args: ['-lc', `${freePort}; ${ensureDeps}; pnpm dev`],
    env: {
      PORT: String(port),
      // Force ANSI color even though stdout is a pipe (not a TTY), so the Preview
      // log view can render colored output. The view parses the codes (ansi.tsx)
      // and strips them where it needs plain text (the ready-marker match).
      FORCE_COLOR: '1',
      ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
    },
  };
}
