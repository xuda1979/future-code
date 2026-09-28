import type { Command } from '../../commands.js'

const pauseMemory = {
  type: 'local',
  name: 'pause-memory',
  description: 'Pause auto-memory for this session',
  supportsNonInteractive: true,
  load: () => import('./pause-memory.js'),
} satisfies Command

export default pauseMemory
