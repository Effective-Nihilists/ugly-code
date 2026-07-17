// Tests for chat history backfill — verifies that on reload/resume,
// the message list starts from the newest messages and ends up in
// chronological order (oldest first), ready for virtualization.
//
// Models the exact algorithm from useCodingAgentChat ~L3041:
//   1. Fetch pages in reverse chronological order (newest first, via no beforeId)
//   2. Prepend each page to the accumulator
//   3. The net result must be chronological.
//
// This turns on ONE critical assumption: the server returns messages in
// OLDEST-FIRST order per page. If the server ever returns newest-first,
// the allHistory array will be scrambled — the "random messages from
// history" bug the user reported.

import { describe, it, expect } from 'vitest';

// ── Helpers ────────────────────────────────────────────────────────────────

interface WireMessage {
  id: string;
  seq: number; // monotonic sequence number for ordering
  role: 'user' | 'assistant' | 'tool' | 'judge' | 'status';
  content?: string;
}

/** Build a set of mock messages with sequential ids 0..n-1.
 *  Message 0 is oldest, n-1 is newest. */
function makeMessages(n: number): WireMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `msg_${String(i).padStart(4, '0')}`,
    seq: i,
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `message ${i}`,
  }));
}

// ── The algorithm under test ──────────────────────────────────────────────

const WINDOW_MAX = 500;
const PAGE_SIZE = 40;

interface MockServer {
  messages: WireMessage[];
  /** Returns a PAGE of messages. When beforeId is undefined, returns the NEWEST
   *  page. When beforeId is set, returns the page BEFORE that id.
   *  Messages within a page are in CHRONOLOGICAL order (oldest first). */
  listMessages(opts: { limit: number; beforeId?: string }): {
    messages: WireMessage[];
    hasMore: boolean;
  };
}

/** Creates a mock server that simulates the chatListMessages API.
 *  Messages 0..n-1 with 0=oldest, n-1=newest. */
function mockServer(msgs: WireMessage[]): MockServer {
  return {
    messages: msgs,
    listMessages(opts) {
      if (opts.beforeId) {
        // Return the page BEFORE this id (older messages).
        const cursorIdx = msgs.findIndex((m) => m.id === opts.beforeId);
        if (cursorIdx === -1) return { messages: [], hasMore: false };
        // Page: messages BEFORE cursorIdx, most recent first (closest to cursor)
        // Server returns them in CHRONOLOGICAL order (oldest first).
        const start = Math.max(0, cursorIdx - opts.limit);
        const page = msgs.slice(start, cursorIdx);
        return { messages: page, hasMore: start > 0 };
      }
      // No cursor → return the NEWEST page.
      const start = Math.max(0, msgs.length - opts.limit);
      const page = msgs.slice(start);
      return { messages: page, hasMore: start > 0 };
    },
  };
}

