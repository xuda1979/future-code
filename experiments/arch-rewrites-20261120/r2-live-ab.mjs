#!/usr/bin/env node
// R2 LIVE A/B: composed-exploration prompt directive vs default (rnd issue 2).
//
// The offline economy is proven (r2-results.json: 10x round trips, 83x
// context bytes for the composed arm). The remaining question is ADOPTION:
// does a prompt-level directive make the live model actually compose, and
// does it win end-to-end?
//
// Method: run future-code -p (live GLM-5.3 via deepseek.env) on the SAME
// multi-step exploration question against this repo, N reps per arm, with
// the treatment arm's prompt carrying a composed-exploration directive.
// Metrics per trial (parsed from --output-format stream-json):
//   - model round trips (assistant messages)
//   - tool calls issued
//   - total context bytes re-serialized (sum of request prompt lengths)
//   - wall clock
// The question has a deterministic ground truth so we can also score
// answer correctness (wrong answers still count in cost metrics).
//
// Arms:
//   baseline:   plain question
//   treatment:  question + composed-exploration directive paragraph
//
// NOTE: the directive rides in the USER prompt, not the system prompt, so
// no host change is needed for the A/B. If treatment wins, the ship-step
// is moving the directive into src/constants/prompts.ts (one line).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPS = Number(process.env.R2_REPS ?? 3);
const ROOT = new URL('../..', import.meta.url).pathname;
const ENV_FILE = join(ROOT, 'deepseek.env');

const QUESTION = `In the directory src/harness/foundry, find all files that call the function "invariant(" more than 20 times, and report for each such file: the file name, the exact call count, and whether it also imports "digest". Answer as a compact JSON object mapping file name to {calls, importsDigest}.`;

const DIRECTIVE = `Before answering, plan the search as ONE bounded shell pipeline when multiple search/filter/count steps are needed (e.g. combine grep, sort, and wc in a single command), rather than iterating per-step tool calls. Show only the final condensed result.`;

function loadEnv() {
  const env = { ...process.env };
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2];
  }
  return env;
}

function groundTruth() {
  // Deterministic answer computed locally (the checker).
  const out = {};
  for (const f of execFileSync('grep', ['-rl', 'invariant(', join(ROOT, 'src/harness/foundry'), '--include=*.ts']).toString().split('\n')) {
    if (!f) continue;
    const text = readFileSync(f, 'utf8');
    const calls = (text.match(/invariant\(/g) ?? []).length;
    if (calls > 20) {
      const name = f.slice(f.lastIndexOf('/') + 1);
      out[name] = { calls, importsDigest: /^import .*digest/m.test(text) };
    }
  }
  return out;
}

function parseStreamJson(text) {
  // future-code stream-json emits one JSON object per line (type: system |
  // assistant | user | result). user lines carry tool_result blocks.
  let assistant = 0, toolUses = 0, toolResults = 0, resultText = '';
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let evt; try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type === 'assistant') {
      assistant++;
      for (const block of evt.message?.content ?? []) if (block.type === 'tool_use') toolUses++;
    } else if (evt.type === 'user') {
      for (const block of evt.message?.content ?? []) if (block.type === 'tool_result') toolResults++;
    } else if (evt.type === 'result') {
      resultText = evt.result ?? '';
    }
  }
  return { assistant, toolUses, toolResults, resultText };
}

function extractAnswerJson(text) {
  // The answer is a JSON object; the model may fence it or lead with prose.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  const first = text.indexOf('{'), last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try next */ }
  }
  return null;
}

function scoreAnswer(text, truth) {
  // Deep-compare the model's answer object against ground truth.
  // Returns { correct, fileScore, notes } — fileScore is the fraction of
  // ground-truth files with exactly matching {calls, importsDigest}.
  const ans = extractAnswerJson(text);
  if (!ans || typeof ans !== 'object') return { correct: false, fileScore: 0, notes: 'no parsable JSON object' };
  // Normalize keys: models may prefix paths (swarm/, operations/); ground
  // truth keys are bare file names.
  const norm = {};
  for (const [k, v] of Object.entries(ans)) norm[k.split('/').pop()] = v;
  let matches = 0;
  const problems = [];
  for (const [name, want] of Object.entries(truth)) {
    const got = norm[name];
    if (!got) { problems.push(`missing ${name}`); continue; }
    const calls = Number(got.calls);
    // Occurrence count (truth) vs call-site count (occurrences minus the
    // kernel.ts definition) are both defensible for kernel.ts; accept either.
    const callsOk = calls === want.calls || (name === 'kernel.ts' && calls === want.calls - 1);
    const digestOk = Boolean(got.importsDigest) === want.importsDigest;
    if (callsOk && digestOk) matches++;
    else problems.push(`${name}: got {calls:${got.calls}, importsDigest:${got.importsDigest}} want {calls:${want.calls}, importsDigest:${want.importsDigest}}${name === 'kernel.ts' ? ' (or calls ' + (want.calls - 1) + ')' : ''}`);
  }
  const extra = Object.keys(norm).filter(k => !(k in truth));
  if (extra.length) problems.push(`extra files: ${extra.join(', ')}`);
  const fileScore = +(matches / Object.keys(truth).length).toFixed(3);
  return { correct: problems.length === 0, fileScore, notes: problems.slice(0, 4).join('; ') };
}

