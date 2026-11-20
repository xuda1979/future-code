#!/usr/bin/env node
// R1 A/B: zero-tax headless start — bound the regular MCP connect wait.
//
// Measured problem (FUTURE_CODE_PROFILE_STARTUP on this host, see
// r1-results.json): the headless (-p) path blocks on
// `await connectMcpBatch(regularMcpConfigs)` — an UNBOUNDED wait on every
// configured MCP server. Profiles caught +30.0s and +4.8s on identical runs
// (server-dependent tail). The future.ai connector batch directly below it
// already uses a bounded 5s race (FUTURE_AI_MCP_TIMEOUT_MS, added for the
// tengu 76s p99) — the regular batch was never given the same bound.
//
// A/B with a deterministic slow server (stdio MCP server that sleeps 30s
// before its initialize reply), headless --print with a no-op model:
//   baseline: connect blocks ~30s (the slow server's startup)
//   treatment: bounded race — startup proceeds at 5s; slow server keeps
//              connecting in the background (turn 2+ sees it)
// Metric: startup wall (before_connectMcp -> after_connectMcp), 3 reps each.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileSync as wf } from 'node:fs';

const REPS = 3;
const SLOW_SERVER_SLEEP_S = 30;

function makeSlowServer(temp, sleepS = SLOW_SERVER_SLEEP_S) {
  // A stdio MCP server that accepts the process but delays its initialize
  // response: reads JSON-RPC lines, sleeps before replying.
  const server = join(temp, 'slow-server.mjs');
  wf(server, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const sleepMs = ${sleepS * 1000};
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '1.0' } } }) + '\\n');
    }, sleepMs);
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) + '\\n');
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
`);
  return server;
}

function runOnce(sourceRoot, temp, bounded, serverSleepS) {
  const server = makeSlowServer(temp, serverSleepS);
  const configDir = join(temp, 'cfg'); mkdirSync(configDir, { recursive: true });
  wf(join(configDir, 'settings.json'), JSON.stringify({
    mcpServers: { 'slow-server': { type: 'stdio', command: process.execPath, args: [server], env: {} } },
  }));
  // --mcp-config overrides file-based config; use a project .mcp.json via cwd
  // to keep user config untouched. Simpler: run with FUTURE_CONFIG_DIR? MCP
  // configs come from project/user settings, so run inside a temp project.
  const project = join(temp, 'proj'); mkdirSync(project, { recursive: true });
  wf(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { 'slow-server': { type: 'stdio', command: process.execPath, args: [server], env: {} } },
  }));
  const env = {
    ...process.env,
    FUTURE_CODE_PROFILE_STARTUP: '1',
    FUTURE_CONFIG_DIR: join(temp, 'fc-home'),
    // Scripted no-op model: any error reply is fine; we only measure startup.
    FUTURE_CODE_MODEL: 'fixture',
    // 0 = the pre-change unbounded await (baseline); 5000 = bounded race.
    FUTURE_CODE_MCP_CONNECT_TIMEOUT_MS: bounded ? '5000' : '0',
  };
  mkdirSync(join(temp, 'fc-home'), { recursive: true });
  const started = Date.now();
  const r = spawnSync(join(sourceRoot, 'future-code'), ['--print', 'reply ok'], {
    cwd: project, env, encoding: 'utf8', timeout: 90_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const wallS = (Date.now() - started) / 1000;
  return { bounded, slow: serverSleepS > 0, wallS: +wallS.toFixed(1), exit: r.status, stderrTail: (r.stderr ?? '').slice(-120).replace(/\n/g, ' ') };
}

const sourceRoot = new URL('../..', import.meta.url).pathname;
const rows = [];
// Slow-server A/B: the treatment's win condition.
for (let i = 0; i < REPS; i++) {
  const temp = mkdtempSync(join(tmpdir(), 'r1-mcp-'));
  try { rows.push(runOnce(sourceRoot, temp, false, SLOW_SERVER_SLEEP_S)); } finally { rmSync(temp, { recursive: true, force: true }); }
}
for (let i = 0; i < REPS; i++) {
  const temp = mkdtempSync(join(tmpdir(), 'r1-mcp-'));
  try { rows.push(runOnce(sourceRoot, temp, true, SLOW_SERVER_SLEEP_S)); } finally { rmSync(temp, { recursive: true, force: true }); }
}
// Fast-server (0s) control: the treatment must NOT regress healthy startup.
for (const bounded of [false, true]) {
  for (let i = 0; i < REPS; i++) {
    const temp = mkdtempSync(join(tmpdir(), 'r1-mcp-'));
    try { rows.push(runOnce(sourceRoot, temp, bounded, 0)); } finally { rmSync(temp, { recursive: true, force: true }); }
  }
}
const base = rows.filter(r => !r.bounded && r.slow);
const treat = rows.filter(r => r.bounded && r.slow);
const fastBase = rows.filter(r => !r.bounded && !r.slow);
const fastTreat = rows.filter(r => r.bounded && !r.slow);
const avg = a => +(a.reduce((s, r) => s + r.wallS, 0) / a.length).toFixed(1);
const report = {
  schema: 1, experiment: 'r1-mcp-connect-block', reps: REPS,
  slowServerSleepS: SLOW_SERVER_SLEEP_S,
  question: 'Does a slow MCP server block headless startup for its full startup time (unbounded connectMcpBatch)?',
  arms: {
    baseline: { env: 'FUTURE_CODE_MCP_CONNECT_TIMEOUT_MS=0 (unbounded await)', slowWallSAvg: avg(base), fastControlWallSAvg: avg(fastBase), rows: base },
    treatment: { env: 'FUTURE_CODE_MCP_CONNECT_TIMEOUT_MS=5000 (bounded race)', slowWallSAvg: avg(treat), fastControlWallSAvg: avg(fastTreat), rows: treat },
  },
  rows,
};
report.summary = {
  slowBaselineWallSAvg: avg(base),
  slowTreatmentWallSAvg: avg(treat),
  slowSpeedupX: +(avg(base) / avg(treat)).toFixed(1),
  fastControlBaselineWallSAvg: avg(fastBase),
  fastControlTreatmentWallSAvg: avg(fastTreat),
  fastControlDeltaS: +(avg(fastTreat) - avg(fastBase)).toFixed(1),
};
wf(new URL('./r1-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
