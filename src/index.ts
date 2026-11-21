import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv, Env, User } from './types';
import {
  ITERATIONS, SESSION_MS, hashPassword, randomHex, safeEqual, sha256Hex, validName, validPassword,
} from './auth';
import {
  EFFORTS, MODELS, MODEL_KEYS, NANO, PRESETS, SEARCH_MAX_LIMIT, costOf, isModelKey, makeQuote,
  type Effort, type ModelKey, type Quote, type Usage,
} from './pricing';
import { patchConfig, readConfig, searchMaxOf, effortOf } from './config';
import { b64u, checkClientData, importKey, parseAuthData, rpIdMatches, verifyAssertion, FLAG_UP, FLAG_UV } from './webauthn';
import { readLedger, readMaxTokens, reserve, settleStatements } from './ledger';
import { UpstreamError, countTokens, openStream, sseEvents, toBase64 } from './anthropic';

const app = new Hono<AppEnv>();
const enc = new TextEncoder();

const SYSTEM_PROMPT =
  'あなたは簡潔で正確なアシスタントです。ユーザーの言語で答えてください。' +
  'HTMLやUIの作成を頼まれたら、外部ファイルに依存しない完結した1つのHTMLを ```html のコードブロックで出力してください。';

// メモリ(ユーザーが画面で書いたメモ)をシステムプロンプトに足す。送信ごとのスイッチで切り替えられる。
const MEM_MAX_ITEMS = 50, MEM_MAX_CHARS = 300, MEM_MAX_TOTAL = 6000;
async function systemFor(env: Env, userId: string, memoryOn: boolean): Promise<string> {
  if (!memoryOn) return SYSTEM_PROMPT;
  const r = await env.DB.prepare('SELECT text FROM memories WHERE user_id = ? ORDER BY created_at').bind(userId).all<{ text: string }>();
  if (!r.results.length) return SYSTEM_PROMPT;
  return SYSTEM_PROMPT + '\n\n# ユーザーについて覚えていること\n' + r.results.map((m) => '- ' + m.text.replace(/\s+/g, ' ')).join('\n')
    + '\n(関係があるときだけ自然に使い、ここに書かれていないことは推測しない。)';
}

const COMPACT_MAX_OUT = 4000;
const COMPACT_PROMPT =
  'ここまでの会話を、新しい会話の冒頭に置いて続きを再開できるよう、要点だけに圧縮して要約してください。' +
  '含めるもの: 目的、決まったこと、未解決の点、重要な事実や数値、ユーザーの好みや条件。' +
  '作業中のコードやHTMLがあれば、続きの作業に必要な最新版を省略せず含めてください(長すぎる場合は構造と主要部分)。' +
  '前置きや挨拶は不要です。ユーザーの言語で、箇条書き中心で書いてください。';

const LIMITS = { image: 8 * 1024 * 1024, pdf: 12 * 1024 * 1024, text: 1024 * 1024 } as const;
const MAX_REQUEST_BYTES = 24 * 1024 * 1024;
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MIN_OUT_TOKENS = 256;

const cap = (env: Env) => Math.round(Number(env.CAP_USD || '25') * NANO);
const err = (c: Context, status: number, code: string, message: string) =>
  c.json({ error: code, message }, status as 400);

/* ------------------------------------------------------------------ 共通ミドルウェア */

// 画面側の更新だけで動くよう、新しい表(メモリ)は無ければ初回アクセス時に作る。migrations/0003 と同じ内容で、何度走っても害はない。
let schemaReady: Promise<void> | null = null;
app.use('/api/*', async (c, next) => {
  if (!schemaReady) {
    schemaReady = c.env.DB.batch([
      c.env.DB.prepare('CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL)'),
      c.env.DB.prepare('CREATE INDEX IF NOT EXISTS memories_user ON memories (user_id, created_at)'),
    ]).then(() => undefined).catch((e) => { schemaReady = null; throw e; });
  }
  await schemaReady;
  await next();
});
app.use('/api/*', async (c, next) => {
  const m = c.req.method;
  if (m !== 'GET' && m !== 'HEAD') {
    const origin = c.req.header('origin');
    const host = new URL(c.req.url).host;
    if ((origin && new URL(origin).host !== host) || !c.req.header('x-pc')) return err(c, 403, 'forbidden', '不正なリクエストです');
  }
  await next();
  c.header('cache-control', 'no-store');
  c.header('x-content-type-options', 'nosniff');
});

async function authenticate(c: Context<AppEnv>): Promise<User | null> {
  const token = getCookie(c, 'sid');
  if (!token) return null;
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).bind(await sha256Hex(token), Date.now()).first<User>();
  return row ?? null;
}

const needAuth = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  const u = await authenticate(c);
  if (!u) return err(c, 401, 'unauthorized', 'ログインが必要です');
  c.set('user', u);
  await next();
};
const needOwner = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  if (c.get('user').role !== 'owner') return err(c, 403, 'owner_only', '最高権限者のみ操作できます');
  await next();
};

async function startSession(c: Context<AppEnv>, userId: string) {
  const token = randomHex(32);
  const now = Date.now();
  await c.env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .bind(await sha256Hex(token), userId, now, now + SESSION_MS).run();
  setCookie(c, 'sid', token, {
    httpOnly: true, sameSite: 'Strict', path: '/', maxAge: SESSION_MS / 1000,
    secure: new URL(c.req.url).protocol === 'https:',
  });
}

/* ------------------------------------------------------------------ 認証・ユーザー */

app.get('/api/session', async (c) => {
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  const u = await authenticate(c);
  return c.json({ setup: (n?.n ?? 0) === 0, user: u ? { name: u.name, role: u.role } : null });
});

app.post('/api/setup', async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b || !validName(b.name) || !validPassword(b.password)) return err(c, 400, 'invalid', 'ユーザー名は3〜32文字の英数字、パスワードは8文字以上です');
  const id = randomHex(8);
  const salt = randomHex(16);
  const hash = await hashPassword(b.password, salt);
  // 最初の1人だけ作れる。同時に2回叩かれても INSERT ... WHERE NOT EXISTS で1件に絞る。
  const r = await c.env.DB.prepare(
    `INSERT INTO users (id, name, role, salt, hash, iterations, created_at)
     SELECT ?1, ?2, 'owner', ?3, ?4, ?5, ?6 WHERE NOT EXISTS (SELECT 1 FROM users)`,
  ).bind(id, b.name, salt, hash, ITERATIONS, Date.now()).run();
  if (r.meta.changes !== 1) return err(c, 409, 'already_setup', '設定済みです');
  await startSession(c, id);
  return c.json({ user: { name: b.name, role: 'owner' } });
});

app.post('/api/login', async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b.name !== 'string' || typeof b.password !== 'string') return err(c, 400, 'invalid', '入力してください');
  const ip = c.req.header('cf-connecting-ip') || 'local';
  const key = `${b.name.toLowerCase()}|${ip}`;
  const now = Date.now();
  const WINDOW = 15 * 60 * 1000;
  const att = await c.env.DB.prepare('SELECT failures, window_start FROM login_attempts WHERE key = ?').bind(key).first<{ failures: number; window_start: number }>();
  if (att && now - att.window_start < WINDOW && att.failures >= 5) return err(c, 429, 'rate_limited', '試行が多すぎます。15分後に再試行してください');

  const u = await c.env.DB.prepare('SELECT id, name, role, salt, hash, iterations FROM users WHERE name = ?').bind(b.name).first<User & { salt: string; hash: string; iterations: number }>();
  // ユーザーが存在しなくても同じ計算量を使い、時間差で存在を推測されないようにする
  const h = await hashPassword(b.password, u?.salt ?? 'x'.repeat(32), u?.iterations ?? ITERATIONS);
  if (!u || !safeEqual(h, u.hash)) {
    const fresh = !att || now - att.window_start >= WINDOW;
    await c.env.DB.prepare(
      `INSERT INTO login_attempts (key, failures, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET failures = ?3, window_start = ?4`,
    ).bind(key, now, fresh ? 1 : (att!.failures + 1), fresh ? now : att!.window_start).run();
    return err(c, 401, 'bad_credentials', 'ユーザー名かパスワードが違います');
  }
  await c.env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
  await startSession(c, u.id);
  return c.json({ user: { name: u.name, role: u.role } });
});

/* ------------------------------------------------------------------ パスキー(ログイン) */

const rpOf = (c: Context) => { const u = new URL(c.req.url); return { rpId: u.hostname, origin: u.origin }; };

