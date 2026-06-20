/**
 * Compact relative-time formatter used across Project Home / Session
 * list / Git panel. Returns strings like "just now", "2m ago", "3h ago",
 * "1d ago". Inputs are epoch-ms timestamps.
 */
export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Even shorter variant used in dense card footers. */
export function timeAgoShort(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const d = Math.floor(s / 86400);
  return d === 1 ? '1d' : `${d}d`;
}
