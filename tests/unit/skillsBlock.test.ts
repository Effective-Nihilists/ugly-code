// Dynamic <available_skills> block formatting (pure).
import { describe, it, expect } from 'vitest';
import { formatAvailableSkills } from '../../client/studio/hooks/skillDiscovery';

describe('formatAvailableSkills', () => {
  it('renders discovered skills with name, scope, description, and path', () => {
    const out = formatAvailableSkills([
      {
        name: 'brainstorming',
        description: 'Turn ideas into designs',
        scope: 'plugin',
        path: '/p/.claude/skills/brainstorming/SKILL.md',
      },
    ]);
    expect(out).toMatch(/<available_skills>/);
    expect(out).toMatch(/brainstorming \(plugin\): Turn ideas into designs/);
    expect(out).toMatch(
      /path: \/p\/\.claude\/skills\/brainstorming\/SKILL\.md/,
    );
    expect(out).toMatch(/<\/available_skills>/);
  });
  it('renders (none) when there are no skills', () => {
    expect(formatAvailableSkills([])).toMatch(/\(none\)/);
  });
  it('excludes built-in command entries', () => {
    const out = formatAvailableSkills([
      { name: 'clear', description: 'x', scope: 'command', kind: 'command' },
    ]);
    expect(out).not.toMatch(/clear/);
  });
});