async function newChallenge(env: Env, purpose: 'login' | 'register', userId: string | null): Promise<string> {
  const ch = b64u.enc(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM webauthn_challenges WHERE created_at < ?').bind(now - 5 * 60_000),
    env.DB.prepare('INSERT INTO webauthn_challenges (challenge, purpose, user_id, created_at) VALUES (?,?,?,?)').bind(ch, purpose, userId, now),
  ]);
  return ch;
}
// 使い捨て: 取り出すと同時に消す
async function takeChallenge(env: Env, ch: string, purpose: 'login' | 'register'): Promise<{ user_id: string | null } | null> {
  return env.DB.prepare('DELETE FROM webauthn_challenges WHERE challenge = ? AND purpose = ? AND created_at > ? RETURNING user_id').bind(ch, purpose, Date.now() - 5 * 60_000).first<{ user_id: string | null }>();
}

app.post('/api/passkey/login/options', async (c) => {
  const { rpId } = rpOf(c);
  return c.json({ challenge: await newChallenge(c.env, 'login', null), rpId, timeout: 60_000 });
});

app.post('/api/passkey/login/verify', async (c) => {
  const fail = () => err(c, 401, 'passkey_failed', 'パスキーを確認できませんでした');
  const b = await c.req.json().catch(() => null);
  if (!b || ['id', 'clientDataJSON', 'authenticatorData', 'signature'].some((k) => typeof b[k] !== 'string')) return fail();
  try {
    const { rpId, origin } = rpOf(c);
    const cdj = b64u.dec(b.clientDataJSON), ad = b64u.dec(b.authenticatorData), sig = b64u.dec(b.signature);
    const challenge = checkClientData(cdj, 'webauthn.get', origin);
    if (!challenge || !(await takeChallenge(c.env, challenge, 'login'))) return fail();
    const cred = await c.env.DB.prepare('SELECT id, user_id, public_key, alg, counter FROM passkeys WHERE id = ?').bind(b.id).first<{ id: string; user_id: string; public_key: string; alg: number; counter: number }>();
    const parsed = parseAuthData(ad);
    if (!cred || !parsed || !(await rpIdMatches(parsed, rpId)) || !(parsed.flags & FLAG_UP) || !(parsed.flags & FLAG_UV)) return fail();
    if (!(await verifyAssertion(b64u.dec(cred.public_key), cred.alg, ad, cdj, sig))) return fail();
    if ((parsed.counter > 0 || cred.counter > 0) && parsed.counter <= cred.counter) return fail(); // 複製の疑い
    const user = await c.env.DB.prepare('SELECT id, name, role FROM users WHERE id = ?').bind(cred.user_id).first<User>();
    if (!user) return fail();
    await c.env.DB.prepare('UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?').bind(parsed.counter, Date.now(), cred.id).run();
    await startSession(c, user.id);
    return c.json({ user: { name: user.name, role: user.role } });
  } catch { return fail(); }
});

app.post('/api/logout', async (c) => {
  const t = getCookie(c, 'sid');
  if (t) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(t)).run();
  deleteCookie(c, 'sid', { path: '/' });
  return c.json({ ok: true });
});

const api = new Hono<AppEnv>();
api.use('*', needAuth);

/* ------------------------------------------------------------------ パスキー(登録・一覧・削除) */

api.get('/passkeys', async (c) => {
  const r = await c.env.DB.prepare('SELECT id, name, created_at AS created, last_used AS lastUsed FROM passkeys WHERE user_id = ? ORDER BY created_at').bind(c.get('user').id).all();
  return c.json({ passkeys: r.results });
});

api.post('/passkeys/options', async (c) => {
  const u = c.get('user');
  const { rpId } = rpOf(c);
  const have = await c.env.DB.prepare('SELECT id FROM passkeys WHERE user_id = ?').bind(u.id).all<{ id: string }>();
  if (have.results.length >= 10) return err(c, 400, 'too_many', 'パスキーは10個までです');
  return c.json({
    challenge: await newChallenge(c.env, 'register', u.id),
    rp: { name: 'Private Chat', id: rpId },
    user: { id: b64u.enc(new TextEncoder().encode(u.id)), name: u.name, displayName: u.name },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    attestation: 'none',
    excludeCredentials: have.results.map((x) => ({ type: 'public-key', id: x.id })),
    timeout: 60_000,
  });
});

api.post('/passkeys', async (c) => {
  const u = c.get('user');
  const fail = (m = 'パスキーを登録できませんでした') => err(c, 400, 'passkey_failed', m);
  const b = await c.req.json().catch(() => null);
  if (!b || ['id', 'clientDataJSON', 'authenticatorData', 'publicKey'].some((k) => typeof b[k] !== 'string') || ![-7, -257].includes(b.alg)) return fail();
  try {
    const { rpId, origin } = rpOf(c);
    const cdj = b64u.dec(b.clientDataJSON), ad = b64u.dec(b.authenticatorData), spki = b64u.dec(b.publicKey);
    const challenge = checkClientData(cdj, 'webauthn.create', origin);
    const took = challenge ? await takeChallenge(c.env, challenge, 'register') : null;
    if (!took || took.user_id !== u.id) return fail();
    const parsed = parseAuthData(ad);
    if (!parsed || !parsed.credId || !(await rpIdMatches(parsed, rpId)) || !(parsed.flags & FLAG_UP) || !(parsed.flags & FLAG_UV)) return fail();
    if (b64u.enc(parsed.credId) !== b.id) return fail();
    await importKey(spki, b.alg); // 鍵として読めるか確認
    const name = (typeof b.name === 'string' && b.name.trim() ? b.name.trim() : 'パスキー').slice(0, 40);
    const transports = Array.isArray(b.transports) ? JSON.stringify(b.transports.filter((t: unknown) => typeof t === 'string').slice(0, 6)) : null;
    const r = await c.env.DB.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, alg, counter, transports, name, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE (SELECT COUNT(*) FROM passkeys WHERE user_id = ?2) < 10 AND NOT EXISTS (SELECT 1 FROM passkeys WHERE id = ?1)`,
    ).bind(b.id, u.id, b.publicKey, b.alg, parsed.counter, transports, name, Date.now()).run();
    if (r.meta.changes !== 1) return fail('このパスキーは登録済みか、上限に達しています');
    return c.json({ ok: true });
  } catch { return fail(); }
});

api.delete('/passkeys/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('user').id).run();
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ メモリ・添付の配信 */

const cleanMem = (t: unknown) => (typeof t === 'string' ? t.replace(/\s+/g, ' ').trim().slice(0, MEM_MAX_CHARS) : '');

api.get('/memories', async (c) => {
  const r = await c.env.DB.prepare('SELECT id, text, created_at AS created FROM memories WHERE user_id = ? ORDER BY created_at').bind(c.get('user').id).all();
  return c.json({ memories: r.results, max: MEM_MAX_ITEMS, maxChars: MEM_MAX_CHARS });
});
api.post('/memories', async (c) => {
  const u = c.get('user');
  const b = await c.req.json().catch(() => null);
  const text = cleanMem(b?.text);
  if (!text) return err(c, 400, 'invalid', '内容を入力してください');
  const st = await c.env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(text)), 0) AS t FROM memories WHERE user_id = ?').bind(u.id).first<{ n: number; t: number }>();
  if ((st?.n ?? 0) >= MEM_MAX_ITEMS || (st?.t ?? 0) + text.length > MEM_MAX_TOTAL) return err(c, 400, 'too_many', 'メモリがいっぱいです。古いものを消してください');
  const id = randomHex(8);
  await c.env.DB.prepare('INSERT INTO memories (id, user_id, text, created_at) VALUES (?,?,?,?)').bind(id, u.id, text, Date.now()).run();
  return c.json({ memory: { id, text } });
});
api.patch('/memories/:id', async (c) => {
  const b = await c.req.json().catch(() => null);
  const text = cleanMem(b?.text);
  if (!text) return err(c, 400, 'invalid', '内容を入力してください');
  const r = await c.env.DB.prepare('UPDATE memories SET text = ? WHERE id = ? AND user_id = ?').bind(text, c.req.param('id'), c.get('user').id).run();
  if (r.meta.changes !== 1) return err(c, 404, 'not_found', '見つかりません');
  return c.json({ ok: true });
});
api.delete('/memories/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('user').id).run();
  return c.json({ ok: true });
});

// 添付の中身(ファイルカードの「開く」)。自分がアップロードしたものだけ。能動的な中身が動かないよう sandbox を付けて返す。
api.get('/attachments/:id', async (c) => {
  const u = c.get('user');
  const a = await c.env.DB.prepare('SELECT name, mime, r2_key FROM attachments WHERE id = ?').bind(c.req.param('id')).first<{ name: string; mime: string; r2_key: string }>();
  if (!a || !a.r2_key.startsWith(`u/${u.id}/`)) return err(c, 404, 'not_found', '見つかりません');
  const o = await c.env.FILES.get(a.r2_key);
  if (!o) return err(c, 404, 'not_found', '見つかりません');
  const inline = a.mime === 'application/pdf' || a.mime.startsWith('image/') || a.mime === 'text/plain';
  return new Response(o.body, { headers: {
    'content-type': a.mime === 'text/plain' ? 'text/plain; charset=utf-8' : a.mime,
    'content-disposition': `${inline && c.req.query('dl') !== '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=300',
  } });
});

