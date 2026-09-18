import type { Command } from '../../commands.js'
import { hasFutureApiKeyAuth } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'login',
    description: hasFutureApiKeyAuth()
      ? 'Switch Future accounts'
      : 'Sign in with your Future account',
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND),
    load: () => import('./login.js'),
  }) satisfies Command