/** Replicate the backfill algorithm from useCodingAgentChat. */
async function backfillHistory(server: MockServer): Promise<{
  allHistory: WireMessage[];
  hasMoreOlder: boolean;
}> {
  let allHistory: WireMessage[] = [];
  let beforeId: string | undefined;
  let exhausted = false;
  let hasMore = false;

  while (!exhausted && allHistory.length < WINDOW_MAX) {
    const page = server.listMessages({
      limit: PAGE_SIZE,
      ...(beforeId ? { beforeId } : {}),
    });
    const msgs = page.messages;
    if (msgs.length === 0) break;
    // Dedup: drop messages already loaded (race: overlapping pages).
    const existingIds = new Set(allHistory.map((m) => m.id));
    const newMsgs = msgs.filter((m) => !existingIds.has(m.id));
    if (newMsgs.length === 0) break;
    allHistory = [...newMsgs, ...allHistory];
    // Trim to WINDOW_MAX — prepending older messages may push past the limit.
    // Drop from the OLDEST end (start) to keep the newest messages visible.
    let trimmed = false;
    if (allHistory.length > WINDOW_MAX) {
      const drop = allHistory.length - WINDOW_MAX;
      allHistory = allHistory.slice(drop);
      trimmed = true;
    }
    // hasMore: false when the server says no more older pages, true
    // otherwise. When we trimmed we know there's more regardless.
    hasMore = trimmed || page.hasMore;
    beforeId = msgs[0].id;
    exhausted = !hasMore;
  }

  return { allHistory, hasMoreOlder: exhausted ? false : hasMore };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('chat history backfill ordering', () => {
  it('produces strictly increasing seq numbers (no scrambling)', async () => {
    const msgs = makeMessages(200);
    const server = mockServer(msgs);
    const { allHistory } = await backfillHistory(server);

    // All 200 messages loaded (200 < 500 so entire history fits).
    expect(allHistory.length).toBe(200);
    // Oldest first → seq 0 at index 0
    expect(allHistory[0].seq).toBe(0);
    // Newest last → seq 199 at index 199
    expect(allHistory[199].seq).toBe(199);

    for (let i = 1; i < allHistory.length; i++) {
      expect(allHistory[i].seq).toBe(allHistory[i - 1].seq + 1);
    }
  });

  it('loads the correct number of pages for a large history', async () => {
    const msgs = makeMessages(200);
    const server = mockServer(msgs);
    const { allHistory, hasMoreOlder } = await backfillHistory(server);

    // 200 msgs / 40 per page = 5 pages, but the algorithm stops when exhausted.
    // Since 200 <= WINDOW_MAX, all should be loaded.
    expect(allHistory.length).toBe(200);
    expect(hasMoreOlder).toBe(false);
  });

  it('stops at WINDOW_MAX and keeps hasMoreOlder when history is huge', async () => {
    const msgs = makeMessages(600); // > 500
    const server = mockServer(msgs);
    const { allHistory, hasMoreOlder } = await backfillHistory(server);

    // Must not exceed WINDOW_MAX
    expect(allHistory.length).toBeLessThanOrEqual(WINDOW_MAX);
    // Should have more older messages since 600 > 500
    expect(hasMoreOlder).toBe(true);
    // The newest message should be the last one (seq 599)
    expect(allHistory[allHistory.length - 1].seq).toBe(599);
  });

  it('newest message is the last one (index length-1)', async () => {
    const msgs = makeMessages(50);
    const server = mockServer(msgs);
    const { allHistory } = await backfillHistory(server);

    const last = allHistory[allHistory.length - 1];
    expect(last.seq).toBe(49); // 0-indexed, 50 msgs → last is msg_0049
  });
});

describe('chat history backfill edge cases', () => {
  it('handles empty history gracefully', async () => {
    const server = mockServer([]);
    const { allHistory, hasMoreOlder } = await backfillHistory(server);
    expect(allHistory).toEqual([]);
    expect(hasMoreOlder).toBe(false);
  });

  it('handles a single page of messages', async () => {
    const msgs = makeMessages(15);
    const server = mockServer(msgs);
    const { allHistory, hasMoreOlder } = await backfillHistory(server);
    expect(allHistory.length).toBe(15);
    expect(allHistory[0].seq).toBe(0);
    expect(allHistory[14].seq).toBe(14);
    expect(hasMoreOlder).toBe(false);
  });

  it('deduplicates overlapping messages across pages', async () => {
    // Simulate a server that returns overlapping pages (race condition).
    // Page 1: msgs 60-105
    // Page 2: msgs 40-79 (overlaps with page 1 on 60-79)
    // Page 3: msgs 0-39
    const msgs = makeMessages(200);
    const server = mockServer(msgs);
    let pageNum = 0;
    const origListMessages = server.listMessages.bind(server);
    server.listMessages = (opts) => {
      pageNum++;
      if (pageNum === 1)
        return { messages: msgs.slice(60, 106), hasMore: true };
      if (pageNum === 2) return { messages: msgs.slice(40, 80), hasMore: true };
      // Page 3+: normal pagination from beforeId
      return origListMessages(opts);
    };
    const { allHistory } = await backfillHistory(server);
    // All seqs should be unique — the overlapping messages (60-79 from page 2) were
    // filtered because 60-79 were already loaded from page 1.
    const seen = new Set<number>();
    for (const m of allHistory) {
      if (seen.has(m.seq)) {
        expect.fail(`duplicate seq ${m.seq} found — dedup failed`);
      }
      seen.add(m.seq);
    }
    // Page 1: 60-105 (46 msgs), Page 2: 40-59 (dedup'd 60-79, only 40-59 new = 20 msgs), Page 3: 0-39 (40 msgs)
    // Total: 46 + 20 + 40 = 106
    expect(allHistory.length).toBe(106);
    expect(allHistory[0].seq).toBe(0);
    expect(allHistory[allHistory.length - 1].seq).toBe(105);
  });

  it('handles a page where every message is a duplicate (break immediately)', async () => {
    const msgs = makeMessages(200);
    const server = mockServer(msgs);
    let pageNum = 0;
    const origListMessages = server.listMessages.bind(server);
    server.listMessages = (opts) => {
      pageNum++;
      if (pageNum <= 2) return origListMessages(opts); // normal first 2 pages
      // 3rd+ call: return the exact messages we already have (all dupes)
      return { messages: msgs.slice(160, 200), hasMore: false };
    };
    const { allHistory } = await backfillHistory(server);
    // Should have loaded only from the first 2 real pages; dup pages were skipped
    // 2 pages = 80 messages (normal). But the mock's 3rd call has hasMore=false
    // and all messages are dupes → newMsgs.length === 0 → break.
    // So we should have > 0 and <= 80 messages.
    // Actually the first 2 pages give us msgs[160..200] and msgs[120..160] = 80 messages.
    expect(allHistory.length).toBe(80);
    expect(pageNum).toBe(3); // called 3 times, 3rd call all-dupes → break
    expect(allHistory[0].seq).toBe(120);
    expect(allHistory[allHistory.length - 1].seq).toBe(199);
  });
});

describe('loadOlderMessages window trimming', () => {
  it('trims from the newest end when window overflows on older load', () => {
    // Simulate the loadOlderMessages algorithm:
    // fresh (older messages) prepended to prev, then slice to WINDOW_MAX
    const fresh = makeMessages(20).map((m) => ({
      ...m,
      id: `older_${m.id}`,
      seq: m.seq,
    })); // seq 0..19
    const prev = makeMessages(490).map((m) => ({
      ...m,
      id: `prev_${m.id}`,
      seq: m.seq + 20,
    })); // seq 20..509

    let next: WireMessage[] = [...fresh, ...prev]; // 20 + 490 = 510 > 500
    expect(next.length).toBe(510);

    if (next.length > WINDOW_MAX) {
      const drop = next.length - WINDOW_MAX;
      next = next.slice(0, next.length - drop); // keep first N, drop from end
    }

    expect(next.length).toBe(WINDOW_MAX);
    // Newest messages (from the end of `prev`) are dropped.
    // The last element was `prev_...` with seq 509, now should be earlier
    expect(next[next.length - 1].seq).toBeLessThan(509);
    // The first element is unchanged (oldest fresh)
    expect(next[0].id.startsWith('older_')).toBe(true);
    // hasMoreNewer should be set to true (we dropped from the newer end)
  });

  it('loadNewerMessages trims from the OLDEST end', () => {
    const prev = makeMessages(490).map((m) => ({
      ...m,
      id: `prev_${m.id}`,
      seq: m.seq,
    })); // 0..489
    const fresh = makeMessages(20).map((m) => ({
      ...m,
      id: `newer_${m.id}`,
      seq: m.seq + 490,
    })); // 490..509

    let next: WireMessage[] = [...prev, ...fresh]; // 510 > 500
    expect(next.length).toBe(510);

    if (next.length > WINDOW_MAX) {
      const drop = next.length - WINDOW_MAX;
      next = next.slice(drop); // drop from start → keep newer messages
    }

    expect(next.length).toBe(WINDOW_MAX);
    // Oldest messages (from start of prev) are dropped.
    expect(next[0].seq).toBeGreaterThan(0);
    // Newest messages preserved at the end
    expect(next[next.length - 1].id.startsWith('newer_')).toBe(true);
  });
});
