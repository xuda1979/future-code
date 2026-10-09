import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateTask, snapshot, compactState, queueDecision, resolveDecision, recordEvidence, verifyEvidence, watchOnce, fanout } from '../../src/ops/runtime.mjs';
const project = () => mkdtempSync(join(tmpdir(), 'future-ops-'));
test('operational state preserves exact argv and errors across reads', async () => {
  const root = project();
  await updateTask(root, { id: 'job-1', status: 'running', argv: ['python', '-m', 'train', '--steps', '200'], lastError: 'device unavailable' });
  assert.deepEqual(compactState(root).tasks[0].argv, ['python', '-m', 'train', '--steps', '200']);
  assert.equal(snapshot(root).tasks['job-1'].lastError, 'device unavailable');
  await assert.rejects(updateTask(root, { id: 'job-1', status: 'done', expectedRevision: 0 }), /STALE_OPERATIONAL_REVISION/);
});
test('decisions are durable and cannot be silently rewritten', async () => {
  const root = project();
  await queueDecision(root, { id: 'hardware', question: 'Replace failed worker?' });
  await assert.rejects(queueDecision(root, { id: 'hardware', question: 'Delete data?' }), /conflict/);
  await resolveDecision(root, 'hardware', 'No');
  await assert.rejects(resolveDecision(root, 'hardware', 'Yes'), /already resolved/);
});
test('evidence fails closed on tampering', async () => {
  const root = project(); writeFileSync(join(root, 'metrics.json'), '{"score":0.5}');
  const e = await recordEvidence(root, { claim: 'evaluation complete', file: 'metrics.json', verdict: 'PASS' });
  assert.equal(verifyEvidence(root, e.id).status, 'PASS');
  writeFileSync(join(root, 'metrics.json'), '{"score":0.6}');
  assert.equal(verifyEvidence(root, e.id).status, 'VOID');
});
test('watchers edge-trigger, dedupe and re-arm on clearing', async () => {
  const root = project(); let active = true; let calls = 0;
  const exec = async () => { calls++; return { status: 'REPLIED', response: { alert: active ? 'disk full' : 'ok' } }; };
  const w = { id: 'disk', box: 'lab', command: 'health', pattern: 'disk full' };
  assert.equal((await watchOnce(root,w,exec)).status,'TRIGGERED');
  assert.equal((await watchOnce(root,w,exec)).status,'DEDUPED');
  active=false; assert.equal((await watchOnce(root,w,exec)).status,'CLEAR');
  active=true; assert.equal((await watchOnce(root,w,exec)).status,'TRIGGERED');
  assert.equal(calls,4);
});
test('remote fanout uses structured replies and never retries by default', async () => {
  const root = project(); const dir = join(root,'.future-code','ops'); mkdirSync(dir,{recursive:true});
  const server = await import('node:http');
  let count = 0;
  const app = server.createServer(async(req,res)=> {
    count++; let chunks=''; for await (const c of req) chunks += c;
    res.setHeader('content-type','application/json');res.end(JSON.stringify({ seen: JSON.parse(chunks).command }));
  });
  await new Promise(done=>app.listen(0,'127.0.0.1',done));
  try {
    writeFileSync(join(dir,'config.json'), JSON.stringify({ schema:1, executors:{ local:{ url:'http://127.0.0.1:'+app.address().port+'/exec', maxConcurrent:2 } } }));
    const r=await fanout(root,[{box:'local',command:'echo one'},{box:'local',command:'echo two'}]);
    assert.equal(r.complete,true);assert.equal(count,2);
    assert.deepEqual(r.results.map(x=>x.response.seen),['echo one','echo two']);
  } finally {app.close();}
});