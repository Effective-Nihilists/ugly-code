// Hidden grading data for mutation-scored eval tasks. Vendored here — NOT in the
// fixture repo — so the agent under test never sees which bugs its suite must catch.
// Same containment rule as evals/sbp/registry.ts.
//
// Calibration (scratchpad validate3.mjs): a PARANOID suite kills 31/31 mutants and
// passes all 7 equivalents; a competent happy-path suite kills only ~15/31; the
// fixture's inherited "100% line coverage" suite kills ~10/31. The 16 adversarial
// mutants (a01-a20) live in the corners example-based testing skips: degenerate/empty
// inputs, unnormalized inputs, and immutability — all documented in SPEC.md, so every
// kill is a fair spec violation. Do NOT list these in the task ticket.

/** A single-token bug seeded into the reference implementation. A suite that does
 *  not fail when this is applied has not really tested the behaviour. */
export interface Mutant {
  id: string;
  /** What the bug is — surfaced in the grade detail for surviving mutants. */
  desc: string;
  find: string;
  replace: string;
}

/** A behaviour-PRESERVING rewrite. A suite that fails here is asserting on the
 *  implementation's source text (hashing/snapshotting the file, counting lines)
 *  rather than on behaviour — i.e. gaming the mutation score. */
export interface EquivalentMutant {
  id: string;
  find: string;
  replace: string;
}

export interface MutationSuite {
  /** Repo-relative file the mutants patch. */
  target: string;
  mutants: Mutant[];
  equivalents: EquivalentMutant[];
}

