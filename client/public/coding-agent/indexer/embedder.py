"""
Local embedding model using ONNX Runtime.

Downloads and caches the model on first use.  Runs entirely offline
after the initial download.  No PyTorch dependency — uses onnxruntime
directly with the HuggingFace tokenizer.
"""

from __future__ import annotations

import os
import sys
import json
import urllib.request
import shutil
from pathlib import Path
from typing import Callable, Optional

import numpy as np

# Lazy imports — filled in by init().
_tokenizer = None
_session = None
_embed_dim: int = 0

# Model config — Jina Embeddings v2 base code (quantized ONNX, ~162 MB).
# Switched from nomic-embed-text-v1.5 (general-purpose) to a code-specific
# embedder. Both are 768-dim BERT-based, so the swap is drop-in compatible
# with the existing sqlite-vec schema. Code-tuned models materially improve
# retrieval recall on identifier-heavy queries (function names, class names,
# import statements) per published benchmarks. SWE-Bench-Pro analysis names
# retrieval quality as the dominant harness lever (15-22pt gap on identical
# models per Augment / Morph studies).
#
# Jina v2 base code:
#   - 161M params, BERT base + ALiBi positional encoding (8K context)
#   - 768-dim output (drop-in vs Nomic v1.5)
#   - No task-prefix convention — embeds raw query/document text
#   - ONNX shipped at onnx/model_quantized.onnx (int8, 161 MB)
MODEL_REPO = "jinaai/jina-embeddings-v2-base-code"
MODEL_FILES = [
    "onnx/model_quantized.onnx",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
]

MAX_SEQ_LEN = 512  # tokens per chunk (model supports 8K but 512 is enough)


def _cache_dir() -> Path:
    """Return the model cache directory."""
    base = os.environ.get(
        "UGLY_STUDIO_CACHE",
        os.path.join(os.path.expanduser("~"), ".ugly-studio"),
    )
    return Path(base) / "coding-agent" / "models" / "jina-v2-code"


def _download_model(cache: Path) -> None:
    """Download model files from HuggingFace."""
    cache.mkdir(parents=True, exist_ok=True)

    for rel_path in MODEL_FILES:
        dest = cache / rel_path.replace("/", os.sep)
        if dest.exists():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        url = f"https://huggingface.co/{MODEL_REPO}/resolve/main/{rel_path}"
        print(f"[indexer] downloading {rel_path}...", file=sys.stderr)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ugly-studio/1.0"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                with open(str(dest) + ".tmp", "wb") as f:
                    shutil.copyfileobj(resp, f)
            os.rename(str(dest) + ".tmp", str(dest))
        except Exception as e:
            # Clean up partial download.
            tmp = str(dest) + ".tmp"
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise RuntimeError(f"Failed to download {rel_path}: {e}") from e
    print("[indexer] model download complete", file=sys.stderr)


