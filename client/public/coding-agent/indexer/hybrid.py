"""Pure fusion/dedupe helpers for hybrid (FTS + semantic) search. No I/O —
fully unit-testable. Consumed by VectorStore.mixed_search."""

from __future__ import annotations

from dataclasses import dataclass

from store import SearchResult


@dataclass
class Candidate:
    result: SearchResult
    fts_rank: int | None = None
    semantic_score: float | None = None
    score: float = 0.0
    rerank_score: float | None = None


def _key(r: SearchResult):
    return (r.file_path, r.start_line, r.end_line)


def dedupe_candidates(
    fts: list[SearchResult], sem: list[SearchResult]
) -> list[Candidate]:
    """Merge FTS + semantic hits by (file, span). A hit found by both keeps
    both sub-scores (fts_rank = its position in the FTS list; semantic_score =
    its vector similarity)."""
    by_key: dict = {}
    for rank, r in enumerate(fts):
        by_key[_key(r)] = Candidate(result=r, fts_rank=rank)
    for r in sem:
        c = by_key.get(_key(r))
        if c is None:
            by_key[_key(r)] = Candidate(result=r, semantic_score=r.score)
        else:
            c.semantic_score = r.score
    return list(by_key.values())


def rrf_fuse(cands: list[Candidate], k: int = 60) -> list[Candidate]:
    """Reciprocal Rank Fusion: score = sum 1/(k + rank) over the retrievers a
    candidate appears in. Used when the cross-encoder re-ranker is disabled /
    unavailable. Sets each candidate's `.score` and returns them sorted desc."""
    sem_sorted = sorted(
        [c for c in cands if c.semantic_score is not None],
        key=lambda c: c.semantic_score,
        reverse=True,
    )
    sem_rank = {id(c): i for i, c in enumerate(sem_sorted)}
    for c in cands:
        s = 0.0
        if c.fts_rank is not None:
            s += 1.0 / (k + c.fts_rank)
        if id(c) in sem_rank:
            s += 1.0 / (k + sem_rank[id(c)])
        c.score = s
    return sorted(cands, key=lambda c: c.score, reverse=True)
