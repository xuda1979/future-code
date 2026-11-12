import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { execFileSync } from 'node:child_process';
import { constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
register('./self-improve-loader.mjs', import.meta.url);
const cycle = await import('../../src/services/selfImprove/cycle.ts');
const subprocess = await import('../../src/services/selfImprove/subprocess.ts');
const ledger = await import('../../src/services/selfImprove/ledger.ts');
const feedback = await import('../../src/services/selfImprove/projectSignals.ts');

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const finding = { title: 'Repair the value', category: 'bug', severity: 'high', target: 'src/value.txt',
  detail: 'The old value is wrong', proposedChange: 'Replace it and preserve verification' } as const;
async function fixture(run: (f: any) => Promise<void> | void) {
  const root = mkdtempSync(join(tmpdir(), 'self-improve-isolation-'));
  const source = join(root, 'source'), remote = join(root, 'remote.git'), home = join(root, 'home');
  mkdirSync(source); mkdirSync(home);
  (globalThis as any).__selfImproveTestHome = home;
  const names = ['FUTURE_SELF_IMPROVE_COMMAND', 'SELF_TEST_CASE', 'SELF_TEST_VALIDATIONS', 'SELF_TEST_FAIL_GATE', 'SELF_TEST_MUTATE_BUILD'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    git(root, 'init', '--bare', remote); git(source, 'init', '-b', 'main');
    git(source, 'config', 'user.name', 'Regression Test'); git(source, 'config', 'user.email', 'test@example.invalid');
    mkdirSync(join(source, 'src/services'), { recursive: true }); mkdirSync(join(source, 'scripts'));
    writeFileSync(join(source, 'src/value.txt'), 'baseline\n');
    writeFileSync(join(source, '.gitignore'), 'poison.cache\n');
    writeFileSync(join(source, 'build.sh'), '#!/bin/sh\nprintf "build\\n" >> "$SELF_TEST_VALIDATIONS"\ntest ! -f poison.cache || exit 1\nif test -n "$SELF_TEST_MUTATE_BUILD"; then printf "mutated" >> src/value.txt; fi\n');
    for (const gate of ['correctness', 'resilience', 'foundry', 'swarm', 'commands']) writeFileSync(join(source, `scripts/test-${gate}.mjs`),
      `import{appendFileSync}from'node:fs';appendFileSync(process.env.SELF_TEST_VALIDATIONS,'${gate}\\n');if(process.env.SELF_TEST_FAIL_GATE==='${gate}')process.exit(1);`);
    git(source, 'add', '-A'); git(source, 'commit', '-m', 'trusted baseline');
    git(source, 'remote', 'add', 'origin', remote); git(source, 'push', '-u', 'origin', 'main');
    const base = git(source, 'rev-parse', 'HEAD');
    const caseFile = join(root, 'case.json'), validationLog = join(root, 'validations.txt'), child = join(root, 'headless');
    writeFileSync(caseFile, JSON.stringify({ mode: 'change' }));
    writeFileSync(child, `#!${process.execPath}\nconst fs=require('node:fs');const c=JSON.parse(fs.readFileSync(process.env.SELF_TEST_CASE,'utf8'));const p=process.argv.at(-1);if(c.promptFile)fs.writeFileSync(c.promptFile,p);if(p.startsWith('Analyze')){process.stderr.write('diagnostic progress\\n');if(c.mode==='analysis-writes')fs.writeFileSync('src/value.txt','unexpected analysis edit');process.stdout.write(c.mode==='invalid-analysis'?'not JSON':'[]');}else{fs.writeFileSync('src/value.txt',c.value??'candidate fix\\n');if(c.mode==='poison')fs.writeFileSync('poison.cache','exploratory state');if(c.mode==='modify-build')fs.writeFileSync('build.sh','exit 0\\n');process.stdout.write('change complete');if(c.mode==='partial-error'){process.stderr.write('actual child failure');process.exit(7);}}\n`, { mode: 0o755 });
    process.env.FUTURE_SELF_IMPROVE_COMMAND = child; process.env.SELF_TEST_CASE = caseFile;
    process.env.SELF_TEST_VALIDATIONS = validationLog; delete process.env.SELF_TEST_FAIL_GATE;
    delete process.env.SELF_TEST_MUTATE_BUILD;
    const ledgerPath = join(home, '.future/self-improve/ledger.jsonl');
    const config = { enabled: true, intervalMinutes: 45, repoUrl: remote, autoMerge: false, autoPush: false, maxConcurrentCycles: 1 };
    const options = { cycleId: 'test-cycle', finding, fingerprint: 'finding-id', repoPath: source, config, ledgerPath, log: () => {} };
    await run({ root, source, remote, home, base, caseFile, validationLog, ledgerPath, config, options,
      setCase: (mode: string) => writeFileSync(caseFile, JSON.stringify({ mode })),
      managed: () => cycle.resolveRepoPath(config, source).repoPath });
  } finally {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(root, { recursive: true, force: true });
  }
}

test('first-run managed cloning works and never uses the foreground checkout', async () => fixture(async f => {
  const resolved = cycle.resolveRepoPath(f.config, f.source);
  assert.equal(resolved.error, undefined); assert.ok(resolved.repoPath);
  assert.notEqual(resolved.repoPath, f.source);
  assert.equal(git(f.source, 'branch', '--show-current'), 'main');
  const mismatch = cycle.resolveRepoPath({ ...f.config, repoUrl: join(f.root, 'other.git') }, f.source);
  assert.equal(mismatch.repoPath, null); assert.match(mismatch.error!, /different repository/);
}));

test('proposals preserve dirty foreground files, branch and index and never overwrite an earlier proposal', async () => fixture(async f => {
  git(f.source, 'checkout', '-b', 'user-task');
  writeFileSync(join(f.source, 'src/value.txt'), 'unfinished user edit\n');
  writeFileSync(join(f.source, 'notes.txt'), 'user notes');
  const first = await cycle.executeFindingChange(f.options);
  assert.equal(git(f.source, 'branch', '--show-current'), 'user-task');
  assert.equal(readFileSync(join(f.source, 'src/value.txt'), 'utf8'), 'unfinished user edit\n');
  assert.equal(readFileSync(join(f.source, 'notes.txt'), 'utf8'), 'user notes');
  assert.equal(git(f.source, 'diff', '--cached'), '');
  assert.equal(first.built, true); assert.equal(first.tested, true); assert.ok(first.commit);
  assert.equal(git(f.source, 'show', `${first.branch}:src/value.txt`), 'candidate fix');
  assert.throws(() => git(f.source, 'show', `${first.branch}:notes.txt`));
  const second = await cycle.executeFindingChange(f.options);
  assert.notEqual(first.branch, second.branch);
  assert.equal(git(f.source, 'rev-parse', first.branch), first.commit);
  assert.equal(readFileSync(f.validationLog, 'utf8').trim().split('\n').length, 12);
}));

test('a failed child preserves its partial private work without committing or validating it', async () => fixture(async f => {
  f.setCase('partial-error');
  const result = await cycle.executeFindingChange(f.options);
  assert.equal(result.commit, undefined); assert.equal(result.built, false); assert.equal(result.tested, false);
  assert.match(result.note!, /Headless session exit 7/); assert.ok(result.worktreePath);
  assert.equal(readFileSync(join(result.worktreePath!, 'src/value.txt'), 'utf8'), 'candidate fix\n');
  assert.equal(readFileSync(join(f.source, 'src/value.txt'), 'utf8'), 'baseline\n');
  assert.equal(existsSync(f.validationLog), false);
}));

test('commit failures cannot be mistaken for a verified candidate', async () => fixture(async f => {
  writeFileSync(join(f.source, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const result = await cycle.executeFindingChange(f.options);
  assert.equal(result.commit, undefined); assert.equal(result.built, false); assert.equal(result.tested, false);
  assert.match(result.note!, /git commit failed/); assert.ok(result.worktreePath);
  assert.equal(existsSync(f.validationLog), false);
}));

test('candidate changes to frozen verification inputs never run or certify themselves', async () => fixture(async f => {
  f.setCase('modify-build');
  const result = await cycle.executeFindingChange(f.options);
  assert.ok(result.commit); assert.equal(result.built, false); assert.equal(result.tested, false);
  assert.equal(result.merged, false); assert.match(result.note!, /verification inputs changed.*build.sh/);
  assert.equal(existsSync(f.validationLog), false);
}));

test('managed promotion requires full frozen validation and leaves the user checkout and remote unchanged', async () => fixture(async f => {
  const managed = f.managed(); assert.ok(managed);
  git(managed, 'config', 'user.name', 'Regression Test'); git(managed, 'config', 'user.email', 'test@example.invalid');
  const result = await cycle.executeFindingChange({ ...f.options, repoPath: managed, config: { ...f.config, autoMerge: true } });
  assert.equal(result.built, true); assert.equal(result.tested, true); assert.equal(result.merged, true);
  assert.equal(result.pushed, false); assert.equal(git(managed, 'rev-parse', 'HEAD'), result.commit);
  assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.base);
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/main'), f.base);
  assert.deepEqual(readFileSync(f.validationLog, 'utf8').trim().split('\n'), ['build', 'correctness', 'resilience', 'foundry', 'swarm', 'commands']);
}));

test('automatic push promotes only a verified managed commit and cannot act through an unmanaged checkout', async () => fixture(async f => {
  const config = { ...f.config, autoMerge: true, autoPush: true };
  const unmanaged = await cycle.executeFindingChange({ ...f.options, config });
  assert.equal(unmanaged.tested, true); assert.equal(unmanaged.merged, false); assert.equal(unmanaged.pushed, false);
  assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.base);
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/main'), f.base);
  const managed = f.managed(); assert.ok(managed);
  git(managed, 'config', 'user.name', 'Regression Test'); git(managed, 'config', 'user.email', 'test@example.invalid');
  const promoted = await cycle.executeFindingChange({ ...f.options, repoPath: managed, config });
  assert.equal(promoted.tested, true); assert.equal(promoted.merged, true); assert.equal(promoted.pushed, true);
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/main'), promoted.commit);
  assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.base);
}));

