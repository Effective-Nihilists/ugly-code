"""
AST-aware code chunker using tree-sitter.

Parses source files into semantic chunks (functions, classes, methods)
at 256-512 token boundaries. Falls back to line-based chunking for
unsupported languages.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field
from typing import Optional

try:
    import tree_sitter_languages
    HAS_TREE_SITTER = True
except ImportError:
    HAS_TREE_SITTER = False

# Languages tree-sitter-languages ships grammars for.  Map file
# extensions to tree-sitter language names.
EXT_TO_LANG: dict[str, str] = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cc": "cpp",
    ".cs": "c_sharp",
    ".swift": "swift",
    ".kt": "kotlin",
    ".lua": "lua",
    ".php": "php",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "bash",
    ".css": "css",
    ".scss": "css",
    ".html": "html",
    ".htm": "html",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".sql": "sql",
    ".r": "r",
    ".R": "r",
    ".scala": "scala",
    ".ex": "elixir",
    ".exs": "elixir",
    ".erl": "erlang",
    ".hs": "haskell",
    ".ml": "ocaml",
    ".vue": "vue",
    ".svelte": "svelte",
    ".dart": "dart",
    ".zig": "zig",
}

# AST node types that represent semantic boundaries we want to split on.
# Grouped by language family because grammars differ.
BOUNDARY_NODES: dict[str, set[str]] = {
    "python": {
        "function_definition",
        "class_definition",
        "decorated_definition",
    },
    "javascript": {
        "function_declaration",
        "class_declaration",
        "method_definition",
        "arrow_function",
        "export_statement",
    },
    "typescript": {
        "function_declaration",
        "class_declaration",
        "method_definition",
        "arrow_function",
        "export_statement",
        "interface_declaration",
        "type_alias_declaration",
        "enum_declaration",
    },
    "tsx": {
        "function_declaration",
        "class_declaration",
        "method_definition",
        "arrow_function",
        "export_statement",
        "interface_declaration",
        "type_alias_declaration",
        "enum_declaration",
    },
    "go": {
        "function_declaration",
        "method_declaration",
        "type_declaration",
    },
    "rust": {
        "function_item",
        "impl_item",
        "struct_item",
        "enum_item",
        "trait_item",
    },
    "ruby": {
        "method",
        "class",
        "module",
        "singleton_method",
    },
    "java": {
        "method_declaration",
        "class_declaration",
        "interface_declaration",
        "enum_declaration",
    },
    "c": {
        "function_definition",
        "struct_specifier",
        "enum_specifier",
    },
    "cpp": {
        "function_definition",
        "class_specifier",
        "struct_specifier",
        "enum_specifier",
        "namespace_definition",
    },
}

# Approximate tokens per char.  cl100k_base averages ~4 chars/token
# for code; we use 3.5 to be conservative.
CHARS_PER_TOKEN = 3.5
MIN_CHUNK_TOKENS = 64
MAX_CHUNK_TOKENS = 512
TARGET_CHUNK_TOKENS = 384


@dataclass
class Chunk:
    file_path: str
    start_line: int  # 1-based
    end_line: int  # 1-based, inclusive
    content: str
    language: str
    parent_scope: str  # e.g. "ClassName.method_name"
    content_hash: str = field(default="")

    def __post_init__(self) -> None:
        if not self.content_hash:
            self.content_hash = hashlib.md5(
                self.content.encode("utf-8", errors="replace")
            ).hexdigest()


def _estimate_tokens(text: str) -> int:
    return max(1, int(len(text) / CHARS_PER_TOKEN))


def _language_for_file(path: str) -> Optional[str]:
    ext = os.path.splitext(path)[1].lower()
    return EXT_TO_LANG.get(ext)


def _boundary_types(lang: str) -> set[str]:
    """Return boundary node types, falling back to a generic set."""
    return BOUNDARY_NODES.get(lang, {
        "function_definition",
        "function_declaration",
        "class_definition",
        "class_declaration",
        "method_definition",
        "method_declaration",
    })


def _node_scope_name(node) -> str:  # type: ignore[no-untyped-def]
    """Extract a human-readable scope name from a tree-sitter node."""
    # Most grammars put the identifier in a child named 'name'.
    name_node = node.child_by_field_name("name")
    if name_node:
        return name_node.text.decode("utf-8", errors="replace")
    return node.type


def _collect_boundary_nodes(
    node,  # type: ignore[no-untyped-def]
    boundary_types: set[str],
    scope: str = "",
) -> list[tuple[str, object]]:
    """DFS to collect all boundary nodes with their scope path."""
    results: list[tuple[str, object]] = []
    if node.type in boundary_types:
        name = _node_scope_name(node)
        current_scope = f"{scope}.{name}" if scope else name
        results.append((current_scope, node))
        # Recurse into children to find nested definitions.
        for child in node.children:
            results.extend(
                _collect_boundary_nodes(child, boundary_types, current_scope)
            )
    else:
        for child in node.children:
            results.extend(
                _collect_boundary_nodes(child, boundary_types, scope)
            )
    return results


def _chunk_by_ast(
    source: str,
    file_path: str,
    language: str,
) -> list[Chunk]:
    """Split source into chunks at AST-identified boundaries."""
    if not HAS_TREE_SITTER:
        return _chunk_by_lines(source, file_path, language)

    try:
        parser = tree_sitter_languages.get_parser(language)
    except Exception:
        return _chunk_by_lines(source, file_path, language)

    tree = parser.parse(source.encode("utf-8"))
    root = tree.root_node
    boundary_types = _boundary_types(language)

    # Collect top-level boundary nodes.
    boundaries = _collect_boundary_nodes(root, boundary_types)

    if not boundaries:
        # No recognizable boundaries — fall back to lines.
        return _chunk_by_lines(source, file_path, language)

    lines = source.split("\n")
    chunks: list[Chunk] = []

    # Sort boundaries by start position.
    boundaries.sort(key=lambda x: x[1].start_point[0])

    # Track which line ranges are covered by boundary nodes.
    covered: list[tuple[int, int, str]] = []  # (start_line, end_line, scope)
    for scope, node in boundaries:
        start = node.start_point[0]  # 0-based
        end = node.end_point[0]  # 0-based
        covered.append((start, end, scope))

    # Merge overlapping/nested ranges — keep only outermost.
    # But also create chunks for nested definitions.
    all_ranges: list[tuple[int, int, str]] = []
    for start, end, scope in covered:
        # Check if this range is nested inside a previous one.
        nested = False
        for prev_start, prev_end, _ in all_ranges:
            if start >= prev_start and end <= prev_end:
                nested = True
                break
        if not nested:
            all_ranges.append((start, end, scope))

    # Create chunks from boundary ranges.
    for start, end, scope in all_ranges:
        content = "\n".join(lines[start : end + 1])
        tokens = _estimate_tokens(content)

        if tokens <= MAX_CHUNK_TOKENS:
            chunks.append(
                Chunk(
                    file_path=file_path,
                    start_line=start + 1,
                    end_line=end + 1,
                    content=content,
                    language=language,
                    parent_scope=scope,
                )
            )
        else:
            # Large function/class — sub-chunk by lines.
            sub_chunks = _chunk_lines_range(
                lines, start, end, file_path, language, scope
            )
            chunks.extend(sub_chunks)

    # Handle gap regions between boundary nodes.
    all_ranges_sorted = sorted(all_ranges, key=lambda x: x[0])
    prev_end = -1
    for start, end, _ in all_ranges_sorted:
        if start > prev_end + 1:
            gap_content = "\n".join(lines[prev_end + 1 : start])
            if gap_content.strip() and _estimate_tokens(gap_content) >= MIN_CHUNK_TOKENS:
                chunks.append(
                    Chunk(
                        file_path=file_path,
                        start_line=prev_end + 2,
                        end_line=start,
                        content=gap_content,
                        language=language,
                        parent_scope="<module>",
                    )
                )
        prev_end = max(prev_end, end)

    # Trailing content after last boundary.
    if prev_end < len(lines) - 1:
        trailing = "\n".join(lines[prev_end + 1 :])
        if trailing.strip() and _estimate_tokens(trailing) >= MIN_CHUNK_TOKENS:
            chunks.append(
                Chunk(
                    file_path=file_path,
                    start_line=prev_end + 2,
                    end_line=len(lines),
                    content=trailing,
                    language=language,
                    parent_scope="<module>",
                )
            )

    # Sort by position.
    chunks.sort(key=lambda c: c.start_line)
    return chunks


def _chunk_lines_range(
    lines: list[str],
    start: int,
    end: int,
    file_path: str,
    language: str,
    scope: str,
) -> list[Chunk]:
    """Split a line range into fixed-size chunks."""
    chunks: list[Chunk] = []
    target_lines = int(TARGET_CHUNK_TOKENS * CHARS_PER_TOKEN / 40)  # ~40 chars/line avg
    target_lines = max(target_lines, 20)

    i = start
    while i <= end:
        chunk_end = min(i + target_lines - 1, end)
        content = "\n".join(lines[i : chunk_end + 1])
        if content.strip():
            chunks.append(
                Chunk(
                    file_path=file_path,
                    start_line=i + 1,
                    end_line=chunk_end + 1,
                    content=content,
                    language=language,
                    parent_scope=scope,
                )
            )
        i = chunk_end + 1

    return chunks


def _chunk_by_lines(
    source: str,
    file_path: str,
    language: str,
) -> list[Chunk]:
    """Fallback: split into fixed-size line-based chunks."""
    lines = source.split("\n")
    return _chunk_lines_range(
        lines, 0, len(lines) - 1, file_path, language, "<module>"
    )


# ── Directories and files to always skip ─────────────────────────────

SKIP_DIRS: set[str] = {
    "node_modules",
    ".git",
    "__pycache__",
    ".next",
    ".nuxt",
    "dist",
    "build",
    ".venv",
    "venv",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    "coverage",
    ".idea",
    ".vscode",
    ".ugly-studio",
    "vendor",
    "target",
}

SKIP_EXTENSIONS: set[str] = {
    ".lock",
    ".min.js",
    ".min.css",
    ".map",
    ".wasm",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".ico",
    ".svg",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".mp3",
    ".mp4",
    ".webm",
    ".webp",
    ".pdf",
    ".zip",
    ".tar",
    ".gz",
    ".bz2",
    ".so",
    ".dylib",
    ".dll",
    ".exe",
    ".bin",
    ".dat",
    ".db",
    ".sqlite",
    ".pyc",
    ".pyo",
    ".class",
    ".o",
    ".obj",
}

MAX_FILE_SIZE = 1_000_000  # 1 MB


def chunk_file(file_path: str) -> list[Chunk]:
    """Chunk a single file.  Returns [] for unsupported/binary files."""
    ext = os.path.splitext(file_path)[1].lower()
    if ext in SKIP_EXTENSIONS:
        return []

    language = _language_for_file(file_path)
    if language is None:
        # Unknown language — try plain line-based if it looks like text.
        try:
            with open(file_path, "r", encoding="utf-8", errors="strict") as f:
                source = f.read(MAX_FILE_SIZE)
        except (UnicodeDecodeError, OSError):
            return []
        if not source.strip():
            return []
        return _chunk_by_lines(source, file_path, "text")

    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            source = f.read(MAX_FILE_SIZE)
    except OSError:
        return []

    if not source.strip():
        return []

    return _chunk_by_ast(source, file_path, language)


def chunk_directory(root: str) -> list[Chunk]:
    """Walk a directory tree and chunk all supported files.

    File paths on emitted chunks are RELATIVE to `root` so the index
    DB is portable across workspaces — a fixture pre-warmed at
    `/path/to/fixture/...` can be copied into a fresh tmpdir and the
    resume-scan still recognizes its chunks. Absolute paths would
    invalidate the cache on every workspace move.
    """
    all_chunks: list[Chunk] = []
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune skipped directories in-place.
        dirnames[:] = [
            d for d in dirnames
            if d not in SKIP_DIRS and not d.startswith(".")
        ]
        for fname in filenames:
            if fname.startswith("."):
                continue
            fpath = os.path.join(dirpath, fname)
            try:
                if os.path.getsize(fpath) > MAX_FILE_SIZE:
                    continue
            except OSError:
                continue
            chunks = chunk_file(fpath)
            # Rewrite to relative paths so the DB is portable.
            rel = os.path.relpath(fpath, root)
            for c in chunks:
                c.file_path = rel
            all_chunks.extend(chunks)

    # Index dependency type entry points so the agent can semantically
    # search for dependency APIs (e.g. "zod schema validation").
    dep_chunks = _chunk_dependency_types(root)
    all_chunks.extend(dep_chunks)

    return all_chunks


# ── Dependency type indexing ──────────────────────────────────────────

# Max size for a dependency .d.ts file to be indexed.
# Files larger than this (e.g. lucide-preact at 25K lines) would
# produce too many chunks and bloat the index.
_DEP_TYPES_MAX_SIZE = 50_000

# Max number of dependency type files to index.
_DEP_TYPES_MAX_FILES = 150


def _chunk_dependency_types(root: str) -> list[Chunk]:
    """Index the type entry point (.d.ts) for each production dependency.

    Only indexes the public API surface — the single .d.ts file each
    package exports — not internal implementation files. This gives the
    agent semantic search over dependency APIs without bloating the index.
    """
    import json as _json

    pkg_json_path = os.path.join(root, "package.json")
    try:
        with open(pkg_json_path, "r", encoding="utf-8") as f:
            pkg = _json.load(f)
    except (OSError, _json.JSONDecodeError):
        return []

    deps = list((pkg.get("dependencies") or {}).keys())
    dev_deps = set((pkg.get("devDependencies") or {}).keys())
    nm = os.path.join(root, "node_modules")

    chunks: list[Chunk] = []
    files_indexed = 0

    for dep_name in deps:
        if files_indexed >= _DEP_TYPES_MAX_FILES:
            break

        types_path = _resolve_dep_types(nm, dep_name, dev_deps)
        if types_path is None:
            continue

        try:
            size = os.path.getsize(types_path)
            if size > _DEP_TYPES_MAX_SIZE or size == 0:
                continue
        except OSError:
            continue

        dep_chunks = chunk_file(types_path)
        chunks.extend(dep_chunks)
        files_indexed += 1

    return chunks


def _resolve_dep_types(
    nm: str, dep_name: str, dev_deps: set[str]
) -> str | None:
    """Resolve the types entry point for a dependency.

    Checks, in order:
    1. The package's own `types` or `typings` field
    2. A corresponding @types/<pkg> package
    Returns the absolute path, or None if no types found.
    """
    import json as _json

    dep_dir = os.path.join(nm, dep_name)
    dep_pkg_path = os.path.join(dep_dir, "package.json")
    try:
        with open(dep_pkg_path, "r", encoding="utf-8") as f:
            dep_pkg = _json.load(f)
    except (OSError, _json.JSONDecodeError):
        return None

    # Check the package's own types field
    types_field = dep_pkg.get("types") or dep_pkg.get("typings")
    if types_field:
        types_path = os.path.join(dep_dir, types_field)
        if os.path.isfile(types_path):
            return types_path

    # Fallback: @types/<pkg>
    if not dep_name.startswith("@"):
        at_types_name = f"@types/{dep_name}"
        if at_types_name in dev_deps:
            at_types_path = os.path.join(nm, at_types_name, "index.d.ts")
            if os.path.isfile(at_types_path):
                return at_types_path

    return None
