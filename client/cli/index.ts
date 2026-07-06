// Runnable CLI entry: parse argv and dispatch. `main` is kept separate (evalCli.ts)
// so it stays unit-testable without process side effects.
import { main } from './evalCli';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => { process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1); },
);
