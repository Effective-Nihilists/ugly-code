// Hidden grading data for mutation-scored eval tasks. Vendored here — NOT in the
// fixture repo — so the agent under test never sees which bugs its suite must catch.
// Same containment rule as evals/sbp/registry.ts.
//
// Target: a 32-function collection/numeric toolkit. 50 mutants (31 adversarial:
// degenerate inputs, ties, duplicates, NaN, negative counts, immutability) + 9
// equivalents. Calibration: a paranoid suite kills 50/50; a competent happy-path
// suite kills far fewer; the inherited "100% coverage" suite lower still. The surface
// is deliberately too large to test exhaustively in-budget — prioritisation is the
// discriminator. Do NOT enumerate these in the task ticket.

export interface Mutant {
  id: string;
  desc: string;
  find: string;
  replace: string;
}

export interface EquivalentMutant {
  id: string;
  find: string;
  replace: string;
}

export interface MutationSuite {
  target: string;
  mutants: Mutant[];
  equivalents: EquivalentMutant[];
}

const SUITES: Record<string, MutationSuite> = {
  "l6-test-suite-mutation": {
    target: "src/kit.ts",
    mutants: [
      {
        "id": "clamp-throw",
        "desc": "clamp does not throw when lo > hi",
        "find": "if (lo > hi) throw new Error('clamp: lo must be <= hi');",
        "replace": "if (lo > hi + 1) throw new Error('clamp: lo must be <= hi');"
      },
      {
        "id": "clamp-below",
        "desc": "clamp returns hi instead of lo below the range",
        "find": "if (x < lo) return lo;",
        "replace": "if (x < lo) return hi;"
      },
      {
        "id": "inrange-end",
        "desc": "inRange includes the exclusive upper bound",
        "find": "return x >= a && x < b;",
        "replace": "return x >= a && x <= b;"
      },
      {
        "id": "inrange-noswap",
        "desc": "inRange does not swap reversed bounds",
        "find": "const a = Math.min(lo, hi);\n  const b = Math.max(lo, hi);",
        "replace": "const a = lo;\n  const b = hi;"
      },
      {
        "id": "round-sign",
        "desc": "roundTo does not restore the sign of negatives",
        "find": "return x < 0 ? -r : r;",
        "replace": "return r;"
      },
      {
        "id": "round-floor",
        "desc": "roundTo floors instead of rounding half away from zero",
        "find": "const r = Math.round(Math.abs(x) * f) / f;",
        "replace": "const r = Math.floor(Math.abs(x) * f) / f;"
      },
      {
        "id": "round-default",
        "desc": "roundTo default dp is 1, not 0",
        "find": "export function roundTo(x: number, dp = 0): number {",
        "replace": "export function roundTo(x: number, dp = 1): number {"
      },
      {
        "id": "gcd-absa",
        "desc": "gcd does not take the absolute value of a",
        "find": "  a = Math.abs(a);\n  b = Math.abs(b);",
        "replace": "  a = a;\n  b = Math.abs(b);"
      },
      {
        "id": "lcm-abs",
        "desc": "lcm can return a negative multiple",
        "find": "return Math.abs(a / gcd(a, b) * b);",
        "replace": "return a / gcd(a, b) * b;"
      },
      {
        "id": "sum-noinit",
        "desc": "sum has no initial value and throws on the empty array",
        "find": "return xs.reduce((a, b) => a + b, 0);",
        "replace": "return xs.reduce((a, b) => a + b);"
      },
      {
        "id": "mean-noempty",
        "desc": "mean does not throw on the empty array (returns NaN)",
        "find": "if (xs.length === 0) throw new Error('mean: empty array');",
        "replace": "if (xs.length < 0) throw new Error('mean: empty array');"
      },
      {
        "id": "median-mutates",
        "desc": "median sorts the caller's array in place",
        "find": "const s = xs.slice().sort((a, b) => a - b);",
        "replace": "const s = xs.sort((a, b) => a - b);"
      },
      {
        "id": "median-noavg",
        "desc": "median of an even count returns the sum of the two middles, not their average",
        "find": "s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!",
        "replace": "s.length % 2 === 0 ? s[mid - 1]! + s[mid]! : s[mid]!"
      },
      {
        "id": "median-mid",
        "desc": "median uses the wrong middle index for odd counts",
        "find": "const mid = Math.floor(s.length / 2);",
        "replace": "const mid = Math.ceil(s.length / 2);"
      },
      {
        "id": "chunk-noninteger",
        "desc": "chunk accepts a fractional n instead of throwing",
        "find": "if (!Number.isInteger(n) || n < 1) throw new Error('chunk: n must be a positive integer');",
        "replace": "if (n < 1) throw new Error('chunk: n must be a positive integer');"
      },
      {
        "id": "take-negative",
        "desc": "take with a negative n slices from the end instead of yielding []",
        "find": "return xs.slice(0, Math.max(0, n));",
        "replace": "return xs.slice(0, n);"
      },
      {
        "id": "drop-negative",
        "desc": "drop with a negative n keeps a tail instead of the whole array",
        "find": "return xs.slice(Math.max(0, n));",
        "replace": "return xs.slice(n);"
      },
      {
        "id": "takewhile-continue",
        "desc": "takeWhile keeps scanning after the predicate first fails",
        "find": "    if (!pred(x)) break;\n    out.push(x);",
        "replace": "    if (!pred(x)) continue;\n    out.push(x);"
      },
      {
        "id": "takewhile-invert",
        "desc": "takeWhile inverts its predicate",
        "find": "if (!pred(x)) break;",
        "replace": "if (pred(x)) break;"
      },
      {
        "id": "dropwhile-invert",
        "desc": "dropWhile inverts its predicate",
        "find": "while (i < xs.length && pred(xs[i]!)) i++;",
        "replace": "while (i < xs.length && !pred(xs[i]!)) i++;"
      },
      {
        "id": "eq-nan",
        "desc": "SameValueZero equality is broken for NaN (uniq keeps both NaNs)",
        "find": "return a === b || (a !== a && b !== b);",
        "replace": "return a === b;"
      },
      {
        "id": "uniq-invert",
        "desc": "uniq keeps only the duplicates",
        "find": "if (!out.some((y) => eq(x, y))) out.push(x);",
        "replace": "if (out.some((y) => eq(x, y))) out.push(x);"
      },
      {
        "id": "uniqby-invert",
        "desc": "uniqBy keeps only the duplicates",
        "find": "if (!seen.some((s) => eq(k, s))) {",
        "replace": "if (seen.some((s) => eq(k, s))) {"
      },
      {
        "id": "groupby-reset",
        "desc": "groupBy resets each group, keeping only the last element per key",
        "find": "(out[k] ??= []).push(x);",
        "replace": "(out[k] = []).push(x);"
      },
      {
        "id": "countby-noinc",
        "desc": "countBy never increments past the first",
        "find": "out[k] = (out[k] ?? 0) + 1;",
        "replace": "out[k] = (out[k] ?? 0);"
      },
      {
        "id": "partition-swap",
        "desc": "partition returns [fail, pass]",
        "find": "for (const x of xs) (pred(x) ? pass : fail).push(x);",
        "replace": "for (const x of xs) (pred(x) ? fail : pass).push(x);"
      },
      {
        "id": "intersection-nodedup",
        "desc": "intersection does not de-duplicate its result",
        "find": "return uniq(a).filter((x) => b.some((y) => eq(x, y)));",
        "replace": "return a.filter((x) => b.some((y) => eq(x, y)));"
      },
      {
        "id": "intersection-invert",
        "desc": "intersection is inverted into difference",
        "find": "return uniq(a).filter((x) => b.some((y) => eq(x, y)));",
        "replace": "return uniq(a).filter((x) => !b.some((y) => eq(x, y)));"
      },
      {
        "id": "difference-dedup",
        "desc": "difference drops duplicates that should be kept",
        "find": "export function difference<T>(a: T[], b: T[]): T[] {\n  return a.filter((x) => !b.some((y) => eq(x, y)));",
        "replace": "export function difference<T>(a: T[], b: T[]): T[] {\n  return uniq(a).filter((x) => !b.some((y) => eq(x, y)));"
      },
      {
        "id": "union-nodedup",
        "desc": "unionArr does not de-duplicate",
        "find": "export function unionArr<T>(a: T[], b: T[]): T[] {\n  return uniq([...a, ...b]);",
        "replace": "export function unionArr<T>(a: T[], b: T[]): T[] {\n  return [...a, ...b];"
      },
      {
        "id": "union-order",
        "desc": "unionArr puts b before a",
        "find": "return uniq([...a, ...b]);",
        "replace": "return uniq([...b, ...a]);"
      },
      {
        "id": "zip-max",
        "desc": "zip runs to the LONGER input, producing undefined pairs",
        "find": "const n = Math.min(a.length, b.length);",
        "replace": "const n = Math.max(a.length, b.length);"
      },
      {
        "id": "flatten-default",
        "desc": "flattenDepth default depth is 2, not 1",
        "find": "export function flattenDepth<T>(xs: unknown[], depth = 1): T[] {",
        "replace": "export function flattenDepth<T>(xs: unknown[], depth = 2): T[] {"
      },
      {
        "id": "flatten-zero",
        "desc": "flattenDepth(xs, 0) recurses one level instead of a shallow copy",
        "find": "if (depth <= 0) return xs.slice() as T[];",
        "replace": "if (depth < 0) return xs.slice() as T[];"
      },
      {
        "id": "flatten-nodecrement",
        "desc": "flattenDepth ignores the depth limit and flattens fully",
        "find": "if (Array.isArray(x)) out.push(...flattenDepth(x, depth - 1));",
        "replace": "if (Array.isArray(x)) out.push(...flattenDepth(x, depth));"
      },
      {
        "id": "rotate-nomod",
        "desc": "rotate does not reduce k modulo the length, breaking for k >= length",
        "find": "const s = ((k % n) + n) % n;",
        "replace": "const s = k;"
      },
      {
        "id": "rotate-direction",
        "desc": "rotate turns right instead of left",
        "find": "return [...xs.slice(s), ...xs.slice(0, s)];",
        "replace": "return [...xs.slice(0, s), ...xs.slice(s)];"
      },
      {
        "id": "pairwise-start",
        "desc": "pairwise starts at index 0, pairing undefined with the first",
        "find": "for (let i = 1; i < xs.length; i++) out.push([xs[i - 1]!, xs[i]!]);",
        "replace": "for (let i = 0; i < xs.length; i++) out.push([xs[i - 1]!, xs[i]!]);"
      },
      {
        "id": "windows-noninteger",
        "desc": "windows accepts a fractional size instead of throwing",
        "find": "if (!Number.isInteger(size) || size < 1) throw new Error('windows: size must be a positive integer');",
        "replace": "if (size < 1) throw new Error('windows: size must be a positive integer');"
      },
      {
        "id": "windows-drop-last",
        "desc": "windows drops the final window",
        "find": "for (let i = 0; i + size <= xs.length; i++) out.push(xs.slice(i, i + size));",
        "replace": "for (let i = 0; i + size < xs.length; i++) out.push(xs.slice(i, i + size));"
      },
      {
        "id": "sortedindex-upper",
        "desc": "sortedIndex returns the UPPER bound, inserting after equal elements",
        "find": "if (xs[mid]! < x) lo = mid + 1;",
        "replace": "if (xs[mid]! <= x) lo = mid + 1;"
      },
      {
        "id": "minby-tie",
        "desc": "minBy lets the LAST tied element win instead of the first",
        "find": "if (k < bestK) {\n      best = xs[i]!;\n      bestK = k;\n    }\n  }\n  return best;\n}\n\n/** The element with the largest",
        "replace": "if (k <= bestK) {\n      best = xs[i]!;\n      bestK = k;\n    }\n  }\n  return best;\n}\n\n/** The element with the largest"
      },
      {
        "id": "minby-max",
        "desc": "minBy selects the maximum",
        "find": "if (k < bestK) {\n      best = xs[i]!;\n      bestK = k;\n    }\n  }\n  return best;\n}\n\n/** The element with the largest",
        "replace": "if (k > bestK) {\n      best = xs[i]!;\n      bestK = k;\n    }\n  }\n  return best;\n}\n\n/** The element with the largest"
      },
      {
        "id": "maxby-tie",
        "desc": "maxBy lets the LAST tied element win instead of the first",
        "find": "if (k > bestK) {",
        "replace": "if (k >= bestK) {"
      },
      {
        "id": "keyby-first",
        "desc": "keyBy keeps the FIRST element on a key collision instead of the last",
        "find": "for (const x of xs) out[key(x)] = x;",
        "replace": "for (const x of xs) out[key(x)] ??= x;"
      },
      {
        "id": "compact-nullish",
        "desc": "compact only removes null/undefined, keeping 0 and ''",
        "find": "return xs.filter((x): x is T => Boolean(x));",
        "replace": "return xs.filter((x): x is T => x != null);"
      },
      {
        "id": "reversed-mutates",
        "desc": "reversed reverses the caller's array in place",
        "find": "return xs.slice().reverse();",
        "replace": "return xs.reverse();"
      },
      {
        "id": "sortedindex-mid",
        "desc": "sortedIndex computes the wrong midpoint",
        "find": "const mid = (lo + hi) >> 1;",
        "replace": "const mid = (lo + hi + 1) >> 1;"
      },
      {
        "id": "sum-offby",
        "desc": "sum starts from 1",
        "find": "return xs.reduce((a, b) => a + b, 0);",
        "replace": "return xs.reduce((a, b) => a + b, 1);"
      },
      {
        "id": "chunk-step",
        "desc": "chunk advances by n-1, producing overlapping chunks",
        "find": "for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));",
        "replace": "for (let i = 0; i < xs.length; i += n - 1) out.push(xs.slice(i, i + n));"
      }
    ],
    equivalents: [
      {
        "id": "eq-clamp-hi",
        "find": "if (x > hi) return hi;",
        "replace": "if (x >= hi) return hi;"
      },
      {
        "id": "eq-clamp-lo",
        "find": "if (x < lo) return lo;",
        "replace": "if (x <= lo) return lo;"
      },
      {
        "id": "eq-gcd-loop",
        "find": "while (b !== 0) {",
        "replace": "while (b > 0) {"
      },
      {
        "id": "eq-inrange-yoda",
        "find": "return x >= a && x < b;",
        "replace": "return a <= x && x < b;"
      },
      {
        "id": "eq-sum-concat",
        "find": "return xs.reduce((a, b) => a + b, 0);",
        "replace": "return xs.reduce((a, b) => b + a, 0);"
      },
      {
        "id": "eq-pairwise-slice",
        "find": "for (let i = 1; i < xs.length; i++) out.push([xs[i - 1]!, xs[i]!]);",
        "replace": "for (let i = 0; i < xs.length - 1; i++) out.push([xs[i]!, xs[i + 1]!]);"
      },
      {
        "id": "eq-take-min",
        "find": "return xs.slice(0, Math.max(0, n));",
        "replace": "return xs.slice(0, Math.max(0, Math.min(n, xs.length)));"
      },
      {
        "id": "eq-lcm-zero",
        "find": "if (a === 0 || b === 0) return 0;",
        "replace": "if (a === 0 && b === 0) return 0;"
      },
      {
        "id": "eq-rotate-negmod",
        "find": "const s = ((k % n) + n) % n;",
        "replace": "const s = k % n;"
      }
    ],
  },
};

export function getMutationSuite(taskName: string): MutationSuite | undefined {
  return SUITES[taskName];
}
