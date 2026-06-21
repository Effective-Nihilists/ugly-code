import React from 'react';
import AgentPanel from '../agent/AgentPanel';

/**
 * Test fixture for the coding-agent loop (`tests/e2e/agent.spec.ts` +
 * `agent.smoke.spec.ts`). Mounts the real {@link AgentPanel} on a stable,
 * unauthenticated route so e2e can drive the full client-side agent loop:
 *
 *   - DETERMINISTIC path: the spec installs the `ugly-app/playwright`
 *     UglyNative mock (so fs/process tool calls resolve in-page) and a
 *     `window.__uglyCodeAgentStep` override (a scripted model), so the loop +
 *     tools + UI run offline with no server or AI.
 *   - REAL smoke path: the spec injects the user's `auth_token` cookie and
 *     omits the step override, so `AgentPanel` calls the real `/api/agentStep`
 *     endpoint → ugly.bot textGen.
 *
 * Production reaches AgentPanel only inside the Studio shell (CodeEditorPage);
 * this fixture exists purely so the panel is addressable by URL for tests, the
 * same convention the inspect/scroll fixtures use.
 */
export default function AgentFixturePage(): React.ReactElement {
  return (
    <div
      data-id="agent-fixture"
      style={{ height: '100dvh', display: 'flex', justifyContent: 'flex-end', background: '#0b0907' }}
    >
      <AgentPanel />
    </div>
  );
}
