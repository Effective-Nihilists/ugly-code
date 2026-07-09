/**
 * Tests for the chat virtualization layer:
 *   1. @tanstack/virtual-core Virtualizer (v3) — framework-agnostic core,
 *      tested with mock scroll elements in Node.
 *   2. Pin-to-bottom logic extracted from CodingAgentChat — scroll pinning
 *      and its gating conditions (userScrolledRef, isLoadingOlder/Newer, …).
 *   3. ResizeObserver-based re-pin gate — verifies the gate conditions.
 *   4. getItemKey — message id vs index fallback.
 *   5. Critique group indexing — user message grouping with critique markers.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Virtualizer,
  observeElementRect,
  observeElementOffset,
} from '@tanstack/virtual-core';

// ── Mock element helpers ─────────────────────────────────────────────────────

/** Create a minimal scroll element mock for the Virtualizer v3.
 *  Virtualizer v3 needs:
 *  - offsetWidth/Height → getRect
 *  - scrollTop/scrollHeight → scroll position
 *  - addEventListener('scroll', …) → scroll tracking
 *  - ownerDocument.defaultView → targetWindow (with rAF, ResizeObserver, …)
 */
function createScrollMock(
  viewportPx = 600,
  contentPx = 20000,
): HTMLDivElement & { _triggerScroll(top: number): void } {
  const scrollListeners = new Set<() => void>();

  const targetWindow = {
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
  };

  const el = {
    offsetWidth: 800,
    offsetHeight: viewportPx,
    scrollTop: 0,
    scrollHeight: contentPx,
    addEventListener: (_event: string, cb: () => void) => { scrollListeners.add(cb); },
    removeEventListener: (_event: string, cb: () => void) => { scrollListeners.delete(cb); },
    ownerDocument: { defaultView: targetWindow },
    _triggerScroll(top: number) {
      this.scrollTop = top;
      for (const cb of scrollListeners) cb();
    },
  } as unknown as HTMLDivElement & { _triggerScroll(top: number): void };

  return el;
}

/** Synchronous scrollToFn for tests: sets scrollTop directly.
 *  The default elementScroll relies on element.scrollTo() which is
 *  async via the Virtualizer's rAF reconcile loop; our sync version
 *  writes scrollTop immediately so test assertions see the result. */
function syncScrollToFn(
  offset: number,
  opts: { adjustments?: number; behavior?: string },
  instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
): void {
  const el = instance.scrollElement;
  if (el) {
    el.scrollTop = offset + (opts.adjustments ?? 0);
  }
}

// ── 1. Virtualizer core tests ───────────────────────────────────────────────

