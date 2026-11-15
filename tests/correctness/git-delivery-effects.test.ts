import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { watchModelStream, isModelProgress, ModelRequestDeadlineError, modelStallAction } from '../../src/utils/modelStreamLiveness.ts'
register('./streaming-tool-executor-loader.mjs', import.meta.url)
const { StreamingToolExecutor } = await import('../../src/services/tools/StreamingToolExecutor.ts')

test('a deadline after real stage/commit/push collects one receipt, preserving hooks and a single remote commit', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'git-delivery-effects-'))
  const repo = join(root, 'repo'), remote = join(root, 'remote.git'), hookCount = join(root, 'hooks-run')
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  let executions = 0
  try {
    git(root, 'init', '--quiet', '--initial-branch=main', repo)
    git(root, 'init', '--quiet', '--bare', remote)
    git(repo, 'config', 'user.name', 'Delivery Regression')
    git(repo, 'config', 'user.email', 'delivery@example.invalid')
    git(repo, 'config', 'commit.gpgsign', 'false')
    git(repo, 'remote', 'add', 'origin', remote)
    writeFileSync(join(repo, 'change.txt'), 'requested change\n')
    // An absolute fixture hook path avoids assumptions about GIT_DIR in hooks.
    writeFileSync(join(repo, '.git/hooks/pre-commit'), '#!/bin/sh\nprintf "hook\\n" >> ' + "'" + hookCount.replace(/'/g, "'\\''") + "'\n", { mode: 0o755 })
    const tools = [{ name: 'Bash', inputSchema: { safeParse: (data: unknown) => ({ success: true, data }) },
      isConcurrencySafe: () => false, interruptBehavior: () => 'cancel' }]
    const context = { abortController: new AbortController(), options: { tools, mcpClients: [] },
      setInProgressToolUseIDs: () => {}, setHasInterruptibleToolInProgress: () => {} }
    ;(globalThis as any).__futureStreamingToolTest = async function* (call: any) {
      executions++
      git(repo, 'add', '--', 'change.txt')
      git(repo, 'commit', '--quiet', '-m', 'Apply requested change')
      git(repo, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
      const head = git(repo, 'rev-parse', 'HEAD')
      yield { message: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: call.id, content: head }] } } }
    }
    const executor = new StreamingToolExecutor(tools as any, (() => {}) as any, context as any)
    let admitted = 0
    async function* provider(signal: AbortSignal) {
      yield { type: 'assistant' }
      while (!signal.aborted) {
        await delay(3)
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta' } } }
      }
    }
    await assert.rejects(async () => {
      for await (const event of watchModelStream(provider, { signal: context.abortController.signal,
        timeoutMs: 1000, maxDurationMs: 150, isProgress: isModelProgress })) {
        if (event.type === 'assistant') {
          admitted++
          executor.addTool({ id: 'delivery', name: 'Bash', input: {} } as any,
            { uuid: 'assistant-delivery', message: { id: 'response-delivery' } } as any)
        }
      }
    }, ModelRequestDeadlineError)
    assert.equal(modelStallAction(admitted, 100, false, true), 'collect')
    assert.throws(() => executor.discard(), /collect their actual results/)
    const results: any[] = []
    for await (const result of executor.getRemainingResults()) if (result.message) results.push(result.message)
    assert.equal(executions, 1)
    const receipts = results.flatMap(message => message.message.content).filter(block => block.type === 'tool_result')
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0]!.is_error, undefined)
    assert.equal(receipts[0]!.content, git(repo, 'rev-parse', 'HEAD'))
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), receipts[0]!.content)
    assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '1')
    assert.equal(readFileSync(hookCount, 'utf8'), 'hook\n')
    assert.equal(git(repo, 'status', '--porcelain'), '')
    assert.equal(context.abortController.signal.aborted, false)
  } finally { delete (globalThis as any).__futureStreamingToolTest; rmSync(root, { recursive: true, force: true }) }
})
