import type { Experiment } from 'ugly-app/shared';

// ─── Event names ──────────────────────────────────────────────────────────────
// Extend this union as you add more trackable events. Use ALL_CAPS convention.
export type AppEventName = 'SESSION_START' | 'CTA_CLICK';

// ─── Experiments ──────────────────────────────────────────────────────────────
// Define A/B experiments here. Set active: false to pause an experiment.
// weights are relative — { weight: 1 } on both branches means 50/50 split.
//
// After adding an experiment, reference experiments in:
//   - server/index.ts handlers (getExperimentAssignments)
//   - client pages (initSession return value)
export const experiments: Experiment<AppEventName>[] = [
  {
    id: 'cta-test',
    name: 'CTA Button Copy',
    description: 'Tests two versions of the homepage CTA button label',
    branches: [
      { id: 'control',   name: 'Control',   weight: 1 },
      { id: 'treatment', name: 'Treatment', weight: 1 },
    ],
    events: ['SESSION_START', 'CTA_CLICK'],
    active: true,
  },
];
