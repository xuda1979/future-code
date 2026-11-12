#!/usr/bin/env node
// Synthetic local cache/output comparison, not a live-LLM productivity claim.
// Run: node scripts/bench-session-memory.mjs --baseline-ref <commit> [--samples 5] [--output result.json]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { register } from 'node:module';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const repo = resolve(dirname(script), '..');
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const fileCount = 96, fileBytes = 1024 * 1024, pipeChunks = 4000, hotHits = 20000;
const sourceFiles = ['fileReadCache.ts', 'CircularBuffer.ts', 'fsOperations.ts', 'stringUtils.ts', 'task/TaskOutput.ts', 'task/diskOutput.ts'].map(p => `src/utils/${p}`);
const harnessFiles = ['scripts/bench-session-memory.mjs', 'tests/correctness/file-read-cache-loader.mjs', 'tests/correctness/task-output-memory-loader.mjs'];

async function retainedHeap() {
  // GC is instrumentation in isolated workers only, never a production policy.
  await new Promise(setImmediate);
  for (let i = 0; i < 3; i++) global.gc();
  return process.memoryUsage().heapUsed;
}

if (process.argv.includes('--worker')) {
  assert.equal(typeof global.gc, 'function');
  const sourceRoot = arg('--root'), fixture = arg('--fixture');
  const kind = arg('--worker');
  register('../tests/correctness/file-read-cache-loader.mjs', import.meta.url);
  register('../tests/correctness/task-output-memory-loader.mjs', import.meta.url);
  if (kind === 'cache') {
    let reads = 0;
    globalThis.__fileReadCacheTest = { encoding: () => 'utf8', fs: {
      statSync: fs.statSync,
      readFileSync: (...args) => { reads++; return fs.readFileSync(...args); },
    } };
    const { fileReadCache: cache } = await import(pathToFileURL(join(sourceRoot, 'src/utils/fileReadCache.ts')).href);
    const before = await retainedHeap();
    function scan() {
      const hash = createHash('sha256');
      for (let i = 0; i < fileCount; i++) {
        const content = cache.readFile(join(fixture, `file-${i}`)).content;
        assert.equal(content.length, fileBytes);
        assert.ok(content.startsWith(`file-${i}:`));
        hash.update(content);
      }
      return hash.digest('hex');
    }
    const start = performance.now();
    const outputHash = scan();
    const scanMs = performance.now() - start;
    const heapDeltaBytes = (await retainedHeap()) - before;
    const stats = cache.getStats();
    // Independently derive charge from retained keys + fixture sizes, for both revisions.
    const retainedChargeBytes = stats.entries.reduce((n, p) => n + (fs.statSync(p).size + p.length) * 2 + 128, 0);
    cache.clear();
    const hotPaths = Array.from({ length: 4 }, (_, i) => join(fixture, `hot-${i}`));
    for (const p of hotPaths) cache.readFile(p);
    const readsBeforeHits = reads;
    const hitStart = performance.now();
    for (let i = 0; i < hotHits; i++) assert.equal(cache.readFile(hotPaths[i % 4]).content.length, 16384);
    const hotHitMs = performance.now() - hitStart;
    assert.equal(reads - readsBeforeHits, 0, 'Hot hits must not re-read content');
    const result = { kind, outputHash, heapDeltaBytes, retainedEntries: stats.size, retainedChargeBytes, scanMs, hotHits, hotHitMs, hotContentReads: reads - readsBeforeHits };
    cache.clear();
    console.log(JSON.stringify(result));
  } else {
    process.env.FUTURE_CODE_TEST_OUTPUT_DIR = join(fixture, 'pipe-output');
    const { TaskOutput } = await import(pathToFileURL(join(sourceRoot, 'src/utils/task/TaskOutput.ts')).href);
    const before = await retainedHeap();
    const output = new TaskOutput('memory-benchmark', null, false, 0);
    // Seeded fixture bytes; every retained progress string is distinct.
    const seed = fs.readFileSync(join(fixture, 'pipe-seed'));
    function stream() {
      const hash = createHash('sha256');
      for (let i = 0; i < pipeChunks; i++) {
        const chunk = `\nprogress-${i}:` + seed.subarray(i * 1500, (i + 1) * 1500).toString('hex');
        hash.update(chunk);
        output.writeStdout(chunk);
      }
      return hash.digest('hex');
    }
    const expectedHash = stream();
    await output.flush();
    const heapDeltaBytes = (await retainedHeap()) - before;
    // Read and hash only after the memory sample so the verifier doesn't skew it.
    const diskHash = sha256(fs.readFileSync(output.path));
    assert.equal(diskHash, expectedHash, 'Complete output must survive the memory optimization');
    const result = { kind, heapDeltaBytes, outputHash: diskHash, outputBytes: fs.statSync(output.path).size };
    output.clear();
    console.log(JSON.stringify(result));
  }
} else {
  const samples = Number(arg('--samples', '5'));
  assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 20);
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  const baselineCommit = git('rev-parse', '--verify', `${arg('--baseline-ref', 'origin/main')}^{commit}`).trim();
  const temp = fs.mkdtempSync(join(tmpdir(), 'future-code-memory-'));
  try {
    const baselineRoot = join(temp, 'baseline'), fixture = join(temp, 'fixture');
    fs.mkdirSync(fixture, { recursive: true });
    const sourceManifest = [];
    for (const path of sourceFiles) {
      const content = git('show', `${baselineCommit}:${path}`);
      const target = join(baselineRoot, path);
      fs.mkdirSync(dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      sourceManifest.push({ path, baselineSha256: sha256(content), candidateSha256: sha256(fs.readFileSync(join(repo, path))) });
    }
    const fixtureHash = createHash('sha256');
    for (let i = 0; i < fileCount; i++) {
      const prefix = `file-${i}:`;
      const content = prefix + String.fromCharCode(65 + i % 26).repeat(fileBytes - prefix.length);
      fs.writeFileSync(join(fixture, `file-${i}`), content);
      fixtureHash.update(content);
    }
    const expectedCacheHash = fixtureHash.digest('hex');
    for (let i = 0; i < 4; i++) fs.writeFileSync(join(fixture, `hot-${i}`), 'h'.repeat(16384));
    // Fixed seed is materialized once, shared across revisions and authenticated.
    // Hex data has no newline, so each chunk contributes one progress line.
    const pipeSeed = Buffer.allocUnsafe(pipeChunks * 1500);
    let randomState = 0x1979;
    for (let i = 0; i < pipeSeed.length; i++) {
      randomState ^= randomState << 13;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      pipeSeed[i] = randomState & 255;
    }
    fs.writeFileSync(join(fixture, 'pipe-seed'), pipeSeed);
    const runs = [];
    for (let sample = 0; sample < samples; sample++) {
      for (const revision of sample % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        for (const kind of ['cache', 'pipe']) {
          const r = spawnSync(process.execPath, ['--expose-gc', '--experimental-strip-types', script, '--worker', kind, '--root', revision === 'baseline' ? baselineRoot : repo, '--fixture', fixture], { encoding: 'utf8', timeout: 60000 });
          if (r.status !== 0) throw new Error(r.stderr || r.stdout);
          const result = JSON.parse(r.stdout);
          if (kind === 'cache') {
            assert.equal(result.outputHash, expectedCacheHash);
            if (revision === 'candidate') assert.ok(result.retainedChargeBytes <= 16 * 1024 * 1024);
          }
          runs.push({ revision, sample, ...result });
          // Each worker starts with its own fresh output file.
          fs.rmSync(join(fixture, 'pipe-output'), { recursive: true, force: true });
        }
      }
    }
    assert.equal(new Set(runs.filter(r => r.kind === 'pipe').map(r => r.outputHash)).size, 1);
    const median = values => {
      const sorted = values.sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    };
    const summary = {};
    for (const kind of ['cache', 'pipe']) {
      summary[kind] = {};
      for (const revision of ['baseline', 'candidate']) {
        const group = runs.filter(r => r.kind === kind && r.revision === revision);
        summary[kind][revision] = Object.fromEntries(Object.keys(group[0]).filter(k => typeof group[0][k] === 'number' && k !== 'sample').map(k => [k, median(group.map(r => r[k]))]));
      }
    }
    const evidence = {
      schemaVersion: 1, measuredAt: new Date().toISOString(), baselineCommit,
      scope: 'Synthetic isolated file-cache and pipe-output stress. Heap retention is not total session RSS, model productivity or live-provider performance. Timings are local microbenchmarks; production GC is unchanged.',
      runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
      contract: { samples, fileCount, fileBytes, pipeChunks, hotHits, pipeSeed: 'xorshift32:0x1979', cacheOutputSha256: expectedCacheHash, pipeSeedSha256: sha256(pipeSeed), instrumentation: 'Fresh processes, alternating revision order, explicit worker-only GC before/after retention measurement; real files and production modules with session/logging/encoding boundaries isolated.' },
      sourceManifest,
      harnessManifest: harnessFiles.map(path => ({ path, sha256: sha256(fs.readFileSync(join(repo, path))) })),
      summary, runs,
    };
    const json = JSON.stringify(evidence, null, 2) + '\n';
    if (arg('--output')) fs.writeFileSync(resolve(arg('--output')), json);
    console.log(json);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
