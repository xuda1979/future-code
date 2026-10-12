/** Offline Ed25519 activation. Public verification only; signing keys never ship. */
import { createHash, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { stateDir } from './providers.mjs';
const trustDefault=fileURLToPath(new URL('../../keys/trusted-issuers.json',import.meta.url));
const assert=(ok,msg)=>{if(!ok)throw new Error('Activation rejected: '+msg)};
const b64=x=>Buffer.from(x).toString('base64url');
const sha=x=>createHash('sha256').update(x).digest('hex');
const now=()=>Math.floor(Date.now()/1000);
export const issuerId=publicPem=>sha(createPublicKey(publicPem).export({type:'spki',format:'der'})).slice(0,24);
function localDir(root){const d=resolve(root);mkdirSync(d,{recursive:true,mode:0o700});const st=lstatSync(d);assert(st.isDirectory()&&!st.isSymbolicLink()&&(st.mode&0o077)===0,'insecure activation directory');return d}
function pathFor(root,file){return join(localDir(root),file)}
function secureRead(path){if(!existsSync(path))return null;const st=lstatSync(path);assert(st.isFile()&&!st.isSymbolicLink()&&(st.mode&0o077)===0&&st.size<65536,'insecure activation file');return readFileSync(path,'utf8')}
function secureWrite(root,file,text){
  const path=pathFor(root,file);if(existsSync(path))secureRead(path);
  const temp=pathFor(root,'.new-'+randomUUID());
  try{writeFileSync(temp,text,{mode:0o600,flag:'wx'});renameSync(temp,path)}
  finally{if(existsSync(temp))unlinkSync(temp)}
}
export function installationId(root=stateDir()){
  const file=pathFor(root,'installation.json');
  let raw=secureRead(file);
  if(raw===null){secureWrite(root,'installation.json',JSON.stringify({schema:1,id:randomUUID()})+'\n');raw=secureRead(file)}
  const data=JSON.parse(raw);assert(data.schema===1&&/^[a-f0-9-]{36}$/i.test(data.id),'invalid installation ID');
  return data.id;
}
export function issueToken({privateKey,passphrase,publicKey,customer,installation,grant='paid',days=30},at=now()){
  assert(typeof customer==='string'&&/^[A-Za-z0-9._@-]{1,128}$/.test(customer),'invalid customer');
  assert(/^[a-f0-9-]{36}$/i.test(installation),'invalid installation');
  assert(['paid','authorized'].includes(grant),'invalid grant');
  assert(Number.isInteger(days)&&days>=1&&days<=366,'invalid validity');
  assert(Number.isSafeInteger(at),'invalid issue time');
  const payload={schema:1,kid:issuerId(publicKey),id:randomUUID(),customer,installation,grant,features:['execution'],
    issuedAt:at,notBefore:at-60,expiresAt:at+days*86400};
  const encoded=b64(JSON.stringify(payload)),signed='FC1.'+encoded;
  return signed+'.'+b64(sign(null,Buffer.from(signed),{key:privateKey,passphrase}));
}
export function verifyToken(token,{installation,trustPath=trustDefault,at=now(),feature='execution'}={}){
  assert(typeof token==='string'&&token.length<16384,'invalid token length');
  const parts=token.trim().split('.');
  assert(parts.length===3&&parts[0]==='FC1'&&parts.slice(1).every(x=>/^[A-Za-z0-9_-]+$/.test(x)),'malformed token');
  let payload;
  try{const json=Buffer.from(parts[1],'base64url').toString('utf8');assert(b64(json)===parts[1],'noncanonical payload');payload=JSON.parse(json);
    assert(JSON.stringify(payload)===json,'noncanonical claim ordering');}
  catch{throw new Error('Activation rejected: malformed claims')}
  const trust=JSON.parse(readFileSync(trustPath,'utf8'));
  assert(trust.schema===1&&Array.isArray(trust.issuers)&&trust.issuers.length<=16,'invalid trust store');
  const issuer=trust.issuers.find(x=>x.kid===payload.kid);
  assert(issuer&&typeof issuer.publicKey==='string'&&issuer.publicKey.includes('BEGIN PUBLIC KEY')&&issuerId(issuer.publicKey)===issuer.kid,'unknown issuer');
  assert(verify(null,Buffer.from('FC1.'+parts[1]),createPublicKey(issuer.publicKey),Buffer.from(parts[2],'base64url')),'invalid signature');
  assert(payload.schema===1&&typeof payload.customer==='string'&&/^[A-Za-z0-9._@-]{1,128}$/.test(payload.customer),'invalid customer');
  assert(['paid','authorized'].includes(payload.grant)&&Array.isArray(payload.features)&&payload.features.includes(feature),'feature not licensed');
  assert(Number.isSafeInteger(payload.issuedAt)&&Number.isSafeInteger(payload.notBefore)&&Number.isSafeInteger(payload.expiresAt)&&payload.expiresAt>payload.issuedAt,'invalid validity');
  assert(Number.isSafeInteger(at)&&at>=payload.notBefore&&at<payload.expiresAt,'not active or expired');
  assert(typeof installation==='string'&&payload.installation===installation,'installation mismatch');
  return {active:true,grant:payload.grant,customer:payload.customer,expiresAt:new Date(payload.expiresAt*1000).toISOString(),licenseId:payload.id,features:payload.features};
}
export function activate(token,{root=stateDir(),trustPath=trustDefault}={}){
  const result=verifyToken(token,{installation:installationId(root),trustPath});
  secureWrite(root,'activation.key',token.trim()+'\n');return result;
}
export function licenseStatus({root=stateDir(),trustPath=trustDefault}={}){
  const token=secureRead(pathFor(root,'activation.key'));
  if(!token)return {active:false,reason:'NOT_ACTIVATED'};
  try{return verifyToken(token,{installation:installationId(root),trustPath})}
  catch(e){return {active:false,reason:e instanceof Error?e.message:'INVALID_ACTIVATION'}}
}
export function requireLicense(opts={}){
  const status=licenseStatus(opts);
  if(!status.active)throw new Error('Activation required: '+status.reason);
  return status;
}
