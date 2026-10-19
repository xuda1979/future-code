const te = new TextEncoder();
export const bytes = value => te.encode(value);
export const b64 = value => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export const unb64 = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
export const digest = async value => b64(await crypto.subtle.digest('SHA-256', bytes(value)));
export const randomKey = () => 'FC1-' + b64(crypto.getRandomValues(new Uint8Array(32)));
export async function seal(value, secret) {
  const key = await crypto.subtle.importKey('raw', unb64(secret), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return b64(iv) + '.' + b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes(value)));
}
export async function open(value, secret) {
  const [iv, data] = value.split('.');
  const key = await crypto.subtle.importKey('raw', unb64(secret), 'AES-GCM', false, ['decrypt']);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(data)));
}
export async function signClaims(claims, privateKey) {
  const raw = privateKey.replace(/-----[^-]+-----|\s/g, '');
  const key = await crypto.subtle.importKey('pkcs8', unb64(raw), 'Ed25519', false, ['sign']);
  const payload = b64(bytes(JSON.stringify(claims)));
  return payload + '.' + b64(await crypto.subtle.sign('Ed25519', key, bytes(payload)));
}
export async function verifyStripe(raw, header, secret, now = Date.now()) {
  if (!header || !secret) return false;
  const fields = header.split(',').map(x => x.split('='));
  const stamp = fields.find(x => x[0] === 't')?.[1];
  if (!/^\d+$/.test(stamp || '') || Math.abs(now / 1000 - Number(stamp)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', bytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  for (const [name, value] of fields) {
    if (name !== 'v1' || !/^[a-f\d]{64}$/i.test(value)) continue;
    const sig = Uint8Array.from(value.match(/../g), x => parseInt(x, 16));
    if (await crypto.subtle.verify('HMAC', key, sig, bytes(stamp + '.' + raw))) return true;
  }
  return false;
}
