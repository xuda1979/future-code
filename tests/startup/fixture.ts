import { isInBundledMode } from '../../src/utils/bundledMode.ts'
import { SandboxManager, convertToSandboxRuntimeConfig } from '../../src/utils/sandbox/sandbox-adapter.ts'
import { getRipgrepStatus, ripgrepCommand, ripGrep } from '../../src/utils/ripgrep.ts'
import { createRipgrepShellIntegration } from '../../src/utils/bash/ShellSnapshot.ts'
import { calls, settings, replaceSettings } from './dependencies.ts'

const action = process.argv[2]
let result: unknown
if (action === 'mode') {
  result = { bundled: isInBundledMode(), embeddedFiles: Bun.embeddedFiles.length }
} else if (action === 'sandbox') {
  result = {
    enabled: SandboxManager.isSandboxingEnabled(),
    reason: SandboxManager.getSandboxUnavailableReason(),
    required: SandboxManager.isSandboxRequired(),
    calls,
  }
} else if (action === 'dependencies') {
  result = { ...SandboxManager.checkDependencies(), calls }
} else if (action === 'reconfigure') {
  const before = SandboxManager.checkDependencies()
  replaceSettings(JSON.parse(process.env.TEST_NEXT_SETTINGS!))
  result = { before, after: SandboxManager.checkDependencies(), calls }
} else if (action === 'config') {
  result = convertToSandboxRuntimeConfig(settings).ripgrep
} else if (action === 'status') {
  result = getRipgrepStatus()
} else if (action === 'shell') {
  result = createRipgrepShellIntegration()
} else if (action === 'command') {
  result = ripgrepCommand()
} else if (action === 'search') {
  result = await ripGrep(['--files'], process.cwd(), new AbortController().signal)
} else {
  throw new Error(`unknown fixture action: ${action}`)
}
console.log(JSON.stringify(result))