const SUITES: Record<string, MutationSuite> = {
  "l6-test-suite-mutation": {
    target: "src/intervals.ts",
    mutants: [
      {
        "id": "n01-norm",
        "desc": "normalize only merges strict overlaps, touching stays split",
        "find": "if (last !== undefined && cur.start <= last.end) {",
        "replace": "if (last !== undefined && cur.start < last.end) {"
      },
      {
        "id": "n02-norm",
        "desc": "normalize keeps zero-length intervals",
        "find": ".filter((i) => i.start < i.end)",
        "replace": ".filter((i) => i.start <= i.end)"
      },
      {
        "id": "n03-contains",
        "desc": "contains treats the exclusive end as inside",
        "find": "point >= iv.start && point < iv.end",
        "replace": "point >= iv.start && point <= iv.end"
      },
      {
        "id": "n04-intersect",
        "desc": "intersect emits a zero-length interval where ranges touch",
        "find": "if (s < e) out.push({ start: s, end: e });",
        "replace": "if (s <= e) out.push({ start: s, end: e });"
      },
      {
        "id": "n05-subtract",
        "desc": "subtract loses the remainder to the left of the cut",
        "find": "if (iv.start < cut.start) next.push({ start: iv.start, end: cut.start });",
        "replace": "if (iv.start > cut.start) next.push({ start: iv.start, end: cut.start });"
      },
      {
        "id": "n06-subtract",
        "desc": "subtract loses the remainder to the right of the cut",
        "find": "if (cut.end < iv.end) next.push({ start: cut.end, end: iv.end });",
        "replace": "if (cut.end > iv.end) next.push({ start: cut.end, end: iv.end });"
      },
      {
        "id": "n07-measure",
        "desc": "measure treats intervals as closed, +1 per interval",
        "find": "sum + (iv.end - iv.start), 0);",
        "replace": "sum + (iv.end - iv.start + 1), 0);"
      },
      {
        "id": "n08-span",
        "desc": "span reports the wrong end",
        "find": "end: n[n.length - 1]!.end",
        "replace": "end: n[n.length - 1]!.start"
      },
      {
        "id": "n09-symdiff",
        "desc": "symmetricDifference inverts the set operation",
        "find": "return subtract(union(a, b), intersect(a, b));",
        "replace": "return subtract(intersect(a, b), union(a, b));"
      },
      {
        "id": "n10-clamp",
        "desc": "clamp unions with the bounds instead of intersecting",
        "find": "return intersect(set, [bounds]);",
        "replace": "return union(set, [bounds]);"
      },
      {
        "id": "n11-overlaps",
        "desc": "overlaps is always true",
        "find": "return intersect(a, b).length > 0;",
        "replace": "return intersect(a, b).length >= 0;"
      },
      {
        "id": "n12-gaps",
        "desc": "gaps reports the wrong hole boundary",
        "find": "out.push({ start: n[i - 1]!.end, end: n[i]!.start });",
        "replace": "out.push({ start: n[i - 1]!.end, end: n[i]!.end });"
      },
      {
        "id": "a01-span",
        "desc": "span of the empty set returns a zero-length interval, not null",
        "find": "if (n.length === 0) return null;",
        "replace": "if (n.length === 0) return { start: 0, end: 0 };"
      },
      {
        "id": "a02-containsInterval",
        "desc": "an empty query interval is reported as NOT covered",
        "find": "if (iv.start >= iv.end) return true;",
        "replace": "if (iv.start >= iv.end) return false;"
      },
      {
        "id": "a03-coalesce",
        "desc": "a negative tol does not throw when the set is empty",
        "find": "if (tol < 0) throw new Error('tol must be non-negative');",
        "replace": "if (tol < 0 && set.length > 0) throw new Error('tol must be non-negative');"
      },
      {
        "id": "a04-coalesce",
        "desc": "coalesce merges only on a strictly-smaller gap; a gap exactly equal to tol is not merged",
        "find": "if (last !== undefined && cur.start - last.end <= tol) {",
        "replace": "if (last !== undefined && cur.start - last.end < tol) {"
      },
      {
        "id": "a05-clamp",
        "desc": "clamp returns the whole set unchanged when bounds are empty",
        "find": "return intersect(set, [bounds]);",
        "replace": "return bounds.start < bounds.end ? intersect(set, [bounds]) : set;"
      },
      {
        "id": "a06-complement",
        "desc": "complement drops set members that begin before the bounds",
        "find": "return subtract([bounds], set);",
        "replace": "return subtract([bounds], set.filter((i) => i.start >= bounds.start));"
      },
      {
        "id": "a07-span",
        "desc": "span returns null for a single-interval set",
        "find": "if (n.length === 0) return null;",
        "replace": "if (n.length <= 1) return null;"
      },
      {
        "id": "a08-shift",
        "desc": "shift does not normalize its result",
        "find": "return normalize(set).map((iv) => ({ start: iv.start + delta, end: iv.end + delta }));",
        "replace": "return set.map((iv) => ({ start: iv.start + delta, end: iv.end + delta }));"
      },
      {
        "id": "a09-union",
        "desc": "union concatenates without normalizing",
        "find": "return normalize([...a, ...b]);",
        "replace": "return [...a, ...b];"
      },
      {
        "id": "a10-intersect",
        "desc": "intersect trusts that `a` is already canonical",
        "find": "const A = normalize(a);",
        "replace": "const A = a;"
      },
      {
        "id": "a11-intersect",
        "desc": "intersect trusts that `b` is already canonical",
        "find": "const B = normalize(b);",
        "replace": "const B = b;"
      },
      {
        "id": "a12-subtract",
        "desc": "subtract trusts that `a` is already canonical",
        "find": "let cur = normalize(a);",
        "replace": "let cur = a.slice();"
      },
      {
        "id": "a13-subtract",
        "desc": "subtract trusts that `b` is already canonical",
        "find": "for (const cut of normalize(b)) {",
        "replace": "for (const cut of b) {"
      },
      {
        "id": "a14-measure",
        "desc": "measure double-counts overlaps in an unnormalized set",
        "find": "return normalize(set).reduce((sum, iv) => sum + (iv.end - iv.start), 0);",
        "replace": "return set.reduce((sum, iv) => sum + (iv.end - iv.start), 0);"
      },
      {
        "id": "a15-coalesce",
        "desc": "coalesce does not drop empties / pre-merge before applying tol",
        "find": "const xs = normalize(set);",
        "replace": "const xs = set.slice().sort(byStart);"
      },
      {
        "id": "a16-normalize",
        "desc": "normalize aliases the caller's interval objects, then mutates them while merging",
        "find": "cur.start <= last.end) {\n      if (cur.end > last.end) last.end = cur.end;\n    } else {\n      out.push({ start: cur.start, end: cur.end });\n    }",
        "replace": "cur.start <= last.end) {\n      if (cur.end > last.end) last.end = cur.end;\n    } else {\n      out.push(cur);\n    }"
      },
      {
        "id": "a17-normalize",
        "desc": "normalize keeps only the last end on a merge, swallowing nested intervals",
        "find": "cur.start <= last.end) {\n      if (cur.end > last.end) last.end = cur.end;\n    } else {",
        "replace": "cur.start <= last.end) {\n      last.end = cur.end;\n    } else {"
      },
      {
        "id": "a19-isDisjoint",
        "desc": "isDisjoint is the negation of what it should be",
        "find": "return intersect(a, b).length === 0;",
        "replace": "return intersect(a, b).length > 0;"
      },
      {
        "id": "a20-containsInterval",
        "desc": "containsInterval is inverted",
        "find": "return subtract([iv], set).length === 0;",
        "replace": "return subtract([iv], set).length !== 0;"
      }
    ],
    equivalents: [
      {
        "id": "q01",
        "find": "point >= iv.start && point < iv.end",
        "replace": "iv.start <= point && point < iv.end"
      },
      {
        "id": "q02",
        "find": "return normalize([...a, ...b]);",
        "replace": "return normalize(a.concat(b));"
      },
      {
        "id": "q03",
        "find": "return subtract(union(a, b), intersect(a, b));",
        "replace": "return union(subtract(a, b), subtract(b, a));"
      },
      {
        "id": "q04",
        "find": "return intersect(a, b).length > 0;",
        "replace": "return intersect(a, b).length !== 0;"
      },
      {
        "id": "q05",
        "find": "return normalize(set).some((iv) => point >= iv.start && point < iv.end);",
        "replace": "return set.some((iv) => point >= iv.start && point < iv.end);"
      },
      {
        "id": "q06",
        "find": "if (iv.start >= iv.end) return true;",
        "replace": "if (iv.start > iv.end) return true;"
      },
      {
        "id": "q07",
        "find": "cur.start - last.end <= tol) {\n      if (cur.end > last.end) last.end = cur.end;",
        "replace": "cur.start - last.end <= tol) {\n      last.end = cur.end;"
      }
    ],
  },
};

export function getMutationSuite(taskName: string): MutationSuite | undefined {
  return SUITES[taskName];
}
