import { appendFileSync, readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync(0, 'utf8'));
if (r.task.interface.log) appendFileSync(r.task.interface.log, JSON.stringify({ phase: r.phase, round: r.round, family: r.family?.id }) + '\n');
if (r.phase === 'ideate') {
  console.log(JSON.stringify({ families: [{ id: 'expanded', approach: 'Direct polynomial evaluation' },
    { id: 'factored', approach: 'Factored polynomial evaluation' }] }));
} else {
  if (r.family.id === 'factored' && r.task.interface.delayMs) await new Promise(resolve => setTimeout(resolve, r.task.interface.delayMs));
  const source = r.round === 2 ? 'x=>0' : r.family.id === 'expanded' ? 'x=>x*x+x+41' : 'x=>(x+1)*x+41';
  console.log(JSON.stringify({ candidate: { source, claimedCost: -1e99 }, notes: ['Check algebra before reducing program size.'] }));
}
