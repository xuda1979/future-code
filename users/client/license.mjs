import { createHash, verify, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, chmodSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { LICENSE_ORIGIN, LICENSE_PUBLIC_KEY } from './config.mjs';

export function verifyToken(token, publicKey, device, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4096 || !publicKey) throw new Error('Invalid license receipt.');
  const pieces = token.split('.');
  if (pieces.length !== 2 || !pieces.every(x => /^[A-Za-z0-9_-]+$/.test(x))) throw new Error('Invalid license receipt.');
  const [payload, signature] = pieces;
  if (!verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, 'base64url'))) throw new Error('Invalid license signature.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const seconds = Math.floor(now / 1000);
  if (claims.v !== 1 || claims.product !== 'future-code' || claims.device !== device || !['solo', 'team'].includes(claims.plan)
      || typeof claims.sub !== 'string' || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
      || claims.iat > seconds + 60 || claims.exp <= seconds || claims.exp <= claims.iat || claims.exp - claims.iat > 86400) throw new Error('License receipt is expired or does not match this device.');
  return claims;
}
function directory() {
  const root = platform() === 'win32' ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local') : join(homedir(), '.config');
  const path = join(root, 'future-code', 'license');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
function deviceId() {
  const path = join(directory(), 'device');
  if (!existsSync(path)) { try { writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
  return createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex');
}
function readState() { try { return JSON.parse(readFileSync(join(directory(), 'receipt.json'), 'utf8')); } catch { return {}; } }
function saveState(state) {
  const path = join(directory(), 'receipt.json');
  const temp = path + '.' + randomBytes(8).toString('hex');
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
  if (platform() !== 'win32') chmodSync(path, 0o600);
}
async function post(path, data) {
  if (!LICENSE_ORIGIN.startsWith('https://')) throw new Error('Invalid licensing service configuration.');
  const response = await fetch(LICENSE_ORIGIN + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(15000), redirect: 'error' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'License service unavailable.');
  return result;
}
async function readKey() {
  if (!process.stdin.isTTY) {
    let value = '';
    for await (const chunk of process.stdin) { value += chunk; if (value.length > 128) throw new Error('Invalid license key.'); }
    return value.trim();
  }
  process.stderr.write('License key (hidden): ');
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    function done(error) { process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); error ? reject(error) : resolve(value.trim()); }
    function onData(chunk) {
      for (const ch of chunk.toString()) {
        if (ch === '\u0003') return done(new Error('Activation cancelled.'));
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (value.length < 128) value += ch;
      }
    }
    process.stdin.on('data', onData);
  });
}
export async function licenseCommand(args) {
  if (args[0] !== 'license') return false;
  const action = args[1]; const device = deviceId();
  if (action === 'activate') {
    const key = await readKey();
    if (!/^FC1-[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Invalid license key. Paste the complete key from your purchase email.');
    const { token } = await post('/api/license/activate', { key, device });
    const claims = verifyToken(token, LICENSE_PUBLIC_KEY, device);
    saveState({ key, token });
    console.log('Activated Future Code ' + claims.plan + '. Receipt valid until ' + new Date(claims.exp * 1000).toISOString());
  } else if (action === 'deactivate') {
    const state = readState();
    if (state.key) await post('/api/license/deactivate', { key: state.key, device });
    const path = join(directory(), 'receipt.json'); if (existsSync(path)) unlinkSync(path);
    console.log('This device has been deactivated.');
  } else if (action === 'status') {
    try { const c = verifyToken(readState().token, LICENSE_PUBLIC_KEY, device); console.log(JSON.stringify({ active: true, plan: c.plan, receiptExpires: new Date(c.exp * 1000).toISOString() })); }
    catch { console.log(JSON.stringify({ active: false, activate: 'future-code license activate' })); }
  } else throw new Error('Usage: future-code license activate|status|deactivate');
  return true;
}
export async function requireLicense() {
  const state = readState(); const device = deviceId();
  if (!state.key) throw new Error('Activate with: future-code license activate');
  let claims;
  try { claims = verifyToken(state.token, LICENSE_PUBLIC_KEY, device); } catch { /* refresh below */ }
  if (!claims || claims.exp * 1000 - Date.now() < 4 * 3600000) {
    try {
      const { token } = await post('/api/license/activate', { key: state.key, device });
      claims = verifyToken(token, LICENSE_PUBLIC_KEY, device); saveState({ key: state.key, token });
    } catch (error) { if (!claims) throw error; }
  }
  return claims;
}
