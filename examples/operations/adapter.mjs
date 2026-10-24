// Synthetic external provider. This fixture never contacts a live service.
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const file = process.env.FUTURE_OPERATIONS_DEMO_PROVIDER;
if (!file || !isAbsolute(file)) throw Error('Set FUTURE_OPERATIONS_DEMO_PROVIDER to an absolute fixture database path');
const request = JSON.parse(readFileSync(0, 'utf8'));
const input = request.input;
if (request.schema !== 1 || !['execute', 'inspect'].includes(request.operation) ||
    !input || Object.keys(input).join() !== 'resource' || input.resource !== 'resource-1' ||
    createHash('sha256').update(JSON.stringify(input)).digest('hex') !== request.inputHash)
  throw Error('Invalid synthetic provider request');
mkdirSync(dirname(file), { recursive: true });
const db = new DatabaseSync(file);
try {
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS commitments(key TEXT PRIMARY KEY,input_hash TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL)');
  if (request.operation === 'execute') db.prepare("INSERT OR IGNORE INTO commitments VALUES(?,?,?,'COMMITTED')")
    .run(request.key, request.inputHash, JSON.stringify(input));
  const row = db.prepare('SELECT * FROM commitments WHERE key=?').get(request.key);
  if (row && row.input_hash !== request.inputHash) throw Error('External identity conflict');
  console.log(JSON.stringify({ schema: 1, key: request.key, inputHash: request.inputHash,
    status: row ? 'CONFIRMED' : 'UNKNOWN', externalId: 'synthetic-' + request.key,
    result: { synthetic: true, resource: input.resource, observed: !!row }, usage: { capacity: row ? 1 : 0 } }));
} finally { db.close(); }
