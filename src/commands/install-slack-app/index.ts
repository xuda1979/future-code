import type { Command } from '../../commands.js'

const installSlackApp = {
  type: 'local',
  name: 'install-slack-app',
  description: 'Install the Future Slack app',
  availability: ['future-ai'],
  supportsNonInteractive: false,
  load: () => import('./install-slack-app.js'),
} satisfies Command

export default installSlackApp
