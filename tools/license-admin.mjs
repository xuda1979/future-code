#!/usr/bin/env node
/** Seller-only issuance utility. The signing private key is NEVER committed. */
import { generateKeyPairSync, createPublicKey, createPrivateKey } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { issuerId, issueToken } from '../src/commercial/license.mjs';
import { hidden } from '../src/commercial/app.mjs';
const usage='Usage: license-admin init --private FILE --trust FILE | issue --private FILE --customer ID --installation UUID --grant paid|authorized --days N --out FILE';
function flags(argv){const m=new Map;for(let i=0;i<argv.length;i++){const k=argv[i],v=argv[++i];if(!['--private','--trust','--customer','--installation','--grant','--days','--out'].includes(k)||m.has(k)||!v||v.startsWith('--'))throw Error('Invalid option '+k);m.set(k,v)}return m}
function get(m,k){const v=m.get(k);if(!v)throw Error('Missing '+k);return v}
export async function seller(argv){
  const cmd=argv[0]??'help';if(cmd==='help')return usage;
  const a=flags(argv.slice(1));
  if(cmd==='init'){
    const privatePath=get(a,'--private'),trustPath=get(a,'--trust');
    if(existsSync(privatePath)||existsSync(trustPath))throw Error('Refusing to overwrite issuer materials');
    const password=await hidden('New offline issuer passphrase (at least 12 characters)');
    if(password.length<12)throw Error('Passphrase too short');
    const k=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},
      privateKeyEncoding:{type:'pkcs8',format:'pem',cipher:'aes-256-cbc',passphrase:password}});
    writeFileSync(privatePath,k.privateKey,{mode:0o600,flag:'wx'});
    writeFileSync(trustPath,JSON.stringify({schema:1,issuers:[{kid:issuerId(k.publicKey),publicKey:k.publicKey}]},null,2)+'\n',{mode:0o644,flag:'wx'});
    return {issuerId:issuerId(k.publicKey),privateKeySaved:privatePath,publicTrustSaved:trustPath,
      next:'Keep the encrypted private key offline. Commit and release only the reviewed public trust file.'};
  }
  if(cmd==='issue'){
    const path=get(a,'--private'),st=lstatSync(path);
    if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0)throw Error('Issuer key must be an encrypted 0600 private file');
    const privateKey=readFileSync(path,'utf8'),passphrase=await hidden('Issuer signing passphrase');
    const publicKey=createPublicKey(createPrivateKey({key:privateKey,passphrase})).export({type:'spki',format:'pem'});
    const token=issueToken({privateKey,passphrase,publicKey,customer:get(a,'--customer'),
      installation:get(a,'--installation'),grant:get(a,'--grant'),days:Number(get(a,'--days'))});
    const dest=get(a,'--out');writeFileSync(dest,token+'\n',{mode:0o600,flag:'wx'});
    return {activationFile:dest,grant:get(a,'--grant'),customer:get(a,'--customer'),notice:'Transmit privately to customer; do not put token or issuer secret in source control.'};
  }
  throw Error(usage);
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  seller(process.argv.slice(2)).then(x=>console.log(typeof x==='string'?x:JSON.stringify(x,null,2)),e=>{console.error(String(e.message??e));process.exitCode=1});
