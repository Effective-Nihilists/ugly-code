// Browser-safe indirection to the codebase indexer.
//
// The indexer implementation (codebase.ts → daemon.ts) imports node:child_process
// and can only be bundled for the coding TASK (esbuild platform:node). But its
// callers — the grep tool, the readiness poll — are also pulled into the
// renderer/worker bundles (tool registry, chat UI), where a static import of the
// node code fails the build ("join not exported by __vite-browser-external").
//
// So callers depend on THIS module, which has no node imports. The task installs
// the real implementation at boot via `setCodebaseProvider`. Every `codebaseProvider()`
// caller (the grep tool's index search, the readiness poll) runs INSIDE the task, so
// the impl is always present by the time it's called — there is no host fallback
// (the ugly-studio `codebase.*` channel was removed). Renderer-side callers reach the
// task over RPC instead (see useSocket `codebaseCall`).

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

let impl: CodebaseProvider | null = null;

/** Called once by the coding task at boot to install the local (in-process) indexer. */
export function setCodebaseProvider(p: CodebaseProvider): void {
  impl = p;
}

/** The active provider. Installed by the coding task at boot; only ever called
 *  from inside the task, so a missing impl is a wiring bug, not a runtime path. */
export function codebaseProvider(): CodebaseProvider {
  if (!impl) {
    throw new Error(
      'codebaseProvider() called before setCodebaseProvider — the indexer only runs in the coding task',
    );
  }
  return impl;
}
