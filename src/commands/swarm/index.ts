import type { Command } from '../../types/command.js'

const planning = `You are coordinating a Foundry Swarm coding task in this existing Future Code session.
Inspect the repository and the operator's swarm spec; do not invent unavailable files or tests.
Produce a bounded Task[] JSON plan, with id, agent (from the pinned roster), goal, acceptance,
dependencies, writeScope, readScope, input, and optional estimatedDurationMs/priority.
Partition by independently verifiable outputs, not arbitrary line counts. Keep interfaces and
shared-schema changes on an explicit dependency path. Avoid overlapping independent writers.
Each worker sees only its capsule and verified dependencies, not this conversation: include the
necessary interfaces, invariants and file paths, but not full histories or logs. Workers can
read scoped files and run only their configured named checks. There is no recursive delegation.
Check that existing frozen verifier checks test the intended behavior; report missing coverage
rather than modifying or weakening trusted checks to get a PASS. Do not put credentials in plans.
Save the proposed plan in a user-approved JSON file. Do not silently initialize, call paid models,
run code, or integrate a branch: these require the user's explicit /swarm ... --allow-exec action.
Use /swarm status/events for evidence. Task PASS is not integration PASS. Never merge into main
or claim a live-model speedup without a matched measurement. Read docs/agent-platform/SWARM.md
for the contract, commands, limits and recovery behavior.`

export const swarmPlan = {
  type: 'prompt',
  name: 'swarm-plan',
  description: 'Plan scoped parallel coding tasks using the current agent as coordinator',
  argumentHint: '<goal>',
  source: 'builtin',
  disableModelInvocation: true,
  contentLength: planning.length,
  progressMessage: 'planning independently verifiable coding tasks',
  async getPromptForCommand(args, _context) {
    return [{ type: 'text', text: `${planning}\n\nUser goal:\n${args}` }]
  },
} satisfies Command

export default {
  type: 'local',
  name: 'swarm',
  description: 'Run durable, scoped coding agents with the existing Foundry kernel',
  argumentHint: 'help | init | run | resume | status | events | integrate',
  supportsNonInteractive: true,
  disableModelInvocation: true,
  load: () => import('./swarm.ts'),
} satisfies Command