describe('Virtualizer (core, @tanstack/virtual-core v3)', () => {
  function makeVirtualizer(
    opts: Partial<import('@tanstack/virtual-core').VirtualizerOptions<HTMLDivElement, HTMLDivElement>> = {},
  ) {
    const el = createScrollMock();
    const v = new Virtualizer({
      count: 10,
      getScrollElement: () => el,
      estimateSize: () => 120,
      overscan: 0,
      observeElementRect,
      observeElementOffset,
      scrollToFn: syncScrollToFn,
      ...opts,
    });
    v._didMount();
    v._willUpdate();
    return { v, el };
  }

  it('returns zero virtual items when count is 0', () => {
    const { v } = makeVirtualizer({ count: 0 });
    expect(v.getTotalSize()).toBe(0);
    expect(v.getVirtualItems()).toHaveLength(0);
  });

  it('estimates total size from count × estimateSize', () => {
    const { v } = makeVirtualizer({ count: 10, estimateSize: () => 120 });
    expect(v.getTotalSize()).toBe(10 * 120);
  });

  it('returns virtual items within the viewport', () => {
    const el = createScrollMock(600, 600 * 100);
    const v = new Virtualizer({
      count: 100,
      getScrollElement: () => el,
      estimateSize: () => 120, // 5 items per 600px viewport
      overscan: 0,
      observeElementRect,
      observeElementOffset,
      scrollToFn: syncScrollToFn,
    });
    v._didMount();
    v._willUpdate();

    const items = v.getVirtualItems();
    expect(items.length).toBeGreaterThanOrEqual(5);
    expect(items[0].index).toBe(0);
    expect(items[items.length - 1].index).toBeGreaterThanOrEqual(4);
  });

  it('shifts virtual items when scrolled down', () => {
    const el = createScrollMock(600, 600 * 100);
    const v = new Virtualizer({
      count: 100,
      getScrollElement: () => el,
      estimateSize: () => 120,
      overscan: 0,
      observeElementRect,
      observeElementOffset,
      scrollToFn: syncScrollToFn,
    });
    v._didMount();
    v._willUpdate();

    el._triggerScroll(600);
    v._willUpdate();
    expect(v.getVirtualItems()[0].index).toBe(5);
  });

  it('overscan includes extra items beyond the viewport', () => {
    const { v } = makeVirtualizer({
      count: 100,
      estimateSize: () => 120,
      overscan: 8,
    });
    const items = v.getVirtualItems();
    // 5 items in viewport (600/120), +8 overscan each side → ~21
    expect(items.length).toBeGreaterThanOrEqual(10);
    expect(items.length).toBeLessThanOrEqual(25);
  });

  it('resizeItem updates a single item size and total', () => {
    const { v } = makeVirtualizer({ count: 5, estimateSize: () => 120 });
    const before = v.getTotalSize(); // 5 × 120 = 600

    v.resizeItem(2, 300);
    expect(v.getTotalSize()).toBe(before + (300 - 120));
  });

  it('getTotalSize grows when count increases via setOptions', () => {
    const { v } = makeVirtualizer({ count: 10, estimateSize: () => 120 });
    expect(v.getTotalSize()).toBe(10 * 120);

    v.setOptions({
      count: 20,
      getScrollElement: () => v.scrollElement ?? createScrollMock(),
      estimateSize: () => 120,
      overscan: 0,
      observeElementRect,
      observeElementOffset,
      scrollToFn: syncScrollToFn,
    });
    v._willUpdate();
    expect(v.getTotalSize()).toBe(20 * 120);
  });
});

// ── 2. getItemKey — message id fallback ──────────────────────────────────────

describe('getItemKey (message id fallback)', () => {
  /** Replicates the getItemKey callback from CodingAgentChat.tsx ~line 7020. */
  function getItemKey(i: number, msgs: { id: string }[]): number | string {
    return msgs[i]?.id ?? i;
  }

  it('returns the message id when the item exists', () => {
    const msgs = [{ id: 'msg_abc' }, { id: 'msg_def' }];
    expect(getItemKey(0, msgs)).toBe('msg_abc');
    expect(getItemKey(1, msgs)).toBe('msg_def');
  });

  it('falls back to index when the item is undefined (out of range)', () => {
    const msgs: { id: string }[] = [{ id: 'msg_abc' }];
    expect(getItemKey(1, msgs)).toBe(1);
    expect(getItemKey(999, msgs)).toBe(999);
  });

  it('falls back to index when id is falsy', () => {
    const msgs = [{ id: 'msg_abc' }, {} as { id: string }];
    expect(getItemKey(1, msgs)).toBe(1);
  });
});

// ── 3. Pin-to-bottom logic ──────────────────────────────────────────────────

