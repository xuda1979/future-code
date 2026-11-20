#!/usr/bin/env node
// R3 A/B: falsification ledger for goal resume (rnd_plan.md issue 3:
// causal state-graph memory). Minimal kernel:
//   - A ledger keyed by (goal, revision) records FAILED attempt fingerprints
//     (tool name + normalized arguments) with their failure signature.
//   - It persists across resume (on-disk JSON in the goal directory) so a
//     post-restart agent cannot re-enter the same falsified dead end.
//   - On a repeated emission, the host intercepts BEFORE execution and
//     returns the prior failure plus a forced-divergence instruction —
//     the model receives the evidence without paying the execution again.
//
// A/B scenario (deterministic, no live model):
//   A scripted agent in a resumed goal emits the SAME failing Bash command
//   for N turns (the classic "dead-loop resume" pathology), then diverges.
//   Baseline (no ledger): every turn executes the command again -> N wasted
//   executions, N identical failures.
//   Treatment (ledger): turn 1 executes and records; turns 2..N are
//   intercepted with the recorded failure -> 1 execution, N-1 interceptions,
//   and the model's context contains the forced-divergence instruction.
//   Both arms converge once the scripted agent diverges (final check PASS).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const TURNS = 10;
const FAILING_COMMAND = 'python3 build_research.py --mode strict';
const norm = (tool, args) => `${tool}:${JSON.stringify(args)}`;
const fingerprint = (tool, args) =>
  createHash('sha256').update(norm(tool, args)).digest('hex').slice(0, 16);

// ---- minimal goal-ledger kernel (the R3 proposal) -------------------------
class FalsificationLedger {
  constructor(dir) { this.path = join(dir, 'falsified-attempts.json'); }
  load(goal, revision) {
    if (!existsSync(this.path)) return new Map();
    const data = JSON.parse(readFileSync(this.path, 'utf8'));
    if (data.goal !== goal || data.revision !== revision) return new Map();
    return new Map(data.attempts.map(a => [a.fingerprint, a]));
  }
  record(goal, revision, tool, args, failure) {
    const entries = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, 'utf8')).attempts
      : [];
    const entry = { fingerprint: fingerprint(tool, args), tool,
      argsSummary: norm(tool, args).slice(0, 120), failure: failure.slice(0, 200), at: Date.now() };
    const next = [...entries.filter(e => e.fingerprint !== entry.fingerprint), entry].slice(-16);
    writeFileSync(this.path, JSON.stringify({ schema: 1, goal, revision, attempts: next }));
    return entry;
  }
}

// ---- scripted environment --------------------------------------------------
function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'r3-ledger-'));
  return { dir, executions: 0, interceptions: 0, divergenceForced: 0 };
}
// The command deterministically fails (simulating a permanently broken build).
function executeCommand(env, command) {
  env.executions += 1;
  return { ok: false, stderr: `SyntaxError: invalid syntax (build_research.py, line 12)\nexit code 1` };
}

// ---- one arm ----------------------------------------------------------------
function runArm({ useLedger }) {
  const env = makeEnv();
  const ledger = new FalsificationLedger(env.dir);
  const goal = 'Repair the strict-mode research build', revision = 2;
  let known = useLedger ? ledger.load(goal, revision) : new Map();
  // Simulated crash BEFORE the run: ledger already has the prior session's
  // failure of this exact command (the resume case).
  if (useLedger) {
    const prior = executeCommand(env, FAILING_COMMAND); // prior session execution
    ledger.record(goal, revision, 'Bash', { command: FAILING_COMMAND }, prior.stderr);
    known = ledger.load(goal, revision);
  }
  const fp = fingerprint('Bash', { command: FAILING_COMMAND });
  let result = null;
  for (let turn = 1; turn <= TURNS; turn++) {
    const emit = turn <= 7 ? FAILING_COMMAND : 'python3 build_research.py --mode default'; // diverges at turn 8
    if (useLedger && known.has(fingerprint('Bash', { command: emit }))) {
      // Host interception: do not execute again; return the recorded failure.
      env.interceptions += 1;
      const prior = known.get(fingerprint('Bash', { command: emit }));
      if (prior.forcedDivergence !== true) {
        env.divergenceForced += 1;
        result = { intercepted: true, message:
          `This exact command was already falsified in this goal (recorded failure: ${prior.failure}). ` +
          `Repeating it cannot succeed. Change the approach: alter the command, fix the underlying cause first, ` +
          `or take a different verified path. Recorded attempt: ${prior.argsSummary}.` };
        ledger.record(goal, revision, 'Bash', { command: emit }, prior.failure);
        continue;
      }
      continue;
    }
    if (emit === FAILING_COMMAND) {
      const r = executeCommand(env, emit);
      if (useLedger) { ledger.record(goal, revision, 'Bash', { command: emit }, r.stderr); known = ledger.load(goal, revision); }
      result = { executed: true, ok: r.ok };
    } else {
      // The diverged command succeeds.
      env.executions += 1;
      result = { executed: true, ok: true, diverged: true };
      break;
    }
  }
  return { arm: useLedger ? 'treatment(ledger)' : 'baseline', executions: env.executions,
    interceptions: env.interceptions, divergenceForced: env.divergenceForced,
    finalOk: result?.ok === true };
}

const baseline = runArm({ useLedger: false });
const treatment = runArm({ useLedger: true });
assert.equal(baseline.finalOk, true);
assert.equal(treatment.finalOk, true);

const report = {
  schema: 1, experiment: 'r3-falsification-ledger', turns: TURNS,
  question: 'After resume, does a persisted falsification ledger prevent repeated identical failing executions?',
  scenario: 'Scripted agent repeats the same failing command for 7 turns, then diverges. ' +
    'Treatment arm resumes with the prior session failure already recorded (crash + resume).',
  rows: [baseline, treatment],
  metrics: {
    wastedExecutions: { baseline: baseline.executions, treatment: treatment.executions },
    hostInterceptions: { baseline: baseline.interceptions, treatment: treatment.interceptions },
    bothArmsConverge: baseline.finalOk && treatment.finalOk,
  },
};
writeFileSync(new URL('./r3-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