test('a failed validation lane blocks promotion and stops spending on later lanes', async () => fixture(async f => {
  process.env.SELF_TEST_FAIL_GATE = 'foundry';
  const result = await cycle.executeFindingChange(f.options);
  assert.equal(result.built, true); assert.equal(result.tested, false); assert.equal(result.merged, false);
  assert.deepEqual(readFileSync(f.validationLog, 'utf8').trim().split('\n'), ['build', 'correctness', 'resilience', 'foundry']);
}));

test('independent verification does not reuse the proposer workspace or ignored exploratory files', async () => fixture(async f => {
  f.setCase('poison');
  const result = await cycle.executeFindingChange(f.options);
  assert.equal(result.built, true); assert.equal(result.tested, true);
  assert.equal(git(f.source, 'show', `${result.branch}:src/value.txt`), 'candidate fix');
}));

test('a successful build exit cannot certify a changed candidate snapshot', async () => fixture(async f => {
  process.env.SELF_TEST_MUTATE_BUILD = '1';
  const result = await cycle.executeFindingChange(f.options);
  assert.equal(result.built, false); assert.equal(result.tested, false); assert.equal(result.merged, false);
  assert.match(result.note!, /Build changed the frozen candidate/); assert.ok(result.worktreePath);
}));

test('invalid analysis is an explicit failure and a read-only violation stays isolated', async () => fixture(async f => {
  mkdirSync(join(f.home, '.future/self-improve'), { recursive: true });
  assert.ok(f.managed());
  f.setCase('invalid-analysis');
  const invalid = await cycle.runSelfImproveCycle({ config: f.config, ledgerPath: f.ledgerPath });
  assert.equal(invalid.status, 'error'); assert.match(invalid.error!, /valid JSON/);
  f.setCase('analysis-writes');
  const changed = await cycle.runSelfImproveCycle({ config: f.config, ledgerPath: f.ledgerPath });
  assert.equal(changed.status, 'error'); assert.match(changed.error!, /Read-only analysis modified/);
  assert.equal(readFileSync(join(f.source, 'src/value.txt'), 'utf8'), 'baseline\n');
}));

