// F — the coding UI is fully DOC-DRIVEN (no dependency on the WebRTC Ugly-Proxy tunnel
// for coding): sending writes a `codingRunRequest` doc (the owning desktop host claims +
// forks + drives the turn — the E-host), and the transcript is a live projection of the
// `codingSessionMessage` docs (committed rows + transient streaming). Every client talks
// only to the server (trackDocs + setDoc); only the host forks locally. The proxy stays
// for OTHER native capabilities + the interactive controls not yet migrated (stop/ask-user
// still ride native.task on desktop).
//
// SEND + TRANSCRIPT are gated by ONE switch so they never mix: doc-driven turns are both
// TRIGGERED by a run-request AND streamed via docs; legacy turns are forked via native.task
// AND streamed via task.listen. Mixing (e.g. doc transcript + legacy send) would work
// mechanically — the agent persists docs either way — but keeping them coupled makes the
// rollout a single, reversible switch.
//
// DEFAULT OFF (opt-in) — enabling requires (a) a Studio build carrying the E-host
// (`startCodingRunHost`) so run-requests get claimed, and (b) a visual render check of the
// doc-sourced transcript. Toggle live in a running Studio devtools (no rebuild):
//   localStorage.setItem('uglycode.docDrivenCoding','1')   // doc-driven
//   localStorage.removeItem('uglycode.docDrivenCoding')    // legacy (default)
// Flip the default here to true once both gates are met + a Studio with the E-host has
// rolled out.
export function docDrivenCoding(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('uglycode.docDrivenCoding') === '1';
  } catch {
    return false;
  }
}
