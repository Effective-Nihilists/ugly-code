// Hidden regression suites for L6 tasks. Vendored here — NOT in the fixture repo —
// so the agent cannot read the tests it is being graded against, let alone tune to
// them. Injected at grade time, run, then removed. Same containment rule as
// evals/sbp/registry.ts and evals/l6/mutation.ts.

export interface HiddenSuite {
  /** Repo-relative path the suite is written to before it is run. */
  path: string;
  content: string;
}

const SUITES: Record<string, HiddenSuite> = {
  "l6-surgical-fix": {
    path: "tests/__hidden__.test.ts",
    content:
      "import { describe, it, expect } from 'vitest';\nimport { prorate } from '../src/proration';\nimport { roundCents, toCents, formatCents } from '../src/money';\nimport { PLANS } from '../src/plans';\n\ndescribe('INC-2291: credits and charges round to the same magnitude', () => {\n  it('credits the reported incident correctly', () => {\n    expect(prorate({ fromPlanId: 'pro', toPlanId: 'starter', daysUsed: 23, daysInPeriod: 32 })).toBe(-563);\n  });\n\n  it('still charges the mirror-image upgrade correctly', () => {\n    expect(prorate({ fromPlanId: 'starter', toPlanId: 'pro', daysUsed: 23, daysInPeriod: 32 })).toBe(563);\n  });\n\n  it('credits another exact-half-cent downgrade', () => {\n    expect(prorate({ fromPlanId: 'scale', toPlanId: 'pro', daysUsed: 15, daysInPeriod: 16 })).toBe(-438);\n  });\n\n  // The property the incident is really about. A hardcoded special case for the\n  // two examples above will not survive this.\n  it('charge and credit are symmetric for every plan pair and every day', () => {\n    for (const a of PLANS) {\n      for (const b of PLANS) {\n        for (const daysInPeriod of [28, 29, 30, 31, 32]) {\n          for (let daysUsed = 0; daysUsed <= daysInPeriod; daysUsed++) {\n            const up = prorate({ fromPlanId: a.id, toPlanId: b.id, daysUsed, daysInPeriod });\n            const down = prorate({ fromPlanId: b.id, toPlanId: a.id, daysUsed, daysInPeriod });\n            expect(Math.abs(up)).toBe(Math.abs(down));\n          }\n        }\n      }\n    }\n  });\n});\n\ndescribe('the fix lives in the shared rounding chokepoint', () => {\n  it('roundCents rounds half away from zero', () => {\n    expect(roundCents(0.5)).toBe(1);\n    expect(roundCents(-0.5)).toBe(-1);\n    expect(roundCents(1.5)).toBe(2);\n    expect(roundCents(-1.5)).toBe(-2);\n    expect(roundCents(2.4)).toBe(2);\n    expect(roundCents(-2.4)).toBe(-2);\n  });\n\n  it('toCents inherits the rule', () => {\n    expect(toCents(-0.125)).toBe(-13);\n    expect(toCents(0.125)).toBe(13);\n  });\n});\n\ndescribe('nothing else moved', () => {\n  it('preserves the original proration behaviour', () => {\n    expect(prorate({ fromPlanId: 'starter', toPlanId: 'pro', daysUsed: 0, daysInPeriod: 30 })).toBe(2000);\n    expect(prorate({ fromPlanId: 'starter', toPlanId: 'pro', daysUsed: 15, daysInPeriod: 30 })).toBe(1000);\n    expect(prorate({ fromPlanId: 'pro', toPlanId: 'pro', daysUsed: 10, daysInPeriod: 30 })).toBe(0);\n    expect(() => prorate({ fromPlanId: 'pro', toPlanId: 'starter', daysUsed: 1, daysInPeriod: 0 })).toThrow();\n    expect(() => prorate({ fromPlanId: 'pro', toPlanId: 'starter', daysUsed: -1, daysInPeriod: 30 })).toThrow();\n  });\n\n  it('preserves formatting', () => {\n    expect(formatCents(-563)).toBe('-$5.63');\n    expect(formatCents(2900)).toBe('$29.00');\n    expect(formatCents(0)).toBe('$0.00');\n  });\n});\n",
  },
};

export function getHiddenSuite(taskName: string): HiddenSuite | undefined {
  return SUITES[taskName];
}