test('analysis parsing is bounded and strict while tolerant callers keep their compatibility', () => {
  assert.deepEqual(cycle.parseFindings('invalid'), []);
  assert.throws(() => cycle.parseFindings('invalid', true), /valid JSON/);
  assert.throws(() => cycle.parseFindings(JSON.stringify(Array.from({ length: 4 }, () => finding)), true), /three-finding budget/);
  assert.throws(() => cycle.parseFindings('[{}]', true));
  assert.deepEqual(cycle.parseFindings('[]', true), []);
});

test('headless output keeps diagnostic stderr separate and enforces UTF-8 prompt budgets', async () => fixture(async f => {
  assert.equal(await subprocess.runHeadlessFuture('Analyze the source', f.source), '[]');
  await assert.rejects(subprocess.runHeadlessFuture('量子', f.source, 1000, 4), /byte budget/);
}));

test('process capture enforces exit/output budgets and drains timed-out descendants', { timeout: 5000 }, async () => fixture(async f => {
  const captured = await subprocess.runSelfImproveProcess([process.execPath, '-e', "process.stdout.write('[]');process.stderr.write('diagnostic');process.exit(7)"], f.source, 1000);
  assert.equal(captured.code, 7); assert.equal(captured.stdout, '[]'); assert.equal(captured.stderr, 'diagnostic');
  await assert.rejects(subprocess.runSelfImproveProcess([process.execPath, '-e', "console.log('x'.repeat(10000))"], f.source, 1000, 32), /byte budget/);
  if (process.platform !== 'win32') {
    const marker = join(f.root, 'late-effect'), started = join(f.root, 'child-started');
    const grandchild = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),700)`;
    const parent = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(started)},String(c.pid));setInterval(()=>{},1000)`;
    await assert.rejects(subprocess.runSelfImproveProcess([process.execPath, '-e', parent], f.source, 400), /deadline/);
    assert.ok(existsSync(started));
    await new Promise(resolve => setTimeout(resolve, 800)); assert.equal(existsSync(marker), false);
  }
}));

