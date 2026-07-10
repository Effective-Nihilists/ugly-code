"""
Per-session overlay for the semantic-search index.

Design:

  - Each session runs inside its own git worktree.
  - The base index at ``<project>/.ugly-studio/codebase-index.db``
    tracks main.
  - Each worktree also has an overlay at
    ``<worktree>/.ugly-studio/session-index.db`` which holds ONLY the
    chunks for files the session has edited plus a `tombstones` table
    for deletes/renames.
  - At query time we search the overlay first, then query the base
    excluding any paths the overlay has covered. The merged ranked
    result reflects "current main, except what this session has
    changed."
  - On session merge/archive, the overlay is replayed into the base
    (ordered by the merge commit) and then removed with the worktree.

This module exposes the overlay store + a small merge helper the
sidecar server wires into the ``/search`` and ``/update`` endpoints
when the caller passes ``worktree_root``.
"""

from __future__ import annotations

import os
import sqlite3
from typing import Optional

import numpy as np

from store import (
    HAS_SQLITE_VEC,
    SearchResult,
    VectorStore,
    _normalize_extensions,
    _serialize_f32,
)


def overlay_db_path(worktree_root: str) -> str:
    """Resolve the on-disk location of this worktree's overlay DB."""
    d = os.path.join(worktree_root, ".ugly-studio")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "session-index.db")


class OverlayStore(VectorStore):
    """VectorStore subclass that points at the worktree's overlay file.

    Inherits the full chunk / vec_chunks schema and the usual
    upsert_chunks / search / delete_file APIs — an overlay IS a
    full-fledged VectorStore, just with a different path and a
    tombstones table layered on top.
    """

    def __init__(self, worktree_root: str, embed_dim: int = 768) -> None:
        # Skip the parent's `_db_path(project_dir)` entirely — we point
        # at a dedicated overlay file. Do the rest of __init__ by hand.
        self.project_dir = worktree_root
        self.embed_dim = embed_dim
        self.db_path = overlay_db_path(worktree_root)
        self._conn: Optional[sqlite3.Connection] = None

    def _ensure_schema(self) -> None:
        super()._ensure_schema()
        conn = self._conn
        assert conn is not None
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tombstones (
                path TEXT PRIMARY KEY,
                deleted_at REAL NOT NULL
            )
            """
        )
        conn.commit()

    # ── Tombstones ──────────────────────────────────────────────────

    def mark_deleted(self, file_path: str) -> None:
        """Mark a file as deleted in this overlay so base hits get masked."""
        import time

        conn = self._connect()
        conn.execute(
            "INSERT OR REPLACE INTO tombstones(path, deleted_at) VALUES (?, ?)",
            (file_path, time.time()),
        )
        # Also purge any stale chunks we had for this path.
        super().delete_file(file_path)
        conn.commit()

    def clear_deleted(self, file_path: str) -> None:
        conn = self._connect()
        conn.execute("DELETE FROM tombstones WHERE path = ?", (file_path,))
        conn.commit()

    def tombstoned_paths(self) -> set[str]:
        conn = self._connect()
        rows = conn.execute("SELECT path FROM tombstones").fetchall()
        return {r[0] for r in rows}

    def covered_paths(self) -> set[str]:
        """All paths the overlay is authoritative on (chunks ∪ tombstones).

        Base search excludes these at query time.
        """
        conn = self._connect()
        rows = conn.execute("SELECT DISTINCT file_path FROM chunks").fetchall()
        paths = {r[0] for r in rows}
        paths |= self.tombstoned_paths()
        return paths


def merged_search(
    base: VectorStore,
    overlay: OverlayStore,
    query_embedding: np.ndarray,
    limit: int,
    scope: Optional[str] = None,
    extensions: Optional[list[str]] = None,
) -> list[SearchResult]:
    """Search base + overlay and return the top-K global.

    Algorithm:
      1. Query overlay with the full limit — its winners outrank base
         for any path it covers.
      2. Query base with the same limit, then drop any result whose
         path is in the overlay's coverage set (tombstones + present
         paths).
      3. Concat overlay_hits + filtered_base_hits, sort by score
         descending, slice to limit.

    We don't try to ATTACH the overlay DB into the base connection;
    sqlite-vec virtual tables are finicky across ATTACH boundaries.
    Two separate queries + an in-memory merge is plenty fast — both
    stores are cosine-ranked and we're only sorting a few dozen rows.
    """
    ext_set = _normalize_extensions(extensions)
    _ = ext_set  # filtering happens inside base.search() already

    overlay_hits = overlay.search(
        query_embedding, limit=limit, scope=scope, extensions=extensions
    )
    base_hits = base.search(
        query_embedding, limit=limit, scope=scope, extensions=extensions
    )

    covered = overlay.covered_paths()
    filtered_base = [h for h in base_hits if h.file_path not in covered]

    merged = list(overlay_hits) + filtered_base
    merged.sort(key=lambda h: h.score, reverse=True)
    return merged[:limit]


def _placeholder_unused_imports() -> None:
    """Touch imports so static checkers don't complain if the full
    server-side wiring hasn't been hooked up yet."""
    _ = HAS_SQLITE_VEC
    _ = _serialize_f32