describe('pinToBottom gating', () => {
  function makeScrollEl(initialScrollHeight = 2000) {
    return { scrollTop: 0, scrollHeight: initialScrollHeight };
  }

  it('pins by setting scrollTop = scrollHeight when user has not scrolled up', () => {
    const el = makeScrollEl(2000);
    const userScrolled = { current: false };
    const pinToBottom = () => {
      if (userScrolled.current) return;
      el.scrollTop = el.scrollHeight;
    };
    pinToBottom();
    expect(el.scrollTop).toBe(2000);
  });

  it('does NOT pin when the user has scrolled up', () => {
    const el = makeScrollEl(2000);
    const userScrolled = { current: true };
    const pinToBottom = () => {
      if (userScrolled.current) return;
      el.scrollTop = el.scrollHeight;
    };
    pinToBottom();
    expect(el.scrollTop).toBe(0);
  });

  it('is a no-op when the scroll element is null', () => {
    const pinToBottom = (el: { scrollTop: number; scrollHeight: number } | null) => {
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    };
    expect(() => pinToBottom(null)).not.toThrow();
  });

  it('re-pins after user scrolls back to bottom', () => {
    const el = makeScrollEl(2000);
    const userScrolled = { current: true };
    const pinToBottom = () => {
      if (userScrolled.current) return;
      el.scrollTop = el.scrollHeight;
    };
    // User scrolled up → blocked
    pinToBottom();
    expect(el.scrollTop).toBe(0);

    // User scrolls back → unblocks
    userScrolled.current = false;
    pinToBottom();
    expect(el.scrollTop).toBe(2000);
  });
});

// ── 4. ResizeObserver re-pin gate ────────────────────────────────────────────

describe('ResizeObserver re-pin gate', () => {
  /** Simulates the ResizeObserver callback from CodingAgentChat ~line 7105. */
  function createRORepin(pinGate: {
    isLoadingOlder: boolean;
    isLoadingNewer: boolean;
    hasMoreNewer: boolean;
  }) {
    const pinToBottom = vi.fn();
    const roCallback = () => {
      const g = pinGate;
      if (g.isLoadingOlder || g.isLoadingNewer || g.hasMoreNewer) return;
      pinToBottom();
    };
    return { pinToBottom, roCallback };
  }

  it('calls pinToBottom when no gate is active', () => {
    const { pinToBottom, roCallback } = createRORepin({
      isLoadingOlder: false,
      isLoadingNewer: false,
      hasMoreNewer: false,
    });
    roCallback();
    expect(pinToBottom).toHaveBeenCalledTimes(1);
  });

  it.each([
    { desc: 'isLoadingOlder', field: 'isLoadingOlder' as const },
    { desc: 'isLoadingNewer', field: 'isLoadingNewer' as const },
    { desc: 'hasMoreNewer', field: 'hasMoreNewer' as const },
  ])('blocks pinToBottom when $desc is true', ({ field }) => {
    const pinGate = {
      isLoadingOlder: false,
      isLoadingNewer: false,
      hasMoreNewer: false,
      [field]: true,
    };
    const { pinToBottom, roCallback } = createRORepin(pinGate);
    roCallback();
    expect(pinToBottom).not.toHaveBeenCalled();
  });

  it('blocks when ALL gates are active', () => {
    const { pinToBottom, roCallback } = createRORepin({
      isLoadingOlder: true,
      isLoadingNewer: true,
      hasMoreNewer: true,
    });
    roCallback();
    expect(pinToBottom).not.toHaveBeenCalled();
  });

  it('unblocks after a gate clears', () => {
    const pinGate = { isLoadingOlder: true, isLoadingNewer: false, hasMoreNewer: false };
    const { pinToBottom, roCallback } = createRORepin(pinGate);

    roCallback();
    expect(pinToBottom).not.toHaveBeenCalled();

    pinGate.isLoadingOlder = false;
    roCallback();
    expect(pinToBottom).toHaveBeenCalledTimes(1);
  });
});

// ── 5. Display message grouping (critique markers) ──────────────────────────

