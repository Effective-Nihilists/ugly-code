"""ugly-studio Python helpers for python_exec.

In one-shot mode only `_guard` (the filesystem-write guard, installed via
`import ugly_studio._guard`) is available. `recursive_llm()` / `final()` are
added in stateful mode (the loopback-TCP bridge) — Plan 2c.
"""
