"""Runtime filesystem-write guard for the ugly-studio security modes.

Installed automatically (via import side effect) whenever the
`UGLY_STUDIO_GUARD_MODE` env var is set. Two modes:

  - `UGLY_STUDIO_GUARD_MODE=spec`: reject ALL write attempts.
    Reading is fine; opening a file for writing raises PermissionError.
  - `UGLY_STUDIO_GUARD_MODE=edit`: only allow writes whose resolved
    absolute path is under `UGLY_STUDIO_GUARD_CWD` or under the system
    temp dirs (`/tmp`, `/private/tmp`, `$TMPDIR`). Writes elsewhere
    raise PermissionError.
  - Anything else (including unset): guard is a no-op. The module
    still imports cleanly so prepended `import ugly_studio._guard`
    statements don't fail in yolo mode.

The guard is belt-and-suspenders — the primary enforcement for a
real sandbox run is the per-project OS user whose file-system ACLs
deny writes outside the project dir. This Python-side hook catches
writes before the syscall, so errors surface inside the Python
interpreter with a clear message the agent can read, instead of as
a cryptic OSError bubbling up from the kernel.

Hooks the common entry points:
  - builtins.open
  - io.open (same object as builtins.open, but defensive)
  - os.open
  - os.remove, os.unlink, os.rmdir, os.removedirs
  - os.rename, os.renames, os.replace
  - os.mkdir, os.makedirs
  - os.truncate
  - os.symlink, os.link
  - os.chmod, os.chown
  - shutil.copy, shutil.copy2, shutil.copyfile, shutil.copytree
  - shutil.move, shutil.rmtree
  - pathlib.Path.write_text, .write_bytes, .unlink, .rmdir, .mkdir,
    .rename, .replace, .touch, .symlink_to, .hardlink_to, .chmod

Things it does NOT catch:
  - Writes via `ctypes` or `os.spawn*` subprocesses (those bypass
    the interpreter). Subprocess writes are governed by the OS-user
    sandbox.
  - Memory-mapped files opened with writable flags. Low priority;
    mmap-to-write isn't a common pattern in agent-generated code.
"""

from __future__ import annotations

import builtins
import io
import os
import pathlib
import shutil
import sys

_MODE = os.environ.get("UGLY_STUDIO_GUARD_MODE", "")
_CWD = os.environ.get("UGLY_STUDIO_GUARD_CWD", "")

# When mode isn't spec or edit, we don't install any hooks.
if _MODE not in ("spec", "edit"):
    pass  # no-op; leaving yolo / unset path untouched.
