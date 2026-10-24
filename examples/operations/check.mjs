// Independent read-only observation; does not trust the model's final answer.
import { DatabaseSync } from 'node:sqlite';
const file = process.env.FUTURE_OPERATIONS_DEMO_PROVIDER;
if (!file) throw Error('Missing synthetic provider path');
const db = new DatabaseSync(file, { readOnly: true });
try {
  const rows = db.prepare("SELECT input,state FROM commitments WHERE state='COMMITTED'").all();
  if (rows.length !== 1 || JSON.parse(rows[0].input).resource !== 'resource-1') throw Error('Intended external fixture transition was not observed');
  console.log(JSON.stringify({ synthetic: true, verdict: 'PASS', observed: 1 }));
} finally { db.close(); }
