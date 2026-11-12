import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { stripTypeScriptTypes } from 'node:module'
import { posix, normalize, sep, join } from 'node:path'
import { normalizeNameForMCP } from '../../src/services/mcp/normalization.ts'
import { defaultPermissionMode } from '../../src/utils/permissions/defaultPermissionMode.ts'
import { getMandatorySafetyCheck, hasExplicitAskRule, preferExplicitAsk } from '../../src/utils/permissions/PermissionResult.ts'

// Execute production policy functions, not copies. Only unavailable CLI/SDK
// services and the unchanged ignore-package adapter are isolated. Fixtures
// contain no real secrets and do not access a user's home or a network share.
const read = (path: string) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
function fn(source: string, name: string, optional = false): string {
  const match = new RegExp('^(?:export )?(?:async )?function ' + name + '(?:<|\\()', 'm').exec(source)
  if (!match) { assert.ok(optional, 'missing production function: ' + name); return '' }
  const rest = source.slice(match.index)
  const next = /\n(?:export )?(?:(?:async )?function\*? |(?:const|let|type|interface|class) )/.exec(rest)
  return rest.slice(0, next?.index ?? rest.length).replace(/^export /, '')
}
function load(source: string, names: string[], scope: Record<string, unknown>) {
  const code = stripTypeScriptTypes(names.map(name => fn(source, name)).join('\n'), { mode: 'transform' })
  return new Function(...Object.keys(scope), code + '\nreturn {' + names.join(',') + '};')(...Object.values(scope))
}
const root = '/fixture/project', home = '/fixture/home', sensitive = root + '/.future/settings.json'
const permissionSource = read('src/utils/permissions/permissions.ts')
const filesystemSource = read('src/utils/permissions/filesystem.ts')
const ruleParserSource = read('src/utils/permissions/permissionRuleParser.ts')
const mcp = load(read('src/services/mcp/mcpStringUtils.ts'),
  ['mcpInfoFromString', 'getMcpPrefix', 'buildMcpToolName', 'getToolNameForPermissionCheck'], { normalizeNameForMCP })
const parser = load(ruleParserSource, ['unescapeRuleContent', 'findFirstUnescapedChar', 'findLastUnescapedChar',
  'permissionRuleValueFromString'], { normalizeLegacyToolName: (name: string) => name })
const ruleFunctions = ['getAllowRules', 'getDenyRules', 'getAskRules', 'toolMatchesRule', 'toolAlwaysAllowedRule',
  'getDenyRuleForTool', 'getAskRuleForTool', 'getRuleByContentsForToolName']