def init() -> None:
    """Load the tokenizer and ONNX model.  Idempotent."""
    global _tokenizer, _session, _embed_dim

    if _session is not None:
        return

    try:
        import onnxruntime as ort
        from tokenizers import Tokenizer
    except ImportError as e:
        raise RuntimeError(
            "Missing dependencies. Install: pip install onnxruntime tokenizers numpy"
        ) from e

    # Deprioritize the sidecar so the foreground studio stays responsive
    # during the initial index. POSIX-only; no-op on Windows.
    if hasattr(os, "nice"):
        try:
            os.nice(10)
        except OSError:
            pass

    cache = _cache_dir()
    _download_model(cache)

    # Load tokenizer.
    tok_path = cache / "tokenizer.json"
    _tokenizer = Tokenizer.from_file(str(tok_path))
    _tokenizer.enable_truncation(max_length=MAX_SEQ_LEN)
    # Dynamic padding: pad each batch to its own longest member, rounded up
    # to a multiple of 8 for cache-friendly shapes. Avoids the 3–5× FLOP
    # waste of padding every chunk to the 512-token max.
    _tokenizer.enable_padding(pad_to_multiple_of=8)

    # Load ONNX model.
    model_path = cache / "onnx" / "model_quantized.onnx"
    sess_opts = ort.SessionOptions()
    sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess_opts.inter_op_num_threads = 1
    # Cap intra-op threads — the indexer runs as a background sidecar and
    # must not saturate every core during indexing. Default is half the
    # machine's cores (min 1, max 4); ONNX scales poorly past ~4 threads
    # on this model anyway. Honours UGLY_STUDIO_EMBED_THREADS for tuning.
    _default_threads = max(1, min(4, (os.cpu_count() or 2) // 2))
    _thread_cap = int(os.environ.get("UGLY_STUDIO_EMBED_THREADS", str(_default_threads)))
    sess_opts.intra_op_num_threads = max(1, min(os.cpu_count() or 1, _thread_cap))
    # Disable the CPU memory arena + memory-pattern optimization. Both
    # default to ON and cause ORT to retain the LARGEST-ever allocation
    # slot per tensor-shape forever — catastrophic on our workload
    # because dynamic padding means the shape grows with the longest
    # seen batch. Over a 60-min session with 60+ `/update` re-embeds
    # on variable-length chunks, the arena was observed ballooning
    # past 10 GB RSS. With arena off ORT frees buffers between runs;
    # pattern off prevents pre-allocating the max pattern it guessed.
    # Trade-off: marginally slower inference (<5% on our quantized
    # model) for bounded memory. Hard-on for now — revisit if a
    # future ORT release changes the default.
    sess_opts.enable_cpu_mem_arena = False
    sess_opts.enable_mem_pattern = False

    # CPU is the default — observed RAM blow-up to ~16 GB when CoreML
    # was active on this quantized Nomic model (CoreML's compiled graph
    # plus rotary-emb shape mismatches). Accelerator providers are opt-in
    # via UGLY_STUDIO_EMBED_PROVIDER=auto (try CoreML/DML/CUDA first,
    # fall back to CPU per-op), or explicit names (coreml/dml/cuda/cpu).
    forced = os.environ.get("UGLY_STUDIO_EMBED_PROVIDER", "").strip().lower()
    available = set(ort.get_available_providers())

    def _filter(*names: str) -> list[str]:
        out = [n for n in names if n in available]
        if "CPUExecutionProvider" not in out:
            out.append("CPUExecutionProvider")
        return out

    if forced == "auto":
        providers = _filter(
            "CoreMLExecutionProvider",
            "DmlExecutionProvider",
            "CUDAExecutionProvider",
            "CPUExecutionProvider",
        )
    elif forced == "coreml":
        providers = _filter("CoreMLExecutionProvider")
    elif forced == "dml":
        providers = _filter("DmlExecutionProvider")
    elif forced == "cuda":
        providers = _filter("CUDAExecutionProvider")
    else:
        providers = ["CPUExecutionProvider"]

    _session = ort.InferenceSession(
        str(model_path), sess_options=sess_opts, providers=providers
    )

    # Determine embedding dimension from model output shape.
    output_meta = _session.get_outputs()[0]
    _embed_dim = output_meta.shape[-1] if len(output_meta.shape) >= 2 else 768
    print(
        f"[indexer] model loaded: dim={_embed_dim}, providers={_session.get_providers()}",
        file=sys.stderr,
    )


def embed_dim() -> int:
    """Return the embedding dimension (call after init)."""
    return _embed_dim or 768


def _adaptive_batch_size(text_len: int, default: int) -> int:
    """Pick a batch size based on the first (shortest) row in a sorted
    slice. Because `embed_texts` sorts inputs by length ascending, all
    rows in a batch started from this position will be at least this
    long — so we cap batch size to keep each forward pass bounded and
    give the progress callback a chance to fire more often in the tail.

    Char-to-token ratio is ~3.5 per chunker.CHARS_PER_TOKEN:
      - > 1400 chars (~400 tok)  -> batch 16  (heavy tail)
      - >  700 chars (~200 tok)  -> batch 32
      - else                     -> `default` (usually 64)
    """
    if text_len > 1400:
        return 16
    if text_len > 700:
        return 32
    return default


def embed_texts(
    texts: list[str],
    batch_size: int = 64,
    progress_cb: Optional[Callable[[int, int], None]] = None,
) -> np.ndarray:
    """
    Embed a list of texts.  Returns a (N, dim) float32 ndarray.

    Nomic Embed expects a task prefix: "search_document: " for indexing,
    "search_query: " for queries.  Callers should prepend the prefix
    before calling this function.

    progress_cb, if provided, is called after each batch with
    (done, total) counts. Exceptions inside the callback are swallowed.
    """
    if _session is None or _tokenizer is None:
        raise RuntimeError("Call init() before embed_texts()")

    if not texts:
        return np.zeros((0, embed_dim()), dtype=np.float32)

    # Sort by char length so each dynamic-padded batch ends up roughly
    # uniform and padding waste is minimized. Keep original indices so we
    # can scatter the resulting rows back to the caller's order.
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    sorted_texts = [texts[i] for i in order]
    total = len(sorted_texts)

    sorted_embeddings: list[np.ndarray] = []

    i = 0
    while i < total:
        # Shrink the batch for long-text slices so wall-clock per batch
        # stays under a second or two. Without this, the final batches
        # (up to 64 x 512 tokens) can take 30-60s on CPU and the UI
        # progress bar appears stuck.
        bsz = _adaptive_batch_size(len(sorted_texts[i]), batch_size)
        batch = sorted_texts[i : i + bsz]
        encodings = _tokenizer.encode_batch(batch)

        input_ids = np.array(
            [e.ids for e in encodings], dtype=np.int64
        )
        attention_mask = np.array(
            [e.attention_mask for e in encodings], dtype=np.int64
        )

        # ONNX inputs vary by model. Nomic v1.5 wants token_type_ids;
        # Jina v2 base code does not (BERT base + ALiBi, no segment ids).
        # Inspect the session once and feed only what's expected.
        feeds: dict = {
            "input_ids": input_ids,
            "attention_mask": attention_mask,
        }
        expected_inputs = {ix.name for ix in _session.get_inputs()}
        if "token_type_ids" in expected_inputs:
            feeds["token_type_ids"] = np.zeros_like(input_ids, dtype=np.int64)

        # Run inference.
        outputs = _session.run(None, feeds)
        # outputs[0] shape: (batch, seq_len, dim) — mean-pool over
        # non-padding tokens.
        token_embeddings = outputs[0]  # (B, S, D)

        # Mean pooling with attention mask.
        mask_expanded = attention_mask[:, :, np.newaxis].astype(np.float32)
        sum_embeddings = (token_embeddings * mask_expanded).sum(axis=1)
        sum_mask = mask_expanded.sum(axis=1).clip(min=1e-9)
        pooled = sum_embeddings / sum_mask

        # L2 normalize.
        norms = np.linalg.norm(pooled, axis=1, keepdims=True).clip(min=1e-9)
        normalized = pooled / norms

        sorted_embeddings.append(normalized.astype(np.float32))

        i += bsz

        if progress_cb is not None:
            try:
                progress_cb(min(i, total), total)
            except Exception:
                pass

    sorted_matrix = np.concatenate(sorted_embeddings, axis=0)

    # Scatter back to original caller order.
    result = np.empty_like(sorted_matrix)
    for sorted_idx, original_idx in enumerate(order):
        result[original_idx] = sorted_matrix[sorted_idx]
    return result


def embed_query(query: str) -> np.ndarray:
    """Embed a single search query.  Returns a (dim,) float32 array.

    Jina v2 base code embeds raw text (no task-prefix convention,
    unlike Nomic v1.5's `search_query:` / `search_document:` prefixes).
    """
    result = embed_texts([query], batch_size=1)
    return result[0]


def embed_documents(
    docs: list[str],
    batch_size: int = 64,
    progress_cb: Optional[Callable[[int, int], None]] = None,
) -> np.ndarray:
    """Embed documents for indexing.

    Jina v2 base code embeds raw text — no task-prefix prepending.
    """
    return embed_texts(docs, batch_size=batch_size, progress_cb=progress_cb)
