// Deterministic lifecycle demo, not an LLM or a discovery benchmark.
import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync(0, 'utf8'));
if (r.phase === 'ideate') {
  console.log(JSON.stringify({ families: [
    { id: 'expanded', approach: 'Evaluate the expanded polynomial.' },
    { id: 'factored', approach: 'Factor the polynomial before evaluation.' }
  ] }));
} else {
  const expanded = r.family.id === 'expanded';
  const source = r.round === 1 ? expanded ? 'n=>{ const answer=n*n+n; return answer; }' : 'n=>{ return n*(n+1); }' :
    r.round === 2 ? 'n=>n*n' : expanded ? 'n=>n*n+n' : 'n=>n*(n+1)';
  console.log(JSON.stringify({ candidate: { source }, notes: ['Validate algebraic simplification over the complete declared finite domain.'] }));
}
