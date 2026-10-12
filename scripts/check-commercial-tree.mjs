#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const tracked=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const forbidden=tracked.filter(x=>/(^|\/)(paper|papers|patents|hact-paper|vendor|node_modules)(\/|$)|\.(?:pdf|pptx|docx|pem|p8|key)$/i.test(x));
if(forbidden.length)throw Error('Disallowed source distribution material: '+forbidden.join(', '));
const root=new Set(tracked.map(p=>p.split('/')[0]));
for(const unwanted of ['future_huanxin_future_proxy.py','future-code.sh','bun.lock','write_paper_sections.py'])
  if(root.has(unwanted))throw Error('Unexpected legacy file: '+unwanted);
const docs=tracked.filter(x=>x.startsWith('docs/')&&x.endsWith('.md'));
for(const path of docs){
  const text=readFileSync(path,'utf8');
  if(/https?:\/\/[^\s\]\)]+\/(?:v1|api)\b/.test(text))throw Error('Hardcoded provider endpoint in documentation: '+path);
}
console.log('Commercial source tree policy PASS: '+tracked.length+' tracked paths; no manuscript, patent or key files.');
