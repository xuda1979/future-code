#!/usr/bin/env node
/** Offline component comparison; no live model requests or productivity claim.
 * node --experimental-strip-types scripts/bench-direct-execution.mjs [base-ref]
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { actionFocusReview } from '../src/commands/goal/actionFocus.ts'
import { gitDeliveryPolicy, nextGitDeliveryPhase, gitDeliveryIntent } from '../src/utils/gitDeliveryPolicy.ts'
import { watchModelStream, isModelProgress, ModelRequestDeadlineError } from '../src/utils/modelStreamLiveness.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ref = process.argv[2] ?? 'HEAD'
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const base = git(['rev-parse', '--verify', ref + '^{commit}'])
const temp = mkdtempSync(join(tmpdir(), 'direct-execution-baseline-'))
const sha = content => createHash('sha256').update(content).digest('hex')
const call = (id, command) => ({ id, name: 'Bash', input: { command } })
const receipt = id => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'unchanged evidence', is_error: false }] } })
try {
  for (const [file, path] of [['action.ts', 'src/commands/goal/actionFocus.ts'], ['git.ts', 'src/utils/gitDeliveryPolicy.ts']])
    writeFileSync(join(temp, file), execFileSync('git', ['show', `${base}:${path}`], { cwd: root, encoding: 'utf8' }))
  const baselineAction = await import(pathToFileURL(join(temp, 'action.ts')).href)
  const baselineGit = await import(pathToFileURL(join(temp, 'git.ts')).href)
  const history = Array.from({ length: 12 }, (_, i) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', ...call('c' + i, i % 2 ? `rg symbol${i} src` : 'git status --short') }] } },
    receipt('c' + i),
  ]).flat()
  const human = [{ type: 'user', message: { content: 'Fix the issue, verify it, then commit and push' } }]
  const initial = gitDeliveryPolicy(human, true)
  const phase = gitDeliveryIntent(human, true) && nextGitDeliveryPhase(initial, [call('stage', 'git add src/worker.ts')], [receipt('stage')])
  const beforeReview = baselineAction.actionFocusReview(history, '/fixture/.future-code/goal.md') !== null
  const afterReview = actionFocusReview(history, '/fixture/.future-code/goal.md') !== null
  assert.equal(beforeReview, false); assert.equal(afterReview, true)
  assert.equal(baselineGit.gitDeliveryPolicy(human, true), false); assert.equal(phase, true)
  const samples = []
  for (let i = 0; i < 5; i++) {
    const sample = {}
    for (const [name, enabled] of [['baseline', false], ['candidate', phase]]) {
      const started = performance.now()
      let outcome = 'completed fixture stream'
      async function* model(signal) {
        for (let n = 0; n < 50 && !signal.aborted; n++) {
          await delay(3)
          yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta' } } }
        }
      }
      try {
        for await (const _ of watchModelStream(model, { signal: new AbortController().signal,
          timeoutMs: 1000, isProgress: isModelProgress, ...(enabled ? { maxDurationMs: 30 } : {}) })) {}
      } catch (error) {
        if (!(error instanceof ModelRequestDeadlineError)) throw error
        outcome = 'host deadline'
      }
      assert.equal(outcome, enabled ? 'host deadline' : 'completed fixture stream')
      sample[name] = { elapsedMs: performance.now() - started, outcome }
    }
    samples.push(sample)
  }
  const paths = ['src/commands/goal/actionFocus.ts', 'src/utils/gitDeliveryPolicy.ts', 'src/utils/shellActivity.ts', 'src/utils/modelStreamLiveness.ts']
  process.stdout.write(JSON.stringify({ schema: 1, base, node: process.version,
    scope: 'Offline latency-policy components; simulated 30 ms model deadline, not the production 120 s setting. No live-LLM productivity claim.',
    shellObservationReview: { receipts: 12, baseline: beforeReview, candidate: afterReview },
    mixedDeliveryPhase: { baseline: false, candidate: phase },
    sourceSha256: Object.fromEntries(paths.map(path => [path, sha(readFileSync(join(root, path)))])),
    fixtureSha256: sha(JSON.stringify({ history, human })), samples,
  }, null, 2) + '\n')
} finally { rmSync(temp, { recursive: true, force: true }) }