function runOnce(env, arm, rep, attempt) {
  const prompt = arm === 'treatment' ? `${DIRECTIVE}\n\n${QUESTION}` : QUESTION;
  const started = Date.now();
  const r = spawnSync(join(ROOT, 'future-code'), [
    '--print', '--output-format', 'stream-json', '--verbose',
    '--model', 'GLM-5.3',
    prompt,
  ], { cwd: ROOT, env: { ...env, FUTURE_CODE_PROFILE_STARTUP: '' }, encoding: 'utf8', timeout: 600_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { attempt, exit: r.status, wallS: +((Date.now() - started) / 1000).toFixed(1),
    stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runTrial(env, arm, rep) {
  const temp = mkdtempSync(join(tmpdir(), 'r2-live-'));
  try {
    const out = join(temp, 'out.jsonl');
    let r = runOnce(env, arm, rep, 1);
    // Retry once on a zero-event hang (API stall producing no stream at all)
    // or a timeout with no assistant turns — these are transport failures,
    // not model behavior, and censoring them would bias the arm.
    const events = parseStreamJson(r.stdout);
    if ((r.exit !== 0 || events.assistant === 0) && r.stderr === '') {
      console.error(`  ${arm} rep ${rep}: zero-output run (exit ${r.exit}, ${r.wallS}s), retrying once`);
      r = runOnce(env, arm, rep, 2);
    }
    writeFileSync(out, r.stdout);
    const metrics = parseStreamJson(r.stdout);
    const { correct, fileScore, notes } = scoreAnswer(metrics.resultText, TRUTH);
    return { arm, rep, exit: r.exit, attempts: r.attempt, wallS: r.wallS, ...metrics, correct, fileScore, notes,
      answerTail: (metrics.resultText ?? '').slice(0, 300), stderr: (r.stderr ?? '').slice(-200) };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

const env = loadEnv();
const TRUTH = groundTruth();
const rows = [];
const RESULTS_PATH = new URL('./r2-live-results.json', import.meta.url);

function persist(rows) {
  const avg = (a, k) => +(a.reduce((s, r) => s + (r[k] ?? 0), 0) / a.length).toFixed(2);
  const base = rows.filter(r => r.arm === 'baseline');
  const treat = rows.filter(r => r.arm === 'treatment');
  const report = {
    schema: 1, experiment: 'r2-live-composed-exploration', reps: REPS,
    model: 'GLM-5.3', question: QUESTION, directive: DIRECTIVE,
    groundTruth: TRUTH,
    questionText: 'live adoption A/B for composed-exploration directive',
    rows,
    summary: {
      baselineRoundTrips: avg(base, 'assistant'),
      treatmentRoundTrips: avg(treat, 'assistant'),
      baselineToolUses: avg(base, 'toolUses'),
      treatmentToolUses: avg(treat, 'toolUses'),
      baselineWallS: avg(base, 'wallS'),
      treatmentWallS: avg(treat, 'wallS'),
      baselineCorrect: base.filter(r => r.correct).length,
      treatmentCorrect: treat.filter(r => r.correct).length,
      baselineFileScore: avg(base, 'fileScore'),
      treatmentFileScore: avg(treat, 'fileScore'),
      roundTripReductionX: +(avg(base, 'assistant') / Math.max(0.01, avg(treat, 'assistant'))).toFixed(2),
    },
  };
  writeFileSync(RESULTS_PATH, JSON.stringify(report, null, 2) + '\n');
  return report;
}

for (let rep = 1; rep <= REPS; rep++) {
  console.error(`baseline rep ${rep}...`);
  rows.push(runTrial(env, 'baseline', rep));
  persist(rows);
}
for (let rep = 1; rep <= REPS; rep++) {
  console.error(`treatment rep ${rep}...`);
  rows.push(runTrial(env, 'treatment', rep));
  persist(rows);
}

const report = persist(rows);
console.log(JSON.stringify(report.summary, null, 2));
for (const r of rows) console.log(r.arm, 'rep', r.rep, 'exit', r.exit, 'attempts', r.attempts, 'assistant', r.assistant, 'toolUses', r.toolUses, 'correct', r.correct, 'fileScore', r.fileScore, 'notes:', r.notes ?? '');
