// Usage: node experiments/agent-productivity-20261118/bench-discovery.mjs BASELINE CANDIDATE [REPEATS]
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spec, reply } from '../../tests/foundry/swarm-fixtures.ts'

const [baseline, candidate, count = '6'] = process.argv.slice(2)
const repeats = Number(count)
assert.ok(baseline && candidate && Number.isInteger(repeats) && repeats >= 1 && repeats <= 30)
const signal = new AbortController().signal
const temp = mkdtempSync(join(tmpdir(), 'future-discovery-'))
const project = join(temp, 'repo')
const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim()
const ids = Array.from({ length: 192 }, (_, i) => String(i).padStart(3, '0'))
const sourcePath = id => `src/file${id}.txt`
const key = id => `key_${id}=`
const firstLine = id => key(id) + createHash('sha256').update(id).digest('hex').slice(0, 12)
const workloads = {
  known: [ids[77]],
  symbols: ids.filter((_, i) => i % 24 === 23),
  retained: ids.filter((_, i) => i % 8 === 7),
}
const checksum = (...parts) => createHash('sha256').update(parts.join('')).digest('hex')
async function load(root) {
  const dir = resolve(root)
  const from = file => import(pathToFileURL(join(dir, 'src/harness/foundry', file)).href)
  const { Store } = await from('store.ts')
  const host = await from('swarm/host.ts')
  const files = ['config', 'driver', 'host', 'model', 'session', 'sourceSearch', 'toolAdmission', 'toolBatches']
    .map(s => `src/harness/foundry/swarm/${s}.ts`)
  return { Store, host, sha: execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceHash: checksum(...files.map(file => readFileSync(join(dir, file), 'utf8'))) }
}

async function trial(runtime, arm, workload, pair) {
  const selected = workloads[workload]
  const expected = selected.map(firstLine).join('\n') + '\n'
  const store = await runtime.Store.open(join(temp, `${workload}-${arm}-${pair}`))
  try {
    const cfg = spec(project)
    cfg.agents.coder.tools = ['search_files', 'read_file', 'write_file']
    cfg.checks.behavior = { argv: [process.execPath, '-e',
      `if(require('node:fs').readFileSync('answer.txt','utf8')!==${JSON.stringify(expected)})process.exit(1)`], replaySafe: true }
    const [checker, ...checkArgs] = cfg.checks.behavior.argv
    assert.equal(spawnSync(checker, checkArgs, { cwd: project }).status, 1)
    cfg.limits.contextBytes = cfg.recipe.contextBytes = 196608
    cfg.recipe.attempts = 1
    await runtime.host.initializeSwarm(store, cfg, signal)

    let requests = 0, scanned = 0, bytesRead = 0, states = 0
    const artifact = store.artifact.bind(store)
    store.artifact = value => {
      if (Array.isArray(value?.history) && Object.hasOwn(value, 'pending') && Object.hasOwn(value, 'toolCalls')) states++
      return artifact(value)
    }
    const fetcher = async (_url, init) => {
      const body = JSON.parse(init.body)
      const results = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content))
      requests++
      if (requests === 1) {
        if (workload !== 'symbols') return reply('', selected.map(id => ({
          name: 'read_file', arguments: { path: sourcePath(id), lines: 1 },
        })), null)
        const queries = selected.map(key)
        const searches = arm === 'combined' ? [{ query: queries[0], additionalQueries: queries.slice(1) }] : queries.map(query => ({ query }))
        return reply('', searches.map(params => ({ name: 'search_files', arguments: { path: 'src', ...params } })), null)
      }
      if (requests === 2) {
        const lines = []
        for (const result of results) {
          assert.ok(!result.error && !result.truncated)
          if (workload === 'symbols') {
            assert.equal(result.nextCursor, null)
            assert.equal(result.skippedFiles, 0)
            scanned += result.scannedFiles
            bytesRead += result.bytesRead
            lines.push(...result.matches.map(hit => hit.text))
          } else lines.push(result.content)
        }
        assert.equal(lines.length, selected.length)
        return reply('', [{ id: 'answer', name: 'write_file', arguments: {
          path: 'answer.txt', content: lines.sort().join('\n') + '\n',
        } }], null)
      }
      assert.equal(requests, 3)
      assert.equal(results.at(-1).changed, true)
      return reply('Answer recorded.', [], null)
    }

    const input = workload === 'symbols' ? { symbols: selected.map(key) } : { paths: selected.map(sourcePath) }
    if (workload === 'retained') input.previousNotes = '0123456789abcdef'.repeat(3072)
    const task = { id: 'collect', goal: 'Collect the requested first-line records in sorted order in answer.txt.',
      acceptance: ['Exact answer bytes and independent combined-tree check'], dependencies: [],
      readScope: ['src'], writeScope: ['answer.txt'], input }
    const started = performance.now()
    const run = await runtime.host.runSwarm(store, [task], signal, undefined, fetcher)
    assert.equal(run.status, 'PASS')
    assert.equal(run.accepted, 1)
    assert.equal(run.attempts, 1)
    assert.equal(run.providerUsage.requests, requests)
    assert.equal(run.providerUsage.tokens, null)
    const integrated = await runtime.host.integrateSwarm(store, run.id, signal)
    const ms = Math.round(performance.now() - started)
    assert.equal(git('show', integrated.commit + ':answer.txt') + '\n', expected)
    const thread = store.readArtifact(store.db.prepare('SELECT state FROM agent_threads WHERE run=?').get(run.id).state)
    const receipts = thread.history.filter(m => m.role === 'tool')
    assert.equal(receipts.length, thread.toolCalls)
    return { ms, requests, calls: thread.toolCalls, states, scanned, bytesRead, tree: integrated.tree }
  } finally { store.close() }
}

try {
  mkdirSync(join(project, 'src'), { recursive: true })
  for (const id of ids) writeFileSync(join(project, sourcePath(id)), firstLine(id) + '\n' + 'filler line\n'.repeat(84))
  writeFileSync(join(project, 'answer.txt'), 'pending\n')
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'corpus')
  const parent = await load(baseline), changed = await load(candidate)
  const samples = [], trees = new Map()
  for (let pair = 0; pair < repeats; pair++) {
    for (const workload of Object.keys(workloads)) {
      const arms = workload === 'symbols' ? ['parent', 'same-calls', 'combined'] : ['parent', 'same-calls']
      const offset = pair % arms.length
      for (const arm of [...arms.slice(offset), ...arms.slice(0, offset)]) {
        try {
          const row = await trial(arm === 'parent' ? parent : changed, arm, workload, pair)
          if (trees.has(workload)) assert.equal(row.tree, trees.get(workload))
          trees.set(workload, row.tree)
          samples.push({ pair, workload, arm, ...row })
        } catch (e) {
          samples.push({ pair, workload, arm, error: String(e) })
          process.exitCode = 1
        }
      }
    }
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, cpu: cpus()[0].model,
    repeats, source: { parent: [parent.sha, parent.sourceHash], candidate: [changed.sha, changed.sourceHash] }, samples }, null, 2))
} finally { rmSync(temp, { recursive: true, force: true }) }
