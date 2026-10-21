// Tiny real evaluator lifecycle; scripted proposals do not measure LLM productivity.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/harness/foundry/store.ts';
import { initializeDiscovery, runDiscovery } from '../src/harness/foundry/discoveryRuntime.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'discovery-demo-'));
const store = await Store.open(dir);
try {
  const spec = JSON.parse(readFileSync(new URL('../examples/discovery-search/spec.json', import.meta.url), 'utf8'));
  initializeDiscovery(store, spec, root);
  const result = await runDiscovery(store);
  if (result.phase !== 'COMPLETE' || result.evaluated !== 6 || result.rejected !== 2 || result.best.report.metrics.sourceBytes !== 8)
    throw Error('Discovery demo failed its predeclared acceptance conditions');
  console.log(JSON.stringify({ fixture: 'scripted proposals + independent finite-domain evaluator', phase: result.phase,
    evaluated: result.evaluated, rejected: result.rejected, retainedCells: result.elites.length,
    best: result.best.proposal.candidate, sourceBytes: result.best.report.metrics.sourceBytes,
    tokens: result.tokens, costUsd: result.costUsd }, null, 2));
} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