test('crash recovery closes dead-owner markers once and still respects live and unknown owners', async () => fixture(async f => {
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim());
  const now = Date.now();
  const abandoned = { kind: 'cycle-start', version: 1, ts: now - 1000, cycleId: 'abandoned',
    repoPath: f.source, repoBranch: 'main', pid: deadPid } as const;
  ledger.appendLedgerEntry(abandoned, f.ledgerPath);
  assert.equal(ledger.shouldStartCycle(ledger.readLedger(f.ledgerPath), now, 45 * 60_000).start, true);
  assert.equal(ledger.recoverAbandonedCycles(f.ledgerPath, now), 1);
  assert.equal(ledger.recoverAbandonedCycles(f.ledgerPath, now), 0);
  assert.equal(ledger.shouldStartCycle(ledger.readLedger(f.ledgerPath), now + 1, 45 * 60_000).start, false);
  assert.equal((ledger.readLedger(f.ledgerPath).at(-1) as any).status, 'error');
  const live = { ...abandoned, cycleId: 'live', pid: process.pid };
  const finishedLater = { ...abandoned, cycleId: 'later', pid: deadPid };
  const entries = [live, finishedLater, { kind: 'cycle-end', version: 1, ts: now, cycleId: 'later', status: 'error', findings: 0, accepted: 0 }] as any;
  assert.equal(ledger.shouldStartCycle(entries, now, 0, true).start, false, 'a later completion cannot hide an earlier live cycle');
  assert.equal(ledger.shouldStartCycle([{ ...abandoned, pid: undefined }], now, 0, true).start, false);
}));


test('local verified promotions accumulate across cycles before an optional push', async () => fixture(async f => {
  const managed = f.managed(); assert.ok(managed)
  git(managed, 'config', 'user.name', 'Regression Test'); git(managed, 'config', 'user.email', 'test@example.invalid')
  const options = { ...f.options, repoPath: managed, config: { ...f.config, autoMerge: true } }
  const first = await cycle.executeFindingChange(options)
  assert.equal(first.merged, true); assert.equal(first.pushed, false); assert.ok(first.commit)
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/main'), f.base)
  assert.equal(cycle.resolveRepoPath(f.config, f.source).repoPath, managed)
  writeFileSync(f.caseFile, JSON.stringify({ mode: 'change', value: 'second verified improvement\n' }))
  const second = await cycle.executeFindingChange({ ...options, fingerprint: 'second-finding' })
  assert.equal(second.built, true); assert.equal(second.tested, true)
  assert.equal(second.merged, true); assert.equal(second.pushed, false); assert.ok(second.commit)
  assert.equal(git(managed, 'rev-parse', second.commit + '^'), first.commit)
  assert.equal(git(managed, 'show', second.commit + '^:src/value.txt'), 'candidate fix')
  assert.equal(git(managed, 'show', second.commit + ':src/value.txt'), 'second verified improvement')
  assert.equal(git(managed, 'rev-parse', 'HEAD'), second.commit)
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/main'), f.base)
  assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.base)
}))

