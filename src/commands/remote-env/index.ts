import type { Command } from '../../commands.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { isFutureAISubscriber } from '../../utils/auth.js'

export default {
  type: 'local-jsx',
  name: 'remote-env',
  description: 'Configure the default remote environment for teleport sessions',
  isEnabled: () =>
    isFutureAISubscriber() && isPolicyAllowed('allow_remote_sessions'),
  get isHidden() {
    return !isFutureAISubscriber() || !isPolicyAllowed('allow_remote_sessions')
  },
  load: () => import('./remote-env.js'),
} satisfies Command