else:
    # Canonicalize the allow-roots once at import. realpath resolves
    # symlinks so a target like ~/project/foo.txt compared against
    # /Users/me/project stays consistent regardless of how the path
    # was spelled on the way in.
    _PROJECT_ROOT = os.path.realpath(_CWD) if _CWD else None
    _TMP_ROOTS = tuple(
        os.path.realpath(p)
        for p in (
            os.environ.get("TMPDIR", ""),
            "/tmp",
            "/private/tmp",
            "/var/folders",  # macOS per-user tmp
        )
        if p
    )

    def _resolve(path_like) -> str:
        """Normalize a filesystem argument to an absolute real path."""
        if isinstance(path_like, (os.PathLike, pathlib.PurePath)):
            path_like = os.fspath(path_like)
        if isinstance(path_like, bytes):
            path_like = path_like.decode(sys.getfilesystemencoding(), "surrogateescape")
        if not isinstance(path_like, str):
            return ""
        # Use abspath instead of realpath here — we want to check the
        # LOGICAL path the caller asked for. realpath would follow
        # existing symlinks; calling that on a not-yet-existing file
        # also works (trailing components pass through) so it's safe
        # to use both.
        abs_path = os.path.abspath(path_like)
        try:
            return os.path.realpath(abs_path)
        except OSError:
            return abs_path

    def _is_under(path: str, root: str) -> bool:
        if not root:
            return False
        path = path.rstrip(os.sep)
        root = root.rstrip(os.sep)
        if path == root:
            return True
        return path.startswith(root + os.sep)

    def _is_allowed_write(path: str) -> bool:
        if _MODE == "spec":
            return False
        # edit mode: allow writes under project root or any tmp root.
        if _PROJECT_ROOT and _is_under(path, _PROJECT_ROOT):
            return True
        for tmp in _TMP_ROOTS:
            if _is_under(path, tmp):
                return True
        return False

    def _deny(where: str, path: str) -> "PermissionError":
        label = "spec mode (read-only)" if _MODE == "spec" else "edit mode (project-scoped writes)"
        return PermissionError(
            f"ugly-studio guard blocked {where}: '{path}' is outside the writable "
            f"area under {label}. Expected prefix: "
            f"{_PROJECT_ROOT or '(none)'} or tmp."
        )

    def _check_write_mode(mode: str) -> bool:
        """True if the `open()` mode flag requests write access."""
        if not isinstance(mode, str):
            return False
        return any(c in mode for c in ("w", "a", "x", "+"))

    # ── builtins.open ────────────────────────────────────────────────
    _real_open = builtins.open

    def _guarded_open(file, mode="r", *args, **kwargs):
        if _check_write_mode(str(mode)):
            path = _resolve(file)
            if path and not _is_allowed_write(path):
                raise _deny("open(...) with write mode", path)
        return _real_open(file, mode, *args, **kwargs)

    builtins.open = _guarded_open
    # io.open is the same object as builtins.open on CPython, but
    # some vendored copies differ — rebind explicitly to be sure.
    io.open = _guarded_open  # type: ignore[assignment]

    # ── os.open ──────────────────────────────────────────────────────
    _real_os_open = os.open
    _WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC

    def _guarded_os_open(path, flags, *args, **kwargs):
        if flags & _WRITE_FLAGS:
            resolved = _resolve(path)
            if resolved and not _is_allowed_write(resolved):
                raise _deny("os.open(...) with write flags", resolved)
        return _real_os_open(path, flags, *args, **kwargs)

    os.open = _guarded_os_open  # type: ignore[assignment]

    # ── os.* mutating calls ──────────────────────────────────────────
    def _wrap_unary(name: str, where: str):
        real = getattr(os, name, None)
        if real is None:
            return

        def wrapper(path, *args, **kwargs):
            resolved = _resolve(path)
            if resolved and not _is_allowed_write(resolved):
                raise _deny(where, resolved)
            return real(path, *args, **kwargs)

        setattr(os, name, wrapper)

    for _name, _where in (
        ("remove", "os.remove"),
        ("unlink", "os.unlink"),
        ("rmdir", "os.rmdir"),
        ("removedirs", "os.removedirs"),
        ("mkdir", "os.mkdir"),
        ("makedirs", "os.makedirs"),
        ("truncate", "os.truncate"),
        ("chmod", "os.chmod"),
        ("chown", "os.chown"),
    ):
        _wrap_unary(_name, _where)

    def _wrap_binary(name: str, where: str):
        real = getattr(os, name, None)
        if real is None:
            return

        def wrapper(src, dst, *args, **kwargs):
            # Either endpoint being outside the allowed roots is a
            # denial — rename/link can create an outside-the-sandbox
            # presence of a file that was previously inside.
            for p in (src, dst):
                resolved = _resolve(p)
                if resolved and not _is_allowed_write(resolved):
                    raise _deny(where, resolved)
            return real(src, dst, *args, **kwargs)

        setattr(os, name, wrapper)

    for _name, _where in (
        ("rename", "os.rename"),
        ("renames", "os.renames"),
        ("replace", "os.replace"),
        ("symlink", "os.symlink"),
        ("link", "os.link"),
    ):
        _wrap_binary(_name, _where)

    # ── shutil ───────────────────────────────────────────────────────
    # shutil routes most operations through open/os.* under the hood
    # so many of these calls would be caught by the hooks above too.
    # Wrap the public API explicitly for clearer error messages.
    def _wrap_shutil_unary(name: str, where: str):
        real = getattr(shutil, name, None)
        if real is None:
            return

        def wrapper(path, *args, **kwargs):
            resolved = _resolve(path)
            if resolved and not _is_allowed_write(resolved):
                raise _deny(where, resolved)
            return real(path, *args, **kwargs)

        setattr(shutil, name, wrapper)

    def _wrap_shutil_binary(name: str, where: str):
        real = getattr(shutil, name, None)
        if real is None:
            return

        def wrapper(src, dst, *args, **kwargs):
            resolved_dst = _resolve(dst)
            if resolved_dst and not _is_allowed_write(resolved_dst):
                raise _deny(where, resolved_dst)
            return real(src, dst, *args, **kwargs)

        setattr(shutil, name, wrapper)

    _wrap_shutil_unary("rmtree", "shutil.rmtree")
    for _name, _where in (
        ("copy", "shutil.copy"),
        ("copy2", "shutil.copy2"),
        ("copyfile", "shutil.copyfile"),
        ("copytree", "shutil.copytree"),
        ("move", "shutil.move"),
    ):
        _wrap_shutil_binary(_name, _where)

    # ── pathlib.Path methods ─────────────────────────────────────────
    # pathlib methods eventually call through to open/os but benefit
    # from a direct block for the same clarity-of-error reason.
    _PathWrite = (
        "write_text",
        "write_bytes",
        "unlink",
        "rmdir",
        "mkdir",
        "touch",
        "chmod",
    )
    for _method_name in _PathWrite:
        _real = getattr(pathlib.Path, _method_name, None)
        if _real is None:
            continue

        def _make_wrapper(name, real):
            def wrapper(self, *args, **kwargs):
                resolved = _resolve(self)
                if resolved and not _is_allowed_write(resolved):
                    raise _deny(f"pathlib.Path.{name}", resolved)
                return real(self, *args, **kwargs)

            return wrapper

        setattr(pathlib.Path, _method_name, _make_wrapper(_method_name, _real))

    _PathBinary = ("rename", "replace", "symlink_to", "hardlink_to")
    for _method_name in _PathBinary:
        _real = getattr(pathlib.Path, _method_name, None)
        if _real is None:
            continue

        def _make_binary_wrapper(name, real):
            def wrapper(self, target, *args, **kwargs):
                for p in (self, target):
                    resolved = _resolve(p)
                    if resolved and not _is_allowed_write(resolved):
                        raise _deny(f"pathlib.Path.{name}", resolved)
                return real(self, target, *args, **kwargs)

            return wrapper

        setattr(pathlib.Path, _method_name, _make_binary_wrapper(_method_name, _real))
