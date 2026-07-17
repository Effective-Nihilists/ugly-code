// Honest +N −M for an edit, computed from the two file bodies the edit tool already has.
//
// Why: the transcript's edit cards badged "+1 −0" for edits that git reports as +1 −1.
// The card could only guess: the agent's anchor-based edits carry no `old_string`, so the
// UI never sees the line that was replaced and counts every write as a pure addition. For
// an anchor editor whose whole risk model is "did it clobber the right line?", a stat that
// structurally cannot report deletions is the one number you'd most want to trust.
//
// The tool, unlike the card, holds the old body AND the new body — so it can just count.
// This is the same line-LCS the transcript's diff view uses, so the badge and the diff can
// never disagree.
import { buildDiffRows, diffStats } from '../../studio/panels/tokenDiff';

export interface EditStat {
  added: number;
  removed: number;
}

/** Line-level +N −M between two file bodies. */
export function editStat(oldBody: string, newBody: string): EditStat {
  return diffStats(buildDiffRows(oldBody, newBody));
}

/** " (+1 −1)" — the suffix a tool result carries so the card can badge the truth. */
export function editStatSuffix(oldBody: string, newBody: string): string {
  const { added, removed } = editStat(oldBody, newBody);
  return ` (+${added} −${removed})`;
}