const rules = load(permissionSource, ruleFunctions, { ...parser, ...mcp,
  PERMISSION_RULE_SOURCES: ['policySettings', 'userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'cliArg', 'command', 'session'] })
const ctx = (mode = defaultPermissionMode({}), deny: string[] = [], ask: string[] = [], allow: string[] = []) => ({
  mode, alwaysDenyRules: { session: deny }, alwaysAskRules: { session: ask }, alwaysAllowRules: { session: allow },
  additionalWorkingDirectories: new Map(), isBypassPermissionsModeAvailable: false,
})

// Exact fixture paths only: this adapter deliberately rejects unsupported
// glob expressions rather than silently substituting another matcher.
function ignoreAdapter() {
  let patterns: string[] = []
  return {
    add(input: string[]) { patterns = input; return this },
    test(path: string) {
      assert.ok(patterns.every(pattern => !/[?*\[\]]/.test(pattern)), 'fixture matcher only accepts literal paths')
      const found = patterns.find(pattern => {
        const p = pattern.replace(/^\/+/, '')
        return path === p || path.startsWith(p + '/')
      })
      return { ignored: found !== undefined, rule: found === undefined ? undefined : { pattern: found } }
    },
  }
}
function filesystem(options: { paths?: string[]; internal?: boolean } = {}) {
  const constants = ['DANGEROUS_FILES', 'DANGEROUS_DIRECTORIES'].map(name => {
    const start = filesystemSource.indexOf('export const ' + name + ' =')
    const end = filesystemSource.indexOf('] as const', start) + '] as const'.length
    assert.ok(start > 0 && end > start)
    return filesystemSource.slice(start, end).replace('export const', 'const')
  }).join('\n')
  const names = ['relativePath', 'normalizeCaseForComparison', 'pathInWorkingPath', 'isFutureSettingsPath',
    'isFutureConfigFilePath', 'isDangerousFilePathToAutoEdit', 'hasSuspiciousWindowsPathPattern', 'checkPathSafetyForAutoEdit',
    'rootPathForSource', 'patternWithRoot', 'getPatternsByRoot', 'matchingRuleForInput',
    'checkReadPermissionForTool', 'checkWritePermissionForTool']
  const extra = fn(filesystemSource, 'matchingRestrictionForFileTool', true)
  const body = stripTypeScriptTypes(constants + '\n' + extra + '\n' + names.map(name => fn(filesystemSource, name)).join('\n'), { mode: 'transform' })
  const scope = { ...rules, ...mcp, posix, normalize, sep, join, DIR_SEP: '/', ignore: ignoreAdapter,
    FILE_EDIT_TOOL_NAME: 'Edit', FILE_READ_TOOL_NAME: 'Read',
    FUTURE_FOLDER_PERMISSION_PATTERN: '/.future/**', GLOBAL_FUTURE_FOLDER_PERMISSION_PATTERN: '~/.future/**',
    homedir: () => home, getOriginalCwd: () => root, getCwd: () => root, getPlatform: () => 'linux',
    expandPath: (path: string) => path.startsWith('~/') ? posix.join(home, path.slice(2)) : path.startsWith('//') ? path : posix.resolve(root, path),
    getPathsForPermissionCheck: (path: string) => options.paths ?? [path],
    getSettingsPaths: () => [], getSettingsRootPathForSource: () => root,
    containsPathTraversal: (path: string) => path.split('/').includes('..'),
    containsVulnerableUncPath: (path: string) => path.startsWith('//') || path.startsWith('\\\\'),
    checkEditableInternalPath: () => ({ behavior: options.internal ? 'allow' : 'passthrough' }),
    checkReadableInternalPath: () => ({ behavior: options.internal ? 'allow' : 'passthrough' }),
    pathInAllowedWorkingPath: (path: string) => path.startsWith(root + '/'),
    getFutureSkillScope: () => null, generateSuggestions: () => [],
  }
  return new Function(...Object.keys(scope), body + '\nreturn {' + names.join(',') + '};')(...Object.values(scope))
}
function engine() {
  const names = ['checkRuleBasedPermissions', 'hasPermissionsToUseToolInner', 'getUpdatedInputOrFallback']
  const helper = fn(permissionSource, 'canBypassSensitiveFileCheck', true)
  const body = stripTypeScriptTypes(helper + '\n' + names.map(name => fn(permissionSource, name)).join('\n'), { mode: 'transform' })
  const scope = { ...rules, getMandatorySafetyCheck, hasExplicitAskRule, BASH_TOOL_NAME: 'Bash', SandboxManager: { isSandboxingEnabled: () => false },
    AbortError: Error, APIUserAbortError: class extends Error {}, logError: (error: unknown) => { throw error },
    createPermissionRequestMessage: () => 'permission request', logForDebugging: () => {}, jsonStringify: JSON.stringify }
  return new Function(...Object.keys(scope), body + '\nreturn {' + names.join(',') + '};')(...Object.values(scope))
}
function outerEngine() {
  const start = permissionSource.indexOf('export const hasPermissionsToUseTool:')
  const end = permissionSource.indexOf('\nfunction persistDenialState(', start)
  assert.ok(start > 0 && end > start)
  const code = stripTypeScriptTypes(permissionSource.slice(start, end).replace('export const', 'const'), { mode: 'transform' })
  let classifierCalls = 0
  const noop = () => {}
  const scope = { hasPermissionsToUseToolInner: engine().hasPermissionsToUseToolInner,
    feature: (name: string) => ['TRANSCRIPT_CLASSIFIER', 'POWERSHELL_AUTO_MODE'].includes(name),
    autoModeStateModule: null, POWERSHELL_TOOL_NAME: 'PowerShell', AGENT_TOOL_NAME: 'Agent', REPL_TOOL_NAME: 'REPL',
    classifierDecisionModule: { isAutoModeAllowlistedTool: () => false },
    createDenialTrackingState: () => ({ totalDenials: 0, consecutiveDenials: 0 }), recordSuccess: (state: unknown) => state,
    persistDenialState: noop, formatActionForClassifier: () => 'dummy action', setClassifierChecking: noop, clearClassifierChecking: noop,
    classifyYoloAction: async () => { classifierCalls++;return { shouldBlock: false, reason: 'fixture classifier allows' } },
    logForDebugging: noop, logEvent: noop, sanitizeToolNameForAnalytics: (name: string) => name, isInProtectedNamespace: () => false,
    getTotalInputTokens: () => 0, getTotalOutputTokens: () => 0, getTotalCacheReadInputTokens: () => 0,
    getTotalCacheCreationInputTokens: () => 0, addToTurnClassifierDuration: noop,
  }
  const run = new Function(...Object.keys(scope), code + '\nreturn hasPermissionsToUseTool;')(...Object.values(scope))
  return { run, classifierCalls: () => classifierCalls }
}
function tool(name: string, fs = filesystem()) {
  const result: any = { name, inputSchema: { parse: (input: unknown) => input }, getPath: (input: any) => input.file_path,
    checkPermissions: (input: any, context: any) => (name === 'Read' ? fs.checkReadPermissionForTool : fs.checkWritePermissionForTool)(
      result, input, context.getAppState().toolPermissionContext) }
  return result
}
function literalPathPolicy(kind: 'bash' | 'powershell', aliases: Record<string, string> = {}) {
  const fs = filesystem()
  const source = read(kind === 'bash' ? 'src/utils/permissions/pathValidation.ts' : 'src/tools/PowerShellTool/pathValidation.ts')
  return load(source, ['isPathAllowed', 'validatePath'], { preferExplicitAsk,
    matchingRuleForInput: fs.matchingRuleForInput, checkPathSafetyForAutoEdit: fs.checkPathSafetyForAutoEdit,
    checkEditableInternalPath: () => ({ behavior: 'passthrough' }), checkReadableInternalPath: () => ({ behavior: 'passthrough' }),
    pathInAllowedWorkingPath: (p: string) => p.startsWith(root + '/'), isPathInSandboxWriteAllowlist: () => false,
    getPathsForPermissionCheck: (p: string) => [...new Set([p, aliases[p] ?? p])],
    getFsImplementation: () => ({}), safeResolvePath: (_: unknown, p: string) => ({ resolvedPath: aliases[p] ?? p, isCanonical: true }),
    getPlatform: () => 'linux', isAbsolute: posix.isAbsolute, resolve: posix.resolve,
    expandTilde: (p: string) => p.startsWith('~/') ? home + p.slice(1) : p,
    containsVulnerableUncPath: (p: string) => p.startsWith('//'),
    containsPathTraversal: (p: string) => p.split('/').includes('..'), GLOB_PATTERN_REGEX: /[*?[\]{}]/,
  })
}
function shell(kind: 'bash' | 'powershell', aliases: Record<string, string> = {}) {
  const paths = literalPathPolicy(kind, aliases)
  const common = { ...paths, preferExplicitAsk, allWorkingDirectories: () => new Set([root]),
    formatDirectoryList: (dirs: string[]) => dirs.join(','), getDirectoryForPath: posix.dirname,
    createReadRuleSuggestion: () => null, getCwd: () => root }
  if (kind === 'bash') return load(read('src/tools/BashTool/pathValidation.ts'),
    ['validateCommandPaths', 'createPathChecker', 'validateSinglePathCommandArgv', 'validateOutputRedirections', 'checkPathConstraints', 'astRedirectsToOutputRedirections'], {
      ...common, PATH_EXTRACTORS: { cat: (args: string[]) => args, touch: (args: string[]) => args },
      COMMAND_OPERATION_TYPE: { cat: 'read', touch: 'create' }, COMMAND_VALIDATOR: {}, ACTION_VERBS: { cat: 'read', touch: 'write' },
      SUPPORTED_PATH_COMMANDS: ['cat', 'touch'], stripWrappersFromArgv: (argv: string[]) => argv,
    })
  return load(read('src/tools/PowerShellTool/pathValidation.ts'), ['checkPathConstraintsForStatement', 'checkPathConstraints'], {
    ...common, resolveToCanonical: (name: string) => name.toLowerCase(), CMDLET_PATH_CONFIG: {},
    extractPathsFromCommand: (command: any) => ({ paths: command.paths, operationType: command.operationType,
      hasUnvalidatablePathArg: false, optionalWrite: false }), isNullRedirectionTarget: (path: string) => path === '/dev/null',
  })
}
function command(kind: 'bash' | 'powershell', paths: string[], operation: string) {
  return kind === 'bash' ? { argv: [operation === 'read' ? 'cat' : 'touch', ...paths], text: 'literal fixture' }
    : { elementType: 'CommandAst', name: operation === 'read' ? 'get-content' : 'set-content', paths, operationType: operation }
}
function shellCheck(kind: 'bash' | 'powershell', permission: any, commands: any[], redirects: string[] = [], aliases: Record<string, string> = {}) {
  const policy = shell(kind, aliases)
  if (kind === 'bash') return policy.checkPathConstraints({ command: 'literal AST fixture' }, root, permission, false,
    redirects.map(target => ({ op: '>', target })), commands)
  return policy.checkPathConstraints({ command: 'literal AST fixture' }, { valid: true, statements: [{ commands,
    redirections: redirects.map(target => ({ target })) }] }, permission)
}
const context = (permission: any) => ({ getAppState: () => ({ toolPermissionContext: permission }), abortController: new AbortController() })
const check = (name: string, path: string, permission = ctx(), fs = filesystem()) =>
  engine().hasPermissionsToUseToolInner(tool(name, fs), { file_path: path }, context(permission))

for (const name of ['Edit', 'Write', 'NotebookEdit']) for (const path of [sensitive, home + '/.zshrc', root + '/.git/config', root + '/.vscode/settings.json']) {
  test('owner full access does not prompt for ' + name + ': ' + path, async () => {
    const result = await check(name, path)
    assert.equal(result.behavior, 'allow')
    assert.equal(result.decisionReason.type, 'mode')
  })
}
for (const path of [home + '/.ssh/id_rsa', home + '/.aws/credentials', root + '/.env']) {
  test('full-access reads cover home and credential-shaped dummy paths: ' + path, async () => {
    assert.equal((await check('Read', path)).behavior, 'allow')
  })
}
test('hook rule-only checks honor the same full-access sensitivity policy', async () => {
  assert.equal(await engine().checkRuleBasedPermissions(tool('Write'), { file_path: sensitive }, context(ctx())), null)
})
for (const mode of ['default', 'acceptEdits', 'dontAsk', 'plan']) {
  test('an explicitly selected restricted mode retains sensitivity checks: ' + mode, async () => {
    assert.equal((await check('Write', sensitive, ctx(mode))).behavior, 'ask')
  })
}
for (const value of [false, undefined, 'true']) {
  test('structural or malformed safety decisions never inherit file authorization: ' + value, async () => {
    const decision = { behavior: 'ask', message: 'structural guard', decisionReason: { type: 'safetyCheck', classifierApprovable: value } }
    const t = { name: 'SendMessage', inputSchema: { parse: (x: unknown) => x }, checkPermissions: () => decision }
    assert.equal((await engine().hasPermissionsToUseToolInner(t, {}, context(ctx()))).behavior, 'ask')
    assert.equal((await engine().checkRuleBasedPermissions(t, {}, context(ctx()))).behavior, 'ask')
  })
}
test('current mode after an asynchronous tool check governs sensitivity allowance', async () => {
  const state = ctx()
  const t = tool('Write');const original = t.checkPermissions
  t.checkPermissions = async (input: any, c: any) => { const result = original(input, c);state.mode = 'default';return result }
  assert.equal((await engine().hasPermissionsToUseToolInner(t, { file_path: sensitive }, context(state))).behavior, 'ask')
})
for (const name of ['Write', 'NotebookEdit', 'Edit']) for (const behavior of ['deny', 'ask']) {
  test('declared ' + name + ' file ' + behavior + ' precedes sensitivity and internal allows', async () => {
    const rules = [name + '(/.future/settings.json)']
    const permission = ctx('bypassPermissions', behavior === 'deny' ? rules : [], behavior === 'ask' ? rules : [])
    for (const internal of [false, true]) {
      const fs = filesystem({ internal })
      const result = await check(name, sensitive, permission, fs)
      assert.equal(result.behavior, behavior)
      assert.equal(result.decisionReason.type, 'rule')
      const hook = await engine().checkRuleBasedPermissions(tool(name, fs), { file_path: sensitive }, context(permission))
      assert.equal(hook?.behavior, behavior)
    }
  })
}
test('generic Edit file restrictions cover Write and NotebookEdit without broadening allow rules', async () => {
  for (const name of ['Write', 'NotebookEdit']) for (const behavior of ['deny', 'ask']) {
    const rule = 'Edit(/.future/settings.json)', permission = ctx('bypassPermissions', behavior === 'deny' ? [rule] : [], behavior === 'ask' ? [rule] : [])
    assert.equal((await check(name, sensitive, permission)).behavior, behavior)
  }
})

test('native tool-wide restrictions still outrank full access', async () => {
  for (const name of ['Read', 'Write', 'Edit', 'NotebookEdit']) for (const behavior of ['deny', 'ask']) {
    const permission = ctx('bypassPermissions', behavior === 'deny' ? [name] : [], behavior === 'ask' ? [name] : [])
    assert.equal((await check(name, sensitive, permission)).behavior, behavior)
  }
})
test('qualified MCP file rules retain identity when a tool shares the Write display name', async () => {
  const t = tool('Write');t.mcpInfo = { serverName: 'fixture', toolName: 'Write' }
  for (const behavior of ['deny', 'ask']) {
    const rule = 'mcp__fixture__Write(/.future/settings.json)'
    const permission = ctx('bypassPermissions', behavior === 'deny' ? [rule] : [], behavior === 'ask' ? [rule] : [])
    assert.equal((await engine().hasPermissionsToUseToolInner(t, { file_path: sensitive }, context(permission))).behavior, behavior)
    assert.equal((await check('Write', sensitive, permission)).behavior, 'allow', 'qualified MCP restriction cannot be reassigned to a native tool')
  }
  assert.equal((await engine().hasPermissionsToUseToolInner(t, { file_path: sensitive }, context(ctx('bypassPermissions', ['Write'])))).behavior, 'allow')
})
test('full-access availability in plan mode preserves its existing permission semantics', async () => {
  const permission = { ...ctx('plan'), isBypassPermissionsModeAvailable: true }
  assert.equal((await check('Write', sensitive, permission)).behavior, 'allow')
  assert.equal(await engine().checkRuleBasedPermissions(tool('Write'), { file_path: sensitive }, context(permission)), null)
})
test('required interaction remains distinct from a sensitive-file heuristic', async () => {
  const t = { ...tool('Write'), requiresUserInteraction: () => true }
  assert.equal((await engine().hasPermissionsToUseToolInner(t, { file_path: sensitive }, context(ctx()))).behavior, 'ask')
})
test('the real outer auto-mode pipeline cannot classify an ambiguous write path as allowed when an ask also matches', async () => {
  const path = root + '/FUTURE~1/config', permission = ctx('auto', [], ['Edit(/FUTURE~1/config)'])
  const outer = outerEngine()
  const result = await outer.run(tool('Write'), { file_path: path }, { ...context(permission), messages: [], options: { tools: [] } },
    { message: { id: 'fixture' } }, 'fixture-id')
  assert.equal(result.behavior, 'ask')
  assert.equal(result.decisionReason.type, 'safetyCheck')
  assert.equal(result.decisionReason.classifierApprovable, false)
  assert.equal(outer.classifierCalls(), 0)
})
test('mandatory compound safety retains original updated input and cannot be weakened by a declared ask', async () => {
  const guard: any = { behavior: 'ask', message: 'mandatory', decisionReason: { type: 'safetyCheck', classifierApprovable: false } }
  const ask: any = { behavior: 'ask', message: 'declared', decisionReason: { type: 'rule',
    rule: { ruleBehavior: 'ask', ruleValue: { toolName: 'Edit', ruleContent: '/asked.txt' }, source: 'session' } } }
  for (const pair of [[guard, ask], [ask, guard]]) {
    const selected = preferExplicitAsk(pair[0], pair[1])!
    assert.equal(selected.decisionReason.type, 'safetyCheck')
    const updatedInput = { command: 'entire original command' }
    const compound: any = { behavior: 'ask', message: 'compound', updatedInput,
      decisionReason: { type: 'subcommandResults', reasons: new Map([['a', pair[0]], ['b', pair[1]]]) } }
    const t = { name: 'Bash', inputSchema: { parse: (x: unknown) => x }, checkPermissions: () => compound }
    const decision = await engine().hasPermissionsToUseToolInner(t, {}, context(ctx()))
    assert.equal(decision.behavior, 'ask');assert.strictEqual(decision.updatedInput, updatedInput)
    assert.equal(decision.decisionReason.classifierApprovable, false)
    const outer = outerEngine()
    assert.equal((await outer.run(t, {}, { ...context(ctx('auto')), messages: [], options: { tools: [] } },
      { message: { id: 'fixture' } }, 'id')).behavior, 'ask')
    assert.equal(outer.classifierCalls(), 0)
  }
})
test('explicit denial outranks mandatory path validation without asking for an override', async () => {
  const path = root + '/FUTURE~1/config'
  assert.equal((await check('Write', path, ctx('bypassPermissions', ['Write(/FUTURE~1/config)']))).behavior, 'deny')
})
test('mode changes during hook rule checks cannot grant stale full access', async () => {
  const permission = ctx(), t = tool('Write'), check = t.checkPermissions
  t.checkPermissions = async (input: any, c: any) => { const result = check(input, c);permission.mode = 'default';return result }
  assert.equal((await engine().checkRuleBasedPermissions(t, { file_path: sensitive }, context(permission))).behavior, 'ask')
})
test('hook allows recheck their updated target against actual read/write restrictions', async () => {
  const policy = engine()
  const hooks = load(read('src/services/tools/toolHooks.ts'), ['resolveHookPermissionDecision'], {
    checkRuleBasedPermissions: policy.checkRuleBasedPermissions, logForDebugging: () => {},
  })
  let prompts = 0
  const canUseTool = async (t: any, input: any, c: any) => { prompts++;return policy.hasPermissionsToUseToolInner(t, input, c) }
  const updated = { file_path: sensitive }, original = { file_path: root + '/ordinary.txt' }
  const allowed = await hooks.resolveHookPermissionDecision({ behavior: 'allow', updatedInput: updated }, tool('Write'), original,
    context(ctx()), canUseTool, {}, 'test-hook')
  assert.equal(allowed.decision.behavior, 'allow');assert.equal(prompts, 0)
  const denied = await hooks.resolveHookPermissionDecision({ behavior: 'allow', updatedInput: updated }, tool('Write'), original,
    context(ctx('bypassPermissions', ['Write(/.future/settings.json)'])), canUseTool, {}, 'test-hook')
  assert.equal(denied.decision.behavior, 'deny');assert.equal(prompts, 0)
  const ask = await hooks.resolveHookPermissionDecision({ behavior: 'allow', updatedInput: updated }, tool('Write'), original,
    context(ctx('bypassPermissions', [], ['Write(/.future/settings.json)'])), canUseTool, {}, 'test-hook')
  assert.equal(ask.decision.behavior, 'ask');assert.equal(prompts, 1, 'only an explicitly configured ask reaches the prompt boundary')
})
test('compound shell receipts cannot hide a declared file or command ask from bypass or hook checks', async () => {
  const rule = { source: 'session', ruleBehavior: 'ask', ruleValue: { toolName: 'Edit', ruleContent: '/.future/settings.json' } }
  const leaf: any = { behavior: 'ask', message: 'declared boundary', decisionReason: { type: 'rule', rule } }
  const combined: any = { behavior: 'ask', message: 'combined shell', decisionReason: { type: 'subcommandResults',
    reasons: new Map([['write config', leaf], ['ordinary', { behavior: 'allow' }]]) } }
  const nested: any = { behavior: 'ask', message: 'nested', decisionReason: { type: 'subcommandResults', reasons: new Map([['compound', combined]]) } }
  nested.decisionReason.reasons.set('cycle', nested)
  for (const name of ['Bash', 'PowerShell']) {
    const t = { name, inputSchema: { parse: (x: unknown) => x }, checkPermissions: () => nested }
    assert.equal((await engine().hasPermissionsToUseToolInner(t, {}, context(ctx()))).behavior, 'ask')
    assert.equal((await engine().checkRuleBasedPermissions(t, {}, context(ctx()))).behavior, 'ask')
  }
})
test('dummy file lifecycle: authorize, write, read, serialize restriction, reopen and deny without changing the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sensitive-owner-access-'))
  try {
    const path = join(dir, '.future/settings.json');mkdirSync(join(dir, '.future'))
    const permission = ctx(), input = { file_path: path }
    assert.equal((await engine().hasPermissionsToUseToolInner(tool('Write'), input, context(permission))).behavior, 'allow')
    writeFileSync(path, '{"dummy":true}\n')
    assert.equal((await check('Read', path)).behavior, 'allow')
    assert.equal(readFileSync(path, 'utf8'), '{"dummy":true}\n')
    const alias = join(dir, 'alias.json');symlinkSync(path, alias)
    const saved = JSON.stringify(['Write(/' + realpathSync(path) + ')'])
    const restored = ctx('bypassPermissions', JSON.parse(saved))
    const reopened = engine(), fs = filesystem({ paths: [alias, realpathSync(path)] })
    const result = await reopened.hasPermissionsToUseToolInner(tool('Write', fs), { file_path: alias }, context(restored))
    assert.equal(result.behavior, 'deny')
    if (result.behavior === 'allow') writeFileSync(alias, 'unexpected overwrite')
    assert.equal(readFileSync(path, 'utf8'), '{"dummy":true}\n')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

for (const kind of ['bash', 'powershell'] as const) {
  for (const operation of ['read', 'create']) for (const behavior of ['ask', 'deny']) {
    test(kind + ' actual command caller preserves ' + operation + ' ' + behavior, async () => {
      const name = operation === 'read' ? 'Read' : 'Edit', rule = name + '(/.future/settings.json)'
      const permission = ctx('bypassPermissions', behavior === 'deny' ? [rule] : [], behavior === 'ask' ? [rule] : [])
      const result = shellCheck(kind, permission, [command(kind, [sensitive], operation)])
      assert.equal(result.behavior, behavior)
      assert.equal(result.decisionReason.rule.ruleBehavior, behavior)
      const t = { name: kind === 'bash' ? 'Bash' : 'PowerShell', inputSchema: { parse: (x: unknown) => x }, checkPermissions: () => result }
      assert.equal((await engine().hasPermissionsToUseToolInner(t, {}, context(permission))).behavior, behavior)
      assert.equal((await engine().checkRuleBasedPermissions(t, {}, context(permission))).behavior, behavior)
    })
  }
  for (const behavior of ['ask', 'deny']) {
    test(kind + ' redirects preserve explicit ' + behavior + ' through their actual caller', () => {
      const rule = 'Edit(/.future/settings.json)', permission = ctx('bypassPermissions', behavior === 'deny' ? [rule] : [], behavior === 'ask' ? [rule] : [])
      assert.equal(shellCheck(kind, permission, [], [sensitive]).behavior, behavior)
    })
  }
  for (const layout of ['same-command', 'separate-commands', 'redirects']) {
    test(kind + ' does not let an earlier ask hide a later deny: ' + layout, () => {
      const asked = root + '/asked.txt', denied = root + '/denied.txt', edit = layout === 'redirects'
      const permission = ctx('bypassPermissions', [(edit ? 'Edit' : 'Read') + '(/denied.txt)'], [(edit ? 'Edit' : 'Read') + '(/asked.txt)'])
      const commands = edit ? [] : layout === 'same-command' ? [command(kind, [asked, denied], 'read')]
        : [command(kind, [asked], 'read'), command(kind, [denied], 'read')]
      const result = shellCheck(kind, permission, commands, edit ? [asked, denied] : [])
      assert.equal(result.behavior, 'deny')
      assert.equal(result.decisionReason.rule.ruleBehavior, 'deny')
    })
  }
  for (const operation of ['read', 'create']) {
    test(kind + ' retains a declared ask after an earlier heuristic: ' + operation, async () => {
      const rule = (operation === 'read' ? 'Read' : 'Edit') + '(/asked.txt)', permission = ctx('bypassPermissions', [], [rule])
      const result = shellCheck(kind, permission, [command(kind, [home + '/outside.txt'], operation), command(kind, [root + '/asked.txt'], operation)])
      assert.equal(result.behavior, 'ask')
      assert.equal(result.decisionReason.type, 'rule')
      const t = { name: kind === 'bash' ? 'Bash' : 'PowerShell', inputSchema: { parse: (x: unknown) => x }, checkPermissions: () => result }
      assert.equal((await engine().hasPermissionsToUseToolInner(t, {}, context(permission))).behavior, 'ask')
      assert.equal((await engine().checkRuleBasedPermissions(t, {}, context(permission))).behavior, 'ask')
    })
  }
  for (const behavior of ['deny', 'ask']) {
    test(kind + ' canonical resolution retains the declared original alias restriction: ' + behavior, () => {
      const alias = root + '/alias.txt', target = root + '/actual.txt', rule = 'Read(/alias.txt)'
      const permission = ctx('bypassPermissions', behavior === 'deny' ? [rule] : [], behavior === 'ask' ? [rule] : [])
      assert.equal(shellCheck(kind, permission, [command(kind, [alias], 'read')], [], { [alias]: target }).behavior, behavior)
    })
  }
  test(kind + ' owner authorization allows a sensitive write through its actual caller without a declared restriction', async () => {
    const result = shellCheck(kind, ctx(), [command(kind, [sensitive], 'create')])
    assert.equal(result.decisionReason.classifierApprovable, true)
    const t = { name: kind === 'bash' ? 'Bash' : 'PowerShell', inputSchema: { parse: (x: unknown) => x }, checkPermissions: () => result }
    assert.equal((await engine().hasPermissionsToUseToolInner(t, {}, context(ctx()))).behavior, 'allow')
    assert.equal(await engine().checkRuleBasedPermissions(t, {}, context(ctx())), null)
  })
  for (const guardFirst of [true, false]) {
    test(kind + ' compound safety stays mandatory through outer auto approval: guardFirst=' + guardFirst, async () => {
      const paths = [root + '/FUTURE~1/config', root + '/asked.txt']
      if (!guardFirst) paths.reverse()
      const permission = ctx('auto', [], ['Edit(/asked.txt)'])
      const result = shellCheck(kind, permission, paths.map(path => command(kind, [path], 'create')))
      assert.equal(result.behavior, 'ask');assert.equal(result.decisionReason.classifierApprovable, false)
      const t = { name: kind === 'bash' ? 'Bash' : 'PowerShell', inputSchema: { parse: (x: unknown) => x }, checkPermissions: () => result }
      const outer = outerEngine()
      assert.equal((await outer.run(t, {}, { ...context(permission), messages: [], options: { tools: [] } },
        { message: { id: 'fixture' } }, 'id')).behavior, 'ask')
      assert.equal(outer.classifierCalls(), 0)
    })
  }
}
for (const behavior of ['deny', 'ask']) {
  test('read-specific ' + behavior + ' wins over heuristic and edit-implied read access', async () => {
    const path = '//server/share/secret', rule = 'Read(//server/share/secret)'
    const permission = ctx('bypassPermissions', behavior === 'deny' ? [rule] : [], behavior === 'ask' ? [rule] : [], ['Edit'])
    assert.equal((await check('Read', path, permission)).behavior, behavior)
  })
  test('restrictions apply to each resolved path: ' + behavior, async () => {
    const alias = root + '/alias.json', rule = 'Write(/.future/settings.json)'
    const permission = ctx('bypassPermissions', behavior === 'deny' ? [rule] : [], behavior === 'ask' ? [rule] : [])
    assert.equal((await check('Write', alias, permission, filesystem({ paths: [alias, sensitive] }))).behavior, behavior)
  })
}
for (const file of ['src/utils/permissions/pathValidation.ts', 'src/tools/PowerShellTool/pathValidation.ts']) {
  test('shell path restrictions precede sensitivity and internal shortcuts: ' + file, () => {
    const fs = filesystem({ internal: true })
    const policy = load(read(file), ['isPathAllowed'], { matchingRuleForInput: fs.matchingRuleForInput,
      checkEditableInternalPath: () => ({ behavior: 'allow' }), checkReadableInternalPath: () => ({ behavior: 'allow' }),
      checkPathSafetyForAutoEdit: fs.checkPathSafetyForAutoEdit, pathInAllowedWorkingPath: () => true,
      isPathInSandboxWriteAllowlist: () => true, getPathsForPermissionCheck: (p: string) => [p] })
    for (const operation of ['read', 'write', 'create']) {
      const name = operation === 'read' ? 'Read' : 'Edit'
      const result = policy.isPathAllowed(sensitive, ctx('bypassPermissions', [], [name + '(/.future/settings.json)']), operation)
      assert.equal(result.allowed, false)
      assert.equal(result.decisionReason.type, 'rule')
      assert.equal(result.decisionReason.rule.ruleBehavior, 'ask')
    }
  })
}