api.post('/password', async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b || !validPassword(b.next) || typeof b.current !== 'string') return err(c, 400, 'invalid', 'パスワードは8文字以上です');
  const u = c.get('user');
  const row = await c.env.DB.prepare('SELECT salt, hash, iterations FROM users WHERE id = ?').bind(u.id).first<{ salt: string; hash: string; iterations: number }>();
  if (!row || !safeEqual(await hashPassword(b.current, row.salt, row.iterations), row.hash)) return err(c, 400, 'bad_credentials', '現在のパスワードが違います');
  const salt = randomHex(16);
  const token = getCookie(c, 'sid')!;
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET salt = ?, hash = ?, iterations = ? WHERE id = ?').bind(salt, await hashPassword(b.next, salt), ITERATIONS, u.id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(u.id, await sha256Hex(token)),
  ]);
  return c.json({ ok: true });
});

api.get('/users', needOwner, async (c) => {
  const r = await c.env.DB.prepare('SELECT name, role FROM users ORDER BY created_at').all();
  return c.json({ users: r.results });
});
api.post('/users', needOwner, async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b || !validName(b.name) || !validPassword(b.password)) return err(c, 400, 'invalid', 'ユーザー名は3〜32文字の英数字、パスワードは8文字以上です');
  const salt = randomHex(16);
  const r = await c.env.DB.prepare(
    `INSERT INTO users (id, name, role, salt, hash, iterations, created_at)
     SELECT ?1, ?2, 'user', ?3, ?4, ?5, ?6
     WHERE (SELECT COUNT(*) FROM users) < 2 AND NOT EXISTS (SELECT 1 FROM users WHERE name = ?2)`,
  ).bind(randomHex(8), b.name, salt, await hashPassword(b.password, salt), ITERATIONS, Date.now()).run().catch(() => null);
  if (!r || r.meta.changes !== 1) return err(c, 409, 'cannot_add', 'ユーザーは2人までで、名前は重複できません');
  return c.json({ ok: true });
});
api.delete('/users/:name', needOwner, async (c) => {
  const u = await c.env.DB.prepare("SELECT id FROM users WHERE name = ? AND role = 'user'").bind(c.req.param('name')).first<{ id: string }>();
  if (!u) return err(c, 404, 'not_found', '見つかりません');
  const files = await c.env.DB.prepare('SELECT r2_key FROM attachments WHERE user_id = ?').bind(u.id).all<{ r2_key: string }>();
  if (files.results.length) await c.env.FILES.delete(files.results.map((f) => f.r2_key));
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(u.id).run(); // sessions, chats, messages, attachments は CASCADE
  return c.json({ ok: true });
});
api.post('/users/:name/password', needOwner, async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b || !validPassword(b.password)) return err(c, 400, 'invalid', 'パスワードは8文字以上です');
  const u = await c.env.DB.prepare("SELECT id FROM users WHERE name = ? AND role = 'user'").bind(c.req.param('name')).first<{ id: string }>();
  if (!u) return err(c, 404, 'not_found', '見つかりません');
  const salt = randomHex(16);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET salt = ?, hash = ?, iterations = ? WHERE id = ?').bind(salt, await hashPassword(b.password, salt), ITERATIONS, u.id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
  ]);
  return c.json({ ok: true });
});

