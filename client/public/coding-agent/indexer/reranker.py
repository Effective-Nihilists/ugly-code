"""Cross-encoder re-ranker (ONNX).

Scores (query, document) pairs for the `mixed` hybrid search. Same
download / ONNX-session pattern as embedder.py: CPU, bounded memory,
downloaded once and cached. Disabled via UGLY_STUDIO_DISABLE_RERANK=1.
"""

from __future__ import annotations

import os
import sys
import shutil
import urllib.request
from pathlib import Path

import numpy as np

# Lazy — filled in by init().
_tokenizer = None
_session = None

MODEL_REPO = os.environ.get(
    "UGLY_STUDIO_RERANK_MODEL", "jinaai/jina-reranker-v2-base-multilingual"
)
MODEL_FILES = [
    "onnx/model.onnx",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
]
MAX_SEQ_LEN = 512


def _cache_dir() -> Path:
    base = os.environ.get(
        "UGLY_STUDIO_CACHE", os.path.join(os.path.expanduser("~"), ".ugly-studio")
    )
    return Path(base) / "coding-agent" / "models" / "jina-reranker-v2"


def _download(cache: Path) -> None:
    cache.mkdir(parents=True, exist_ok=True)
    for rel in MODEL_FILES:
        dest = cache / rel.replace("/", os.sep)
        if dest.exists():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        url = f"https://huggingface.co/{MODEL_REPO}/resolve/main/{rel}"
        print(f"[reranker] downloading {rel}...", file=sys.stderr)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ugly-studio/1.0"})
            with urllib.request.urlopen(req, timeout=180) as resp:
                with open(str(dest) + ".tmp", "wb") as f:
                    shutil.copyfileobj(resp, f)
            os.rename(str(dest) + ".tmp", str(dest))
        except Exception as e:
            tmp = str(dest) + ".tmp"
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise RuntimeError(f"Failed to download {rel}: {e}") from e


def disabled() -> bool:
    return os.environ.get("UGLY_STUDIO_DISABLE_RERANK") == "1"


def init() -> None:
    """Download + load the model. Idempotent. No-op when disabled."""
    global _tokenizer, _session
    if _session is not None or disabled():
        return

    import onnxruntime as ort
    from tokenizers import Tokenizer

    if hasattr(os, "nice"):
        try:
            os.nice(10)
        except OSError:
            pass

    cache = _cache_dir()
    _download(cache)

    _tokenizer = Tokenizer.from_file(str(cache / "tokenizer.json"))
    # Pair truncation ('longest_first' default) trims the longer side of a
    # (query, doc) pair to fit MAX_SEQ_LEN.
    _tokenizer.enable_truncation(max_length=MAX_SEQ_LEN)
    _tokenizer.enable_padding(pad_to_multiple_of=8)

    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    opts.inter_op_num_threads = 1
    # Bounded memory (see embedder.py rationale) + a background-sidecar
    # thread cap.
    opts.enable_cpu_mem_arena = False
    opts.enable_mem_pattern = False
    default_threads = max(1, min(4, (os.cpu_count() or 2) // 2))
    cap = int(os.environ.get("UGLY_STUDIO_EMBED_THREADS", str(default_threads)))
    opts.intra_op_num_threads = max(1, min(os.cpu_count() or 1, cap))

    _session = ort.InferenceSession(
        str(cache / "onnx" / "model.onnx"),
        sess_options=opts,
        providers=["CPUExecutionProvider"],
    )
    print("[reranker] model loaded", file=sys.stderr)


def available() -> bool:
    """True if the re-ranker can score (deps present, model loadable, not
    disabled). Never raises — logs and returns False on any failure."""
    if disabled():
        return False
    try:
        init()
        return _session is not None
    except Exception as e:
        print(f"[reranker] unavailable: {e}", file=sys.stderr)
        return False


def rerank(query: str, docs: list[str], top_k: int | None = None):
    """Score each (query, doc) pair with the cross-encoder. Returns
    [(original_index, score), ...] sorted by score descending, capped to
    top_k. Empty input → []."""
    if not docs:
        return []
    if _session is None:
        init()

    # Proper cross-encoder input: encode the (query, doc) PAIR so the model
    # sees [CLS] query [SEP] doc [SEP] (the tokenizer's post-processor adds
    # the separators + token_type_ids).
    enc = _tokenizer.encode_batch([(query, d) for d in docs])
    input_ids = np.array([e.ids for e in enc], dtype=np.int64)
    attention_mask = np.array([e.attention_mask for e in enc], dtype=np.int64)

    feeds: dict = {"input_ids": input_ids, "attention_mask": attention_mask}
    expected = {ix.name for ix in _session.get_inputs()}
    if "token_type_ids" in expected:
        # tokenizers exposes type_ids per encoding; fall back to zeros.
        try:
            feeds["token_type_ids"] = np.array(
                [e.type_ids for e in enc], dtype=np.int64
            )
        except Exception:
            feeds["token_type_ids"] = np.zeros_like(input_ids)

    logits = _session.run(None, feeds)[0]  # (N, 1) or (N,)
    scores = np.asarray(logits, dtype=np.float32).reshape(-1)

    order = sorted(range(len(docs)), key=lambda i: float(scores[i]), reverse=True)
    if top_k is not None:
        order = order[:top_k]
    return [(i, float(scores[i])) for i in order]
