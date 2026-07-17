// R7-6: the "unverified" signal behind the chat banner.
//
// Todos are model-authored — the model marks them completed on its own word, with no binding
// to any objective check — so a green "todos done" checklist next to a failed verification is
// misleading. A verification is a `grep mode:lsp-diagnostics` call (the typecheck), which
// returns "(no diagnostics…)" when clean and the diagnostics body otherwise. This module
// derives, from the transcript, whether the CURRENT turn's LATEST typecheck still had errors —
// only the latest one counts, since an earlier failure the model has since fixed shouldn't warn.
//
// Pulled out of CodingAgentChat.tsx as a pure function so it's unit-testable (see
// tests/unit/turnVerify.test.ts) — mirrors the toolCardSummary extraction.

/** The minimal transcript-message shape this scan reads. `ChatMessage[]` satisfies it. */
export interface VerifyScanMsg {
  role?: string;
  toolUses?: {
    name: string;
    /** JSON-stringified tool input (grep carries `mode` here). */
    input: string;
    result?: string;
    status: string;
  }[];
}

/** Index of the first message AFTER the last user message — the start of the current turn. */
export function turnStartIndex(messages: VerifyScanMsg[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i + 1;
  }
  return 0;
}

/**
 * Did the turn's MOST RECENT typecheck (`grep mode:lsp-diagnostics`) still report diagnostics?
 * Scans `[from, to]` newest-first and decides on the first typecheck it finds — a later clean
 * run overrides an earlier failure. In-flight / errored typechecks don't count as "failed
 * verification" (the tool itself broke, a different signal).
 */
export function findTurnVerifyFailed(
  messages: VerifyScanMsg[],
  from: number,
  to: number,
): boolean {
  if (to >= messages.length) to = messages.length - 1;
  if (from < 0) from = 0;
  for (let i = to; i >= from; i--) {
    const msg = messages[i];
    if (!msg.toolUses?.length) continue;
    for (let j = msg.toolUses.length - 1; j >= 0; j--) {
      const tool = msg.toolUses[j];
      if (tool.name.toLowerCase() !== 'grep') continue;
      let mode: unknown;
      try {
        mode = (JSON.parse(tool.input) as { mode?: unknown }).mode;
      } catch {
        continue;
      }
      if (mode !== 'lsp-diagnostics') continue;
      if (tool.status !== 'done') return false;
      const r = (tool.result ?? '').trim();
      return r.length > 0 && !r.startsWith('(no diagnostics');
    }
  }
  return false;
}