api.post('/ledger/reset', needOwner, async (c) => {
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE ledger SET spent = 0, resets = resets + 1 WHERE id = 1'),
    c.env.DB.prepare('UPDATE ledger_models SET spent = 0'),
  ]);
  return c.json({ ledger: await readLedger(c.env.DB, Date.now()) });
});
// Console の実額に合わせて使用額を直接設定する(最高権限者のみ)。モデル別の内訳は新しい合計に比例して直す。
api.post('/ledger/set', needOwner, async (c) => {
  const b = await c.req.json().catch(() => null);
  const usd = Number(b?.usd);
  if (!Number.isFinite(usd) || usd < 0) return err(c, 400, 'invalid', '金額を入力してください');
  const nano = Math.round(usd * 1e9);
  if (nano > cap(c.env)) return err(c, 400, 'invalid', '上限を超える金額は入れられません');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE ledger_models SET spent = CAST(ROUND(1.0 * spent * ?1 / (SELECT SUM(spent) FROM ledger_models)) AS INTEGER) WHERE (SELECT SUM(spent) FROM ledger_models) > 0').bind(nano),
    c.env.DB.prepare('UPDATE ledger_models SET spent = 0 WHERE (SELECT SUM(spent) FROM ledger_models) = 0 OR ?1 = 0').bind(nano),
    c.env.DB.prepare('UPDATE ledger SET spent = ? WHERE id = 1').bind(nano),
  ]);
  return c.json({ ledger: await readLedger(c.env.DB, Date.now()) });
});
// Console の実額を取りに行く(管理用キーが設定されているときだけ)。ここでは数字を見せるだけで、台帳は変えない。
// 反映は「この額に合わせる」(/ledger/set)で、最高権限者が確認してから。
api.post('/ledger/sync', needOwner, async (c) => {
  const key = c.env.ANTHROPIC_ADMIN_KEY;
  if (!key) return err(c, 400, 'no_admin_key', '管理用キー(ANTHROPIC_ADMIN_KEY)が設定されていません');
  const b = await c.req.json().catch(() => ({}));
  const now = new Date();
  const since = typeof b?.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.since) ? b.since : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const ws = c.env.ANTHROPIC_WORKSPACE_ID || '';
  let cents = 0;
  let page: string | null = null;
  try {
    for (let i = 0; i < 12; i++) {
      const url = new URL('https://api.anthropic.com/v1/organizations/cost_report');
      url.searchParams.set('starting_at', `${since}T00:00:00Z`);
      url.searchParams.set('limit', '31');
      url.searchParams.append('group_by[]', 'workspace_id');
      if (page) url.searchParams.set('page', page);
      const r = await fetch(url, { headers: { 'x-api-key': key, 'anthropic-version': '2026-10-21' } });
      if (!r.ok) return err(c, 502, 'sync_failed', `Console に問い合わせられません (${r.status})。管理用キーの種類と権限を確認してください`);
      const j = (await r.json()) as { data?: { results?: { amount?: string; workspace_id?: string | null }[] }[]; has_more?: boolean; next_page?: string };
      for (const bk of j.data ?? []) for (const x of bk.results ?? []) if (!ws || x.workspace_id === ws) cents += Number(x.amount ?? 0) || 0;
      if (!j.has_more || !j.next_page) break;
      page = j.next_page;
    }
  } catch (e) { return err(c, 502, 'sync_failed', `Console に問い合わせられません: ${(e as Error).message}`); }
  const led = await readLedger(c.env.DB, Date.now());
  return c.json({ since, workspace: ws || null, consoleNano: Math.round(cents * 1e7), siteNano: led.spent });
});
api.post('/ledger/limiter', needOwner, async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b.override !== 'boolean') return err(c, 400, 'invalid', 'override を指定してください');
  await c.env.DB.prepare('UPDATE ledger SET override = ? WHERE id = 1').bind(b.override ? 1 : 0).run();
  return c.json({ ledger: await readLedger(c.env.DB, Date.now()) });
});
api.put('/settings', needOwner, async (c) => {
  const b = await c.req.json().catch(() => null);
  if (b?.config !== undefined) {
    const next = patchConfig(await readConfig(c.env.DB), b.config);
    if (typeof next === 'string') return err(c, 400, 'invalid', next);
    await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('config', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(JSON.stringify(next)).run();
    if (b.maxTokens === undefined) return c.json({ config: next, searchMaxUses: searchMaxOf(next), maxTokens: await readMaxTokens(c.env.DB) });
  }
  const cur = await readMaxTokens(c.env.DB);
  const next = { ...cur };
  for (const k of MODEL_KEYS) {
    const v = b?.maxTokens?.[k];
    if (v !== undefined) {
      if (!PRESETS.includes(v)) return err(c, 400, 'invalid', `最大出力は ${PRESETS.join(' / ')} から選んでください`);
      next[k] = v;
    }
  }
  await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('maxTokens', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(JSON.stringify(next)).run();
  const cfg = await readConfig(c.env.DB);
  return c.json({ maxTokens: next, config: cfg, searchMaxUses: searchMaxOf(cfg) });
});

/* ------------------------------------------------------------------ 状態 */

api.get('/state', async (c) => {
  const u = c.get('user');
  const [ledger, maxTokens, cfg] = await Promise.all([readLedger(c.env.DB, Date.now()), readMaxTokens(c.env.DB), readConfig(c.env.DB)]);
  return c.json({
    user: { name: u.name, role: u.role },
    capNano: cap(c.env),
    ledger,
    maxTokens,
    models: Object.fromEntries(MODEL_KEYS.map((k) => [k, { name: MODELS[k].name, in: MODELS[k].in, out: MODELS[k].out, recMax: MODELS[k].recMax }])),
    config: cfg,
    efforts: EFFORTS,
    searchMaxUses: searchMaxOf(cfg),
    searchLimit: SEARCH_MAX_LIMIT,
    syncAvailable: u.role === 'owner' && !!c.env.ANTHROPIC_ADMIN_KEY,
    presets: PRESETS,
  });
});

/* ------------------------------------------------------------------ チャット */

api.get('/chats', async (c) => {
  const u = c.get('user');
  const q = (c.req.query('q') ?? '').trim().slice(0, 100);
  if (!q) {
    const r = await c.env.DB.prepare('SELECT id, title, updated_at AS updated, pinned FROM chats WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC LIMIT 200').bind(u.id).all();
    return c.json({ chats: r.results });
  }
  // タイトルか本文に含まれる会話。該当した発言の前後を抜粋で返す。
  const r = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.updated_at AS updated, c.pinned,
       (SELECT substr(m.text, MAX(1, instr(lower(m.text), lower(?2)) - 24), 90) FROM messages m
         WHERE m.chat_id = c.id AND instr(lower(m.text), lower(?2)) > 0 ORDER BY m.seq LIMIT 1) AS snip
     FROM chats c
     WHERE c.user_id = ?1 AND (instr(lower(c.title), lower(?2)) > 0
       OR EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND instr(lower(m.text), lower(?2)) > 0))
     ORDER BY c.pinned DESC, c.updated_at DESC LIMIT 50`,
  ).bind(u.id, q).all();
  return c.json({ chats: r.results });
});

api.get('/chats/:id', async (c) => {
  const chat = await c.env.DB.prepare('SELECT id, title, updated_at AS updated, pinned, last_model AS lastModel, last_ts AS lastTs FROM chats WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('user').id).first();
  if (!chat) return err(c, 404, 'not_found', '見つかりません');
  const [m, a, v] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT id, role, text, model, meta, ts, compacted FROM messages WHERE chat_id = ? ORDER BY seq').bind(c.req.param('id')),
    c.env.DB.prepare('SELECT id, message_id, name, kind, tokens, size FROM attachments WHERE chat_id = ? AND message_id IS NOT NULL').bind(c.req.param('id')),
    c.env.DB.prepare('SELECT msg_id, COUNT(*) AS n FROM ai_versions WHERE msg_id IN (SELECT id FROM messages WHERE chat_id = ?) GROUP BY msg_id').bind(c.req.param('id')),
  ]);
  const atts = new Map<string, unknown[]>();
  for (const x of a.results as { id: string; message_id: string; name: string; kind: string; tokens: number; size: number }[]) {
    if (!atts.has(x.message_id)) atts.set(x.message_id, []);
    atts.get(x.message_id)!.push({ id: x.id, name: x.name, kind: x.kind, tokens: x.tokens, size: x.size });
  }
  const vers = new Map((v.results as { msg_id: string; n: number }[]).map((x) => [x.msg_id, x.n]));
  const messages = (m.results as { id: string; role: string; text: string; model: string | null; meta: string | null; ts: number; compacted: number }[]).map((x) => {
    const meta = x.meta ? JSON.parse(x.meta) : {};
    return {
      id: x.id, role: x.role, text: x.text, model: x.model, ts: x.ts, compacted: !!x.compacted,
      meta, atts: atts.get(x.id) ?? [], vers: vers.get(x.id) ?? 0, ver: meta.ver ?? (vers.get(x.id) ? 1 : 0),
    };
  });
  return c.json({ chat, messages });
});

// 名前の変更・ピン留め
api.patch('/chats/:id', async (c) => {
  const b = await c.req.json().catch(() => null);
  const own = await c.env.DB.prepare('SELECT id FROM chats WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('user').id).first();
  if (!own) return err(c, 404, 'not_found', '見つかりません');
  const sets: string[] = []; const vals: unknown[] = [];
  if (b?.title !== undefined) {
    const t = typeof b.title === 'string' ? b.title.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    if (!t) return err(c, 400, 'invalid', 'タイトルを入力してください');
    sets.push('title = ?'); vals.push(t);
  }
  if (b?.pinned !== undefined) { sets.push('pinned = ?'); vals.push(b.pinned ? 1 : 0); }
  if (!sets.length) return err(c, 400, 'invalid', '変更がありません');
  await c.env.DB.prepare(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, c.req.param('id')).run();
  const row = await c.env.DB.prepare('SELECT id, title, pinned FROM chats WHERE id = ?').bind(c.req.param('id')).first();
  return c.json({ chat: row });
});

// 応答の版を切り替える(再生成した応答の行き来)。いちばん最後の応答だけ。
api.post('/messages/:id/version', async (c) => {
  const b = await c.req.json().catch(() => null);
  const n = Number(b?.n);
  if (!Number.isInteger(n) || n < 1) return err(c, 400, 'invalid', '版を指定してください');
  const m = await c.env.DB.prepare(
    `SELECT m.id, m.chat_id FROM messages m JOIN chats c ON c.id = m.chat_id
     WHERE m.id = ?1 AND c.user_id = ?2 AND m.role = 'ai'
       AND m.seq = (SELECT MAX(seq) FROM messages WHERE chat_id = m.chat_id)`,
  ).bind(c.req.param('id'), c.get('user').id).first<{ id: string; chat_id: string }>();
  if (!m) return err(c, 404, 'not_found', '切り替えられるのは最後の応答だけです');
  const v = await c.env.DB.prepare('SELECT text, model, meta, ts FROM ai_versions WHERE msg_id = ? AND n = ?').bind(m.id, n).first<{ text: string; model: string | null; meta: string | null; ts: number }>();
  if (!v) return err(c, 404, 'not_found', 'その版はありません');
  let meta: any = {};
  try { meta = v.meta ? JSON.parse(v.meta) : {}; } catch { /* 空で */ }
  meta.ver = n;
  const stmts = [c.env.DB.prepare('UPDATE messages SET text = ?, model = ?, meta = ?, ts = ? WHERE id = ?').bind(v.text, v.model, JSON.stringify(meta), v.ts, m.id)];
  if (typeof meta.hist === 'number') stmts.push(c.env.DB.prepare('UPDATE chats SET hist_tokens = ? WHERE id = ?').bind(meta.hist, m.chat_id));
  await c.env.DB.batch(stmts);
  return c.json({ id: m.id, text: v.text, model: v.model, meta, ver: n });
});

/* ------------------------------------------------------------------ エクスポート */

const safeName = (t: string) => t.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 50) || 'chat';
const download = (c: Context, body: string, name: string, type: string) =>
  new Response(body, { headers: { 'content-type': `${type}; charset=utf-8`, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

async function exportRows(env: Env, chatId: string) {
  const r = await env.DB.prepare('SELECT role, text, model, meta, ts, compacted FROM messages WHERE chat_id = ? ORDER BY seq').bind(chatId).all<{ role: string; text: string; model: string | null; meta: string | null; ts: number; compacted: number }>();
  return r.results.map((x) => {
    let meta: any = {}; try { meta = x.meta ? JSON.parse(x.meta) : {}; } catch { /* */ }
    return { role: x.role, text: x.text, model: x.model, ts: x.ts, compacted: !!x.compacted, summary: meta.kind === 'summary', costUsd: typeof meta.cost === 'number' ? meta.cost / NANO : undefined };
  });
}

api.get('/chats/:id/export', async (c) => {
  const chat = await c.env.DB.prepare('SELECT id, title, updated_at FROM chats WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('user').id).first<{ id: string; title: string; updated_at: number }>();
  if (!chat) return err(c, 404, 'not_found', '見つかりません');
  const rows = await exportRows(c.env, chat.id);
  if (c.req.query('format') === 'json') return download(c, JSON.stringify({ title: chat.title, exportedAt: new Date().toISOString(), messages: rows }, null, 2), `${safeName(chat.title)}.json`, 'application/json');
  const md = [`# ${chat.title}`, '', `> ${new Date().toISOString()} に書き出し`, ''];
  for (const m of rows) {
    md.push(m.summary ? '## 要約(圧縮)' : m.role === 'user' ? '## あなた' : `## Claude${m.model && m.model in MODELS ? `(${MODELS[m.model as ModelKey].name})` : ''}`, '', m.text, '');
  }
  return download(c, md.join('\n'), `${safeName(chat.title)}.md`, 'text/markdown');
});

api.get('/export', async (c) => {
  const chats = await c.env.DB.prepare('SELECT id, title, updated_at FROM chats WHERE user_id = ? ORDER BY updated_at DESC').bind(c.get('user').id).all<{ id: string; title: string; updated_at: number }>();
  const out = [];
  for (const ch of chats.results) out.push({ title: ch.title, updatedAt: new Date(ch.updated_at).toISOString(), messages: await exportRows(c.env, ch.id) });
  return download(c, JSON.stringify({ exportedAt: new Date().toISOString(), chats: out }, null, 2), 'private-chat-all.json', 'application/json');
});

api.delete('/chats/:id', async (c) => {
  const id = c.req.param('id');
  const own = await c.env.DB.prepare('SELECT id FROM chats WHERE id = ? AND user_id = ?').bind(id, c.get('user').id).first();
  if (!own) return err(c, 404, 'not_found', '見つかりません');
  const files = await c.env.DB.prepare('SELECT r2_key FROM attachments WHERE chat_id = ?').bind(id).all<{ r2_key: string }>();
  if (files.results.length) await c.env.FILES.delete(files.results.map((f) => f.r2_key));
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM attachments WHERE chat_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM chats WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ 添付 */

interface AttRow { id: string; name: string; kind: 'image' | 'pdf' | 'text'; mime: string; size: number; tokens: number; r2_key: string; message_id?: string | null }

async function attachmentBlock(env: Env, a: AttRow) {
  const obj = await env.FILES.get(a.r2_key);
  if (!obj) throw new Error(`添付 ${a.name} が見つかりません`);
  const buf = await obj.arrayBuffer();
  if (a.kind === 'image') return { type: 'image', source: { type: 'base64', media_type: a.mime, data: toBase64(buf) } };
  if (a.kind === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(buf) } };
  return { type: 'document', title: a.name, source: { type: 'text', media_type: 'text/plain', data: new TextDecoder().decode(buf) } };
}

async function userContent(env: Env, atts: AttRow[], text: string) {
  const blocks: unknown[] = [];
  for (const a of atts) blocks.push(await attachmentBlock(env, a));
  if (text) blocks.push({ type: 'text', text });
  return blocks;
}

function kindOf(name: string, mime: string): 'image' | 'pdf' | 'text' | null {
  if (IMAGE_MIME.includes(mime)) return 'image';
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (/\.(txt|md|csv|json|html|css|js|ts|py|xml|ya?ml|log)$/i.test(name) || mime.startsWith('text/')) return 'text';
  return null;
}

api.post('/upload', async (c) => {
  const u = c.get('user');
  const name = decodeURIComponent(c.req.header('x-filename') || 'file').slice(0, 120);
  const mime = (c.req.header('content-type') || 'application/octet-stream').split(';')[0].trim();
  const kind = kindOf(name, mime);
  if (!kind) return err(c, 415, 'unsupported', `${name} は対応していません`);
  const declared = Number(c.req.header('content-length') || '0');
  if (declared > LIMITS[kind]) return err(c, 413, 'too_large', `${name} が大きすぎます`);
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > LIMITS[kind]) return err(c, 413, 'too_large', `${name} が大きすぎます`);
  const modelKey = c.req.query('model');
  const m = MODELS[isModelKey(modelKey) ? modelKey : 'sonnet'];

  const id = randomHex(8);
  const row: AttRow = { id, name, kind, mime: kind === 'text' ? 'text/plain' : kind === 'pdf' ? 'application/pdf' : mime, size: body.byteLength, tokens: 0, r2_key: `u/${u.id}/${id}` };
  let tokens: number;
  try {
    // 先にR2へ置かず、まず数える。数えられないファイル(壊れたPDFなど)は保存しない。
    const tmp = { ...row };
    await c.env.FILES.put(row.r2_key, body);
    const block = await attachmentBlock(c.env, tmp);
    tokens = await countTokens(c.env, { model: m.id, messages: [{ role: 'user', content: [block] }] });
  } catch (e) {
    await c.env.FILES.delete(row.r2_key);
    if (e instanceof UpstreamError) return err(c, 502, 'count_failed', `トークンを数えられません: ${upstreamMessage(e)}`);
    throw e;
  }
  await c.env.DB.prepare('INSERT INTO attachments (id, user_id, name, kind, mime, size, tokens, r2_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, u.id, name, kind, row.mime, row.size, tokens, row.r2_key, Date.now()).run();
  // 24時間以上たった未使用の添付を掃除
  const stale = await c.env.DB.prepare('SELECT id, r2_key FROM attachments WHERE user_id = ? AND message_id IS NULL AND created_at < ?').bind(u.id, Date.now() - 86_400_000).all<{ id: string; r2_key: string }>();
  if (stale.results.length) {
    await c.env.FILES.delete(stale.results.map((s) => s.r2_key));
    await c.env.DB.batch(stale.results.map((s) => c.env.DB.prepare('DELETE FROM attachments WHERE id = ?').bind(s.id)));
  }
  return c.json({ id, name, kind, size: row.size, tokens });
});

api.delete('/upload/:id', async (c) => {
  const a = await c.env.DB.prepare('SELECT id, r2_key FROM attachments WHERE id = ? AND user_id = ? AND message_id IS NULL').bind(c.req.param('id'), c.get('user').id).first<{ id: string; r2_key: string }>();
  if (a) {
    await c.env.FILES.delete(a.r2_key);
    await c.env.DB.prepare('DELETE FROM attachments WHERE id = ?').bind(a.id).run();
  }
  return c.json({ ok: true });
});

function upstreamMessage(e: UpstreamError): string {
  try { return JSON.parse(e.body)?.error?.message ?? `HTTP ${e.status}`; } catch { return `HTTP ${e.status}`; }
}

// 送信前の添付。編集中は、編集対象のメッセージに付いていた添付も再利用できる。
async function loadPending(c: Context<AppEnv>, ids: unknown, editMsgId: string | null = null): Promise<AttRow[] | null> {
  if (!Array.isArray(ids) || ids.length > 10 || ids.some((x) => typeof x !== 'string')) return null;
  const out: AttRow[] = [];
  for (const id of ids as string[]) {
    const a = await c.env.DB.prepare('SELECT id, name, kind, mime, size, tokens, r2_key, message_id FROM attachments WHERE id = ? AND user_id = ? AND (message_id IS NULL OR message_id = ?)').bind(id, c.get('user').id, editMsgId ?? '').first<AttRow>();
    if (!a) return null;
    out.push(a);
  }
  return out;
}

/* ------------------------------------------------------------------ 履歴と編集 */

type HistoryMsg = { role: 'user' | 'assistant'; content: unknown };

// 編集対象のユーザーメッセージの並び順(seq)。自分のチャットのユーザー発言だけが編集できる。
async function editTarget(env: Env, userId: string, chatId: string, msgId: string): Promise<number | null> {
  const r = await env.DB.prepare("SELECT m.seq AS seq FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = ? AND m.chat_id = ? AND c.user_id = ? AND m.role = 'user' AND m.compacted = 0").bind(msgId, chatId, userId).first<{ seq: number }>();
  return r ? r.seq : null;
}

// beforeSeq を渡すと、その手前までの履歴だけを返す(編集・再生成のとき)。
// 圧縮済みの発言は送らず、要約を先頭の1往復として送る。
async function buildHistory(env: Env, chatId: string, beforeSeq: number | null): Promise<{ history: HistoryMsg[]; bytes: number }> {
  const [ms, ats] = await env.DB.batch([
    env.DB.prepare('SELECT id, role, text, meta FROM messages WHERE chat_id = ?1 AND compacted = 0 AND (?2 IS NULL OR seq < ?2) ORDER BY seq').bind(chatId, beforeSeq),
    env.DB.prepare('SELECT id, name, kind, mime, size, tokens, r2_key, message_id FROM attachments WHERE chat_id = ? AND message_id IS NOT NULL').bind(chatId),
  ]);
  const rows = ms.results as { id: string; role: string; text: string; meta: string | null }[];
  const ids = new Set(rows.map((r) => r.id));
  const byMsg = new Map<string, AttRow[]>();
  let bytes = 0;
  for (const a of ats.results as unknown as AttRow[]) {
    if (!ids.has(a.message_id!)) continue;
    if (!byMsg.has(a.message_id!)) byMsg.set(a.message_id!, []);
    byMsg.get(a.message_id!)!.push(a);
    bytes += a.size;
  }
  const history: HistoryMsg[] = [];
  for (const x of rows) {
    if (x.role === 'user') history.push({ role: 'user', content: await userContent(env, byMsg.get(x.id) ?? [], x.text) });
    else if (isSummary(x.meta)) {
      history.push({ role: 'user', content: `これまでの会話の要約です。これを前提に、続きの会話に答えてください。\n\n${x.text}` });
      history.push({ role: 'assistant', content: '要約を踏まえて続けます。' });
    } else if (x.text) history.push({ role: 'assistant', content: x.text });
  }
  return { history, bytes };
}
const isSummary = (meta: string | null) => { try { return !!meta && JSON.parse(meta).kind === 'summary'; } catch { return false; } };

// 編集中の見積もり用: 手前までの履歴(システムプロンプト込み)のトークン数。入力のたびに数え直さないよう少しの間だけ覚える。
const editHistCache = new Map<string, { v: number; until: number }>();
async function editHistTokens(env: Env, chatId: string, msgId: string, seq: number, system: string): Promise<number> {
  const key = `${chatId}:${msgId}:${system.length}`;
  const hit = editHistCache.get(key);
  if (hit && hit.until > Date.now()) return hit.v;
  const { history } = await buildHistory(env, chatId, seq);
  let v = 0;
  if (history.length) {
    const probe = { role: 'user' as const, content: '.' };
    const model = MODELS.sonnet.id;
    const [withH, alone] = await Promise.all([
      countTokens(env, { model, system, messages: [...history, probe] }),
      countTokens(env, { model, messages: [probe] }),
    ]);
    v = Math.max(0, withH - alone);
  }
  if (editHistCache.size > 200) editHistCache.clear();
  editHistCache.set(key, { v, until: Date.now() + 10 * 60_000 });
  return v;
}

/* ------------------------------------------------------------------ 見積もり(送信前のトークン数・割合) */

interface GateResult { ok: boolean; why?: 'cap' | 'worst'; ov?: boolean }

function gateOf(q: Quote, outPrice: number, remaining: number, override: boolean): GateResult {
  const minViable = q.inputNano + q.searchWorstNano + MIN_OUT_TOKENS * outPrice;
  if (minViable > remaining) return { ok: false, why: 'cap' };
  if (q.worstNano <= remaining) return { ok: true };
  if (override) return { ok: true, ov: true };
  return { ok: false, why: 'worst' };
}

api.post('/quote', async (c) => {
  const u = c.get('user');
  const b = await c.req.json().catch(() => null);
  if (!b) return err(c, 400, 'invalid', '不正なリクエストです');
  const cfg = await readConfig(c.env.DB);
  const compact = b.compact === true;
  const rawText = typeof b.text === 'string' ? b.text.trim() : '';
  const text = compact ? COMPACT_PROMPT + (rawText ? `\n\n追加の指示: ${rawText}` : '') : rawText;
  const search = compact ? false : cfg.permission === 'auto' ? true : !!b.search;
  const effort = effortOf(cfg, b.effort);
  const sMax = searchMaxOf(cfg);
  const system = await systemFor(c.env, u.id, b.memory !== false);
  const editId: string | null = !compact && typeof b.editMsgId === 'string' && b.editMsgId ? b.editMsgId : null;
  const atts = compact ? [] : await loadPending(c, b.attachmentIds ?? [], editId);
  if (!atts) return err(c, 400, 'invalid_attachment', '添付が見つかりません');
  if (compact && !b.chatId) return err(c, 400, 'invalid', '圧縮できる会話がありません');

  let hist = 0;
  let editEmpty = false;
  if (editId) {
    if (!b.chatId) return err(c, 400, 'invalid', '不正なリクエストです');
    const seq = await editTarget(c.env, u.id, b.chatId, editId);
    if (seq == null) return err(c, 404, 'not_found', '編集するメッセージが見つかりません');
    try { hist = await editHistTokens(c.env, b.chatId, editId, seq, system); }
    catch (e) { if (e instanceof UpstreamError) return err(c, 502, 'count_failed', `トークンを数えられません: ${upstreamMessage(e)}`); throw e; }
    editEmpty = hist === 0;
  } else if (b.chatId) {
    const ch = await c.env.DB.prepare('SELECT hist_tokens, last_model, last_ts FROM chats WHERE id = ? AND user_id = ?').bind(b.chatId, u.id).first<{ hist_tokens: number; last_model: string | null; last_ts: number | null }>();
    if (!ch) return err(c, 404, 'not_found', 'チャットが見つかりません');
    hist = ch.hist_tokens;
  }
  const isNewChat = !b.chatId;
  const empty = !text && atts.length === 0;
  const [ledger, maxTokens] = await Promise.all([readLedger(c.env.DB, Date.now()), readMaxTokens(c.env.DB)]);
  const remaining = cap(c.env) - ledger.spent - ledger.reserved;

  let content: unknown[] = [];
  if (!empty) {
    try { content = await userContent(c.env, atts, text); } catch (e) { return err(c, 400, 'invalid_attachment', (e as Error).message); }
  }
  const chatRow = b.chatId ? await c.env.DB.prepare('SELECT last_model, last_ts FROM chats WHERE id = ?').bind(b.chatId).first<{ last_model: string | null; last_ts: number | null }>() : null;

  const models: Record<string, Quote & { gate: GateResult }> = {};
  try {
    await Promise.all(MODEL_KEYS.map(async (k) => {
      const m = MODELS[k];
      let newTokens = 0;
      if (!empty) {
        newTokens = await countTokens(c.env, {
          model: m.id,
          messages: [{ role: 'user', content }],
          ...(isNewChat || editEmpty ? { system } : {}),
        });
      } else if (isNewChat) {
        newTokens = 0;
      }
      const warm = !editId && !!chatRow && chatRow.last_model === k && !!chatRow.last_ts && Date.now() - chatRow.last_ts < 5 * 60 * 1000;
      const q = makeQuote(m, {
        histTokens: hist, newTokens, cacheWarm: warm, outMax: compact ? COMPACT_MAX_OUT : maxTokens[k], search,
        searchMax: sMax, searchAuto: cfg.permission === 'auto', effort, ...(compact ? { expOut: 1500 } : {}),
      });
      models[k] = { ...q, gate: gateOf(q, m.out, remaining, ledger.override) };
    }));
  } catch (e) {
    if (e instanceof UpstreamError) return err(c, 502, 'count_failed', `トークンを数えられません: ${upstreamMessage(e)}`);
    throw e;
  }
  return c.json({ models, ledger, capNano: cap(c.env) });
});

/* ------------------------------------------------------------------ 送信(SSE) */

const estText = (s: string) => {
  let cjk = 0, other = 0;
  for (const ch of s) (ch.codePointAt(0)! >= 0x2e80 ? cjk++ : other++);
  return Math.ceil(cjk * 1.05 + other / 3);
};

api.post('/send', async (c) => {
  const u = c.get('user');
  const env = c.env;
  const b = await c.req.json().catch(() => null);
  if (!b || !isModelKey(b.model)) return err(c, 400, 'invalid', 'モデルを選んでください');
  const model: ModelKey = b.model;
  const m = MODELS[model];
  const cfg = await readConfig(env.DB);

  // 種類: 通常 / 編集して送り直し(editMsgId) / 最後の応答の再生成(regenId) / 会話の圧縮(compact)
  const compact = b.compact === true;
  const regenId: string | null = !compact && typeof b.regenId === 'string' && b.regenId ? b.regenId : null;
  const editId: string | null = !compact && !regenId && typeof b.editMsgId === 'string' && b.editMsgId ? b.editMsgId : null;
  const rawText = typeof b.text === 'string' ? b.text.trim() : '';
  const search = compact ? false : cfg.permission === 'auto' ? true : !!b.search;
  const effort: Effort = effortOf(cfg, b.effort);
  const sMax = searchMaxOf(cfg);
  const system = await systemFor(env, u.id, b.memory !== false);
  const thinkOn = cfg.thinking && !compact;
  let chatId: string = b.chatId;
  if ((compact || regenId || editId) && !chatId) return err(c, 400, 'invalid', '不正なリクエストです');

  let text = rawText;
  let atts: AttRow[] = [];
  if (!compact && !regenId) {
    const pending = await loadPending(c, b.attachmentIds ?? [], editId);
    if (!pending) return err(c, 400, 'invalid_attachment', '添付が見つかりません');
    atts = pending;
    if (!text && atts.length === 0) return err(c, 400, 'empty', 'メッセージを入力してください');
  }
  if (text.length > 200_000) return err(c, 413, 'too_large', 'メッセージが長すぎます');

  // 履歴
  let isNew = false;
  let history: HistoryMsg[] = [];
  let historyBytes = 0;
  let editSeq: number | null = null;
  let dropFiles: { id: string; r2_key: string }[] = [];
  let regen: { aiId: string; userId: string; nextN: number } | null = null;
  if (chatId) {
    const ch = await env.DB.prepare('SELECT id FROM chats WHERE id = ? AND user_id = ?').bind(chatId, u.id).first();
    if (!ch) return err(c, 404, 'not_found', 'チャットが見つかりません');
    if (regenId) {
      const a = await env.DB.prepare("SELECT id, seq, meta FROM messages WHERE id = ?1 AND chat_id = ?2 AND role = 'ai' AND compacted = 0 AND seq = (SELECT MAX(seq) FROM messages WHERE chat_id = ?2)").bind(regenId, chatId).first<{ id: string; seq: number; meta: string | null }>();
      if (!a || isSummary(a.meta)) return err(c, 404, 'not_found', '再生成できるのは最後の応答だけです');
      const um = await env.DB.prepare("SELECT id, seq, text FROM messages WHERE chat_id = ? AND role = 'user' AND seq < ? AND compacted = 0 ORDER BY seq DESC LIMIT 1").bind(chatId, a.seq).first<{ id: string; seq: number; text: string }>();
      if (!um) return err(c, 404, 'not_found', '元の発言が見つかりません');
      text = um.text;
      const ar = await env.DB.prepare('SELECT id, name, kind, mime, size, tokens, r2_key, message_id FROM attachments WHERE message_id = ?').bind(um.id).all<AttRow>();
      atts = ar.results;
      const h = await buildHistory(env, chatId, um.seq);
      history = h.history; historyBytes = h.bytes;
      const mx = await env.DB.prepare('SELECT COALESCE(MAX(n), 1) AS n FROM ai_versions WHERE msg_id = ?').bind(a.id).first<{ n: number }>();
      regen = { aiId: a.id, userId: um.id, nextN: (mx?.n ?? 1) + 1 };
    } else if (compact) {
      const h = await buildHistory(env, chatId, null);
      if (h.history.length < 2) return err(c, 400, 'compact_empty', '圧縮する会話がまだありません');
      history = h.history; historyBytes = h.bytes;
      text = COMPACT_PROMPT + (rawText ? `\n\n追加の指示: ${rawText}` : '');
    } else {
      if (editId) {
        editSeq = await editTarget(env, u.id, chatId, editId);
        if (editSeq == null) return err(c, 404, 'not_found', '編集するメッセージが見つかりません');
      }
      const h = await buildHistory(env, chatId, editSeq);
      history = h.history; historyBytes = h.bytes;
      if (editSeq != null) {
        // 編集で消えるメッセージの添付(再利用するものは除く)
        const reused = new Set(atts.map((a) => a.id));
        const gone = await env.DB.prepare('SELECT id, r2_key FROM attachments WHERE chat_id = ?1 AND message_id IN (SELECT id FROM messages WHERE chat_id = ?1 AND seq >= ?2)').bind(chatId, editSeq).all<{ id: string; r2_key: string }>();
        dropFiles = gone.results.filter((g) => !reused.has(g.id));
      }
    }
  } else {
    chatId = randomHex(8);
    isNew = true;
  }
  if (historyBytes + atts.reduce((s, a) => s + a.size, 0) > MAX_REQUEST_BYTES) return err(c, 413, 'too_large', '添付が多すぎます。新しいチャットで試してください');

  let newContent: unknown[];
  try { newContent = await userContent(env, atts, text); } catch (e) { return err(c, 400, 'invalid_attachment', (e as Error).message); }
  const messages = [...history, { role: 'user' as const, content: newContent }];

  // 正確な入力トークン数(送信直前)
  let inputTokens: number;
  try { inputTokens = await countTokens(env, { model: m.id, system, messages }); }
  catch (e) { if (e instanceof UpstreamError) return err(c, 502, 'count_failed', `トークンを数えられません: ${upstreamMessage(e)}`); throw e; }

  // 最悪ケースを計算して、原子的に予約する
  const maxTokens = compact ? COMPACT_MAX_OUT : (await readMaxTokens(env.DB))[model];
  const q = makeQuote(m, { histTokens: 0, newTokens: inputTokens, cacheWarm: false, outMax: maxTokens, search, searchMax: sMax, effort });
  const reservationId = randomHex(8);
  const now = Date.now();
  const minViable = q.inputNano + q.searchWorstNano + MIN_OUT_TOKENS * m.out;
  const res = await reserve(env.DB, reservationId, now, cap(env), q.worstNano, minViable);
  if (!res.ok) {
    return err(c, 402, res.why === 'cap' ? 'cap' : 'limiter', res.why === 'cap' ? '上限に達しています' : '最悪ケースが残額を超えています(解除は最高権限者のみ)');
  }
  // 制限解除中は、予約できた額に収まるよう max_tokens を絞る。API側が上限を守るので、出力が予約を超えることはない。
  const outAllowed = Math.floor((res.amount - q.inputNano - q.searchWorstNano) / m.out);
  const maxTok = Math.max(MIN_OUT_TOKENS, Math.min(maxTokens, outAllowed));

  const upstreamBody = {
    model: m.id,
    max_tokens: maxTok,
    system,
    messages,
    cache_control: { type: 'ephemeral' },
    output_config: { effort },
    ...(thinkOn ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
    ...(search ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: sMax }] } : {}),
  };

  const userMsgId = regen ? regen.userId : randomHex(8);
  const aiMsgId = regen ? regen.aiId : randomHex(8);
  const title = (text || atts[0]?.name || '新しいチャット').replace(/\s+/g, ' ').slice(0, 28);
  const ac = new AbortController();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let clientGone = false;
  const emit = async (event: string, data: unknown) => {
    if (clientGone) return;
    try { await writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); }
    catch { clientGone = true; ac.abort(); }
  };

  writer.closed.catch(() => { clientGone = true; ac.abort(); });

  const run = async () => {
    const hb = setInterval(() => { void emit('ping', {}); }, 8000);
    let usage: Usage = {};
    let out = '';
    let sources: { title: string; url: string }[] = [];
    let searches = 0;
    let finished = false;
    let failure: string | null = null;
    let stopReason: string | null = null;
    let rid: string | null = null;
    let think = '';
    let started = false;
    const cites: [number, number][] = [];
    try {
      await emit('meta', { chatId, title, userMsgId, aiMsgId, maxTokens: maxTok, reserved: res.amount, overridden: res.overridden, mode: compact ? 'compact' : regen ? 'regen' : editId ? 'edit' : 'chat', ver: regen?.nextN ?? null, effort });
      const up = await openStream(env, upstreamBody, ac.signal);
      rid = up.headers.get('request-id');
      started = true;
      for await (const ev of sseEvents(up.body!)) {
        const d = ev.data;
        switch (d.type) {
          case 'message_start':
            usage = { ...d.message?.usage };
            break;
          case 'content_block_start': {
            const cb = d.content_block;
            if (cb?.type === 'server_tool_use' && cb.name === 'web_search') { searches++; await emit('status', { searching: true, n: searches }); }
            if (cb?.type === 'web_search_tool_result' && Array.isArray(cb.content)) {
              const items = cb.content.filter((r: any) => r.type === 'web_search_result').map((r: any) => ({ title: String(r.title ?? r.url), url: String(r.url) }));
              sources = [...sources, ...items.filter((i: { url: string }) => !sources.some((s) => s.url === i.url))];
              await emit('sources', { items: sources });
            }
            break;
          }
          case 'content_block_delta':
            if (d.delta?.type === 'text_delta' && d.delta.text) { out += d.delta.text; await emit('text', { t: d.delta.text }); }
            else if (d.delta?.type === 'thinking_delta' && d.delta.thinking) {
              if (think.length < 30_000) { think += d.delta.thinking; await emit('think', { t: d.delta.thinking }); }
            } else if (d.delta?.type === 'citations_delta' && d.delta.citation?.url) {
              // 引用: 今までに出た本文の末尾に、出典の番号を付ける
              const url = String(d.delta.citation.url);
              let i = sources.findIndex((s) => s.url === url);
              if (i < 0) { sources = [...sources, { title: String(d.delta.citation.title ?? url), url }]; i = sources.length - 1; await emit('sources', { items: sources }); }
              if (cites.length < 400 && !cites.some((x) => x[0] === out.length && x[1] === i)) { cites.push([out.length, i]); await emit('cite', { at: out.length, i }); }
            }
            break;
          case 'message_delta':
            usage = { ...usage, ...d.usage };
            stopReason = d.delta?.stop_reason ?? stopReason;
            break;
          case 'message_stop':
            finished = true;
            break;
          case 'error':
            failure = d.error?.message ?? 'upstream error';
            break;
        }
        if (failure) break;
      }
    } catch (e) {
      if (e instanceof UpstreamError) failure = upstreamMessage(e);
      else if (!ac.signal.aborted) failure = (e as Error).message;
    }

    // 精算。最後の usage が届かなかった(停止・切断)ときは、見えているテキストから多めに見積もる。
    const stopped = !finished && !failure;
    let estimated = false;
    if (!finished) {
      const visible = estText(out) + estText(think);
      const guessOut = Math.ceil(visible * 1.3) + 200; // 見えない思考ぶんの上乗せ
      // リクエストが受理されたのに入力の使用量が届かなかったときは、数えた入力ぶんを最も高い単価(キャッシュ書き込み)で計上する
      if (started && !(usage.input_tokens || usage.cache_creation_input_tokens || usage.cache_read_input_tokens)) usage = { ...usage, cache_creation_input_tokens: inputTokens };
      usage = { ...usage, output_tokens: Math.max(usage.output_tokens ?? 0, out ? guessOut : usage.output_tokens ?? 0), server_tool_use: { web_search_requests: Math.max(searches, usage.server_tool_use?.web_search_requests ?? 0) } };
      estimated = true;
    }
    let actual = costOf(m, usage);
    if (estimated) actual = Math.min(actual, res.amount); // 予約を超えて課金されることはない
    const noOutput = !out && !finished;
    const totalIn = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    const histAfter = compact ? estText(out) + 300 : totalIn + Math.min(usage.output_tokens ?? 0, estText(out));
    const meta = {
      cost: actual, pct: actual / cap(env) * 100, model, searches: usage.server_tool_use?.web_search_requests ?? searches,
      sources, stopped, estimated, truncated: stopReason === 'max_tokens', usage, effort, rid, hist: histAfter,
      ...(think ? { think } : {}), ...(cites.length ? { cites } : {}),
    };

    const stmts: D1PreparedStatement[] = [...settleStatements(env.DB, reservationId, model, actual)];
    const ts = Date.now();
    // 圧縮は最後まで出きったときだけ反映する(途中のまま既存の会話を畳んでしまわない)
    const persist = compact ? finished && !failure && !!out : !failure || !!out;
    let dropAfter = false;
    if (persist) {
      if (compact) {
        stmts.push(
          env.DB.prepare('UPDATE messages SET compacted = 1 WHERE chat_id = ?').bind(chatId),
          env.DB.prepare('INSERT INTO messages (id, chat_id, seq, role, text, model, meta, ts) VALUES (?1, ?2, (SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE chat_id = ?2), \'ai\', ?3, ?4, ?5, ?6)').bind(aiMsgId, chatId, out, model, JSON.stringify({ ...meta, kind: 'summary' }), ts),
          env.DB.prepare('UPDATE chats SET updated_at = ?, hist_tokens = ?, last_model = ?, last_ts = ? WHERE id = ?').bind(ts, histAfter, model, ts, chatId),
        );
      } else if (regen) {
        const mj = JSON.stringify({ ...meta, error: failure, ver: regen.nextN });
        stmts.push(
          // 初めての再生成なら、元の応答を第1版として残す
          env.DB.prepare('INSERT INTO ai_versions (id, msg_id, n, text, model, meta, ts) SELECT ?1, id, 1, text, model, meta, ts FROM messages WHERE id = ?2 AND NOT EXISTS (SELECT 1 FROM ai_versions WHERE msg_id = ?2)').bind(randomHex(8), regen.aiId),
          env.DB.prepare('INSERT INTO ai_versions (id, msg_id, n, text, model, meta, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(randomHex(8), regen.aiId, regen.nextN, out, model, mj, ts),
          env.DB.prepare('UPDATE messages SET text = ?, model = ?, meta = ?, ts = ? WHERE id = ?').bind(out, model, mj, ts, regen.aiId),
          env.DB.prepare('UPDATE chats SET updated_at = ?, hist_tokens = ?, last_model = ?, last_ts = ? WHERE id = ?').bind(ts, histAfter, model, ts, chatId),
        );
      } else {
        if (editSeq != null) {
          // この発言以降を消して、新しい発言と応答に置き換える(新しいseqは編集した位置から続く)
          for (const f of dropFiles) stmts.push(env.DB.prepare('DELETE FROM attachments WHERE id = ?').bind(f.id));
          stmts.push(env.DB.prepare('DELETE FROM messages WHERE chat_id = ? AND seq >= ?').bind(chatId, editSeq));
          if (history.length === 0) stmts.push(env.DB.prepare('UPDATE chats SET title = ? WHERE id = ?').bind(title, chatId));
          dropAfter = true;
        }
        if (isNew) stmts.push(env.DB.prepare('INSERT INTO chats (id, user_id, title, updated_at, hist_tokens, last_model, last_ts) VALUES (?,?,?,?,?,?,?)').bind(chatId, u.id, title, ts, 0, model, ts));
        stmts.push(
          env.DB.prepare('INSERT INTO messages (id, chat_id, seq, role, text, ts) VALUES (?1, ?2, (SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE chat_id = ?2), \'user\', ?3, ?4)').bind(userMsgId, chatId, text, ts),
          env.DB.prepare('INSERT INTO messages (id, chat_id, seq, role, text, model, meta, ts) VALUES (?1, ?2, (SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE chat_id = ?2), \'ai\', ?3, ?4, ?5, ?6)').bind(aiMsgId, chatId, out, model, JSON.stringify({ ...meta, error: failure }), ts),
          env.DB.prepare('UPDATE chats SET updated_at = ?, hist_tokens = ?, last_model = ?, last_ts = ? WHERE id = ?').bind(ts, histAfter, model, ts, chatId),
          ...atts.map((a) => env.DB.prepare('UPDATE attachments SET chat_id = ?, message_id = ? WHERE id = ?').bind(chatId, userMsgId, a.id)),
        );
      }
    }
    let settled = true;
    try { await env.DB.batch(stmts); } catch (e) { settled = false; console.error('settle failed', e); }
    if (settled && dropAfter && dropFiles.length) { try { await env.FILES.delete(dropFiles.map((f) => f.r2_key)); } catch { /* 残っても害はない */ } }

    const ledger = await readLedger(env.DB, Date.now());
    if (failure) await emit('error', { message: failure, costNano: actual, ledger, saved: persist && !!out && settled, rid });
    else await emit('done', { costNano: actual, pct: meta.pct, usage, stopped, estimated, truncated: meta.truncated, searches: meta.searches, noOutput, ledger, rid, ver: regen?.nextN ?? null, compacted: compact && persist && settled, effort });
    clearInterval(hb);
    try { await writer.close(); } catch { /* 切断済み */ }
  };

  c.executionCtx.waitUntil(run());
  return new Response(readable, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
  });
});

app.route('/api', api);
app.notFound((c) => (c.req.path.startsWith('/api/') ? err(c, 404, 'not_found', '見つかりません') : c.env.ASSETS.fetch(c.req.raw)));
app.onError((e, c) => {
  console.error(e);
  return err(c, 500, 'internal', 'サーバーでエラーが起きました');
});

export default app;