describe('critique group indexing', () => {
  /** Extracted from CodingAgentChat — groups user messages by
   *  CRITIQUE_MARKER_CLIENT to track critique iterations. */
  const CRITIQUE_MARKER_CLIENT = '🔍 [This is an automated code review]';

  function computeCritiqueGroups(
    messages: { role: string; content: string }[],
  ): { critiqueGroupIndex: Record<number, number>; critiqueGroupTotal: number[] } {
    const total: number[] = [];
    const idx: Record<number, number> = {};
    let groupStart = 0;
    let seenInGroup = 0;
    const finalizeGroup = (end: number) => {
      for (let j = groupStart; j < end; j++) {
        total[j] = seenInGroup;
      }
    };
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'user' && !m.content.includes(CRITIQUE_MARKER_CLIENT)) {
        finalizeGroup(i);
        groupStart = i;
        seenInGroup = 0;
      } else if (m.role === 'user' && m.content.includes(CRITIQUE_MARKER_CLIENT)) {
        seenInGroup += 1;
        idx[i] = seenInGroup;
      }
    }
    finalizeGroup(messages.length);
    return { critiqueGroupIndex: idx, critiqueGroupTotal: total };
  }

  it('assigns group total 0 for a single normal user message', () => {
    const msgs = [{ role: 'user', content: 'hello' }];
    const { critiqueGroupTotal } = computeCritiqueGroups(msgs);
    expect(critiqueGroupTotal[0]).toBe(0);
  });

  it('groups critique messages after a user message', () => {
    const msgs = [
      { role: 'user', content: 'fix this bug' },
      { role: 'user', content: '🔍 [This is an automated code review]\nfoo' },
      { role: 'user', content: '🔍 [This is an automated code review]\nbar' },
    ];
    const { critiqueGroupTotal, critiqueGroupIndex } = computeCritiqueGroups(msgs);
    expect(critiqueGroupTotal).toEqual([2, 2, 2]);
    expect(critiqueGroupIndex[1]).toBe(1);
    expect(critiqueGroupIndex[2]).toBe(2);
  });

  it('resets group count on a new normal user message', () => {
    const msgs = [
      { role: 'user', content: 'first prompt' },
      { role: 'user', content: '🔍 [This is an automated code review]\nfix?' },
      { role: 'user', content: 'second prompt' },
      { role: 'user', content: '🔍 [This is an automated code review]\nstill?' },
    ];
    const { critiqueGroupTotal, critiqueGroupIndex } = computeCritiqueGroups(msgs);
    expect(critiqueGroupTotal).toEqual([1, 1, 1, 1]);
    expect(critiqueGroupIndex[1]).toBe(1);
    expect(critiqueGroupIndex[3]).toBe(1);
  });

  it('assigns total 0 for assistant messages that precede a user message', () => {
    const msgs = [
      { role: 'assistant', content: 'some code' },
      { role: 'user', content: 'hello' },
    ];
    const { critiqueGroupTotal } = computeCritiqueGroups(msgs);
    // The first finalizeGroup fires at index 1 (the user message), setting
    // total[0] = 0. The user message itself gets total[1] = 0.
    // Both are valid — the group has 0 critiques.
    expect(critiqueGroupTotal[0]).toBe(0);
    expect(critiqueGroupTotal[1]).toBe(0);
  });

  it('tracks three consecutive critiques in one group', () => {
    const msgs = [
      { role: 'user', content: 'do it' },
      { role: 'user', content: '🔍 [This is an automated code review]\na' },
      { role: 'user', content: '🔍 [This is an automated code review]\nb' },
      { role: 'user', content: '🔍 [This is an automated code review]\nc' },
    ];
    const { critiqueGroupTotal } = computeCritiqueGroups(msgs);
    expect(critiqueGroupTotal).toEqual([3, 3, 3, 3]);
  });

  it('assigns incremental critique indices within a group', () => {
    const msgs = [
      { role: 'user', content: 'do it' },
      { role: 'user', content: '🔍 [This is an automated code review]\n1' },
      { role: 'user', content: '🔍 [This is an automated code review]\n2' },
    ];
    const { critiqueGroupIndex } = computeCritiqueGroups(msgs);
    expect(critiqueGroupIndex[1]).toBe(1);
    expect(critiqueGroupIndex[2]).toBe(2);
    expect(critiqueGroupIndex[0]).toBeUndefined();
  });
});