test('unreceipted managed commits cannot become the next self-improvement baseline', async () => fixture(async f => {
  const managed = f.managed(); assert.ok(managed)
  git(managed, 'config', 'user.name', 'Regression Test'); git(managed, 'config', 'user.email', 'test@example.invalid')
  writeFileSync(join(managed, 'src/value.txt'), 'unverified managed edit\n')
  git(managed, 'add', '-A'); git(managed, 'commit', '-m', 'no independent validation receipt')
  const unknown = git(managed, 'rev-parse', 'HEAD')
  const result = await cycle.executeFindingChange({ ...f.options, repoPath: managed, config: { ...f.config, autoMerge: true } })
  assert.equal(result.commit, undefined); assert.equal(result.built, false); assert.equal(result.merged, false)
  assert.match(result.note!, /not authenticated/)
  assert.equal(git(managed, 'rev-parse', 'HEAD'), unknown)
  assert.equal(existsSync(f.validationLog), false)
}))

test('dirty, divergent or wrong-repository managed state is preserved and cannot be extended', async () => fixture(async f => {
  const managed = f.managed(); assert.ok(managed)
  git(managed, 'config', 'user.name', 'Regression Test'); git(managed, 'config', 'user.email', 'test@example.invalid')
  const options = { ...f.options, repoPath: managed, config: { ...f.config, autoMerge: true } }
  writeFileSync(join(managed, 'src/value.txt'), 'unfinished managed edit\n')
  const dirty = await cycle.executeFindingChange(options)
  assert.equal(dirty.commit, undefined); assert.match(dirty.note!, /must be clean/)
  assert.equal(readFileSync(join(managed, 'src/value.txt'), 'utf8'), 'unfinished managed edit\n')
  git(managed, 'checkout', '--', 'src/value.txt')
  const first = await cycle.executeFindingChange(options); assert.equal(first.merged, true)
  writeFileSync(join(f.source, 'src/value.txt'), 'independent remote advance\n')
  git(f.source, 'add', '-A'); git(f.source, 'commit', '-m', 'remote advance'); git(f.source, 'push', 'origin', 'main')
  const divergent = await cycle.executeFindingChange(options)
  assert.equal(divergent.commit, undefined); assert.match(divergent.note!, /diverged/)
  assert.equal(git(managed, 'rev-parse', 'HEAD'), first.commit)
  const other = join(f.root, 'other.git'); git(f.root, 'init', '--bare', other)
  git(other, 'fetch', f.remote, 'refs/heads/main:refs/heads/main')
  git(managed, 'remote', 'set-url', 'origin', other)
  const wrong = await cycle.executeFindingChange(options)
  assert.equal(wrong.commit, undefined); assert.match(wrong.note!, /different repository/)
  assert.equal(git(managed, 'rev-parse', 'HEAD'), first.commit)
}))

test('the live background analyzer receives bounded project feedback as advisory data',
  { skip: typeof constants.O_NONBLOCK !== 'number' || typeof constants.O_NOFOLLOW !== 'number' }, async () => fixture(async f => {
  assert.ok(f.managed())
  const path = join(f.home, '.future', 'self-improve', 'project-feedback.jsonl')
  assert.equal(feedback.recordProjectSignal({
    projectId: 'private objective never sent to the improvement child',
    kind: 'incomplete-turn', errorCategory: 'turn-ended', recoveryAttempts: 2,
  }, { path, now: Date.now() }), true)
  const promptFile = join(f.root, 'analysis-prompt.txt')
  writeFileSync(f.caseFile, JSON.stringify({ mode: 'change', promptFile }))
  const result = await cycle.runSelfImproveCycle({ config: f.config, ledgerPath: f.ledgerPath })
  assert.equal(result.status, 'no-findings')
  const prompt = readFileSync(promptFile, 'utf8')
  assert.match(prompt, /UNTRUSTED ADVISORY DATA/); assert.match(prompt, /incomplete-turn/)
  assert.match(prompt, /unchanged independent gates/); assert.match(prompt, /turn-ended/)
  assert.ok(!prompt.includes('private objective'))
  assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.base)
}))
