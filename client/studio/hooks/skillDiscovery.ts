/**
 * Client-side skill discovery over the native bridge. The deployed Worker has no
 * access to the user's filesystem (where skills live as `<dir>/<name>/SKILL.md`),
 * so the old `/api/listSkills` sidecar endpoint is dead here — instead we scan the
 * same directories the monolith did, via `native.fs`:
 *   - project:  <projectPath>/.claude/skills
 *   - user:     ~/.claude/skills
 *   - plugin:   each enabled plugin's <installPath>/skills
 * Precedence project > user > plugin (project overrides). Everything is
 * best-effort: a missing dir or unreadable file is skipped silently, and in a
 * plain browser (no native bridge) it returns [].
 */

import { native } from 'ugly-app/native';
import { getActiveProjectPath } from './useSocket';
import type { Skill } from './useSlashCommands';

/** Minimal `---\nkey: value\n---` frontmatter parser (no YAML dep). */
function parseFrontmatter(source: string): Record<string, string | undefined> | null {
  if (!source.startsWith('---')) return null;
  const end = source.indexOf('\n---', 3);
  if (end === -1) return null;
  const out: Record<string, string | undefined> = {};
  for (const line of source.slice(3, end).trim().split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key) out[key] = line.slice(colon + 1).trim();
  }
  return out;
}

async function loadSkillsFromDir(dir: string, scope: Skill['scope']): Promise<Skill[]> {
  let entries: { name: string; isDirectory: boolean }[];
  try {
    entries = await native.fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const e of entries) {
    if (!e.isDirectory) continue;
    try {
      const fm = parseFrontmatter(await native.fs.readFile(`${dir}/${e.name}/SKILL.md`));
      if (fm?.name) out.push({ name: fm.name, description: fm.description ?? '', scope });
    } catch {
      /* not a skill dir (no SKILL.md) — skip */
    }
  }
  return out;
}

/** Best-effort home dir from the absolute project path (macOS/Linux layouts). */
function homeFromProject(projectPath: string): string | null {
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)/.exec(projectPath);
  return m ? m[1] : null;
}

async function loadPluginSkills(home: string): Promise<Skill[]> {
  let enabled: Set<string>;
  try {
    const settings = JSON.parse(await native.fs.readFile(`${home}/.claude/settings.json`)) as {
      enabledPlugins?: Record<string, boolean>;
    };
    enabled = new Set(
      Object.entries(settings.enabledPlugins ?? {})
        .filter(([, v]) => v)
        .map(([k]) => k),
    );
  } catch {
    return [];
  }
  if (enabled.size === 0) return [];
  let manifest: { plugins?: Record<string, { installPath?: string }[]> };
  try {
    manifest = JSON.parse(await native.fs.readFile(`${home}/.claude/plugins/installed_plugins.json`)) as typeof manifest;
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const [key, entries] of Object.entries(manifest.plugins ?? {})) {
    if (!enabled.has(key)) continue;
    const installPath = entries[0]?.installPath;
    if (installPath) dirs.push(`${installPath}/skills`);
  }
  const all = await Promise.all(dirs.map((d) => loadSkillsFromDir(d, 'plugin')));
  return all.flat();
}

export async function discoverSkills(): Promise<Skill[]> {
  const project = getActiveProjectPath();
  const home = project ? homeFromProject(project) : null;
  const [projectSkills, userSkills, pluginSkills] = await Promise.all([
    project ? loadSkillsFromDir(`${project}/.claude/skills`, 'project') : Promise.resolve([] as Skill[]),
    home ? loadSkillsFromDir(`${home}/.claude/skills`, 'user') : Promise.resolve([] as Skill[]),
    home ? loadPluginSkills(home) : Promise.resolve([] as Skill[]),
  ]);
  // Project overrides user overrides plugin.
  const byName = new Map<string, Skill>();
  for (const s of pluginSkills) byName.set(s.name, s);
  for (const s of userSkills) byName.set(s.name, s);
  for (const s of projectSkills) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
