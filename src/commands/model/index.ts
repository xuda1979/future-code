import type { Command } from '../../commands.js'
import { getMainLoopModel, renderModelName } from '../../utils/model/model.js'

export default {
  type: 'local-jsx',
  name: 'model',
  get description() {
    return `Select a model or add an endpoint locally with /model add (currently ${renderModelName(getMainLoopModel())})`
  },
  argumentHint: '[model | add <id> <base-url> | list]',
  // This is also the recovery command for a stalled provider. It must not
  // queue behind the very inference request the operator is replacing.
  immediate: true,
  load: () => import('./model.js'),
} satisfies Command
