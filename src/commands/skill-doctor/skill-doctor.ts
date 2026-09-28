/**
 * /skill-doctor — show which loaded skills are unused and costing context.
 *
 * Every enabled skill contributes frontmatter (name, description, whenToUse)
 * to the system prompt on every request, whether or not it is ever invoked.
 * This command lists all loaded skills sorted by that always-paid token cost
 * and flags the ones this session has actually used (via the Skill tool) so
 * the rest are visible as pure overhead. Disabling a skill in /skills or
 * removing it from the skills directory reclaims its cost.
 *
 * Rendering lives in the dependency-free ./skill-doctor-format.ts.
 */

import { getSessionId } from '../../bootstrap/state.js'
import type { LocalCommandCall, LocalJSXCommandContext } from '../../types/command.js'
import { getCwd } from '../../utils/cwd.js'
import {
  estimateSkillFrontmatterTokens,
  getSkillDirCommands,
} from '../../skills/loadSkillsDir.js'
import { formatSkillDoctor } from './skill-doctor-format.js'

function usedSkillNames(context: LocalJSXCommandContext): Set<string> {
  const used = new Set<string>()
  for (const message of context.messages ?? []) {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: string }).type === 'tool_use' &&
        (block as { name?: string }).name === 'Skill'
      ) {
        const skill = (block as { input?: { skill?: string } }).input?.skill
        if (skill) used.add(skill)
      }
    }
  }
  return used
}

export const call: LocalCommandCall = async (_args, context) => {
  const cwd = getCwd()
  const skillCommands = await getSkillDirCommands(cwd)
  const used = usedSkillNames(context)

  const rows = skillCommands.map(skill => ({
    name: skill.name,
    tokens: estimateSkillFrontmatterTokens(skill),
    usedThisSession: used.has(skill.name),
    source: skill.loadedFrom ?? 'skills',
  }))

  return {
    type: 'text',
    value: formatSkillDoctor(rows, getSessionId() as string),
  }
}
