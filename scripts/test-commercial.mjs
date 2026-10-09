#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const test = fileURLToPath(new URL('../tests/commercial/commercial.test.mjs', import.meta.url));
const r=spawnSync(process.execPath,['--test',test],{cwd:root,stdio:'inherit'});
if (r.error) throw r.error;
process.exitCode=r.status ?? 1;
