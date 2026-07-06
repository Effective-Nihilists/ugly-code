// ugly-code CLI entry. First-class eval runner so `pnpm dlx ugly-code --eval <task>`
// runs an eval against the deployed origin as a logged-in user.
//   ugly-code --eval <task> [--model m] [--origin o] [--token t] [--test-user]
//   ugly-code --login
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolveAuth } from './auth';
import { runEval } from './evalRun';
import { runComparison, renderScoreboard, type CompareSpec } from './compare';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv.includes('--login')) {
      // Delegate to the ugly-app browser login flow (writes ~/.ugly-bot/auth.json).
      const { spawnCollect } = await import('../agent/tools/spawn');
      const r = await spawnCollect('ugly-app', ['login'], {});
      process.stdout.write(r.stdout);
      return r.code ?? 0;
    }

    // A/B comparison: `--compare <spec.json>` (custom matrix) or
    // `--eval <task> --compare` (default flat-vs-SBV matrix for that task).
    if (argv.includes('--compare')) {
      const origin = flag(argv, '--origin') ?? process.env.UGLY_CODE_ORIGIN ?? '';
      if (!origin) { process.stderr.write('No origin. Pass --origin or set UGLY_CODE_ORIGIN.\n'); return 2; }
      const token = flag(argv, '--token');
      const auth = await resolveAuth({ origin, ...(token ? { token } : {}), testUser: argv.includes('--test-user') });
      const specFile = flag(argv, '--compare');
      const evalTask = flag(argv, '--eval');
      let spec: CompareSpec;
      if (specFile) {
        spec = JSON.parse(await readFile(specFile, 'utf8')) as CompareSpec;
      } else if (evalTask) {
        spec = { tasks: [evalTask], configs: [{ label: 'flat', pattern: 'none' }, { label: 'sbv', pattern: 'spec-build-verify' }] };
      } else {
        process.stderr.write('usage: ugly-code --compare <spec.json>  |  --eval <task> --compare\n');
        return 2;
      }
      const ranAt = Date.now();
      const result = await runComparison(spec, { origin: auth.origin, token: auth.token, ranAt });
      const dir = `${process.env.HOME ?? '.'}/.ugly-code/comparisons`;
      await mkdir(dir, { recursive: true });
      await writeFile(`${dir}/comparison-${ranAt}.json`, JSON.stringify(result, null, 2));
      process.stdout.write(`${renderScoreboard(result)}\n\nsaved: ${dir}/comparison-${ranAt}.json\n`);
      return 0;
    }

    const taskName = flag(argv, '--eval');
    if (taskName) {
      const origin = flag(argv, '--origin') ?? process.env.UGLY_CODE_ORIGIN ?? '';
      if (!origin) {
        process.stderr.write('No origin. Pass --origin <deployed-ugly-code-url> or set UGLY_CODE_ORIGIN.\n');
        return 2;
      }
      const token = flag(argv, '--token');
      const auth = await resolveAuth({
        origin,
        ...(token ? { token } : {}),
        testUser: argv.includes('--test-user'),
      });
      const model = flag(argv, '--model');
      const pattern = flag(argv, '--pattern');
      const res = await runEval({ taskName, origin: auth.origin, token: auth.token, ...(model ? { model } : {}), ...(pattern ? { pattern } : {}) });
      process.stdout.write(`${taskName}: ${res.score}/${res.scoreMax}\n`);
      return res.score >= res.scoreMax ? 0 : 1;
    }

    process.stderr.write('usage: ugly-code --eval <task> [--model m] [--origin o] [--token t] [--test-user]\n       ugly-code --login\n');
    return 2;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
