import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issuerId, issueToken, installationId, licenseStatus, requireLicense, activate, verifyToken } from '../../src/commercial/license.mjs';
import { validateProvider, envName, upsertProvider, listProviders, providerById, saveProviderSecret, providerSecret, sealSecrets, unsealSecrets, bindProfile } from '../../src/commercial/providers.mjs';
import { command } from '../../src/commercial/app.mjs';
const temp=t=>{const p=mkdtempSync(join(tmpdir(),'commercial-test-'));t.after(()=>rmSync(p,{force:true,recursive:true}));return p};
const profile=(id='primary',protocol='chat-completions')=>({id,protocol,url:'https://endpoint.invalid/provider',model:'customer-selected',auth:{scheme:'raw',header:'x-customer-token'},secretMode:'vault'});
function fixture(t){
  const root=temp(t),keys=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},
    privateKeyEncoding:{type:'pkcs8',format:'pem',cipher:'aes-256-cbc',passphrase:'example-vendor-secret'}});
  const trust=join(root,'trust.json'),installation=installationId(root);
  writeFileSync(trust,JSON.stringify({schema:1,issuers:[{kid:issuerId(keys.publicKey),publicKey:keys.publicKey}]}));
  return {root,keys,trust,installation};
}
test('paid and authorized licenses verify offline with an installation binding',t=>{
 const {root,keys,trust,installation}=fixture(t);
 for(const grant of ['paid','authorized']){
  const token=issueToken({privateKey:keys.privateKey,passphrase:'example-vendor-secret',
    publicKey:keys.publicKey,customer:'customer-1',installation,grant,days:30});
  assert.equal(verifyToken(token,{trustPath:trust,installation}).grant,grant);
  assert.equal(activate(token,{trustPath:trust,root}).grant,grant);
  assert.equal(requireLicense({trustPath:trust,root}).grant,grant);
  assert.equal(statSync(join(root,'activation.key')).mode&0o077,0);
  assert.throws(()=>verifyToken(token,{trustPath:trust,installation:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'}),/installation mismatch/);
  assert.throws(()=>verifyToken(token,{trustPath:trust,installation,at:Math.floor(Date.now()/1000)+40*86400}),/expired/);
  const p=token.split('.');p[2]=(p[2][0]==='x'?'y':'x')+p[2].slice(1);
  assert.throws(()=>verifyToken(p.join('.'),{trustPath:trust,installation}),/signature/);
 }
});
test('no trusted issuer means signed keys fail closed and unactivated execution is blocked',t=>{
 const {root,keys,installation}=fixture(t);
 const token=issueToken({privateKey:keys.privateKey,passphrase:'example-vendor-secret',
  publicKey:keys.publicKey,customer:'customer-2',installation,days:2});
 assert.throws(()=>verifyToken(token,{installation}),/unknown issuer/);
 assert.deepEqual(licenseStatus({root}),{active:false,reason:'NOT_ACTIVATED'});
 assert.throws(()=>requireLicense({root}),/Activation required/);
});
test('vault ciphertext does not contain credentials, decrypts only with password, rejects tampering',t=>{
 const root=temp(t),pass='long-password-example';
 saveProviderSecret('primary','secret-value-should-not-leak',pass,root);
 const bytes=readFileSync(join(root,'secrets.enc.json'),'utf8');
 assert.equal(bytes.includes('secret-value-should-not-leak'),false);
 assert.equal(statSync(join(root,'secrets.enc.json')).mode&0o077,0);
 assert.equal(providerSecret('primary',pass,root),'secret-value-should-not-leak');
 assert.throws(()=>providerSecret('primary','incorrect-password',root),/Unable to unlock/);
 const envelope=sealSecrets({primary:'secret'},pass);envelope.tag='AAAAAAAAAAAAAAAAAAAAAA';
 assert.throws(()=>unsealSecrets(envelope,pass),/Unable to unlock/);
});
test('all built-in wire protocols can be configured without storing secrets',t=>{
 const root=temp(t);
 for(const protocol of ['anthropic','chat-completions','responses','gemini']){
  const p=profile(protocol.replace(/-/g,''),protocol);
  upsertProvider(p,root);
  assert.equal(providerById(p.id,root).protocol,protocol);
 }
 assert.equal(listProviders(root).length,4);
 const saved=readFileSync(join(root,'providers.json'),'utf8');
 assert.equal(saved.includes('secret-value-should-not-leak'),false);
 assert.equal(statSync(join(root,'providers.json')).mode&0o077,0);
 assert.notEqual(envName('a_b'),envName('a-b'));
 assert.equal(bindProfile(profile(),{system:'system',tools:['read_file'],checks:['check']}).auth.header,'x-customer-token');
});
test('reject unsafe URLs, embedded credentials, unknown auth fields and forbidden headers',()=>{
 const p=profile();
 for(const url of ['http://example.invalid','https://me:pass@example.invalid','https://example.invalid/?secret=test','https://example.invalid/#secret'])
  assert.throws(()=>validateProvider({...p,url}),/forbidden|HTTPS/);
 assert.throws(()=>validateProvider({...p,apiKey:'dont'}),/field/);
 assert.throws(()=>validateProvider({...p,auth:{scheme:'raw',header:'cookie'}}),/header/);
 assert.equal(validateProvider({...p,url:'http://127.0.0.1:10000/local'}).protocol,'chat-completions');
});
test('commercial commands expose safe metadata, installation request and reject execution without activation',async t=>{
 const root=temp(t);
 const response=await command(['license','request','--state-dir',root]);assert.match(response.installation,/^[a-f0-9-]{36}$/);
 assert.deepEqual(await command(['provider','list','--state-dir',root]),[]);
 const x=await command(['license','status','--state-dir',root]);assert.equal(x.active,false);
 await assert.rejects(command(['run','--state-dir',root,'--tasks','missing.json','--profile','a','--allow-exec']),/Activation required/);
 assert.match(await command(['help']),/Future-Code Commercial/);
});
