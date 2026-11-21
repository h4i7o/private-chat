// パスキー(WebAuthn)の検証。ライブラリを使わず、Workers の WebCrypto だけで行う。
// 登録時は attestation を求めず(none)、ブラウザが返す公開鍵(SPKI)をそのまま保存する。
// ログイン時の署名検証が本体。

export const b64u = {
  enc(buf: ArrayBuffer | Uint8Array): string {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(s: string): Uint8Array {
    const t = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const bin = atob(t);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

const te = new TextEncoder();
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const sha256 = async (d: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', d));

export interface AuthData { rpIdHash: Uint8Array; flags: number; counter: number; credId?: Uint8Array }

export function parseAuthData(d: Uint8Array): AuthData | null {
  if (d.length < 37) return null;
  const flags = d[32];
  const counter = ((d[33] << 24) | (d[34] << 16) | (d[35] << 8) | d[36]) >>> 0;
  const out: AuthData = { rpIdHash: d.slice(0, 32), flags, counter };
  if (flags & 0x40) {
    if (d.length < 55) return null;
    const len = (d[53] << 8) | d[54];
    if (d.length < 55 + len) return null;
    out.credId = d.slice(55, 55 + len);
  }
  return out;
}

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;

/** clientDataJSON を検証して、チャレンジを返す。 */
export function checkClientData(raw: Uint8Array, type: 'webauthn.create' | 'webauthn.get', origin: string): string | null {
  let cd: any;
  try { cd = JSON.parse(new TextDecoder().decode(raw)); } catch { return null; }
  if (cd.type !== type || cd.origin !== origin || cd.crossOrigin === true || typeof cd.challenge !== 'string') return null;
  return cd.challenge;
}

export async function rpIdMatches(authData: AuthData, rpId: string): Promise<boolean> {
  return eq(authData.rpIdHash, await sha256(te.encode(rpId)));
}

// ECDSA の署名は DER で届く。WebCrypto は r||s(各32バイト)を求める。
function derToRaw(sig: Uint8Array, size = 32): Uint8Array | null {
  if (sig[0] !== 0x30) return null;
  let i = 2;
  if (sig[1] & 0x80) i = 2 + (sig[1] & 0x7f);
  const read = () => {
    if (sig[i] !== 0x02) return null;
    const len = sig[i + 1];
    let v = sig.slice(i + 2, i + 2 + len);
    i += 2 + len;
    while (v.length > size && v[0] === 0) v = v.slice(1);
    if (v.length > size) return null;
    const o = new Uint8Array(size);
    o.set(v, size - v.length);
    return o;
  };
  const r = read(); const s = read();
  if (!r || !s) return null;
  const out = new Uint8Array(size * 2);
  out.set(r, 0); out.set(s, size);
  return out;
}

export async function importKey(spki: Uint8Array, alg: number): Promise<CryptoKey> {
  if (alg === -7) return crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  if (alg === -257) return crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  throw new Error('unsupported alg');
}

/** ログイン時の署名を検証する。署名対象は authenticatorData || SHA-256(clientDataJSON)。 */
export async function verifyAssertion(spki: Uint8Array, alg: number, authData: Uint8Array, clientDataJSON: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const key = await importKey(spki, alg);
    const hash = await sha256(clientDataJSON);
    const data = new Uint8Array(authData.length + hash.length);
    data.set(authData, 0); data.set(hash, authData.length);
    if (alg === -7) {
      const raw = derToRaw(signature);
      return !!raw && crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, data);
    }
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);
  } catch { return false; }
}
