import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

// Only isolate prompt/bootstrap dependencies. Context, execa, Git, and the
// project layout collector are the real implementation.
const noop = () => {}
const stub = (path: string, exports: Record<string, unknown>) =>
  mock.module(new URL(`../../src/${path}.ts`, import.meta.url).pathname, () => exports)
let git = 'git'
let workingDirectory: string | undefined
mock.module('bun:bundle', () => ({ feature: () => false }))
stub('bootstrap/state', { getAdditionalDirectoriesForFutureMd: () => [], setCachedFutureMdContent: noop })
stub('constants/common', { getLocalISODate: () => '' })
stub('utils/cwd', { getCwd: () => workingDirectory ?? process.cwd() })
stub('utils/systemResources', { getMemoryContextLine: () => '' })
stub('utils/futuremd', { filterInjectedMemoryFiles: noop, getFutureMds: noop, getMemoryFiles: noop })
stub('utils/diagLogs', { logForDiagnosticsNoPII: noop })
stub('utils/envUtils', { isBareMode: () => false, isEnvTruthy: () => false })
stub('utils/execFileNoThrowPortable', { execSyncWithDefaults_DEPRECATED: noop })
stub('utils/git', {
  getBranch: async () => 'work', getDefaultBranch: async () => 'main',
  getIsGit: async () => true, gitExe: () => git,
})
stub('utils/gitSettings', { shouldIncludeGitInstructions: () => true })
stub('utils/log', { logError: noop })

const { getGitStatus, getSystemContext } = await import('../../src/context.ts')
const { execFileNoThrowWithCwd } = await import('../../src/utils/execFileNoThrow.ts')

async function fixture(run: (dir: string) => Promise<void>) {
  const cwd = process.cwd(), nodeEnv = process.env.NODE_ENV
  const dir = mkdtempSync(join(tmpdir(), 'git-context-'))
  try {
    delete process.env.NODE_ENV
    process.chdir(dir)
    execFileSync('git', ['init', '-q', '-b', 'work'])
    execFileSync('git', ['config', 'status.showUntrackedFiles', 'normal'])
    writeFileSync('tracked.txt', 'valid\n')
    execFileSync('git', ['add', 'tracked.txt'])
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
      'commit', '-qm', 'pinned starting commit'])
    getGitStatus.cache.clear?.()
    getSystemContext.cache.clear?.()
    await run(dir)
  } finally {
    git = 'git'
    workingDirectory = undefined
    if (nodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnv
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('healthy startup preserves real tracked and untracked status', () => fixture(async () => {
  assert.match(await getGitStatus() ?? '', /Status:\n\(clean\)/)
  writeFileSync('tracked.txt', 'changed\n')
  writeFileSync('new.txt', 'new\n')
  getGitStatus.cache.clear?.()
  const snapshot = await getGitStatus()
  assert.match(snapshot ?? '', /^ M tracked\.txt$/m)
  assert.match(snapshot ?? '', /\?\? new\.txt/)
  assert.match(snapshot ?? '', /pinned starting commit/)
}))

test('a Git status failure is reported as unavailable', () => fixture(async dir => {
  git = join(dir, 'fixture-git')
  writeFileSync(git, '#!/bin/sh\nif [ "$2" = status ]; then exit 42; fi\nexec git "$@"\n', { mode: 0o700 })
  const snapshot = await getGitStatus()
  assert.match(snapshot ?? '', /Status:\n\(unavailable/)
  assert.match(snapshot ?? '', /Current branch: work/)
}))

test('Git and layout use the same working directory as the request', () => fixture(async dir => {
  workingDirectory = dir
  process.chdir(tmpdir())
  const context = await getSystemContext()
  assert.match(context.gitStatus ?? '', /pinned starting commit/)
  assert.match(context.projectDigest ?? '', /tracked\.txt/)
}))

test('a slow optional Git scan yields the first request with layout and completed Git facts', () => fixture(async dir => {
  git = join(dir, 'fixture-git')
  writeFileSync(git, '#!/bin/sh\nif [ "$2" = status ]; then exec sleep 3; fi\nexec git "$@"\n', { mode: 0o700 })
  const start = performance.now()
  const context = await getSystemContext()
  assert.ok(performance.now() - start < 2300, 'startup must not wait for the slow status process')
  assert.match(context.gitStatus ?? '', /Status:\n\(unavailable/)
  assert.match(context.gitStatus ?? '', /pinned starting commit/)
  assert.match(context.projectDigest ?? '', /tracked\.txt/)
}))

test('the Git subprocess wrapper runs cancellable commands and honors abort', () => fixture(async dir => {
  const controller = new AbortController()
  const running = execFileNoThrowWithCwd('/bin/sh', ['-c', 'touch started && exec sleep 10'], {
    cwd: dir, abortSignal: controller.signal, timeout: 5000,
  })
  try {
    await Promise.race([
      running.then(result => { throw new Error(`Child exited before cancellation with code ${result.code}`) }),
      (async () => {
        const deadline = performance.now() + 2000
        while (!existsSync(join(dir, 'started')) && performance.now() < deadline) await delay(10)
        assert.ok(existsSync(join(dir, 'started')))
      })(),
    ])
    const start = performance.now()
    controller.abort()
    assert.notEqual((await running).code, 0)
    assert.ok(performance.now() - start < 2000)
  } finally {
    controller.abort()
  }
}))
