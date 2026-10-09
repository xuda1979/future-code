#!/usr/bin/env node
/** Offline commercial entrypoint; cannot execute models, shell tools or deploy. */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeEvaluation } from './evaluation.mjs';
import { checkReadiness } from './readiness.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
export const help = `Future-Code Commercial Preview (local, no API calls)
  demo                         summarize the recorded offline replay (NOT a speedup)
  doctor [--manifest FILE]     check human-reviewed launch blockers
  report --input FILE [--out FILE] [--html FILE]
                               analyze a real-project paired-trial JSON and write a self-contained dashboard
  help
For live trials use scripts/evaluate-real-project.mjs with frozen acceptance tests.
No command grants a distribution license, deploys to production or starts untrusted code.`;
const read = path => {
  if (statSync(path).size > 8 * 1024 * 1024) throw new Error('input exceeds 8 MiB');
  const raw = readFileSync(path, 'utf8');
  return { value: JSON.parse(raw), raw };
};
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const number = n => n === null ? 'Unknown' : typeof n === 'number' ? Number(n.toFixed(3)).toLocaleString('en-US') : String(n);
export function dashboard(summary) {
  const cell = (key, value) => `<div class="stat"><span>${esc(key)}</span><strong>${esc(number(value))}</strong></div>`;
  const arm = key => { const x = summary.arms[key]; return `<section><h2>${esc(key)}</h2><div class="stats">${cell('Verified objectives',x.verifiedObjectives)}${cell('Objectives/hour',x.verifiedObjectivesPerHour)}${cell('Cost per success (USD)',x.costPerVerifiedObjectiveUsd)}${cell('Model requests',x.modelRequests)}</div></section>`; };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Future-Code · Verified R&D evaluation</title><style>body{margin:0;background:#0d1725;color:#ecf2f7;font:16px system-ui,sans-serif}main{max-width:1060px;margin:auto;padding:48px 24px}h1{font-size:clamp(28px,4vw,46px);letter-spacing:-.04em}h2{font-size:20px}p{line-height:1.55;color:#c5d2dc}.lead{font-size:18px}.state{font-weight:700;color:#f9cd77}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}.stat,section{background:#162538;border:1px solid #31445b;border-radius:14px;padding:16px}.stat span{display:block;color:#b3c6d8;font-size:13px}.stat strong{display:block;font-size:22px;margin-top:8px}section{margin:16px 0}.meta{font:12px ui-monospace,monospace;overflow-wrap:anywhere}footer{margin-top:36px;color:#b3c6d8}</style></head><body><main><p>FUTURE-CODE / CUSTOMER EVALUATION</p><h1>Verified R&amp;D: evaluation overview</h1><p class="lead state">${esc(summary.decision)} · ${esc(summary.mode.toUpperCase())}</p><p>${esc(summary.disclosure)}</p>${arm('baseline')}${arm('candidate')}<section><h2>Measurement boundaries</h2><p>${esc(summary.billingDisclosure)}</p><p>Repetitions per arm: ${esc(summary.repetitions)}. Observed speedup: ${esc(number(summary.observedSpeedup))}.</p><p class="meta">Protocol ${esc(summary.protocolHash)}<br>Input SHA-256 ${esc(summary.inputSha256)}</p></section><footer>Local static report. No network requests, third-party scripts or model calls. This dashboard summarizes reported trial data; it does not independently authenticate source or verifier execution.</footer></main></body></html>`;
}
export function run(argv) {
  const command = argv[0] ?? 'help';
  if (command === 'help' && argv.length === 1 || command === 'help' && argv.length === 0) return { help };
  if (!['demo','doctor','report'].includes(command)) throw new Error(`unknown command: ${command}`);
  const allowed = command === 'doctor' ? new Set(['--manifest']) : command === 'report' ? new Set(['--input','--out','--html']) : new Set();
  const opts = new Map();
  for (let i=1;i<argv.length;i++) {
    const k=argv[i], v=argv[++i];
    if (!allowed.has(k) || opts.has(k) || !v || v.startsWith('--')) throw new Error(`unknown, duplicate or missing option: ${k}`);
    opts.set(k,v);
  }
  if (command === 'doctor') {
    const path=opts.get('--manifest') ?? resolve(repo,'docs/commercial/release-gates.json');
    return checkReadiness(read(path).value);
  }
  const path = command === 'demo' ? resolve(repo,'docs/agent-platform/validation/real-project-replay.json') : opts.get('--input');
  if (!path) throw new Error('required --input FILE');
  const { value, raw } = read(path);
  const summary = analyzeEvaluation(value,raw);
  if (opts.has('--out')) writeFileSync(opts.get('--out'),JSON.stringify(summary,null,2)+'\n',{flag:'wx',mode:0o600});
  if (opts.has('--html')) writeFileSync(opts.get('--html'),dashboard(summary),{flag:'wx',mode:0o600});
  return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output=run(process.argv.slice(2));
    console.log(typeof output.help === 'string' ? output.help : JSON.stringify(output,null,2));
    if (output.status === 'BLOCKED' || output.decision === 'QUALITY_GATE_FAILED') process.exitCode=2;
  } catch (e) { console.error(JSON.stringify({error:e instanceof Error ? e.message : String(e)}));process.exitCode=1; }
}
