// Glue between the CodeMirror editor and the LSP request handlers. Pure
// argument-shaping + result-formatting; unit-tested against mocked handlers.
// The editor passes the live buffer `content` so navigation/hover reflect
// unsaved edits (the handler syncs it via openFile(path, content)).

import {
  lspDefinition,
  lspImplementation,
  lspReferences,
  lspHover,
} from '../agent/lsp/handlers';

export type CmLanguage = 'javascript' | 'python' | 'css' | 'html' | 'markdown';

/** 0-indexed editor position (LSP convention). */
export interface EditorPos {
  line: number;
  character: number;
}

export interface LspResult {
  path: string;
  line: number;
  character: number;
  preview?: string;
}

export function languageForPath(path: string): CmLanguage | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'javascript';
  if (ext === 'py') return 'python';
  if (ext === 'css' || ext === 'scss') return 'css';
  if (ext === 'html' || ext === 'htm' || ext === 'xml') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  return null;
}

function input(path: string, pos: EditorPos, content: string, projectPath: string | null) {
  return {
    path,
    line: pos.line,
    character: pos.character,
    ...(projectPath ? { cwd: projectPath } : {}),
    content,
  };
}

async function locate(
  fn: typeof lspDefinition,
  path: string,
  pos: EditorPos,
  content: string,
  projectPath: string | null,
): Promise<LspResult[]> {
  const { results } = await fn(input(path, pos, content, projectPath), projectPath);
  return results;
}

export const runDefinition = (p: string, pos: EditorPos, c: string, root: string | null) =>
  locate(lspDefinition, p, pos, c, root);
export const runImplementation = (p: string, pos: EditorPos, c: string, root: string | null) =>
  locate(lspImplementation, p, pos, c, root);
export const runReferences = (p: string, pos: EditorPos, c: string, root: string | null) =>
  locate(lspReferences, p, pos, c, root);

export async function runHover(
  p: string,
  pos: EditorPos,
  c: string,
  root: string | null,
): Promise<string | null> {
  const { contents } = await lspHover(input(p, pos, c, root), root);
  return contents;
}
