// General-purpose, project-scoped operational plane. No model or experiment assumptions.
// Node/Bun compatible; safe to import in a compiled CLI.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';

const MAX_OUTPUT = 256 * 1024;
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const STATES = new Set(['queued', 'running', 'blocked', 'done', 'failed', 'cancelled']);
const sha = x => createHash('sha256').update(x).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export const opsDir = project => join(resolve(project), '.future-code', 'ops');
const fresh = () => ({ schema: 1, revision: 0, tasks: {}, watchers: {}, decisions: {}, evidence: [] });
function directory(project) {
  const dir = opsDir(project);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
function readSnapshot(dir) {
  const file = join(dir, 'state.json');
  if (!existsSync(file)) return fresh();
  const state = JSON.parse(readFileSync(file, 'utf8'));
  if (state.schema !== 1 || !state.tasks || !state.watchers || !state.decisions || !Array.isArray(state.evidence))
    throw new Error('Invalid operational state: fail closed and reconcile manually');
  return state;
}
export function snapshot(project = process.cwd()) {
  return readSnapshot(directory(project));
}
async function withState(project, update) {
  const dir = directory(project), lock = join(dir, '.state.lock');
  let fd;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { fd = openSync(lock, 'wx', 0o600); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; await wait(25); }
  }
  if (fd === undefined) throw new Error('Operational state busy; do not break a possibly live lock');
  try {
    const state = readSnapshot(dir);
    const value = await update(state);
    state.revision++;
    const tmp = join(dir, '.state-' + randomUUID());
    const out = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(out, JSON.stringify(state)); fsyncSync(out); }
    finally { closeSync(out); }
    try { renameSync(tmp, join(dir, 'state.json')); }
    finally { if (existsSync(tmp)) unlinkSync(tmp); }
    // Persist the rename on POSIX when the directory supports fsync.
    if (process.platform !== 'win32') {
      const d = openSync(dir, 'r');
      try { fsyncSync(d); } finally { closeSync(d); }
    }
    return value;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
export async function updateTask(project, input) {
  if (!input || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(input.id))
    throw new Error('Invalid task ID');
  if (!STATES.has(input.status)) throw new Error('Invalid task status');
  if (input.argv !== undefined && (!Array.isArray(input.argv) || input.argv.length > 128 ||
    !input.argv.every(s => typeof s === 'string' && s.length <= 4096))) throw new Error('Invalid exact argv');
  for (const key of ['goal', 'lastError', 'next']) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 4096))
      throw new Error('Invalid ' + key);
  }
  return withState(project, state => {
    if (input.expectedRevision !== undefined && input.expectedRevision !== state.revision)
      throw new Error('STALE_OPERATIONAL_REVISION');
    const current = state.tasks[input.id] || {};
    const next = { ...current, id: input.id, status: input.status, updatedAt: Date.now() };
    for (const key of ['goal', 'argv', 'lastError', 'next']) {
      if (input[key] !== undefined) next[key] = input[key];
    }
    state.tasks[input.id] = next;
    return next;
  });
}
export async function queueDecision(project, decision) {
  if (!decision || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(decision.id) ||
    typeof decision.question !== 'string' || !decision.question.trim() || decision.question.length > 4096)
    throw new Error('Invalid decision');
  return withState(project, state => {
    const previous = state.decisions[decision.id];
    if (previous) {
      if (previous.question !== decision.question) throw new Error('Decision ID conflict');
      return previous;
    }
    return state.decisions[decision.id] = { ...decision, status: 'pending', createdAt: Date.now() };
  });
}
export async function resolveDecision(project, id, answer) {
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 4096) throw new Error('Invalid decision answer');
  return withState(project, state => {
    const d = state.decisions[id];
    if (!d) throw new Error('Unknown decision');
    if (d.status === 'resolved' && d.answer !== answer) throw new Error('Decision already resolved');
    d.status = 'resolved'; d.answer = answer; d.resolvedAt = Date.now(); return d;
  });
}
function artifactPath(project, p) {
  if (typeof p !== 'string' || !p || p.includes('\0')) throw new Error('Invalid artifact path');
  const root = resolve(project), path = resolve(root, p);
  if (path === root || relative(root, path).startsWith('..') || isAbsolute(relative(root, path)))
    throw new Error('Evidence file outside project');
  return path;
}
export async function recordEvidence(project, input) {
  if (!input || typeof input.claim !== 'string' || !input.claim.trim() || input.claim.length > 4096)
    throw new Error('Invalid evidence claim');
  const file = artifactPath(project, input.file);
  if (!statSync(file).isFile()) throw new Error('Evidence must be a regular file');
  // Small verified receipts only: large checkpoints should have a separately pinned manifest.
  if (statSync(file).size > 16 * 1024 * 1024) throw new Error('Evidence file too large: provide a manifest');
  const hash = sha(readFileSync(file));
  return withState(project, state => {
    const prev = state.evidence.at(-1)?.entryHash || null;
    const entry = { id: randomUUID(), claim: input.claim, file: relative(resolve(project), file),
      sha256: hash, verdict: input.verdict === 'PASS' ? 'PASS' : 'UNKNOWN',
      previousHash: prev, at: Date.now() };
    entry.entryHash = sha(JSON.stringify(entry));
    state.evidence.push(entry);
    return entry;
  });
}
export function verifyEvidence(project, id) {
  const entry = snapshot(project).evidence.find(e => e.id === id);
  if (!entry) throw new Error('Unknown evidence ID');
  try {
    const path = artifactPath(project, entry.file);
    if (!statSync(path).isFile() || statSync(path).size > 16 * 1024 * 1024) return { ...entry, status: 'VOID' };
    return { ...entry, status: sha(readFileSync(path)) === entry.sha256 ? entry.verdict : 'VOID' };
  } catch { return { ...entry, status: 'VOID' }; }
}
// Bounded projection to restore exact argv/error/task/decisions after compaction.
export function compactState(project = process.cwd()) {
  const s = snapshot(project);
  const tasks = Object.values(s.tasks).filter(t => !TERMINAL.has(t.status))
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
  const decisions = Object.values(s.decisions).filter(d => d.status === 'pending').slice(0, 12);
  const watchers = Object.entries(s.watchers).slice(0, 20).map(([id, w]) => ({
    id, outcome: w.outcome, pendingAction: w.pendingAction || null, lastAt: w.lastAt,
  }));
  return { schema: 1, revision: s.revision, tasks, decisions, watchers,
    evidenceHead: s.evidence.at(-1)?.entryHash || null,
    note: 'Live process and remote-job state MUST be reconciled before new effects.' };
}
export function loadConfig(project = process.cwd()) {
  const file = join(directory(project), 'config.json');
  if (!existsSync(file)) throw new Error('Missing .future-code/ops/config.json; configure approved executors first');
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  if (cfg.schema !== 1 || !cfg.executors || typeof cfg.executors !== 'object' ||
      (cfg.watchers && !Array.isArray(cfg.watchers))) throw new Error('Invalid ops config');
  for (const [name, e] of Object.entries(cfg.executors)) {
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(name)) throw new Error('Invalid executor name');
    const u = new URL(e.url);
    if (u.username || u.password || u.search || u.hash || !['http:', 'https:'].includes(u.protocol))
      throw new Error('Invalid executor URL');
    if (u.protocol === 'http:' && !(['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || e.allowInsecureHttp === true))
      throw new Error('Unencrypted remote endpoint requires explicit operator opt-in');
    if (e.tokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.tokenEnv)) throw new Error('Invalid token environment name');
  }
  return cfg;
}
const inflight = new Map();
async function limitBox(name, max, action) {
  // Per-process admission; the remote server still owns global capacity.
  let entry = inflight.get(name);
  if (!entry) { entry = { running: 0, queue: [] }; inflight.set(name, entry); }
  if (entry.running >= max) await new Promise(done => entry.queue.push(done));
  entry.running++;
  try { return await action(); }
  finally { entry.running--; const next = entry.queue.shift(); if (next) next(); }
}
async function responseText(resp, max = MAX_OUTPUT) {
  const reader = resp.body?.getReader();
  if (!reader) return '';
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error('REMOTE_OUTPUT_LIMIT_EXCEEDED');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}
export async function remoteExec(project, box, command, options = {}) {
  if (typeof command !== 'string' || !command.trim() || command.length > 16384) throw new Error('Invalid remote command');
  const cfg = loadConfig(project), e = cfg.executors[box];
  if (!e) throw new Error('Unknown executor: ' + box);
  const timeoutMs = options.timeoutMs ?? 90_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3_600_000) throw new Error('Invalid timeoutMs');
  const key = options.idempotencyKey;
  if (key !== undefined && (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)))
    throw new Error('Invalid idempotency key');
  const retries = options.retries ?? 0;
  if (!Number.isInteger(retries) || retries < 0 || retries > 2) throw new Error('Invalid retry count');
  if (retries && (!key || e.idempotencyKeys !== true))
    throw new Error('Retries require server-enforced idempotency keys; unknown command outcomes cannot be replayed');
  const max = e.maxConcurrent ?? 3;
  if (!Number.isInteger(max) || max < 1 || max > 64) throw new Error('Invalid executor concurrency');
  return limitBox(box, max, async () => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      const token = e.tokenEnv ? process.env[e.tokenEnv] : null;
      if (e.tokenEnv && !token) { clearTimeout(timer); throw new Error('Missing executor token environment variable'); }
      try {
        const body = { [e.commandField || 'command']: command, [e.timeoutField || 'timeout']: Math.ceil(timeoutMs / 1000) };
        if (key) body.request_id = key;
        const resp = await fetch(e.url, { method: 'POST', headers: { 'content-type': 'application/json',
          ...(token ? { authorization: 'Bearer ' + token } : {}), ...(key ? { 'idempotency-key': key } : {}) },
          body: JSON.stringify(body), signal: options.signal ? AbortSignal.any([abort.signal, options.signal]) : abort.signal });
        const text = await responseText(resp);
        if (!resp.ok) {
          if (attempt < retries && resp.status >= 500) { await wait(100 * (attempt + 1)); continue; }
          return { box, status: 'HTTP_ERROR', httpStatus: resp.status, error: text.slice(0, 1024) };
        }
        let value;
        try { value = JSON.parse(text); }
        catch { return { box, status: 'MALFORMED', error: 'Remote response is not JSON', preview: text.slice(0, 1024) }; }
        return { box, status: 'REPLIED', response: value };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (attempt >= retries) return { box, status: 'UNKNOWN', error: String(error?.message || error).slice(0, 512) };
        await wait(100 * (attempt + 1));
      } finally { clearTimeout(timer); }
    }
  });
}
export async function fanout(project, requests, options = {}) {
  if (!Array.isArray(requests) || requests.length > 32 ||
    !requests.every(x => x && typeof x.box === 'string' && typeof x.command === 'string'))
    throw new Error('Invalid fanout requests');
  const results = await Promise.all(requests.map(r => remoteExec(project, r.box, r.command,
    { timeoutMs: r.timeoutMs ?? options.timeoutMs, idempotencyKey: r.idempotencyKey, retries: r.retries ?? 0, signal: options.signal })));
  return { results, complete: results.every(r => r.status === 'REPLIED') };
}
export async function watchOnce(project, watcher, exec = remoteExec) {
  if (!watcher || !/^[a-zA-Z0-9_-]{1,64}$/.test(watcher.id) || !watcher.box ||
      !watcher.command || typeof watcher.pattern !== 'string' || watcher.pattern.length > 1024)
    throw new Error('Invalid watcher');
  // Validate the regex before opening remote connections.
  const regex = new RegExp(watcher.pattern);
  const response = await exec(project, watcher.box, watcher.command, { timeoutMs: watcher.timeoutMs ?? 90_000 });
  if (response.status !== 'REPLIED') {
    await withState(project, s => { s.watchers[watcher.id] = { ...(s.watchers[watcher.id] || {}),
      outcome: 'UNKNOWN', lastAt: Date.now() }; });
    return { id: watcher.id, status: 'UNKNOWN' };
  }
  const body = JSON.stringify(response.response).slice(0, MAX_OUTPUT);
  const match = regex.test(body);
  const fingerprint = sha(body);
  const before = snapshot(project).watchers[watcher.id];
  if (!match) {
    await withState(project, s => { s.watchers[watcher.id] = { outcome: 'CLEAR', lastAt: Date.now(), armed: true }; });
    return { id: watcher.id, status: 'CLEAR' };
  }
  if (before && before.armed === false) return { id: watcher.id, status: 'DEDUPED' };
  const actionKey = watcher.id + ':' + fingerprint.slice(0, 24);
  // Persist intent before any external effect. Crash/timeout => UNKNOWN and operator reconciliation.
  await withState(project, s => { s.watchers[watcher.id] = { outcome: 'TRIGGERED',
    lastAt: Date.now(), armed: false, fingerprint, pendingAction: watcher.action ? actionKey : null }; });
  if (!watcher.action) return { id: watcher.id, status: 'TRIGGERED', evidenceHash: fingerprint };
  const action = watcher.action;
  if (action.type !== 'remote' || typeof action.box !== 'string' || typeof action.command !== 'string')
    return { id: watcher.id, status: 'NEEDS_OPERATOR', evidenceHash: fingerprint };
  // Only an explicitly admitted idempotent remote endpoint may execute recovery unattended.
  const e = loadConfig(project).executors[action.box];
  if (action.auto !== true || e?.idempotencyKeys !== true) return { id: watcher.id, status: 'NEEDS_OPERATOR' };
  const result = await exec(project, action.box, action.command, { idempotencyKey: actionKey, retries: 0, timeoutMs: action.timeoutMs ?? 90_000 });
  await withState(project, s => {
    const w = s.watchers[watcher.id];
    w.outcome = result.status === 'REPLIED' ? 'ACTION_REPLIED' : 'UNKNOWN';
    if (result.status === 'REPLIED') w.pendingAction = null;
  });
  return { id: watcher.id, status: result.status === 'REPLIED' ? 'ACTION_REPLIED' : 'UNKNOWN', evidenceHash: fingerprint };
}
export async function superviseOnce(project, exec = remoteExec) {
  const cfg = loadConfig(project), now = Date.now();
  const watchers = (cfg.watchers || []).filter(w => {
    const last = snapshot(project).watchers[w.id]?.lastAt ?? 0;
    return now - last >= (w.pollMs ?? 30_000);
  });
  return Promise.all(watchers.map(async w => {
    try { return await watchOnce(project, w, exec); }
    catch (e) { return { id: w.id, status: 'ERROR', error: String(e?.message || e) }; }
  }));
}
export async function supervise(project, signal, exec = remoteExec) {
  while (!signal.aborted) {
    const results = await superviseOnce(project, exec);
    for (const r of results) if (r.status !== 'CLEAR' && r.status !== 'DEDUPED')
      process.stderr.write(JSON.stringify({ at: Date.now(), ...r }) + '\n');
    await Promise.race([wait(1000), new Promise(done => signal.addEventListener('abort', done, { once: true }))]);
  }
}
