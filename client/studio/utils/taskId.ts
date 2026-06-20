/**
 * Mint a per-call task id for cancellable long-running RPCs.
 *
 * Used by callers of `initProject` and `codingAgentChatCreate` (and
 * any future RPC that opts out of the 60s WebSocket timeout) to give
 * the server something stable to register an AbortController under,
 * which the Stop button can later target via `cancelTask({ taskId })`.
 *
 * Uses `crypto.randomUUID` where available (modern browsers + the
 * Electron renderer in a secure context); falls back to a Date+random
 * string when the secure-context API isn't exposed. The id is opaque
 * to the server — only its uniqueness within an active session
 * matters.
 */
export function generateTaskId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `task-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}
