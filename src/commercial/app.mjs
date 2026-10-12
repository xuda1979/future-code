#!/usr/bin/env node
/** Commercial entry point. No secrets or provider endpoints are built in. */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { stateDir, protocols, upsertProvider, listProviders, providerById, saveProviderSecret, providerSecret, envName, bindProfile, validateProvider } from './providers.mjs';
import { installationId, activate, licenseStatus, requireLicense } from './license.mjs';
export const HELP=`Future-Code Commercial
  provider add                          Interactive URL/model/auth/API-key setup
  provider list                         List profiles (never print secrets)
  license request                       Obtain installation ID
  license activate --file TOKENFILE     Install signed paid/authorized activation
  license status                        Show activation expiry/status
  init --profile NAME --spec FILE --allow-exec [--root DIR]
  run --profile NAME --tasks FILE --allow-exec [--root DIR]
  resume --profile NAME --run ID --allow-exec [--root DIR]
  supervise --profile NAME --objective ID --allow-exec [--goal FILE --tasks FILE] [--root DIR]
  status [--root DIR]
  integrate --run ID --allow-exec [--root DIR]
  report --input FILE [--out FILE] [--html FILE]
  help
Default private configuration: your user config directory. Override using --state-dir DIR.
`;
const assert=(ok,msg)=>{if(!ok)throw new Error(msg)};
export function parse(flags){
  const allowed=new Set(['--state-dir','--profile','--root','--tasks','--run','--objective','--goal','--spec','--file','--out','--html','--input','--allow-exec']);
  const m=new Map();
  for(let i=0;i<flags.length;i++){
    const k=flags[i];assert(allowed.has(k)&&!m.has(k),'Unknown or duplicate option '+k);
    if(k==='--allow-exec'){m.set(k,'true');continue}
    const v=flags[++i];assert(v&&!v.startsWith('--'),'Missing '+k);m.set(k,v);
  }return m;
}
async function ask(question,def=''){
  assert(process.stdin.isTTY,'Interactive setup requires a terminal');
  const q=createInterface({input:process.stdin,output:process.stderr});
  try{return (await q.question(question+(def?` [${def}]`:'')+': ')).trim()||def}
  finally{q.close()}
}
export async function hidden(question) {
  const input=process.stdin,output=process.stderr;
  assert(input.isTTY&&typeof input.setRawMode==='function','Hidden prompt requires a terminal');
  output.write(question+': ');const chars=[],previous=input.isRaw;
  return new Promise((resolve,reject)=>{
    const finish=(error)=>{
      input.off('data',onData);input.setRawMode(Boolean(previous));input.pause();output.write('\n');
      if(error)reject(error);else resolve(chars.join(''));
    };
    const onData=chunk=>{for(const ch of chunk.toString('utf8')){
      if(ch==='\u0003'){finish(new Error('Cancelled'));return}
      if(ch==='\r'||ch==='\n'){finish();return}
      if(ch==='\u007f'||ch==='\b'){chars.pop();continue}
      if(ch>=' '&&chars.length<8192)chars.push(ch);
    }};
    input.setRawMode(true);input.resume();input.on('data',onData);
  });
}
async function wizard(root){
  const id=await ask('Profile name','primary');
  const protocol=await ask('Protocol ('+protocols.join('/')+')','chat-completions');
  const url=await ask('Your provider endpoint URL (HTTPS outside localhost)');
  const model=await ask('Your model identifier');
  const def=protocol==='anthropic'?{scheme:'raw',header:'x-api-key'}:protocol==='gemini'?
    {scheme:'raw',header:'x-goog-api-key'}:{scheme:'bearer',header:'authorization'};
  const scheme=await ask('Authentication (bearer/raw/none)',def.scheme);
  const header=await ask('Authentication header',def.header);
  const secretMode=scheme==='none'?'none':await ask('Key source (vault/prompt/env)','vault');
  const profile=validateProvider({id,protocol,url,model,auth:{scheme,header},secretMode});
  if(secretMode==='vault'){
    const secret=await hidden('API key (hidden)');
    const pass=await hidden('Vault master passphrase, 12+ chars (hidden)');
    saveProviderSecret(id,secret,pass,root);
  }
  const status=upsertProvider(profile,root);
  return {...status, ...(secretMode==='env'?{environmentVariable:envName(id)}:{}),
    note:'Profile metadata is local. Secret values are never written to the repository.'};
}
function readJson(path){assert(statSync(path).size<=2*1024*1024,'Spec exceeds 2 MiB');return JSON.parse(readFileSync(path,'utf8'))}
async function withSecrets(root,profile,fn){
  if(profile.secretMode==='none')return fn();
  const key=envName(profile.id);
  if(profile.secretMode==='env'){assert(process.env[key],'Missing secret environment '+key);return fn()}
  assert(!Object.hasOwn(process.env,key),'Credential environment collision: '+key);
  let secret;
  if(profile.secretMode==='prompt')secret=await hidden('API key for '+profile.id+' (hidden)');
  else secret=providerSecret(profile.id,await hidden('Vault master passphrase (hidden)'),root);
  assert(!!secret,'Empty credential');
  try{process.env[key]=secret;return await fn()}
  finally{delete process.env[key];secret=undefined}
}
export async function command(argv){
  const [group,sub,...rest]=argv;
  if(!group||group==='help')return HELP;
  if(group==='report'){
    const {run}=await import('./cli.mjs');
    return run(['report',sub,...rest].filter(x=>x!==undefined));
  }
  const nested=group==='provider'||group==='license';
  const opts=parse(nested?rest:[sub,...rest].filter(x=>x!==undefined));
  const root=opts.get('--state-dir')??stateDir();
  if(group==='provider'){
    if(sub==='add')return wizard(root);
    if(sub==='list')return listProviders(root).map(p=>({name:p.id,protocol:p.protocol,model:p.model,secretMode:p.secretMode}));
    throw new Error('Expected provider add or provider list');
  }
  if(group==='license'){
    if(sub==='request')return {installation:installationId(root)};
    if(sub==='status')return licenseStatus({root});
    if(sub==='activate'){assert(opts.has('--file'),'Activation requires --file');return activate(readFileSync(opts.get('--file'),'utf8'),{root})}
    throw new Error('Expected license request, activate or status');
  }
  assert(['init','run','resume','supervise','status','integrate'].includes(group),'Unknown command '+group);
  const swarmRoot=opts.get('--root')??'.future-code/swarm';
  if(group==='status'){
    const {handleSwarm}=await import('../harness/foundry/swarm/cli.ts');
    return handleSwarm(['status','--root',swarmRoot]);
  }
  assert(opts.has('--allow-exec'),'Explicit --allow-exec required');
  if(group!=='init')requireLicense({root});
  if(group==='init'){
    assert(opts.has('--spec')&&opts.has('--profile'),'init requires --spec and --profile');
    const p=providerById(opts.get('--profile'),root),spec=readJson(opts.get('--spec'));
    const agents=Object.fromEntries(Object.entries(spec.agents).map(([id,old])=>[id,bindProfile(p,old)]));
    const {Store}=await import('../harness/foundry/store.ts');
    const {initializeSwarm}=await import('../harness/foundry/swarm/host.ts');
    const db=await Store.open(swarmRoot);
    try{const data=await initializeSwarm(db,{...spec,agents},new AbortController().signal);
      return {initialized:true,root:db.root,baseCommit:data.baseCommit,profiles:Object.keys(agents)}}
    finally{db.close()}
  }
  const a=[group,'--root',swarmRoot,'--allow-exec',
    ...['--run','--objective','--tasks','--goal'].flatMap(k=>opts.has(k)?[k,opts.get(k)]:[])];
  const {handleSwarm}=await import('../harness/foundry/swarm/cli.ts');
  if(['run','resume','supervise'].includes(group)){
    assert(opts.has('--profile'),'Execution requires --profile');
    const profile=providerById(opts.get('--profile'),root);
    const {Store}=await import('../harness/foundry/store.ts');
    const {loadSwarm}=await import('../harness/foundry/swarm/host.ts');
    const db=await Store.open(swarmRoot);
    try{
      const spec=loadSwarm(db).spec;
      for(const configured of Object.values(spec.agents)){
        const bound=bindProfile(profile,configured);
        for(const k of ['protocol','url','model','keyEnv'])
          assert(configured[k]===bound[k],'Selected provider does not match pinned objective: '+k);
        assert(JSON.stringify(configured.auth??null)===JSON.stringify(bound.auth??null),'Pinned authentication differs from selected profile');
      }
    }finally{db.close()}
    return withSecrets(root,profile,()=>handleSwarm(a));
  }
  return handleSwarm(a);
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  // Node 22.16 does not strip .ts imports automatically. Relaunch transparently
  // before reading any user secrets or starting a run; preserve terminal input.
  if(!process.features.typescript&&!process.execArgv.includes('--experimental-strip-types')){
    const child=spawnSync(process.execPath,['--experimental-strip-types',...process.argv.slice(1)],{stdio:'inherit'});
    if(child.error)throw child.error;
    process.exitCode=child.status??1;
  }else command(process.argv.slice(2)).then(value=>console.log(typeof value==='string'?value:JSON.stringify(value,null,2)),e=>{
    console.error(e instanceof Error?e.message:String(e));process.exitCode=1;
  });
}
