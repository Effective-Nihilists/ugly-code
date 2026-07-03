// Registry of restored agent tools. `dispatchTool` consults this first; a name
// it doesn't recognise falls through to the legacy inline switch. Each restored
// tool is a self-contained module implementing ToolModule and pushing itself
// (or being registered) here — mirroring the monolith's tools/<tool>.ts layout.

import type { TextGenTool } from 'ugly-app/shared';
import type { ToolContext } from '../tools';
import { grepTool } from './grep';
import { globTool } from './glob';
import { lspDiagnosticsTool } from './lspDiagnostics';
import { multieditTool } from './multiedit';
import { pythonExecTool } from './pythonExec';
import { pythonLibrariesTool } from './pythonLibraries';

export interface ToolModule {
  name: string;
  /** Model-facing JSON-schema spec (added to AGENT_TOOLS). */
  spec: TextGenTool;
  /** Execute the tool; returns the string fed back as tool_result. */
  run(
    input: Record<string, unknown>,
    ctx: ToolContext | undefined,
  ): Promise<string>;
}

export const TOOL_REGISTRY: ToolModule[] = [grepTool, globTool, lspDiagnosticsTool, multieditTool, pythonExecTool, pythonLibrariesTool];

/** Model-facing specs for every registered tool (appended to AGENT_TOOLS when
 *  assembling the per-turn tool list). */
export function registeredToolSpecs(): TextGenTool[] {
  return TOOL_REGISTRY.map((t) => t.spec);
}

/** Run a registered tool. Returns undefined when `name` is not registered, so
 *  the caller can fall back to the legacy dispatch switch. */
export async function runRegisteredTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext | undefined,
): Promise<string | undefined> {
  const mod = TOOL_REGISTRY.find((t) => t.name === name);
  if (!mod) return undefined;
  return mod.run(input, ctx);
}
