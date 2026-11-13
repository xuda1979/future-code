#!/usr/bin/env node
// Real parser/terminal cache stress; this is not a live-agent productivity test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire, register } from 'node:module';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url), repo = resolve(dirname(script), '..');
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const sha = value => createHash('sha256').update(value).digest('hex');
const sources = [
  'src/components/Markdown.tsx', 'src/utils/markdownLexer.ts', 'src/utils/byteBoundedCache.ts',
  'src/utils/hash.ts', 'src/utils/intl.ts', 'src/utils/sliceAnsi.ts',
  ...['output', 'screen', 'bidi', 'stringWidth', 'line-width-cache', 'widest-line', 'warn', 'layout/geometry', 'termio/ansi'].map(p => `src/ink/${p}.ts`),
];
const harness = ['scripts/bench-render-cache-memory.mjs', 'tests/rendering/source-loader.mjs', 'tests/rendering/benchmark-loader.mjs'];
const streamVersions = 600, historyMessages = 300, characterLines = 12000, lineChars = 120;

async function heap() {
  await new Promise(setImmediate);
  for (let i = 0; i < 3; i++) global.gc();
  return process.memoryUsage().heapUsed;
}

if (process.argv.includes('--worker')) {
  assert.equal(typeof global.gc, 'function');
  globalThis.require = createRequire(import.meta.url);
  register('../tests/rendering/benchmark-loader.mjs', import.meta.url);
  const sourceRoot = arg('--root'), kind = arg('--worker'), candidate = arg('--revision') === 'candidate';
  const module = path => import(pathToFileURL(join(sourceRoot, path)).href);
  const hash = createHash('sha256');
  let result;
  if (kind === 'characters') {
    const { default: Output } = await module('src/ink/output.ts');
    const { CharPool, HyperlinkPool, StylePool, createScreen } = await module('src/ink/screen.ts');
    const styles = new StylePool();
    const screen = createScreen(lineChars, 1, styles, new CharPool(), new HyperlinkPool());
    const output = new Output({ width: lineChars, height: 1, stylePool: styles, screen });
    const before = await heap(), start = performance.now();
    for (let i = 0; i < characterLines; i++) {
      const line = String(i).padStart(8, '0') + '0123456789abcdef'.repeat(7);
      output.reset(lineChars, 1, screen);
      output.write(0, 0, line);
      output.get();
      hash.update(Buffer.from(screen.cells.buffer));
    }
    const scanMs = performance.now() - start, heapDeltaBytes = (await heap()) - before;
    const cache = output.charCache;
    const retainedEntries = cache.size, chargedBytes = cache.calculatedBytes ?? null;
    cache.clear();
    const hotScreen = createScreen(lineChars, 50, styles, new CharPool(), new HyperlinkPool());
    const hot = new Output({ width: lineChars, height: 50, stylePool: styles, screen: hotScreen });
    const frame = () => {
      hot.reset(lineChars, 50, hotScreen);
      for (let y = 0; y < 50; y++) hot.write(0, y, String(y).padStart(8, '0') + 'x'.repeat(112));
      hot.get();
    };
    for (let i = 0; i < 10; i++) frame();
    let coldRebuilds = 0;
    const oldSet = hot.charCache.set.bind(hot.charCache);
    hot.charCache.set = (...args) => { coldRebuilds++; return oldSet(...args); };
    const hotStart = performance.now();
    for (let i = 0; i < 500; i++) frame();
    const hotMs = performance.now() - hotStart;
    assert.equal(coldRebuilds, 0, 'Unchanged frames must reuse clustered characters');
    if (candidate) assert.ok(chargedBytes <= 8 * 1024 * 1024);
    result = { kind, heapDeltaBytes, retainedEntries, chargedBytes, scanMs, hotMs, hotFrames: 500, coldRebuilds };
  } else {
    const lexer = await module(candidate ? 'src/utils/markdownLexer.ts' : 'src/components/Markdown.tsx');
    const before = await heap(), start = performance.now();
    const count = kind === 'streaming' ? streamVersions : historyMessages;
    function scan() {
      for (let i = 0; i < count; i++) {
        const content = kind === 'streaming'
          ? '```text\n' + '0123456789abcdef'.repeat(8192) + 'x'.repeat(i * 64) + i
          : '# Result ' + i + '\n\n```text\n' + '0123456789abcdef'.repeat(4096) + '\n```\n';
        const tokens = lexer.cachedLexer(content, kind !== 'streaming');
        hash.update(JSON.stringify(tokens));
      }
    }
    scan();
    const scanMs = performance.now() - start, heapDeltaBytes = (await heap()) - before;
    const stats = lexer.getMarkdownTokenCacheStats();
    lexer.clearMarkdownTokenCache();
    const hot = Array.from({ length: 20 }, (_, i) => `# Hot ${i}\n\n\`\`\`ts\n` + 'const x = 1;\n'.repeat(200) + '\n```');
    for (const s of hot) lexer.cachedLexer(s);
    const { marked } = await import('marked');
    const parse = marked.lexer;
    let coldRebuilds = 0;
    marked.lexer = (...args) => { coldRebuilds++; return parse(...args); };
    const hotStart = performance.now();
    for (let i = 0; i < 10000; i++) lexer.cachedLexer(hot[i % hot.length]);
    const hotMs = performance.now() - hotStart;
    marked.lexer = parse;
    assert.equal(coldRebuilds, 0, 'Hot historical messages must not be reparsed');
    if (candidate) assert.ok(stats.bytes <= stats.maxBytes);
    result = { kind, heapDeltaBytes, retainedEntries: stats.entries, chargedBytes: stats.bytes ?? null, scanMs, hotMs, hotHits: 10000, coldRebuilds };
  }
  console.log(JSON.stringify({ ...result, outputHash: hash.digest('hex') }));
} else {
  const samples = Number(arg('--samples', '3'));
  assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 10);
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  const baselineCommit = git('rev-parse', '--verify', `${arg('--baseline-ref', 'HEAD')}^{commit}`).trim();
  const temp = fs.mkdtempSync(join(tmpdir(), 'render-cache-memory-'));
  try {
    const baselineRoot = join(temp, 'baseline'), sourceManifest = [];
    fs.mkdirSync(baselineRoot);
    fs.symlinkSync(join(repo, 'node_modules'), join(baselineRoot, 'node_modules'), 'dir');
    for (const path of sources) {
      const exists = spawnSync('git', ['cat-file', '-e', `${baselineCommit}:${path}`], { cwd: repo }).status === 0;
      let previous = null;
      if (exists) {
        previous = git('show', `${baselineCommit}:${path}`);
        const target = join(baselineRoot, path);
        fs.mkdirSync(dirname(target), { recursive: true });
        fs.writeFileSync(target, previous);
      }
      sourceManifest.push({ path, baselineSha256: previous === null ? null : sha(previous), candidateSha256: sha(fs.readFileSync(join(repo, path))) });
    }
    const runs = [];
    for (let sample = 0; sample < samples; sample++) {
      for (const revision of sample % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        for (const kind of ['streaming', 'history', 'characters']) {
          const r = spawnSync(process.execPath, ['--expose-gc', '--experimental-strip-types', script, '--worker', kind, '--root', revision === 'baseline' ? baselineRoot : repo, '--revision', revision], { cwd: repo, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
          if (r.status !== 0) throw new Error(r.stderr || r.stdout);
          runs.push({ sample, revision, ...JSON.parse(r.stdout) });
        }
      }
    }
    const median = values => {
      const sorted = values.sort((a, b) => a - b), m = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
    };
    const summary = {};
    for (const kind of ['streaming', 'history', 'characters']) {
      const group = runs.filter(r => r.kind === kind);
      assert.equal(new Set(group.map(r => r.outputHash)).size, 1, `${kind} output must match across both revisions`);
      summary[kind] = {};
      for (const revision of ['baseline', 'candidate']) {
        const rows = group.filter(r => r.revision === revision);
        summary[kind][revision] = Object.fromEntries(Object.keys(rows[0]).filter(k => typeof rows[0][k] === 'number' && k !== 'sample').map(k => [k, median(rows.map(r => r[k]))]));
      }
    }
    const dependencies = Object.fromEntries(['marked', '@alcalzone/ansi-tokenize', 'bidi-js', 'emoji-regex', 'get-east-asian-width', 'strip-ansi', '@babel/core'].map(name => {
      let dir = dirname(fileURLToPath(import.meta.resolve(name)));
      while (true) {
        const path = join(dir, 'package.json');
        if (fs.existsSync(path)) {
          const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
          if (pkg.name === name) return [name, pkg.version];
        }
        if (dirname(dir) === dir) throw new Error(`Cannot locate dependency metadata: ${name}`);
        dir = dirname(dir);
      }
    }));
    const evidence = {
      schemaVersion: 1, measuredAt: new Date().toISOString(), baselineCommit,
      scope: 'Synthetic retained JS heap in fresh Node processes. Not total session RSS, five live Mac sessions, end-to-end productivity or model quality. GC is measurement-only. Cold eviction can require reparsing old UI data.',
      runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, dependencies },
      contract: { samples, streamVersions, historyMessages, characterLines, lineChars, order: 'Alternating revision order, sequential isolated workers; real parser and terminal rendering, equal complete token/cell hashes; baseline private lexer exposed by transpilation only.' },
      sourceManifest, harnessManifest: harness.map(path => ({ path, sha256: sha(fs.readFileSync(join(repo, path))) })), summary, runs,
    };
    const json = JSON.stringify(evidence, null, 2) + '\n';
    if (arg('--output')) fs.writeFileSync(resolve(arg('--output')), json);
    console.log(json);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
