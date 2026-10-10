#!/usr/bin/env node
/** Offline SQL hotspot measurement, not a live-agent productivity benchmark. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, cpus, platform, arch } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Store } from "../src/harness/foundry/store.ts";
import { SessionJournal } from "../src/harness/foundry/swarm/session.ts";
import { runRequestTotals } from "../src/harness/foundry/swarm/requestAccounting.ts";

const root = mkdtempSync(join(tmpdir(), "request-accounting-bench-"));
const store = await Store.open(root);
const samples = 7;
function measure(fn, iterations) {
  for (let i = 0; i < 10; i++) fn();
  const observations = [];
  for (let s = 0; s < samples; s++) {
    const started = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    observations.push((performance.now() - started) * 1000 / iterations);
  }
  observations.sort((a, b) => a - b);
  return { medianUs: observations[Math.floor(samples / 2)], maxUs: observations.at(-1), samples, iterations };
}
try {
  new SessionJournal(store);
  const insert = store.db.prepare(`INSERT INTO agent_requests
    (id,run,task,fence,provider,bytes,request,started,deadline,status,tokens)
    VALUES(?,'bench','task',1,'pool',1000,'fixture',?,?,'DONE',5)`);
  const legacy = store.db.prepare("SELECT COUNT(*) AS requests,COALESCE(SUM(bytes),0) AS bytes FROM agent_requests WHERE run='bench'");
  const results = [];
  let rows = 0;
  for (const size of [100, 10000, 100000]) {
    store.transaction(() => { while (rows < size) { insert.run(String(rows), rows, rows + 1); rows++; } });
    const measured = runRequestTotals(store, "bench");
    assert.equal(measured.requests, size); assert.equal(measured.bytes, size * 1000);
    assert.deepEqual({ requests: measured.requests, bytes: measured.bytes }, { ...legacy.get() });
    const scan = measure(() => legacy.get(), 50);
    const indexed = measure(() => runRequestTotals(store, "bench"), 500);
    results.push({ historyRows: size, legacyAggregate: scan, indexedCounter: indexed,
      lookupSpeedup: scan.medianUs / indexed.medianUs });
  }
  const queryPlan = store.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM agent_request_totals WHERE run='bench' AND task='' AND fence=0").all();
  assert.ok(queryPlan.some(row => /SEARCH.*INDEX/.test(String(row.detail))));
  console.log(JSON.stringify({ schema: 1, status: "HOST_SQL_MICROBENCHMARK_NOT_RND_SPEEDUP",
    runtime: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? null,
    sourceHashes: Object.fromEntries(["../src/harness/foundry/store.ts", "../src/harness/foundry/swarm/session.ts",
      "../src/harness/foundry/swarm/requestAccounting.ts"].map(path => [path.slice(3),
      createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex")])),
    results, queryPlan, liveLLMCalls: 0, comparisonWithClaudeOrCodex: null }, null, 2));
} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
