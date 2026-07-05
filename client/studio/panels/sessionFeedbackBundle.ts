/**
 * Caps a serialized coding-session bundle so an enormous session doesn't blow past
 * the D1 row limit when it rides along in a feedback report's `context`. Keeps the
 * most-recent turns, dropping the oldest first. Extracted from the former
 * ReportSessionIssueButton so it can be shared by the feedback-context provider.
 */

// Keep the serialized session bundle under this — D1 rows have a size ceiling and
// a report should stay a single row. Oldest turns are dropped first if it exceeds.
const MAX_BUNDLE_BYTES = 700_000;

/** Trim a bundle's `messages` (oldest-first) until the whole thing fits the cap. */
export function capSessionBundle(bundle: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(bundle).length <= MAX_BUNDLE_BYTES) return bundle;
  const msgs = Array.isArray(bundle.messages) ? [...(bundle.messages as unknown[])] : [];
  const originalCount = msgs.length;
  let kept = msgs;
  while (
    kept.length > 1 &&
    JSON.stringify({ ...bundle, messages: kept }).length > MAX_BUNDLE_BYTES
  ) {
    kept = kept.slice(Math.max(1, Math.ceil(kept.length / 10))); // drop oldest ~10%
  }
  return { ...bundle, messages: kept, _truncated: { originalCount, keptCount: kept.length } };
}
