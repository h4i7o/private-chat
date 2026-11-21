// パスワードは PBKDF2-SHA256(Workers の上限 100,000 回)。セッションはランダムトークンで、DB にはそのハッシュだけを持つ。

const enc = new TextEncoder();
export const ITERATIONS = 100_000;
export const SESSION_MS = 7 * 24 * 3600 * 1000; // ログインは1週間保存

export const toHex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b instanceof Uint8Array ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b)]
    .map((x) => x.toString(16).padStart(2, '0')).join('');

export const randomHex = (bytes = 16) => toHex(crypto.getRandomValues(new Uint8Array(bytes)));

export async function hashPassword(password: string, salt: string, iterations = ITERATIONS): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations },
    key,
    256,
  );
  return toHex(bits);
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export function validName(n: unknown): n is string {
  return typeof n === 'string' && /^[A-Za-z0-9_.\-]{3,32}$/.test(n);
}
export function validPassword(p: unknown): p is string {
  return typeof p === 'string' && p.length >= 8 && p.length <= 200;
}
