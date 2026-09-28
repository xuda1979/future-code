import type { Command } from '../../commands.js'

const skillDoctor = {
  type: 'local',
  name: 'skill-doctor',
  description: 'Show which loaded skills are unused and costing context',
  supportsNonInteractive: true,
  load: () => import('./skill-doctor.js'),
} satisfies Command

export default skillDoctor
