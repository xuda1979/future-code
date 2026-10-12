/** Local provider registry and encrypted key vault. No defaults for URLs or API keys. */
import { createHash, randomBytes, randomUUID, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, existsSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
const check=(v,m)=>{if(!v)throw new Error('Provider setup rejected: '+m)};
const idRe=/^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const blocked=new Set(['host','cookie','set-cookie','content-type','content-length','connection','transfer-encoding','proxy-authorization']);
export const protocols=['chat-completions','anthropic','responses','gemini'];
export const stateDir=()=>resolve(process.env.XDG_CONFIG_HOME||join(homedir(),'.config'),'future-code','commercial');
export const envName=id=>{check(idRe.test(id),'invalid provider ID');return 'FC_PROVIDER_'+createHash('sha256').update(id).digest('hex').slice(0,24).toUpperCase()};
export function validateProvider(p){
  check(p&&typeof p==='object'&&!Array.isArray(p),'invalid profile');
  const fields=['id','protocol','url','model','auth','secretMode'];
  check(fields.every(k=>Object.hasOwn(p,k))&&Object.keys(p).every(k=>fields.includes(k)),'unknown/missing profile field');
  check(idRe.test(p.id),'invalid provider name');
  check(protocols.includes(p.protocol),'unsupported wire protocol');
  check(typeof p.url==='string'&&p.url.length<=2048,'invalid endpoint URL');
  let url;try{url=new URL(p.url)}catch{throw new Error('Provider setup rejected: invalid URL')}
  check((url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))&&!!url.hostname,'remote endpoints require HTTPS');
  check(!url.username&&!url.password&&!url.search&&!url.hash,'credentials, query parameters and fragments forbidden in URL');
  check(typeof p.model==='string'&&p.model.length>0&&p.model.length<=200&&!/[\x00-\x1f]/.test(p.model),'invalid model ID');
  check(p.auth&&typeof p.auth==='object'&&Object.keys(p.auth).every(k=>['scheme','header'].includes(k)),'invalid auth');
  check(['bearer','raw','none'].includes(p.auth.scheme),'invalid auth scheme');
  check(typeof p.auth.header==='string'&&/^[a-z][a-z0-9-]{0,63}$/i.test(p.auth.header)&&!blocked.has(p.auth.header.toLowerCase()),'invalid auth header');
  check(p.auth.scheme!=='bearer'||p.auth.header.toLowerCase()==='authorization','bearer auth requires Authorization');
  check(['vault','prompt','env','none'].includes(p.secretMode),'invalid secret mode');
  check((p.auth.scheme==='none')===(p.secretMode==='none'),'none authorization requires none secret mode');
  return structuredClone(p);
}
function dir(root){const d=resolve(root);mkdirSync(d,{recursive:true,mode:0o700});const s=lstatSync(d);check(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&0o077)===0,'insecure profile directory; expected mode 0700');return d}
function file(root,name){return join(dir(root),name)}
function read(root,name){
  const p=file(root,name);if(!existsSync(p))return null;
  const s=lstatSync(p);check(s.isFile()&&!s.isSymbolicLink()&&(s.mode&0o077)===0&&s.size<=1024*1024,'insecure local file or permissions');
  return readFileSync(p,'utf8');
}
function save(root,name,value){
  const p=file(root,name);if(existsSync(p))read(root,name);
  const temp=file(root,'.new-'+randomUUID());
  try{writeFileSync(temp,value,{flag:'wx',mode:0o600});renameSync(temp,p)}
  finally{if(existsSync(temp))unlinkSync(temp)}
}
export function listProviders(root=stateDir()){
  const data=read(root,'providers.json');if(!data)return [];
  const o=JSON.parse(data);check(o.schema===1&&Array.isArray(o.providers)&&o.providers.length<=32,'invalid registry');
  const items=o.providers.map(validateProvider);check(new Set(items.map(x=>x.id)).size===items.length,'duplicate profiles');return items;
}
export function upsertProvider(profile,root=stateDir()){
  const validated=validateProvider(profile);const list=listProviders(root);
  const index=list.findIndex(x=>x.id===profile.id);if(index<0){check(list.length<32,'profile limit reached');list.push(validated)}else list[index]=validated;
  save(root,'providers.json',JSON.stringify({schema:1,providers:list},null,2)+'\n');
  return {name:profile.id,protocol:profile.protocol,model:profile.model,secretMode:profile.secretMode};
}
export function providerById(id,root=stateDir()){const p=listProviders(root).find(x=>x.id===id);check(p,'unknown provider profile');return p}
function keyFor(password,salt){
  check(typeof password==='string'&&password.length>=12,'master passphrase must contain at least 12 characters');
  return scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
}
export function sealSecrets(values,password){
  check(values&&typeof values==='object'&&!Array.isArray(values)&&Object.values(values).every(v=>typeof v==='string'&&v.length>0&&v.length<8192),'invalid secrets');
  const salt=randomBytes(16),iv=randomBytes(12),key=keyFor(password,salt);
  try{
    const cipher=createCipheriv('aes-256-gcm',key,iv);
    const data=Buffer.concat([cipher.update(JSON.stringify(values),'utf8'),cipher.final()]);
    return {schema:1,kdf:'scrypt-N32768-r8-p1',cipher:'aes-256-gcm',salt:salt.toString('base64url'),iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),data:data.toString('base64url')};
  }finally{key.fill(0)}
}
export function unsealSecrets(value,password){
  check(value?.schema===1&&value.kdf==='scrypt-N32768-r8-p1'&&value.cipher==='aes-256-gcm','invalid vault format');
  const salt=Buffer.from(value.salt,'base64url'),iv=Buffer.from(value.iv,'base64url'),tag=Buffer.from(value.tag,'base64url'),data=Buffer.from(value.data,'base64url');
  check(salt.length===16&&iv.length===12&&tag.length===16&&data.length<=1024*1024,'invalid vault dimensions');
  const key=keyFor(password,salt);
  try{
    const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);
    const parsed=JSON.parse(Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8'));
    check(parsed&&typeof parsed==='object'&&!Array.isArray(parsed),'invalid decrypted data');return parsed;
  }catch{throw new Error('Unable to unlock provider vault')}
  finally{key.fill(0)}
}
export function saveProviderSecret(id,secret,password,root=stateDir()){
  check(idRe.test(id)&&typeof secret==='string'&&secret.length>0&&secret.length<8192,'invalid credential');
  const old=read(root,'secrets.enc.json');
  const values=old?unsealSecrets(JSON.parse(old),password):{};
  values[id]=secret;save(root,'secrets.enc.json',JSON.stringify(sealSecrets(values,password))+'\n');
}
export function providerSecret(id,password,root=stateDir()){
  const raw=read(root,'secrets.enc.json');check(raw,'no encrypted vault');
  const result=unsealSecrets(JSON.parse(raw),password)[id];
  check(typeof result==='string'&&result.length>0,'secret absent from vault');return result;
}
export function bindProfile(profile,old){
  validateProvider(profile);
  return {...old,protocol:profile.protocol,url:profile.url,model:profile.model,auth:profile.auth,
    ...(profile.secretMode==='none'?{keyEnv:undefined}:{keyEnv:envName(profile.id)}),fallbacks:undefined,hedgeAfterMs:undefined};
}
