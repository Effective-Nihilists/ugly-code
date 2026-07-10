// Browser-safe indirection to the codebase indexer.
//
// The indexer implementation (codebase.ts → daemon.ts) imports node:child_process
// and can only be bundled for the coding TASK (esbuild platform:node). But its
// callers — the grep tool, the readiness poll — are also pulled into the
// renderer/worker bundles (tool registry, chat UI), where a static import of the
// node code fails the build ("join not exported by __vite-browser-external").
//
// So callers depend on THIS module, which has no node imports. The task installs
// the real implementation at boot via `setCodebaseProvider`; everywhere else (and
// before the task registers) a host-channel fallback routes to ugly-studio's
// `codebase.*` native channel — the pre-move behavior. The grep tool's index
// search only ever executes inside the task, so the fallback is really just for
// the renderer helpers and belt-and-suspenders.

import { installUglyNative } from 'ugly-app/native';
// Type-only — erased at compile time, so this does NOT pull node:http in.
import type { SearchMode, SearchResponse } from './client';

export interface IndexerReadiness {
  status: 'idle' | 'indexing' | 'ready' | 'error';
  indexedChunks?: number;
  totalChunks?: number;
  totalFiles?: number;
  indexedFiles?: number;
  phase?: string;
  elapsedSeconds?: number;
  chunksPerSec?: number;
  filesPerSec?: number;
  etaSeconds?: number;
  error?: string;
}

export interface CodebaseDiagnostics {
  message?: string;
  lastError?: string | null;
  logTail?: string;
}

export interface SearchOpts {
  scope?: string;
  extensions?: string[];
  worktreeRoot?: string;
}

export interface CodebaseProvider {
  ensureIndex(projectPath: string): void;
  indexerReadiness(
    projectPath: string,
  ): Promise<{ indexer: IndexerReadiness; diagnostics?: CodebaseDiagnostics }>;
  search(
    projectPath: string,
    query: string,
    limit: number,
    mode: SearchMode,
    opts?: SearchOpts,
  ): Promise<SearchResponse>;
  update(projectPath: string, files: string[], worktreeRoot?: string): Promise<void>;
  reconcile(projectPath: string, worktreeRoot?: string): void;
}

const inv = (channel: string, payload: unknown): Promise<unknown> =>
  installUglyNative().invoke(channel as never, payload as never);

/** Routes to ugly-studio's host `codebase.*` channel — the pre-move path. */
const hostFallback: CodebaseProvider = {
  ensureIndex(projectPath) {
    void inv('codebase.ensureIndex', { projectPath }).catch(() => undefined);
  },
  async indexerReadiness(projectPath) {
    const r = (await inv('codebase.status', { projectPath })) as {
      indexer: IndexerReadiness;
      diagnostics?: CodebaseDiagnostics;
    };
    return r.diagnostics ? { indexer: r.indexer, diagnostics: r.diagnostics } : { indexer: r.indexer };
  },
  async search(projectPath, query, limit, mode, opts) {
    return (await inv('codebase.search', {
      projectPath,
      query,
      limit,
      mode,
      ...(opts?.scope ? { scope: opts.scope } : {}),
      ...(opts?.extensions ? { extensions: opts.extensions } : {}),
      ...(opts?.worktreeRoot ? { worktreeRoot: opts.worktreeRoot } : {}),
    })) as SearchResponse;
  },
  async update(projectPath, files, worktreeRoot) {
    await inv('codebase.update', {
      projectPath,
      files,
      ...(worktreeRoot ? { worktreeRoot } : {}),
    });
  },
  reconcile(projectPath, worktreeRoot) {
    void inv('codebase.reconcile', {
      projectPath,
      ...(worktreeRoot ? { worktreeRoot } : {}),
    }).catch(() => undefined);
  },
};

let impl: CodebaseProvider | null = null;

/** Called once by the coding task at boot to install the local (in-process) indexer. */
export function setCodebaseProvider(p: CodebaseProvider): void {
  impl = p;
}

/** The active provider: the task-installed local one, else the host channel. */
export function codebaseProvider(): CodebaseProvider {
  return impl ?? hostFallback;
}
