// Vendored SWE-bench-Pro (SBP) task metadata — extracted from
// ugly-studio f5a74c2^:evals/tasks/sbpro-*/eval/metadata.json. Holds the hidden
// test_patch + fail_to_pass/pass_to_pass so ugly-code can grade SBP tasks
// host-side (no Docker) for the Python subset. Add an import per vendored task.
import ansible from './sbpro-ansible-ansible-39bd8b99.json';

/** Raw SBP metadata. `selected_test_files_to_run` / `fail_to_pass` / `pass_to_pass`
 *  are JSON-string-encoded arrays (SWE-bench-Pro format) — parse via `parseSbpArray`. */
export interface SbpMeta {
  instance_id: string;
  repo: string;
  base_commit: string;
  repo_language: string;
  test_patch: string;
  selected_test_files_to_run: string;
  fail_to_pass: string;
  pass_to_pass: string;
}

const SBP_META: Record<string, SbpMeta> = {
  'sbpro-ansible-ansible-39bd8b99': ansible as SbpMeta,
};

export function getSbpMeta(taskName: string): SbpMeta | undefined {
  return SBP_META[taskName];
}
export function isSbpTask(taskName: string): boolean {
  return taskName in SBP_META;
}

/** SBP list fields are strings holding a JSON array; parse defensively. */
export function parseSbpArray(s: string): string[] {
  try {
    const a: unknown = JSON.parse(s);
    return Array.isArray(a) ? a.map(String) : s ? [s] : [];
  } catch {
    return s ? [s] : [];
  }
}
