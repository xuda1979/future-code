#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=join(root,'tests/commercial');
const tests=readdirSync(dir).filter(x=>x.endsWith('.test.mjs')).sort().map(x=>join(dir,x));
if(tests.length<3)throw Error('Expected commercial regression test files');
const r=spawnSync(process.execPath,['--experimental-strip-types','--test',...tests],{cwd:root,stdio:'inherit'});
if(r.error)throw r.error;process.exitCode=r.status??1;
