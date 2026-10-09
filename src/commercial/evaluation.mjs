/** Commercial reporting boundary for Foundry's real-project benchmark.
 * This consumes evidence metadata. It does NOT authenticate a remote worker,
 * prove independence of the original verifier, or certify product performance.
 */
import { createHash } from 'node:crypto';

const assert = (test, message) => { if (!test) throw new Error(`invalid evaluation: ${message}`); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonnegative = value => finite(value) && value >= 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const gitSha = value => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value);
const median = values => { const v = [...values].sort((a, b) => a - b); const i = Math.floor(v.length / 2); return v.length % 2 ? v[i] : (v[i-1] + v[i]) / 2; };
const approx = (a, b) => finite(a) && Math.abs(a-b) <= Math.max(1e-6, Math.abs(b)*1e-8);

export function analyzeEvaluation(report, raw = '') {
  assert(isObject(report) && report.schema === 1, 'expected schema 1 object');
  assert(report.type === undefined || report.type === 'future-code-real-project-evaluation', 'incorrect source report type');
  assert(['live', 'replay'].includes(report.mode), 'invalid mode');
  const repetitions = report.repetitions;
  assert(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 20, 'invalid repetitions');
  assert(sha(report.protocolHash), 'missing protocol hash');
  assert(Array.isArray(report.trials) && report.trials.length === repetitions * 2, 'incomplete trial pairs');
  const seen = new Set(), sources = new Set(), tasks = new Set(), checks = new Set();
  const arms = { baseline: [], candidate: [] };
  for (const t of report.trials) {
    assert(isObject(t) && ['baseline', 'candidate'].includes(t.arm), 'invalid arm');
    assert(Number.isSafeInteger(t.repetition) && t.repetition >= 0 && t.repetition < repetitions, 'invalid repetition');
    const key = `${t.repetition}:${t.arm}`;
    assert(!seen.has(key), 'duplicate trial'); seen.add(key);
    assert(t.mode === report.mode, 'mixed trial mode');
    assert(['PASS', 'FAIL'].includes(t.status), 'invalid trial status');
    assert(gitSha(t.sourceCommit), 'missing source commit');
    assert(sha(t.taskHash) && sha(t.checksHash) && sha(t.reportHash), 'missing evidence identity');
    sources.add(t.sourceCommit); tasks.add(t.taskHash); checks.add(t.checksHash);
    const m = t.metrics;
    assert(isObject(m) && finite(m.wallClockMs) && m.wallClockMs > 0, 'invalid wall time');
    assert(Number.isSafeInteger(m.verifiedObjectives) && [0, 1].includes(m.verifiedObjectives), 'invalid accepted objectives');
    assert(Number.isSafeInteger(m.modelRequests) && m.modelRequests >= 0, 'invalid request count');
    assert(m.costUsd === null || nonnegative(m.costUsd), 'invalid cost');
    if (report.mode === 'replay') assert(m.modelRequests === 0, 'replay cannot record live requests');
    if (t.status === 'PASS') {
      assert(m.verifiedObjectives === 1 && isObject(t.integration) && gitSha(t.integration.tree), 'unsubstantiated PASS');
      assert(Array.isArray(t.artifactManifest) && t.artifactManifest.length > 0, 'missing acceptance artifacts');
      assert(t.artifactManifest.every(a => a.status === 'PASS' && sha(a.artifact) && sha(a.evidence)), 'invalid acceptance manifest');
    } else assert(m.verifiedObjectives === 0, 'FAIL trial claims objective completion');
    arms[t.arm].push(t);
  }
  assert(sources.size === 1 && tasks.size === 1 && checks.size === 1, 'comparison uses inconsistent source/tasks/checks');
  const allPass = report.trials.every(t => t.status === 'PASS');
  assert(report.allPass === allPass, 'summary quality mismatch');
  assert(report.modelRequests === report.trials.reduce((n, t) => n + t.metrics.modelRequests, 0), 'request sum mismatch');
  const times = Object.fromEntries(Object.entries(arms).map(([arm, trials]) => [arm, median(trials.map(t => t.metrics.wallClockMs))]));
  assert(isObject(report.medianWallClockMs) && approx(report.medianWallClockMs.baseline, times.baseline) && approx(report.medianWallClockMs.candidate, times.candidate), 'median summary mismatch');
  const decision = !allPass ? 'QUALITY_GATE_FAILED' : report.mode === 'replay' ? 'OFFLINE_BOUNDARY_ONLY' :
    repetitions < 3 ? 'INSUFFICIENT_REPETITIONS' : times.candidate < times.baseline ? 'OBSERVED_TIME_GAIN' : 'NO_OBSERVED_TIME_GAIN';
  assert(report.decision === decision, 'unsupported report decision');
  const speedup = report.mode === 'live' && allPass ? times.baseline / times.candidate : null;
  assert(speedup === null ? report.observedSpeedup === null : approx(report.observedSpeedup, speedup), 'speedup mismatch');
  const liveModelEvidence = report.mode === 'live' && Object.values(arms).every(trials =>
    trials.some(t => t.metrics.modelRequests > 0));
  const totals = Object.fromEntries(Object.entries(arms).map(([arm, trials]) => {
    const successes = trials.reduce((n, t) => n + t.metrics.verifiedObjectives, 0);
    const wallClockMs = trials.reduce((n, t) => n + t.metrics.wallClockMs, 0);
    const completeBilling = report.mode === 'live' && trials.every(t => nonnegative(t.metrics.costUsd));
    const costUsd = completeBilling ? trials.reduce((n, t) => n + t.metrics.costUsd, 0) : null;
    return [arm, { trials: trials.length, verifiedObjectives: successes, wallClockMs,
      verifiedObjectivesPerHour: successes * 3600000 / wallClockMs,
      modelRequests: trials.reduce((n, t) => n + t.metrics.modelRequests, 0),
      costUsd,
      costPerVerifiedObjectiveUsd: costUsd !== null && costUsd > 0 && successes > 0 ? costUsd / successes : null }];
  }));
  return {
    schema: 1, kind: 'future-code-commercial-evaluation-summary',
    inputSha256: typeof raw === 'string' && raw.length > 0 ? createHash('sha256').update(raw).digest('hex') : null,
    protocolHash: report.protocolHash, sourceCommit: [...sources][0], taskHash: [...tasks][0], checksHash: [...checks][0],
    mode: report.mode, repetitions, decision: liveModelEvidence || report.mode === 'replay' ? decision : 'NO_LIVE_MODEL_REQUESTS',
    allPass, medianWallClockMs: times, observedSpeedup: liveModelEvidence ? speedup : null,
    arms: totals,
    disclosure: report.mode === 'replay' ? 'OFFLINE FIXTURE ONLY: zero real model calls; no productivity or cost advantage is demonstrated.' :
      !liveModelEvidence ? 'No real model requests recorded for at least one arm. No agent productivity advantage is demonstrated.' :
      allPass && repetitions >= 3 ? 'Observed paired-trial result, NOT proof of a causal or general advantage. Input claims and verifier independence require external audit.' :
      'Insufficient or failed live comparison. No productivity advantage is substantiated.',
    billingDisclosure: Object.values(totals).every(a => a.costPerVerifiedObjectiveUsd !== null) ?
      'Reported host costs only; external invoice reconciliation not independently established.' :
      'Dollar efficiency unavailable: missing or zero reported billing or no successful objectives. Never treat unknown as zero.',
  };
}
