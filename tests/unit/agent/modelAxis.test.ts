import { describe, it, expect } from 'vitest';
import type {
  MaxModeCallbacks,
  MaxModePeer,
  PeerProvider,
} from '../../../client/studio/agent/patterns/peerTypes';
import { getPattern } from '../../../client/studio/agent/patterns/registry';
import {
  runMidFanout,
  synthBoundaryOf,
} from '../../../client/studio/agent/patterns/mid-mode-host';
import { runMaxMode } from '../../../client/studio/agent/patterns/max-mode-host';
import { runGroupMode } from '../../../client/studio/agent/patterns/group-mode-host';
import { resolveModel } from '../../../client/studio/agent/patterns/resolve-model';

// A recording stub for MaxModeCallbacks — captures the host's peer interactions so
// tests can assert spawn/settle/teardown counts and winner selection without a real
// session runtime (the monolith's own host-agnostic test strategy).
function stub(): {
  cb: MaxModeCallbacks;
  log: string[];
  spawned: MaxModePeer[];
} {
  const log: string[] = [];
  const spawned: MaxModePeer[] = [];
  const cb: MaxModeCallbacks = {
    async spawnPeers(modelIds, opts) {
      const peers = modelIds.map((m, i) => ({
        id: `peer${i}`,
        modelId: m,
        cwd: `/wt/${i}`,
        ...(opts?.personas?.[i] ? { persona: opts.personas[i] as string } : {}),
      }));
      spawned.push(...peers);
      log.push(`spawn[${opts?.peerKind ?? 'single'}]:${modelIds.join(',')}`);
      return peers;
    },
    async sendToPeerAndSettle(peer, text) {
      log.push(`send:${peer.modelId}`);
      void text;
    },
    async tearDownPeer(peer) {
      log.push(`teardown:${peer.modelId}`);
    },
    async getPeerDiff(peer) {
      return `diff-${peer.modelId}`;
    },
    async getPeerSpec(peer) {
      return `spec-${peer.modelId}`;
    },
  };
  return { cb, log, spawned };
}

const pickerProvider: PeerProvider = {
  async complete() {
    return '{"winner": 1, "reason": "stub picks #1"}';
  },
};
const specProvider: PeerProvider = {
  async complete() {
    return 'CONSOLIDATED SUPER SPEC BODY';
  },
};

describe('synthBoundaryOf', () => {
  it('is the index of the first edit-family step', () => {
    expect(synthBoundaryOf(getPattern('spec-build-verify')!)).toBe(1); // build @ 1
    expect(synthBoundaryOf(getPattern('investigate-fix')!)).toBe(2); // fix @ 2
    expect(synthBoundaryOf(getPattern('quick-edit')!)).toBe(0); // edit @ 0
    // chat-qa has no edit step → boundary = steps.length (nothing to widen)
    expect(synthBoundaryOf(getPattern('chat-qa')!)).toBe(1);
  });
});

describe('runMidFanout (mid-mode / super-*)', () => {
  it('fans SPEC out to the pool, synthesizes, tears every peer down, returns injection', async () => {
    const { cb, log } = stub();
    const res = await runMidFanout({
      pattern: getPattern('spec-build-verify')!,
      userRequest: 'add a widget',
      peerModels: ['m1', 'm2', 'm3'],
      callbacks: cb,
      provider: specProvider,
    });
    expect(res.synthBoundary).toBe(1);
    expect(res.superSpec).toContain('CONSOLIDATED SUPER SPEC');
    expect(res.injection.length).toBeGreaterThan(0);
    // 3 peers spawned + torn down; SPEC (1 pre-step) sent to each.
    expect(log.filter((l) => l.startsWith('spawn')).length).toBe(1);
    expect(
      log.filter((l) => l === 'send:m1' || l === 'send:m2' || l === 'send:m3')
        .length,
    ).toBe(3);
    expect(log.filter((l) => l.startsWith('teardown')).length).toBe(3);
  });

  it('degenerates safely with no pool', async () => {
    const { cb } = stub();
    const res = await runMidFanout({
      pattern: getPattern('spec-build-verify')!,
      userRequest: 'x',
      peerModels: [],
      callbacks: cb,
      provider: specProvider,
    });
    expect(res.injection).toBe('');
    expect(res.synthBoundary).toBe(0);
  });
});

describe('runMaxMode', () => {
  it('runs every step across peers, picks the winner, tears down only losers', async () => {
    const { cb, log } = stub();
    const res = await runMaxMode({
      pattern: getPattern('spec-build-verify')!,
      userRequest: 'add a widget',
      peerModels: ['m0', 'm1', 'm2'],
      callbacks: cb,
      provider: pickerProvider,
      pollinator: 'none', // keep the test deterministic (no insight calls)
    });
    expect(res.winner.modelId).toBe('m1'); // picker chose index 1
    expect(res.winnerDiff).toBe('diff-m1');
    // 3 steps × 3 peers = 9 sends.
    expect(log.filter((l) => l.startsWith('send:')).length).toBe(9);
    // losers m0 + m2 torn down; winner m1 kept.
    expect(
      log.filter((l) => l === 'teardown:m0' || l === 'teardown:m2').length,
    ).toBe(2);
    expect(log).not.toContain('teardown:m1');
  });
});

describe('runGroupMode', () => {
  it('spawns persona peers, one kickoff each, picks a winner over diffs', async () => {
    const { cb, log } = stub();
    const res = await runGroupMode({
      userRequest: 'refactor the auth flow',
      peerModels: ['m0', 'm1', 'm2'],
      callbacks: cb,
      provider: pickerProvider,
    });
    expect(res.winner.modelId).toBe('m1');
    expect(res.peerDiffs).toHaveLength(3);
    expect(res.peerDiffs.find((d) => d.model === 'm1')?.isWinner).toBe(true);
    expect(log.filter((l) => l.startsWith('spawn[group]')).length).toBe(1);
    // one kickoff send per peer.
    expect(log.filter((l) => l.startsWith('send:')).length).toBe(3);
    // losers torn down, winner kept.
    expect(log).not.toContain('teardown:m1');
  });
});

describe('resolveModel', () => {
  it('maps tiers to concrete ids and honors an allowlist', () => {
    expect(resolveModel({ hint: 'strong' })).toBe('deepseek_v4_pro');
    expect(typeof resolveModel({ hint: 'cheap' })).toBe('string');
    expect(resolveModel({ hint: 'strong', allowlist: ['minimax_m2_7'] })).toBe(
      'minimax_m2_7',
    );
  });
});
