'use strict';
/* Private Chat — フロントエンド。サーバーAPI(/api/*)だけと話す。
   金額はサーバーから nano-USD(1e-9ドル)の整数で届く。表示の直前にだけドルへ直す。 */

const EFF_LABEL = { low: '低', medium: '中', high: '高' };
const MODELS = {
  sonnet: { name: 'Sonnet 5.5', icon: 'bolt' },
  opus:   { name: 'Opus 5.5',   icon: 'diamond' },
  fable:  { name: 'Fable 5.2',  icon: 'sparkle' },
};
const MODEL_KEYS = Object.keys(MODELS);
const LIMITS = { image: 8 * 1024 * 1024, pdf: 12 * 1024 * 1024, text: 1024 * 1024 };

/* ---------- helpers ---------- */
const $ = (s) => document.querySelector(s);
const ic = (n, c = '') => `<svg class="i ${c}"><use href="#i-${n}"/></svg>`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtPct = (n) => (n < 0.01 ? n.toFixed(4) : n < 10 ? n.toFixed(2) : n.toFixed(1));
const fmtUSD = (n) => '$' + (n < 0.01 ? n.toFixed(4) : n < 1 ? n.toFixed(3) : n.toFixed(2));
const dm = (s) => `<span class="dm">${s}</span>`;
const fmtTok = (n) => Math.round(n).toLocaleString('en-US');
const fmtK = (n) => (n >= 1000 ? n / 1000 + 'K' : n);
const usd = (nano) => nano / 1e9;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 保存できなくても動く */ } };
const fmtDate = (ms) => new Date(ms).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
function dlBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
function dlUrl(url) { const a = document.createElement('a'); a.href = url; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }
const b64u = {
  enc(buf) { let s = ''; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - (s.length % 4)) % 4); const r = atob(s), u = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) u[i] = r.charCodeAt(i); return u; },
};
const estText = (s) => { let c = 0, o = 0; for (const ch of s) (ch.codePointAt(0) >= 0x2e80 ? c++ : o++); return Math.ceil(c * 1.05 + o / 3); };

function tween(el, to, suffix = '') {
  if (!el) return;
  const from = el._v ?? 0; el._v = to; cancelAnimationFrame(el._r); const t0 = performance.now();
  const f = (t) => { const k = Math.min(1, (t - t0) / 550), e = 1 - Math.pow(1 - k, 3); el.textContent = fmtPct(from + (to - from) * e) + suffix; if (k < 1) el._r = requestAnimationFrame(f); };
  el._r = requestAnimationFrame(f);
}
function shake(el) { if (!el) return; el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); setTimeout(() => el.classList.remove('shake'), 480); }
function toast(msg, icon = 'check', kind = '') {
  const l = $('#layer'); l.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = document.createElement('div'); t.className = 'toast glass ' + kind; t.innerHTML = ic(icon) + '<span>' + esc(msg) + '</span>'; l.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 2800);
}

/* ---------- API ---------- */
class ApiError extends Error { constructor(m, status, code) { super(m); this.status = status; this.code = code; } }
async function req(path, { method = 'GET', body, raw, headers = {}, signal } = {}) {
  const r = await fetch('/api' + path, {
    method, signal, credentials: 'same-origin',
    headers: { 'x-pc': '1', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  let j = null; try { j = await r.json(); } catch { /* 本文なし */ }
  if (!r.ok) {
    if (r.status === 401 && S.user && path !== '/login') { sessionExpired(); }
    throw new ApiError(j?.message || `エラー (${r.status})`, r.status, j?.error);
  }
  return j;
}

/* ---------- state ---------- */
const S = {
  user: null, role: null, cap: 25e9, ledger: { spent: 0, reserved: 0, override: false, byModel: { sonnet: 0, opus: 0, fable: 0 } },
  maxTokens: {}, models: {}, presets: [4000, 8000, 16000, 32000, 64000], searchMax: 3,
  searchLimit: 20,
  config: { effortMode: 'fixed', permission: 'manual', searchMax: 3, searchUnlimited: false, thinking: true }, effort: 'medium', mem: true, memCount: 0, syncAvailable: false, syncRes: null, rq: null, installEv: null,
  chats: [], chat: null, model: 'sonnet', search: false, atts: [], text: '',
  quotes: {}, edit: null, draft: null, counting: false, quoteErr: null, seq: 0, live: 0, streaming: false, abort: null, pop: null,
  pv: { kind: 'html', name: '', file: null, open: false, html: '', mode: 'preview', device: 'desktop', ready: false, pending: null, last: 0, errs: [], vi: -1 },
};
{ const mv = lsGet('pc.mem'); if (mv === '0') S.mem = false; }
{ const e = lsGet('pc.effort'); if (e === 'low' || e === 'medium' || e === 'high') S.effort = e; }
const isOwner = () => S.role === 'owner';
const isSum = (m) => m && m.role === 'ai' && m.meta && m.meta.kind === 'summary';
let chatQ = '';
const pctOf = (nano) => (nano / S.cap) * 100;

/* ---------- boot / auth ---------- */
let authMode = 'login';
function showAuth(mode) {
  Orb.scan(document);
  authMode = mode; $('#shell').hidden = true; $('#shell').classList.remove('on');
  const a = $('#auth'); a.hidden = false; a.classList.remove('out');
  $('#authTitle').textContent = mode === 'setup' ? '最高権限者を作成' : 'ログイン';
  $('#aPass2Box').hidden = mode !== 'setup'; $('#pkLogin').hidden = mode === 'setup' || !PK_OK;
  $('#aPass').autocomplete = mode === 'setup' ? 'new-password' : 'current-password';
  $('#aUser').value = ''; $('#aPass').value = ''; $('#aPass2').value = ''; $('#authErr').classList.remove('on'); $('#authGo').classList.remove('busy');
  setTimeout(() => $('#aUser').focus(), 500);
}
function authErr(msg) { const e = $('#authErr'); e.textContent = msg; e.classList.add('on'); shake($('#authForm')); $('#authGo').classList.remove('busy'); }
$('#authForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const u = $('#aUser').value.trim(), p = $('#aPass').value, go = $('#authGo');
  if (!u || !p) return authErr('入力してください');
  $('#authErr').classList.remove('on'); go.classList.add('busy');
  try {
    if (authMode === 'setup') {
      if (!/^[A-Za-z0-9_.\-]{3,32}$/.test(u)) return authErr('ユーザー名は3〜32文字の英数字です');
      if (p.length < 8) return authErr('パスワードは8文字以上です');
      if (p !== $('#aPass2').value) return authErr('パスワードが一致しません');
      const r = await req('/setup', { method: 'POST', body: { name: u, password: p } });
      await enter(r.user);
    } else {
      const r = await req('/login', { method: 'POST', body: { name: u, password: p } });
      await enter(r.user);
    }
  } catch (e) { authErr(e.message); }
});

const PK_OK = !!(window.PublicKeyCredential && navigator.credentials);
const PK_REG_OK = PK_OK && typeof AuthenticatorAttestationResponse !== 'undefined' && typeof AuthenticatorAttestationResponse.prototype.getPublicKey === 'function' && typeof AuthenticatorAttestationResponse.prototype.getAuthenticatorData === 'function';
const quiet = (e) => e && (e.name === 'NotAllowedError' || e.name === 'AbortError');
const pkMsg = (e) => e && e.name === 'InvalidStateError' ? 'この端末のパスキーは登録済みです' : e && e.name === 'SecurityError' ? 'このアドレスでは使えません(https か localhost が必要です)' : e && e.name === 'NotSupportedError' ? 'この端末は対応していません' : (e && e.message) || 'パスキーを使えませんでした';
async function passkeyLogin() {
  const btn = $('#pkLogin'); btn.classList.add('busy');
  try {
    const o = await req('/passkey/login/options', { method: 'POST' });
    const cred = await navigator.credentials.get({ publicKey: { challenge: b64u.dec(o.challenge), rpId: o.rpId, userVerification: 'required', timeout: o.timeout } });
    const r = cred.response;
    const res = await req('/passkey/login/verify', { method: 'POST', body: { id: cred.id, clientDataJSON: b64u.enc(r.clientDataJSON), authenticatorData: b64u.enc(r.authenticatorData), signature: b64u.enc(r.signature) } });
    await enter(res.user);
  } catch (e) { if (!quiet(e)) authErr(e instanceof ApiError ? e.message : pkMsg(e)); }
  finally { btn.classList.remove('busy'); }
}
$('#pkLogin').onclick = passkeyLogin;
function deviceName() { const u = navigator.userAgent; return /Android/.test(u) ? 'Android' : /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : /Linux/.test(u) ? 'Linux' : 'この端末'; }
async function passkeyAdd() {
  const o = await req('/passkeys/options', { method: 'POST' });
  const pub = { ...o, challenge: b64u.dec(o.challenge), user: { ...o.user, id: b64u.dec(o.user.id) }, excludeCredentials: (o.excludeCredentials || []).map((x) => ({ type: x.type, id: b64u.dec(x.id) })) };
  const cred = await navigator.credentials.create({ publicKey: pub });
  const r = cred.response;
  await req('/passkeys', { method: 'POST', body: { id: cred.id, clientDataJSON: b64u.enc(r.clientDataJSON), authenticatorData: b64u.enc(r.getAuthenticatorData()), publicKey: b64u.enc(r.getPublicKey()), alg: r.getPublicKeyAlgorithm(), transports: r.getTransports ? r.getTransports() : [], name: deviceName() } });
}

async function boot() {
  try {
    const s = await req('/session');
    if (s.user) await enter(s.user); else showAuth(s.setup ? 'setup' : 'login');
  } catch (e) { showAuth('login'); toast(e.message, 'x', 'bad'); }
}

async function loadState() {
  const st = await req('/state');
  S.user = st.user.name; S.role = st.user.role; S.cap = st.capNano; S.ledger = st.ledger; S.maxTokens = st.maxTokens; S.models = st.models; S.presets = st.presets; S.searchMax = st.searchMaxUses; S.config = st.config; S.searchLimit = st.searchLimit || 20; S.syncAvailable = !!st.syncAvailable;
}
async function loadChats() { S.chats = (await req('/chats' + (chatQ ? '?q=' + encodeURIComponent(chatQ) : ''))).chats; }
const refreshList = async () => { try { await loadChats(); } catch { /* 無視 */ } renderList(); };

async function enter(user) {
  S.user = user.name; S.role = user.role;
  await Promise.all([loadState(), loadChats()]);
  chatQ = ''; $('#chatQ').value = ''; S.chat = null; S.model = 'sonnet'; S.search = false; S.atts = []; S.text = ''; S.live = 0; S.quotes = {}; S.edit = null; S.draft = null;
  $('#auth').classList.add('out'); setTimeout(() => { $('#auth').hidden = true; }, 600);
  const sh = $('#shell'); sh.hidden = false; if (innerWidth <= 900) sh.classList.remove('sb-open'); requestAnimationFrame(() => sh.classList.add('on'));
  $('#sbAv').textContent = S.user[0]; $('#sbName').textContent = S.user;
  $('#sbRole').innerHTML = isOwner() ? ic('crown', 'sm') + '最高権限者' : ic('user', 'sm') + 'ユーザー';
  $('#input').value = ''; autosize(); renderAll(); renderMem(); loadMemCount(); recount(true); setTimeout(() => $('#input').focus(), 700);
}
function sessionExpired() { S.user = null; S.edit = null; S.draft = null; pvClose(); closePop(); closeModal(); showAuth('login'); toast('ログインが切れました', 'lock', 'warn'); }
async function logout() {
  if (S.streaming && S.abort) S.abort.abort();
  try { await req('/logout', { method: 'POST' }); } catch { /* 既に切れている */ }
  S.user = null; S.edit = null; S.draft = null; closePop(); closeModal(); pvClose(); $('#shell').classList.remove('on'); setTimeout(() => showAuth('login'), 450);
}
// 別端末や別ユーザーの利用も反映する
async function refreshLedger() { if (!S.user || S.streaming) return; try { S.ledger = (await req('/state')).ledger; renderBudget(); renderMeter(); } catch { /* 無視 */ } }
setInterval(refreshLedger, 60000);
addEventListener('focus', refreshLedger);

/* ---------- rendering: shell ---------- */
function renderAll() { renderEditBar(); renderModelChip(); renderBudget(); renderMeter(); renderAtts(); renderSearch(); renderList(); renderThread(); renderSend(); renderPvBtn(); }
function renderModelChip() { const m = MODELS[S.model]; $('#btnModel').innerHTML = `<span class="mi ${S.model}">${ic(m.icon, 'sm')}</span><span>${m.name}</span>${ic('chev', 'sm chev')}`; }
function renderMem() { const b = $('#btnMem'); b.classList.toggle('on', S.mem); b.setAttribute('aria-pressed', S.mem); b.querySelector('sup').textContent = S.memCount; }
async function loadMemCount() { try { S.memCount = (await req('/memories')).memories.length; } catch { /* 0のまま */ } renderMem(); }
$('#btnMem').onclick = () => { if (S.streaming) return; S.mem = !S.mem; lsSet('pc.mem', S.mem ? '1' : '0'); renderMem(); recount(true); toast(S.mem ? 'メモリを使います' : 'メモリを使いません', 'memory'); };
function renderSearch() {
  const b = $('#btnSearch'), auto = S.config.permission === 'auto', on = auto || S.search;
  b.classList.toggle('on', on); b.classList.toggle('auto', auto); b.setAttribute('aria-pressed', on);
  b.querySelector('sup').textContent = S.config.searchUnlimited ? '∞' : S.searchMax;
}
function renderList() {
  const h = S.chats.map((c, i) => `<div class="sbi ${S.chat && c.id === S.chat.id ? 'act' : ''}" data-id="${c.id}" style="animation-delay:${Math.min(i, 10) * 35}ms" role="button" tabindex="0">${c.pinned ? `<span class="pn">${ic('pin2', 'sm')}</span>` : ic('chat', 'sm')}<span class="tt"><span class="t">${esc(c.title)}</span>${c.snip ? `<span class="snip">${esc(String(c.snip).replace(/\s+/g, ' '))}</span>` : ''}</span><button class="ib sm mo" data-more="${c.id}" aria-label="メニュー" aria-expanded="false">${ic('more', 'sm')}</button></div>`).join('');
  $('#chatList').innerHTML = h || (chatQ ? '<div class="sb-empty">見つかりません</div>' : '');
}
const busyToast = () => toast('応答の完了後に操作できます', 'lock', 'warn');
async function openChat(id) {
  if (S.streaming) return busyToast();
  cancelEdit();
  try {
    const r = await req('/chats/' + id);
    S.chat = { id: r.chat.id, title: r.chat.title, msgs: r.messages };
    pvClose(); renderAll(); recount(true); if (innerWidth <= 900) setSide(false);
  } catch (e) { toast(e.message, 'x', 'bad'); }
}
$('#chatList').addEventListener('click', (e) => {
  const mo = e.target.closest('[data-more]');
  if (mo) { e.stopPropagation(); const id = mo.dataset.more; openPop(mo, 'rowmenu', () => rowMenuHTML(id), { w: 210, align: 'right' }); return; }
  if (e.target.closest('input.rn')) return;
  const r = e.target.closest('.sbi'); if (r) openChat(r.dataset.id);
});
$('#chatList').addEventListener('dblclick', (e) => { const t = e.target.closest('.t'); if (t) startRename(t.closest('.sbi').dataset.id); });
function rowMenuHTML(id) {
  const c = S.chats.find((x) => x.id === id);
  const it = (a, i, t, cls = '') => `<button class="mrow sm ${cls}" data-rm="${a}" data-id="${id}">${ic(i, 'sm')}<span>${t}</span></button>`;
  return it('pin', 'pin2', c && c.pinned ? 'ピン留めを外す' : 'ピン留め') + it('rename', 'edit', '名前を変更') + it('md', 'download', 'Markdown') + it('json', 'download', 'JSON') + it('del', 'trash', '削除', 'dng');
}
function startRename(id) {
  if (S.streaming) return busyToast();
  const row = $('#chatList').querySelector(`.sbi[data-id="${id}"]`), c = S.chats.find((x) => x.id === id); if (!row || !c) return;
  const t = row.querySelector('.t'), inp = document.createElement('input'); inp.className = 'rn'; inp.value = c.title; inp.maxLength = 60; inp.setAttribute('aria-label', 'タイトル'); t.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const fin = async (save) => {
    if (done) return; done = true; const v = inp.value.trim();
    if (save && v && v !== c.title) { try { const r = await req('/chats/' + id, { method: 'PATCH', body: { title: v } }); c.title = r.chat.title; if (S.chat && S.chat.id === id) S.chat.title = r.chat.title; } catch (e) { toast(e.message, 'x', 'bad'); } }
    renderList();
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); fin(true); } else if (e.key === 'Escape') { e.stopPropagation(); fin(false); } });
  inp.addEventListener('blur', () => fin(true));
}
async function deleteChat(id) {
  if (S.streaming) return busyToast();
  const row = $('#chatList').querySelector(`.sbi[data-id="${id}"]`);
  try { await req('/chats/' + id, { method: 'DELETE' }); } catch (x) { return toast(x.message, 'x', 'bad'); }
  if (row) row.classList.add('gone');
  setTimeout(() => { S.chats = S.chats.filter((c) => c.id !== id); if (S.chat && S.chat.id === id) { cancelEdit(); S.chat = null; pvClose(); } renderAll(); recount(true); }, 280);
}
async function rowAction(a, id) {
  closePop();
  if (a === 'rename') return setTimeout(() => startRename(id), 60);
  if (a === 'del') return deleteChat(id);
  if (a === 'md' || a === 'json') return dlUrl(`/api/chats/${id}/export?format=${a}`);
  if (a === 'pin') { const c = S.chats.find((x) => x.id === id); try { await req('/chats/' + id, { method: 'PATCH', body: { pinned: !(c && c.pinned) } }); await refreshList(); } catch (e) { toast(e.message, 'x', 'bad'); } }
}
let qTimer;
$('#chatQ').addEventListener('input', (e) => { chatQ = e.target.value.trim(); clearTimeout(qTimer); qTimer = setTimeout(refreshList, 250); });
function setSide(v) { $('#shell').classList.toggle('sb-open', v); }
$('#btnSide').onclick = () => setSide(!$('#shell').classList.contains('sb-open'));
$('#btnSideIn').onclick = () => setSide(false); $('#scrim').onclick = () => setSide(false);
$('#btnNew').onclick = () => { if (S.streaming) return busyToast(); cancelEdit(); S.chat = null; pvClose(); renderAll(); recount(true); $('#input').focus(); if (innerWidth <= 900) setSide(false); };
$('#btnSettings').onclick = () => openSettings(); $('#sbAv').onclick = () => openSettings(isOwner() ? 'budget' : 'account');

/* ---------- 見積もり(サーバーの値をそのまま使う) ---------- */
const ZERO = { newTokens: 0, histTokens: 0, inputNano: 0, expectedNano: 0, worstNano: 0, gate: { ok: true } };
const quote = (k) => S.quotes[k] || ZERO;
function compactCmd() { if (S.edit) return null; const m = /^\/compact(?:\s+([\s\S]*))?$/.exec(S.text.trim()); return m ? { extra: (m[1] || '').trim() } : null; }
function quoteBody() {
  const cm = compactCmd(), b = { chatId: S.chat?.id || null, effort: S.effort, memory: S.mem };
  if (cm) return { ...b, compact: true, text: cm.extra, attachmentIds: [], search: false };
  return { ...b, editMsgId: S.edit?.id || null, text: S.text, attachmentIds: S.atts.filter((a) => a.status === 'ready').map((a) => a.id), search: S.search };
}
let countTimer;
function recount(immediate) {
  clearTimeout(countTimer); S.counting = true; renderMeter();
  countTimer = setTimeout(async () => {
    const seq = ++S.seq;
    if (compactCmd() && !S.chat?.id) { S.quotes = {}; S.counting = false; S.quoteErr = null; renderMeter(); renderBudget(); return; }
    try {
      const r = await req('/quote', { method: 'POST', body: quoteBody() });
      if (seq !== S.seq) return;
      S.quotes = r.models; S.ledger = r.ledger; S.cap = r.capNano; S.counting = false; S.quoteErr = null;
    } catch (e) {
      if (seq !== S.seq) return;
      S.counting = false; if (S.quoteErr !== e.message) toast(e.message, 'x', 'bad'); S.quoteErr = e.message;
    }
    renderMeter(); renderBudget();
  }, immediate ? 0 : 300);
}

/* ---------- budget gauge ---------- */
function ringColor(p) { return p >= 90 ? 'var(--bad)' : p >= 70 ? 'var(--warn)' : 'var(--accent)'; }
function ringSVG(size, r, sw, used, est) {
  const C = 2 * Math.PI * r, u = Math.min(100, used), e = Math.min(100, used + est);
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="transform:rotate(-90deg)"><circle class="tr" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${sw}"/><circle class="es" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${sw}" stroke="${ringColor(used)}" stroke-dasharray="${C * e / 100} ${C}"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${sw}" stroke="${ringColor(used)}" stroke-dasharray="${C * u / 100} ${C}"/></svg>`;
}
const usedNano = () => S.ledger.spent + S.live;
function checkAlerts() {
  if (!S.user || S.streaming) return;
  const p = pctOf(S.ledger.spent), lvl = p >= 80 ? 80 : p >= 50 ? 50 : 0; if (!lvl) return;
  const key = 'pc.alert.' + S.user; let seen = 0;
  const [r, l] = (lsGet(key) || '').split(':'); if (+r === S.ledger.resets) seen = +l || 0;
  if (lvl <= seen) return;
  lsSet(key, S.ledger.resets + ':' + lvl);
  toast('予算の' + lvl + '%に達しました', 'alert', lvl >= 80 ? 'bad' : 'warn');
}
function orbSync() {
  if (typeof Orb === 'undefined') return;
  const p = pctOf(usedNano());
  const state = p >= 90 ? 'alert' : S.streaming ? (S.phase === 'speak' ? 'speaking' : 'thinking') : p >= 80 ? 'alert' : 'idle';
  Orb.set({ state, used: p }); $('#composer')?.classList.toggle('busy', !!S.streaming);
}
const thkHTML = (label) => `<div class="thk"><span class="orbw"><canvas data-orb="mini" data-size="48"></canvas></span><div class="tt"><b>${label}</b><p class="tc"></p></div></div>`;
function renderBudget() {
  const pct = pctOf(usedNano()), q = quote(S.model), est = S.text || S.atts.length ? pctOf(q.expectedNano) : 0;
  const b = $('#btnBudget'); b.classList.toggle('warn', S.ledger.override);
  if (!b._built) { b.innerHTML = '<span class="rg"></span><span class="pc dm"></span><span class="lk" hidden></span>'; b._built = true; }
  b.querySelector('.rg').innerHTML = ringSVG(30, 12, 4, pct, est);
  tween(b.querySelector('.pc'), pct, '%');
  const lk = b.querySelector('.lk'); lk.hidden = !S.ledger.override; lk.innerHTML = ic('unlock', 'sm');
  if (S.pop && (S.pop.kind === 'budget' || S.pop.kind === 'model')) S.pop.refresh();
  orbSync(); checkAlerts();
}
function renderMeter() {
  const q = quote(S.model), u = pctOf(usedNano()), e = pctOf(q.expectedNano), w = pctOf(q.worstNano), g = q.gate || { ok: true };
  const bar = $('#cmeter'); const set = (c, l, wd) => { const el = bar.querySelector('.' + c); el.style.left = Math.max(0, l) + '%'; el.style.width = Math.max(0, Math.min(wd, 100 - l)) + '%'; };
  set('u', 0, u); set('e', u, e); set('w', u, w); bar.classList.toggle('over', u + w > 100);
  const nums = $('#nums');
  if (S.counting) { if (!nums.querySelector('.sk')) nums.innerHTML = '<span class="sk"></span><span class="sk w"></span>'; }
  else if (S.quoteErr) nums.innerHTML = `<span class="n">${ic('x', 'sm')}見積もれません</span>`;
  else {
    const over = u + w > 100;
    nums.innerHTML = `<span class="n">${ic('tok', 'sm')}<b>${dm(fmtTok(q.newTokens))}</b></span><span class="n"><b>${dm(fmtPct(u) + '%')}</b><i>→</i><b class="acc">${dm(fmtPct(u + e) + '%')}</b></span><span class="n mx ${over ? 'bad' : ''}">${ic('bolt', 'sm')}<b>${dm(fmtPct(u + w) + '%')}</b></span>`;
  }
  const lim = $('#limBox'); const show = !S.streaming && !S.counting && (g.why === 'worst' || (S.ledger.override && u + w > 100));
  lim.hidden = !show; lim.className = 'lim' + (S.ledger.override ? ' ov' : '');
  lim.innerHTML = S.ledger.override ? ic('unlock', 'sm') + '解除中' : ic('lock', 'sm') + (isOwner() ? '解除' : '制限');
  renderSend();
}
function renderSend() {
  const b = $('#btnSend'); let mode = 'idle';
  if (S.streaming) mode = 'stop';
  else {
    const q = quote(S.model), empty = !S.text.trim() && !S.atts.length;
    if (empty || S.counting || S.quoteErr || S.atts.some((a) => a.status !== 'ready') || (compactCmd() && !S.chat?.id)) mode = 'idle'; else mode = q.gate && q.gate.ok ? 'ready' : 'blocked';
  }
  b.dataset.mode = mode; b.setAttribute('aria-label', mode === 'stop' ? '停止' : '送信');
}

/* ---------- popovers ---------- */
function closePop() { if (!S.pop) return; const p = S.pop; S.pop = null; p.el.classList.add('out'); setTimeout(() => p.el.remove(), 210); if (p.anchor && p.anchor.setAttribute) p.anchor.setAttribute('aria-expanded', 'false'); }
function openPop(anchor, kind, build, { w = 340, align = 'left' } = {}) {
  if (S.pop && S.pop.kind === kind) { closePop(); return; }
  closePop();
  const el = document.createElement('div'); el.className = 'pop glass'; el.style.width = w + 'px'; $('#layer').appendChild(el);
  const r = anchor.getBoundingClientRect(); let left = align === 'right' ? r.right - w : r.left; left = Math.max(12, Math.min(innerWidth - w - 12, left));
  el.style.left = left + 'px'; el.style.top = r.bottom + 8 + 'px'; el.style.transformOrigin = (align === 'right' ? 'right' : 'left') + ' top';
  const pop = { kind, el, anchor, refresh() { const old = el.querySelector('[data-gauge]'); el.innerHTML = build(); const nw = el.querySelector('[data-gauge]'); if (nw && old && old._orb) nw.replaceWith(old); else if (nw) Orb.gauge(nw); } }; S.pop = pop; pop.refresh(); anchor.setAttribute && anchor.setAttribute('aria-expanded', 'true');
}
document.addEventListener('pointerdown', (e) => { if (S.pop && !S.pop.el.contains(e.target) && !(S.pop.anchor && S.pop.anchor.contains && S.pop.anchor.contains(e.target))) closePop(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (S.pop) closePop(); else if ($('.modal-bg')) closeModal(); else if (S.edit) cancelEdit(); else if (S.pv.open && innerWidth <= 900) pvClose(); } });

$('#btnModel').onclick = (e) => openPop(e.currentTarget, 'model', modelPopHTML, { w: 360 });
$('#btnBudget').onclick = (e) => openPop(e.currentTarget, 'budget', budgetPopHTML, { w: 340, align: 'right' });
$('#limBox').onclick = (e) => { if (isOwner()) openPop(e.currentTarget, 'budget', budgetPopHTML, { w: 340, align: 'right' }); else { shake(e.currentTarget); toast('解除は最高権限者のみです', 'lock', 'warn'); } };
const priceLabel = (k) => { const m = S.models[k]; return m ? dm(`$${m.in / 1000} / $${m.out / 1000}`) : ''; };
function modelPopHTML() {
  const rows = MODEL_KEYS.map((k) => { const m = MODELS[k], q = quote(k);
    return `<button class="mrow ${k === S.model ? 'sel' : ''}" data-model="${k}"><span class="mi ${k}">${ic(m.icon)}</span><span class="nm"><b>${m.name}</b><span>${priceLabel(k)}</span></span><span class="rt"><span class="v">${dm('+' + fmtPct(pctOf(q.expectedNano)) + '%')}</span><span class="v2">${ic('bolt', 'sm')}${dm(fmtPct(pctOf(q.worstNano)) + '%')}</span></span><span class="ck">${ic('check', 'sm')}</span></button>`; }).join('');
  const eff = S.config.effortMode === 'select'
    ? `<div class="seg3" data-eff>${['low', 'medium', 'high'].map((e) => `<button data-eff-v="${e}" class="${S.effort === e ? 'on' : ''}">${EFF_LABEL[e]}</button>`).join('')}</div>`
    : `<span class="lkc">${ic('lock', 'sm')}Effort 中</span>`;
  const auto = S.config.permission === 'auto';
  return rows + `<div class="pfoot">${eff}<span class="lkc">${ic(auto ? 'unlock' : 'lock', 'sm')}権限 ${auto ? '自動' : '手動'}</span><span class="lkc">${ic('tok', 'sm')}${fmtK(S.maxTokens[S.model] || 0)}</span></div>`;
}
function budgetPopHTML() {
  const used = usedNano(), pct = pctOf(used), tot = Math.max(1, Object.values(S.ledger.byModel).reduce((a, b) => a + b, 0));
  const colors = { sonnet: 'color-mix(in srgb,var(--accent) 100%,transparent)', opus: 'color-mix(in srgb,var(--accent) 55%,transparent)', fable: 'color-mix(in srgb,var(--accent) 26%,transparent)' };
  const stack = MODEL_KEYS.map((k) => `<i style="flex:${S.ledger.byModel[k] / tot};background:${colors[k]}"></i>`).join('');
  const rows = MODEL_KEYS.map((k) => `<div class="mrow"><span class="mi ${k}">${ic(MODELS[k].icon, 'sm')}</span><span class="nm"><b>${MODELS[k].name}</b></span><span class="rt"><span class="v">${dm(fmtUSD(usd(S.ledger.byModel[k])))}</span></span></div>`).join('');
  const lim = `<div class="mrow">${ic(S.ledger.override ? 'unlock' : 'shield')}<span class="nm"><b>最悪ケース制限</b></span><button class="sw ${S.ledger.override ? '' : 'on'}" data-lim ${isOwner() ? '' : 'disabled'} aria-label="最悪ケース制限" aria-pressed="${!S.ledger.override}" style="margin-left:auto"></button></div>`;
  const left = Math.max(0, 100 - pct), warn = pct >= 80 ? 'bad' : pct >= 50 ? 'hot' : '';
  return `<div class="gwrap ${warn}"><div class="gws" data-gauge data-size="212"></div><div class="gc">${ic('bolt', 'sm')}<span class="dm">${fmtPct(left)}%</span></div></div>
  <div class="grow2"><div class="amt">${dm(fmtUSD(Math.max(0, usd(S.cap) - usd(used))))}<small>/ ${dm('$' + usd(S.cap))}</small></div><div class="thr"><span class="${pct >= 50 ? 'hit' : ''}">${ic('alert', 'sm')}${dm('50')}</span><span class="${pct >= 80 ? 'hit bad' : ''}">${ic('alert', 'sm')}${dm('80')}</span></div></div>
  <div class="stack">${stack}</div>${rows}<div style="height:1px;background:var(--line);margin:4px 10px"></div>${lim}`;
}
document.addEventListener('click', (e) => {
  const m = e.target.closest('[data-model]');
  if (m && S.pop && S.pop.el.contains(m)) { if (S.streaming) return busyToast(); S.model = m.dataset.model; renderModelChip(); renderMeter(); renderBudget(); if (S.pop) S.pop.refresh(); setTimeout(closePop, 260); return; }
  const l = e.target.closest('[data-lim]'); if (l && !l.disabled && S.pop && S.pop.el.contains(l)) toggleLimiter();
  const ef = e.target.closest('[data-eff-v]'); if (ef && S.pop && S.pop.el.contains(ef)) { S.effort = ef.dataset.effV; lsSet('pc.effort', S.effort); S.pop.refresh(); recount(true); return; }
  const rmn = e.target.closest('[data-rm]'); if (rmn && S.pop && S.pop.el.contains(rmn)) { rowAction(rmn.dataset.rm, rmn.dataset.id); return; }
  const rg = e.target.closest('[data-rg]'); if (rg && S.pop && S.pop.kind === 'regen' && S.pop.el.contains(rg)) { const k = rg.dataset.rg, rq = S.rq; closePop(); if (rq && rq.models) { S.model = k; renderModelChip(); runStream({ k, q: rq.models[k], mode: 'regen', useSearch: S.config.permission === 'auto' ? true : rq.search }); } return; }
  const rgs = e.target.closest('[data-rgs]'); if (rgs && S.pop && S.pop.kind === 'regen' && S.pop.el.contains(rgs) && S.rq) { S.rq.search = !S.rq.search; S.rq.models = null; S.pop.refresh(); loadRegenQuote(); }
});
async function toggleLimiter() {
  if (!isOwner()) return;
  try {
    const r = await req('/ledger/limiter', { method: 'POST', body: { override: !S.ledger.override } });
    S.ledger = r.ledger; renderBudget(); recount(true);
    toast(S.ledger.override ? '制限を解除しました' : '制限を有効にしました', S.ledger.override ? 'unlock' : 'shield', S.ledger.override ? 'warn' : '');
    if (S.pop) S.pop.refresh();
  } catch (e) { toast(e.message, 'x', 'bad'); }
}

/* ---------- composer ---------- */
const input = $('#input');
// 高さのアニメーション中は scrollHeight が縮まない。測るあいだだけ無効にして、現在の高さから新しい高さへ動かす。
function autosize() {
  const cur = input.offsetHeight;
  input.style.transition = 'none'; input.style.height = '0px';
  const next = Math.min(200, Math.max(26, input.scrollHeight));
  input.style.height = cur + 'px'; void input.offsetHeight;
  input.style.transition = ''; input.style.height = next + 'px';
}
input.addEventListener('input', () => { S.text = input.value; autosize(); renderEditBar(); recount(); renderSend(); });
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !COARSE) { e.preventDefault(); send(); } });
$('#btnSend').onclick = () => send();
$('#btnSearch').onclick = () => {
  if (S.streaming) return;
  if (S.config.permission === 'auto') { toast('検索は自動です。必要なときだけ使われます', 'globe'); return; }
  S.search = !S.search; renderSearch(); recount(true);
};
$('#btnAttach').onclick = () => $('#file').click();
$('#file').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
input.addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); addFiles(f); } });
let dragN = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files') && !$('#shell').hidden) { dragN++; $('#drop').classList.add('on'); } });
addEventListener('dragleave', () => { dragN = Math.max(0, dragN - 1); if (!dragN) $('#drop').classList.remove('on'); });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); dragN = 0; $('#drop').classList.remove('on'); if (!$('#shell').hidden) addFiles([...e.dataTransfer.files]); });

function kindOf(f) {
  if (/^image\/(png|jpeg|gif|webp)$/.test(f.type)) return 'image';
  if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) return 'pdf';
  if (/\.(txt|md|csv|json|html|css|js|ts|py|xml|ya?ml|log)$/i.test(f.name) || f.type.startsWith('text/')) return 'text';
  return null;
}
async function addFiles(files) {
  for (const f of files) {
    const kind = kindOf(f);
    if (!kind) { toast(f.name + ' は対応していません', 'x', 'bad'); continue; }
    if (f.size > LIMITS[kind]) { toast(f.name + ' が大きすぎます(' + fmtK(Math.round(LIMITS[kind] / 1024)) + 'B まで)', 'x', 'bad'); continue; }
    const a = { id: 'tmp' + Math.random().toString(36).slice(2), name: f.name, kind, size: f.size, tokens: 0, status: 'counting', thumb: null, isNew: true };
    S.atts.push(a); renderAtts(); renderSend();
    try {
      if (kind === 'image') a.thumb = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsDataURL(f); });
      if (kind === 'pdf') { const s = new TextDecoder('latin1').decode(new Uint8Array(await f.arrayBuffer())); a.pages = Math.max(1, (s.match(/\/Type\s*\/Page[^s]/g) || []).length); }
      const r = await req('/upload?model=' + S.model, { method: 'POST', raw: f, headers: { 'x-filename': encodeURIComponent(f.name), 'content-type': f.type || 'application/octet-stream' } });
      a.id = r.id; a.tokens = r.tokens; a.status = 'ready';
    } catch (e) {
      S.atts = S.atts.filter((x) => x !== a); toast(e.message, 'x', 'bad');
    }
    renderAtts(); recount(true);
  }
}
function renderAtts() {
  const price = (S.models[S.model]?.in || 2000) * 1.25;
  $('#atts').innerHTML = S.atts.map((a) => {
    const pc = pctOf(a.tokens * price);
    const th = a.thumb ? `<img src="${a.thumb}" alt="">` : ic(a.kind === 'image' ? 'image' : 'doc');
    const info = a.status === 'counting' ? '<span class="sk"></span>' : `<span>${dm(fmtTok(a.tokens))} tok &nbsp;${dm('+' + fmtPct(pc) + '%')}${a.pages ? ' &nbsp;' + a.pages + 'p' : ''}</span>`;
    const html = `<div class="att" data-id="${a.id}" ${a.isNew ? '' : 'style="animation:none"'}><span class="th">${th}</span><span class="ai"><b>${esc(a.name)}</b>${info}</span><button class="ib sm" data-rm="${a.id}" aria-label="削除">${ic('x', 'sm')}</button></div>`;
    a.isNew = false; return html;
  }).join('');
}
$('#atts').addEventListener('click', (e) => {
  const r = e.target.closest('[data-rm]'); if (!r) return;
  const a = S.atts.find((x) => x.id === r.dataset.rm); S.atts = S.atts.filter((x) => x !== a);
  if (a && a.status === 'ready' && !a.fromEdit) req('/upload/' + a.id, { method: 'DELETE' }).catch(() => {});
  renderAtts(); recount(true);
});

/* ---------- send / stream ---------- */
async function send() {
  if (S.streaming) { S.abort?.abort(); return; }
  const rmem = /^\/remember\s+([\s\S]+)$/.exec(S.text.trim());
  if (rmem) {
    try { await req('/memories', { method: 'POST', body: { text: rmem[1] } }); S.text = ''; input.value = ''; autosize(); renderEditBar(); renderSend(); toast('メモリに追加しました', 'memory'); loadMemCount(); }
    catch (e) { toast(e.message, 'x', 'bad'); }
    return;
  }
  const cm = compactCmd();
  const text = S.text.trim(); if (!cm && !text && !S.atts.length) return;
  if (cm && !S.chat?.id) { shake($('#composer')); toast('まだ圧縮する会話がありません', 'layers', 'warn'); return; }
  for (let n = 0; n < 100 && (S.counting || S.atts.some((a) => a.status === 'counting')); n++) await sleep(30);
  const k = S.model, q = quote(k);
  if (S.counting || S.quoteErr || S.atts.some((a) => a.status !== 'ready')) { shake($('#composer')); return; }
  if (!q.gate.ok) { shake($('#composer')); shake($('#btnSend')); toast(q.gate.why === 'cap' ? '上限に達しています' : '最悪ケースが残額を超えています' + (isOwner() ? '' : '(解除は最高権限者のみ)'), 'lock', 'bad'); return; }

  if (cm) {
    S.text = ''; input.value = ''; autosize(); renderEditBar(); renderSend();
    return runStream({ k, q, mode: 'compact', extra: cm.extra });
  }
  const atts = S.atts.slice(), useSearch = S.search;
  if (!S.chat) S.chat = { id: null, title: (text || atts[0].name).slice(0, 28), msgs: [] };
  const edit = S.edit ? { id: S.edit.id, idx: S.edit.idx, orig: S.chat.msgs.slice() } : null;
  const um = { id: 'u' + Date.now(), role: 'user', text, ts: Date.now(), atts: atts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, size: a.size, tokens: a.tokens })) };
  if (edit) S.chat.msgs = S.chat.msgs.slice(0, edit.idx); // この発言以降は置き換わる
  S.chat.msgs.push(um);
  S.text = ''; S.atts = []; S.search = false; S.edit = null; S.draft = null; input.value = ''; autosize(); renderEditBar(); renderAtts(); renderSearch(); renderThread();
  await runStream({ k, q, text, atts, useSearch, um, edit, mode: edit ? 'edit' : 'chat' });
}

async function* readSSE(body) {
  const reader = body.getReader(), dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(raw)?.[1], data = /^data: (.*)$/m.exec(raw)?.[1];
      if (ev && data) { try { yield { ev, data: JSON.parse(data) }; } catch { /* 壊れた断片 */ } }
    }
  }
}

async function reloadChat(id) {
  const r = await req('/chats/' + id);
  S.chat = { id: r.chat.id, title: r.chat.title, msgs: r.messages };
  renderThread();
}
function refreshMeta() {
  if (!S.chat) return;
  S.chat.msgs.forEach((m) => { if (m.role !== 'ai') return; const el = $('#thread').querySelector(`.msg.ai[data-id="${m.id}"]`); if (el) finishAiDOM(el, m, true); });
}

async function runStream({ k, q, text = '', atts = [], useSearch = false, um = null, edit = null, mode = 'chat', extra = '' }) {
  const chat = S.chat;
  let ai, el, snap = null;
  if (mode === 'regen') {
    ai = chat.msgs[chat.msgs.length - 1];
    snap = { text: ai.text, meta: ai.meta, model: ai.model, ver: ai.ver, vers: ai.vers };
    ai.text = ''; ai.meta = {}; ai.model = k;
    el = $('#thread').querySelector(`.msg.ai[data-id="${ai.id}"]`);
    el.querySelector('.srcs-slot').innerHTML = ''; el.querySelector('.ai-meta-slot').innerHTML = '';
  } else if (mode === 'compact') {
    ai = { id: 'a' + Date.now(), role: 'ai', text: '', model: k, ts: Date.now(), meta: { kind: 'summary' }, atts: [] };
    el = addSumDOM(ai);
  } else {
    ai = { id: 'a' + Date.now(), role: 'ai', text: '', model: k, ts: Date.now(), meta: {}, atts: [] };
    chat.msgs.push(ai); el = addAiDOM(ai);
  }
  const body = el.querySelector('.ai-body');
  S.streaming = true; const ctl = new AbortController(); S.abort = ctl; renderSend(); renderMeter();
  S.phase = 'think'; body.innerHTML = thkHTML('推論中'); Orb.scan(body); orbSync(); el.querySelector('.think-slot')?.replaceChildren(); scrollEnd(true);
  if (mode !== 'compact') { $('#pvLive').classList.add('on'); renderPvBtn(); }

  const outPrice = (S.models[k]?.out || 10000);
  let raf = 0, serverDone = null, failure = null, gotMeta = false;
  const paint = () => {
    raf = 0; renderAiBody(body, ai, true);
    S.live = q.inputNano + estText(ai.text) * outPrice + (ai.meta.searches || 0) * 1e7;
    renderBudget(); renderMeter();
    if (mode !== 'compact') { const h = extractHtml(ai.text); if (h) pvStream(h.html, h.done); }
    scrollEnd();
  };
  const payload = { chatId: chat.id, model: k, effort: S.effort, memory: S.mem, search: useSearch,
    ...(mode === 'regen' ? { regenId: ai.id } : mode === 'compact' ? { compact: true, text: extra } : { editMsgId: edit?.id || null, text, attachmentIds: atts.map((a) => a.id) }) };
  try {
    const r = await fetch('/api/send', { method: 'POST', credentials: 'same-origin', signal: ctl.signal, headers: { 'x-pc': '1', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) {
      let j = null; try { j = await r.json(); } catch { /* */ }
      if (r.status === 401) sessionExpired();
      throw new ApiError(j?.message || 'エラー (' + r.status + ')', r.status, j?.error);
    }
    for await (const { ev, data } of readSSE(r.body)) {
      if (ev === 'meta') {
        gotMeta = true;
        if (um) { // 仮IDを本物のIDに置き換え、編集ボタンを出す
          const ue = document.querySelector(`.msg.user[data-id="${um.id}"]`); um.id = data.userMsgId;
          if (ue) { ue.dataset.id = um.id; const ur = ue.querySelector('.urow'); if (ur && !ur.querySelector('.ed')) ur.insertAdjacentHTML('afterbegin', editBtn(um.id)); }
        }
        if (mode !== 'regen') { ai.id = data.aiMsgId; el.dataset.id = ai.id; }
        if (mode === 'chat' || mode === 'edit') if (!chat.id) { chat.id = data.chatId; S.chats.unshift({ id: data.chatId, title: data.title, updated: Date.now() }); renderList(); }
        if (data.overridden) toast('残額に合わせて出力を ' + fmtTok(data.maxTokens) + ' トークンまでに絞りました', 'unlock', 'warn');
      } else if (ev === 'status') {
        ai.meta.searches = data.n; body.innerHTML = thkHTML('検索中'); Orb.scan(body);
      } else if (ev === 'sources') {
        ai.meta.sources = data.items; if (!raf) raf = requestAnimationFrame(paint);
      } else if (ev === 'think') {
        ai.meta.think = (ai.meta.think || '') + data.t; if (!raf) raf = requestAnimationFrame(paint);
      } else if (ev === 'cite') {
        (ai.meta.cites = ai.meta.cites || []).push([data.at, data.i]);
      } else if (ev === 'text') {
        if (S.phase !== 'speak') { S.phase = 'speak'; orbSync(); } ai.text += data.t; if (!raf) raf = requestAnimationFrame(paint);
      } else if (ev === 'done') serverDone = data;
      else if (ev === 'error') failure = data;
    }
  } catch (e) {
    if (e.name !== 'AbortError') failure = failure || { message: e.message, notSent: !gotMeta };
  }
  cancelAnimationFrame(raf);
  S.live = 0; S.streaming = false; S.phase = null; S.abort = null; $('#pvLive').classList.remove('on'); orbSync();

  if (!gotMeta && failure) {
    // 送信前に弾かれた: 画面を元に戻す
    if (mode === 'regen') { Object.assign(ai, snap); renderThread(); }
    else if (mode === 'compact') { el.remove(); }
    else {
      if (edit) { chat.msgs = edit.orig; S.edit = { id: edit.id, idx: edit.idx }; S.draft = { text: '', atts: [], search: false }; }
      else { chat.msgs = chat.msgs.filter((m) => m !== ai && m !== um); if (!chat.msgs.length && !chat.id) S.chat = null; }
      S.text = text; input.value = text; S.atts = atts; S.search = useSearch; autosize();
    }
    renderAll(); recount(true); toast(failure.message, 'lock', 'bad'); return;
  }
  if (serverDone) {
    S.ledger = serverDone.ledger;
    ai.meta = { ...ai.meta, cost: serverDone.costNano, pct: serverDone.pct, searches: serverDone.searches, stopped: serverDone.stopped, estimated: serverDone.estimated, truncated: serverDone.truncated, rid: serverDone.rid, effort: serverDone.effort };
    if (mode === 'compact') {
      if (serverDone.compacted) { try { await reloadChat(chat.id); } catch { /* 次に開いたとき反映される */ } }
      else { el.remove(); toast('圧縮は完了しなかったので、会話はそのままです', 'layers', 'warn'); }
    } else {
      if (mode === 'regen') { ai.ver = serverDone.ver; ai.vers = (snap.vers || 1) + 1; ai.meta.ver = serverDone.ver; }
      renderAiBody(body, ai, false); finishAiDOM(el, ai); refreshMeta();
    }
  } else {
    // 停止・切断・途中エラー: 精算結果はサーバーに保存されている。少し待って読み直す。
    if (failure) toast(failure.message, 'x', 'bad');
    await sleep(900);
    try { await loadState(); if (chat.id) await reloadChat(chat.id); } catch { /* 無視 */ }
    renderThread();
  }
  const h = extractHtml((S.chat?.msgs.at(-1) || ai).text || ''); if (h && h.done && mode !== 'compact') { S.pv.vi = -1; pvStream(h.html, true, true); }
  await refreshList();
  renderBudget(); renderPvBtn(); recount(true); scrollEnd();
}

/* ---------- thread ---------- */
function renderThread() {
  const t = $('#thread'), c = S.chat;
  if (!c || !c.msgs.length) {
    t.innerHTML = `<div class="empty"><div class="orb-wrap"><canvas data-orb="hero" data-size="132"></canvas></div><div class="sugg"><button class="sg" data-sg="html">${ic('code')}HTML</button><button class="sg" data-sg="web">${ic('globe')}Web</button><button class="sg" data-sg="file">${ic('clip')}ファイル</button></div></div>`; Orb.scan(t); return;
  }
  t.innerHTML = '';
  c.msgs.forEach((m) => { if (m.role === 'user') t.insertAdjacentHTML('beforeend', userHTML(m)); else { const el = isSum(m) ? addSumDOM(m, true) : addAiDOM(m, true); renderAiBody(el.querySelector('.ai-body'), m, false); finishAiDOM(el, m, true); } });
  scrollEnd(true); markEdit();
}
$('#thread').addEventListener('click', (e) => {
  const sg = e.target.closest('[data-sg]');
  if (sg) {
    const k = sg.dataset.sg;
    if (k === 'html') input.value = '時計のHTMLを作って'; else if (k === 'web') { input.value = '今日の主要ニュースを調べて'; S.search = true; renderSearch(); } else { $('#file').click(); return; }
    S.text = input.value; autosize(); recount(true); input.focus(); return;
  }
  const ed = e.target.closest('[data-edit]'); if (ed) return startEdit(ed.dataset.edit);
  const afc = e.target.closest('.afc');
  if (afc) { const f = fileSrc.get(afc.dataset.k); if (!f) return; if (e.target.closest('[data-act="fdl"]')) return dlFile(f); return fileOpen(f); }
  const b = e.target.closest('[data-act]'); if (!b) return; const code = b.closest('.code');
  if (b.dataset.act === 'regen') return openRegen(b);
  if (b.dataset.act === 'ver') return switchVer(+b.dataset.d);
  if (b.dataset.act === 'rid') { try { navigator.clipboard.writeText(b.dataset.rid); } catch { /* */ } toast('リクエストIDをコピーしました', 'check'); return; }
  if (b.dataset.act === 'copy') { const txt = code ? code.querySelector('code').textContent : b.closest('.msg').querySelector('.ai-body').innerText; try { navigator.clipboard.writeText(txt); } catch { /* */ } b.innerHTML = ic('check', 'sm'); setTimeout(() => { b.innerHTML = ic('copy', 'sm'); }, 1400); }
  if (b.dataset.act === 'pv') pvOpen(code.querySelector('code').textContent);
  if (b.dataset.act === 'dl' && code) { const lang = (code.dataset.lang || 'text').toLowerCase(); dlBlob(new Blob([code.querySelector('code').textContent], { type: 'text/plain;charset=utf-8' }), 'code.' + (EXT[lang] || (/^[a-z0-9]{1,5}$/.test(lang) ? lang : 'txt'))); }
  if (b.dataset.act === 'mmd' && code) { const pre = code.querySelector('pre'); pre.hidden = !pre.hidden; }
});
function userHTML(m) {
  const at = (m.atts || []).map((a) => {
    const ext = (a.name.split('.').pop() || '').slice(0, 4).toUpperCase();
    const th = a.kind === 'image' && a.id ? `<img src="/api/attachments/${esc(a.id)}" alt="" loading="lazy">` : `<span class="fx">${esc(ext || 'FILE')}</span>`;
    const sz = a.size ? (a.size < 1024 * 1024 ? Math.max(1, Math.round(a.size / 1024)) + ' KB' : (a.size / 1024 / 1024).toFixed(1) + ' MB') : '';
    return `<a class="fcard" ${a.id ? `href="/api/attachments/${esc(a.id)}" target="_blank" rel="noopener noreferrer"` : ''} title="${esc(a.name)}"><span class="ft">${th}</span><span class="fi"><b>${esc(a.name)}</b><small>${[a.kind === 'pdf' ? 'PDF' : a.kind === 'image' ? '画像' : 'テキスト', sz, a.tokens ? fmtK(a.tokens) + ' tok' : ''].filter(Boolean).join(' · ')}</small></span></a>`;
  }).join('');
  return `<div class="msg user ${m.compacted ? 'compacted' : ''}" data-id="${m.id}">${at ? `<div class="arow">${at}</div>` : ''}<div class="urow">${m.id && m.id.length === 16 && !m.compacted ? editBtn(m.id) : ''}${m.text ? `<div class="bubble">${esc(m.text)}</div>` : ''}</div></div>`;
}
const editBtn = (id) => `<button class="ib sm ed" data-edit="${id}" aria-label="編集">${ic('edit', 'sm')}</button>`;

/* ---------- 送信後の編集: 下の入力欄に戻して、同じ見積もりで送り直す。この発言以降は置き換わる ---------- */
function renderEditBar() {
  const b = $('#ebar'), cm = compactCmd();
  b.classList.toggle('cmp', !!cm);
  if (S.edit) { b.hidden = false; b.innerHTML = ic('edit', 'sm') + '<span>編集中</span><span class="grow"></span><button class="ib sm" data-cancel-edit aria-label="編集をやめる">' + ic('x', 'sm') + '</button>'; }
  else if (cm) { b.hidden = false; b.innerHTML = ic('layers', 'sm') + '<span>会話を要約して続ける</span><span class="grow"></span><button class="ib sm" data-clear-cmd aria-label="やめる">' + ic('x', 'sm') + '</button>'; }
  else if (/^\/\w*$/.test(S.text) && (('/compact'.startsWith(S.text) && S.chat?.id) || '/remember'.startsWith(S.text))) {
    b.hidden = false;
    b.innerHTML = (S.chat?.id && '/compact'.startsWith(S.text) ? `<button class="chipb" data-fill-compact>${ic('layers', 'sm')}<span>/compact</span></button>` : '') + ('/remember'.startsWith(S.text) ? `<button class="chipb" data-fill-remember>${ic('memory', 'sm')}<span>/remember</span></button>` : '');
  }
  else { b.hidden = true; b.innerHTML = ''; }
}
function markEdit() {
  [...$('#thread').children].forEach((el, i) => { el.classList.toggle('faded', !!S.edit && i > S.edit.idx); el.classList.toggle('editing', !!S.edit && i === S.edit.idx); });
}
function startEdit(id) {
  if (S.streaming) return busyToast();
  const c = S.chat; if (!c) return;
  const idx = c.msgs.findIndex((m) => m.id === id && m.role === 'user'); if (idx < 0) return;
  const m = c.msgs[idx];
  if (!S.edit) S.draft = { text: S.text, atts: S.atts, search: S.search };
  S.edit = { id, idx };
  S.text = m.text || ''; input.value = S.text;
  S.atts = (m.atts || []).filter((a) => a.id).map((a) => ({ id: a.id, name: a.name, kind: a.kind, size: a.size || 0, tokens: a.tokens || 0, status: 'ready', thumb: null, fromEdit: true, isNew: true }));
  S.search = false;
  renderEditBar(); markEdit(); autosize(); renderAtts(); renderSearch(); renderSend(); recount(true);
  input.focus(); input.setSelectionRange(S.text.length, S.text.length);
  const row = $('#thread').children[idx]; if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function cancelEdit() {
  if (!S.edit) return;
  const d = S.draft || { text: '', atts: [], search: false };
  S.atts.filter((a) => !a.fromEdit && a.status === 'ready').forEach((a) => req('/upload/' + a.id, { method: 'DELETE' }).catch(() => {}));
  S.edit = null; S.draft = null;
  S.text = d.text; input.value = d.text; S.atts = d.atts; S.search = d.search;
  renderEditBar(); markEdit(); autosize(); renderAtts(); renderSearch(); renderSend(); recount(true);
}
$('#ebar').addEventListener('click', (e) => {
  if (e.target.closest('[data-cancel-edit]')) return cancelEdit();
  if (e.target.closest('[data-clear-cmd]')) { S.text = ''; input.value = ''; autosize(); renderEditBar(); recount(true); renderSend(); return; }
  if (e.target.closest('[data-fill-remember]')) { S.text = '/remember '; input.value = S.text; autosize(); renderEditBar(); renderSend(); input.focus(); return; }
  if (e.target.closest('[data-fill-compact]')) { S.text = '/compact'; input.value = S.text; autosize(); renderEditBar(); recount(true); renderSend(); input.focus(); }
});
function addAiDOM(m, quiet) { const d = document.createElement('div'); d.className = 'msg ai' + (m.compacted ? ' compacted' : ''); d.dataset.id = m.id; if (quiet) d.style.animation = 'none'; d.innerHTML = '<div class="think-slot"></div><div class="srcs-slot"></div><div class="ai-body"></div><div class="ai-meta-slot"></div>'; $('#thread').appendChild(d); return d; }
function addSumDOM(m, quiet) { const d = document.createElement('div'); d.className = 'msg ai sumcard'; d.dataset.id = m.id; if (quiet) d.style.animation = 'none'; d.innerHTML = `<div class="sh">${ic('layers', 'sm')}<span>要約</span></div><div class="srcs-slot" hidden></div><div class="ai-body"></div><div class="ai-meta-slot"></div>`; $('#thread').appendChild(d); return d; }
function updateThink(el, m, streaming) {
  const slot = el && el.querySelector('.think-slot'); if (!slot) return;
  const t = (m.meta && m.meta.think) || '';
  let box = slot.querySelector('.think-box');
  const thinking = streaming && !m.text;
  if (thinking) { const tc = el.querySelector('.thk .tc'); if (tc && t) tc.textContent = t.replace(/\s+/g, ' ').trim().slice(-240); if (box) box.remove(); return; }
  if (!t) { if (box) box.remove(); return; }
  if (!box) {
    box = document.createElement('details'); box.className = 'think-box';
    box.innerHTML = `<summary>${ic('bulb', 'sm')}<span class="tl"></span><svg class="i sm chev"><use href="#i-chev"/></svg></summary><div class="tb"></div>`;
    box.querySelector('summary').addEventListener('click', () => { box.dataset.user = '1'; });
    slot.appendChild(box);
  }
  box.querySelector('.tl').textContent = '思考';
  box.classList.remove('live');
  const tb = box.querySelector('.tb'); if (tb.textContent !== t) tb.textContent = t;
}
function renderAiBody(body, m, streaming) {
  const el = body.closest('.msg'); updateThink(el, m, streaming);
  if (!m.text && streaming) return;
  body.innerHTML = md(m.text, m.meta && m.meta.cites, m.meta && m.meta.sources) + (m.meta?.error && !streaming ? `<p style="color:var(--bad)">${esc(m.meta.error)}</p>` : '') + (streaming ? '<span class="caret"></span>' : '');
  body.querySelectorAll('.code.open pre').forEach((p) => { p.scrollTop = p.scrollHeight; });
  hydrateMermaid(body);
}
function hostOf(u) { try { return new URL(u).host; } catch { return u; } }
function finishAiDOM(el, m, quiet) {
  const meta = m.meta || {};
  const src = (meta.sources || []).map((s, i) => `<a class="src" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.title)}"><b>${i + 1}</b>${esc(hostOf(s.url))}</a>`).join('');
  el.querySelector('.srcs-slot').innerHTML = src ? `<div class="srcs">${src}</div>` : '';
  const last = !!S.chat && S.chat.msgs[S.chat.msgs.length - 1] === m && !m.compacted && !isSum(m) && !S.streaming;
  const tags = [];
  if (meta.cost != null) tags.push(`<span class="tg">${ic(MODELS[m.model || 'sonnet'].icon, 'sm')}${dm(fmtUSD(usd(meta.cost)))}<span>${dm(fmtPct(meta.pct ?? pctOf(meta.cost)) + '%')}</span></span>`);
  if (meta.searches) tags.push(`<span class="tg">${ic('globe', 'sm')}${meta.searches}</span>`);
  if (meta.stopped) tags.push(`<span class="tg" title="停止">${ic('stop', 'sm')}</span>`);
  if (meta.truncated) tags.push(`<span class="tg bad" title="最大出力に達して途中で終わりました">${ic('tok', 'sm')}</span>`);
  if (last && m.vers > 1) tags.push(`<span class="ver"><button data-act="ver" data-d="-1" aria-label="前の版" ${m.ver <= 1 ? 'disabled' : ''}>‹</button><b>${m.ver}/${m.vers}</b><button data-act="ver" data-d="1" aria-label="次の版" ${m.ver >= m.vers ? 'disabled' : ''}>›</button></span>`);
  const btns = (last ? `<button class="ib sm" data-act="regen" aria-label="再生成">${ic('refresh', 'sm')}</button>` : '')
    + `<button class="ib sm" data-act="copy" aria-label="コピー">${ic('copy', 'sm')}</button>`
    + (meta.rid ? `<button class="ib sm" data-act="rid" data-rid="${esc(meta.rid)}" title="${esc(meta.rid)}" aria-label="リクエストIDをコピー">${ic('id', 'sm')}</button>` : '');
  el.querySelector('.ai-meta-slot').innerHTML = `<div class="ai-meta" ${quiet ? 'style="animation:none;opacity:1"' : ''}>${tags.join('')}${btns}</div>`;
}
/* ---------- 再生成と版の切り替え ---------- */
async function openRegen(anchor) {
  if (S.streaming) return busyToast();
  const c = S.chat; if (!c || c.msgs.length < 2) return;
  const um = c.msgs[c.msgs.length - 2];
  if (!um || um.role !== 'user' || c.msgs[c.msgs.length - 1].role !== 'ai') return;
  S.rq = { um, search: false, models: null, err: null };
  openPop(anchor, 'regen', regenPopHTML, { w: 360 });
  await loadRegenQuote();
}
async function loadRegenQuote() {
  const rq = S.rq; if (!rq) return;
  try {
    const r = await req('/quote', { method: 'POST', body: { chatId: S.chat.id, editMsgId: rq.um.id, text: rq.um.text || '', attachmentIds: (rq.um.atts || []).map((a) => a.id), search: rq.search, effort: S.effort, memory: S.mem } });
    if (S.rq !== rq) return; rq.models = r.models; rq.err = null; S.ledger = r.ledger;
  } catch (e) { rq.err = e.message; }
  if (S.pop && S.pop.kind === 'regen') S.pop.refresh();
}
function regenPopHTML() {
  const rq = S.rq;
  if (!rq || !rq.models) return `<div class="sb-empty">${rq && rq.err ? esc(rq.err) : '<span class="sk w"></span>'}</div>`;
  const rows = MODEL_KEYS.map((k) => { const m = MODELS[k], q = rq.models[k], ok = q.gate.ok;
    return `<button class="mrow ${ok ? '' : 'off'}" data-rg="${k}" ${ok ? '' : 'disabled'}><span class="mi ${k}">${ic(m.icon)}</span><span class="nm"><b>${m.name}</b><span>${priceLabel(k)}</span></span><span class="rt"><span class="v">${dm('+' + fmtPct(pctOf(q.expectedNano)) + '%')}</span><span class="v2">${ic('bolt', 'sm')}${dm(fmtPct(pctOf(q.worstNano)) + '%')}</span></span></button>`; }).join('');
  const foot = S.config.permission === 'auto' ? '' : `<div class="pfoot"><button class="tog ${rq.search ? 'on' : ''}" data-rgs aria-pressed="${rq.search}" aria-label="Web検索">${ic('globe')}<sup>${S.config.searchUnlimited ? '∞' : S.searchMax}</sup></button></div>`;
  return rows + foot;
}
async function switchVer(d) {
  if (S.streaming) return busyToast();
  const c = S.chat, m = c && c.msgs[c.msgs.length - 1]; if (!m || m.role !== 'ai') return;
  const n = (m.ver || 1) + d; if (n < 1 || n > m.vers) return;
  try {
    const r = await req('/messages/' + m.id + '/version', { method: 'POST', body: { n } });
    m.text = r.text; m.model = r.model; m.meta = r.meta; m.ver = r.ver;
    const el = $('#thread').querySelector(`.msg.ai[data-id="${m.id}"]`); renderAiBody(el.querySelector('.ai-body'), m, false); finishAiDOM(el, m, true);
    const h = extractHtml(m.text); if (h && h.done) { S.pv.vi = -1; pvStream(h.html, true, true); }
    renderPvBtn(); recount(true);
  } catch (e) { toast(e.message, 'x', 'bad'); }
}
function scrollEnd(force) { const s = $('#scroll'); const near = s.scrollHeight - s.scrollTop - s.clientHeight < 160; if (force || near) s.scrollTo({ top: s.scrollHeight, behavior: force ? 'auto' : 'smooth' }); }
$('#scroll').addEventListener('scroll', (e) => $('#top').classList.toggle('scrolled', e.target.scrollTop > 8));

/* ---------- markdown(最小限) ---------- */
function inline(s) { s = esc(s); s = s.replace(/`([^`]+)`/g, '<code>$1</code>'); s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'); return s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'); }
const TROW = /^\s*\|.*\|\s*$/, TSEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (ln) => ln.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
function tableHTML(rows) {
  const al = cells(rows[1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
  const td = (t, c, i) => `<${t}${al[i] ? ` style="text-align:${al[i]}"` : ''}>${inline(c)}</${t}>`;
  const head = '<tr>' + cells(rows[0]).map((c, i) => td('th', c, i)).join('') + '</tr>';
  const body = rows.slice(2).map((r) => '<tr>' + cells(r).map((c, i) => td('td', c, i)).join('') + '</tr>').join('');
  return `<div class="tbl"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}
function para(s) {
  let out = '', buf = [], ul = false, ol = false;
  const fp = () => { if (buf.length) { out += '<p>' + buf.map(inline).join('<br>') + '</p>'; buf = []; } };
  const fl = () => { if (ul) { out += '</ul>'; ul = false; } if (ol) { out += '</ol>'; ol = false; } };
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]; let m;
    if (!ln.trim()) { fp(); fl(); continue; }
    if (TROW.test(ln) && i + 1 < lines.length && TSEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      fp(); fl(); const rows = [ln, lines[i + 1]]; i += 2;
      while (i < lines.length && TROW.test(lines[i])) rows.push(lines[i++]);
      i--; out += tableHTML(rows); continue;
    }
    if ((m = ln.match(/^(#{1,3})\s+(.*)/))) { fp(); fl(); const n = m[1].length + 2; out += `<h${n}>${inline(m[2])}</h${n}>`; continue; }
    if ((m = ln.match(/^\s*[-*]\s+(.*)/))) { fp(); if (ol) { out += '</ol>'; ol = false; } if (!ul) { out += '<ul>'; ul = true; } out += '<li>' + inline(m[1]) + '</li>'; continue; }
    if ((m = ln.match(/^\s*\d+\.\s+(.*)/))) { fp(); if (ul) { out += '</ul>'; ul = false; } if (!ol) { out += '<ol>'; ol = true; } out += '<li>' + inline(m[1]) + '</li>'; continue; }
    fl(); buf.push(ln);
  }
  fp(); fl(); return out;
}
/* 数式(KaTeX)と図(Mermaid)は、必要になったときだけ読み込む。どちらも自分のドメインから配る(CSP は 'self' のまま)。 */
const loaded = {};
function loadOnce(key, loader) { return loaded[key] || (loaded[key] = loader().catch((e) => { delete loaded[key]; throw e; })); }
const loadScript = (src) => new Promise((ok, ng) => { const t = document.createElement('script'); t.src = src; t.onload = ok; t.onerror = () => ng(new Error(src)); document.head.appendChild(t); });
const loadCss = (href) => new Promise((ok) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.onload = ok; l.onerror = ok; document.head.appendChild(l); });
const katexReady = () => loadOnce('katex', async () => { await Promise.all([loadCss('/vendor/katex/katex.min.css'), loadScript('/vendor/katex/katex.min.js')]); });
const mermaidReady = () => loadOnce('mermaid', async () => {
  await loadScript('/vendor/mermaid.min.js');
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral', fontFamily: 'inherit', flowchart: { htmlLabels: false } });
});
const mathCache = new Map();
function texHTML(tex, display) {
  const k = (display ? 'D' : 'I') + tex;
  if (mathCache.has(k)) return mathCache.get(k);
  if (!window.katex) { katexReady().then(rerenderAll).catch(() => {}); return `<span class="math-pending">${esc(tex)}</span>`; }
  let h; try { h = window.katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'html' }); } catch { h = `<code>${esc(tex)}</code>`; }
  h = display ? `<div class="math-d">${h}</div>` : h;
  if (mathCache.size > 400) mathCache.clear();
  mathCache.set(k, h); return h;
}
// 本文から数式を抜き出して目印に置き換える($5と$10のような金額は数式にしない)。閉じていない数式(ストリーミング途中)はそのまま。
function protectMath(t, list) {
  const put = (tex, display) => { list.push([tex, display]); return '\uE010' + (list.length - 1) + '\uE011'; };
  t = t.replace(/\$\$([\s\S]+?)\$\$/g, (_, x) => put(x.trim(), true));
  t = t.replace(/\\\[([\s\S]+?)\\\]/g, (_, x) => put(x.trim(), true));
  t = t.replace(/\\\(([\s\S]+?)\\\)/g, (_, x) => put(x.trim(), false));
  t = t.replace(/\$([^\s$](?:[^$\n]*[^\s$])?)\$(?!\d)/g, (all, x) => {
    if (/^\d/.test(x)) return /^[\d.,\s+\-*/^_{}()=\\<>a-zA-Z]+$/.test(x) && (/[\\^_{}=+*/<>-]/.test(x) || /^\d[\d.,]*$/.test(x)) ? put(x, false) : all;
    return /[\\^_{}=+*/<>-]/.test(x) || /^[A-Za-z]{1,2}$/.test(x) ? put(x, false) : all;
  });
  return t;
}
const EXT = { javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', html: 'html', css: 'css', json: 'json', markdown: 'md', md: 'md', bash: 'sh', sh: 'sh', shell: 'sh', sql: 'sql', yaml: 'yml', yml: 'yml', xml: 'xml', csv: 'csv', jsx: 'jsx', tsx: 'tsx', java: 'java', c: 'c', cpp: 'cpp', go: 'go', rust: 'rs', ruby: 'rb', php: 'php', swift: 'swift', kotlin: 'kt', mermaid: 'mmd', text: 'txt' };
EXT.svg = 'svg'; EXT.rs = 'rs'; EXT.txt = 'txt';
const KIND = { html: 'HTML', md: 'ドキュメント', py: 'Python', js: 'JavaScript', ts: 'TypeScript', json: 'JSON', css: 'CSS', sh: 'シェル', sql: 'SQL', yml: 'YAML', svg: 'SVG', csv: 'CSV', jsx: 'JSX', tsx: 'TSX', java: 'Java', c: 'C', cpp: 'C++', go: 'Go', rs: 'Rust', rb: 'Ruby', php: 'PHP', swift: 'Swift', kt: 'Kotlin', xml: 'XML', txt: 'テキスト' };
const fileSrc = new Map();
function fileInfo(lang, info) {
  const m = /(?:file(?:name)?|title|name)\s*=\s*["']?([^"'\s]+)/i.exec(info || '') || /^\s*([\w.-]+\.[A-Za-z0-9]{1,6})\s*$/.exec(info || '');
  const name = m ? m[1].replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) : '';
  const l = lang.toLowerCase(), ext = (name.includes('.') ? name.split('.').pop() : (EXT[l] || (/^[a-z0-9]{1,5}$/.test(l) ? l : 'txt'))).toLowerCase();
  return { name: name || ({ html: 'page', md: 'document' }[ext] || 'code') + '.' + ext, ext, named: !!name };
}
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const mmdSrc = new Map(), mmdSvg = new Map();
function asCardFor(lang, info, code) {
  const l = lang.toLowerCase(); if (l === 'mermaid') return false;
  const n = code ? code.replace(/\n$/, '').split('\n').length : 0;
  if (/(?:file(?:name)?|title|name)\s*=|^\s*[\w.-]+\.[A-Za-z0-9]{1,6}\s*$/i.test(info || '')) return true;
  if (['html', 'svg', 'markdown', 'md'].includes(l)) return n >= 8;
  return n >= 25;
}
function md(src, cites, sources) {
  // 引用: 本文の該当位置に目印を差し込み、整形後に番号つきのリンクへ置き換える
  if (cites && cites.length) {
    const by = new Map(); for (const [at, i] of cites) { if (!by.has(at)) by.set(at, []); if (!by.get(at).includes(i)) by.get(at).push(i); }
    for (const at of [...by.keys()].sort((a, b) => b - a)) { if (at > src.length) continue; src = src.slice(0, at) + '\uE020' + by.get(at).map((i) => i + 1).join(',') + '\uE021' + src.slice(at); }
  }
  const math = [];
  const re = /```([\w+#-]*)([^\n`]*)\n?([\s\S]*?)(```|$)/g; let last = 0, m, out = '';
  const text = (t) => para(protectMath(t, math));
  while ((m = re.exec(src))) {
    if (m.index > last) out += text(src.slice(last, m.index));
    const lang = m[1] || 'text', info = m[2], open = m[4] !== '```', code = m[3].replace(/\uE020[\d,]+\uE021/g, '');
    if (lang === 'mermaid' && !open) {
      const k = hash(code); mmdSrc.set(k, code);
      out += `<div class="code mmd" data-lang="mermaid" data-k="${k}"><div class="code-h">${ic('layers', 'sm')}<span>図</span><span class="grow"></span><button class="ib sm" data-act="mmd" aria-label="コードを表示">${ic('doc', 'sm')}</button><button class="ib sm" data-act="copy" aria-label="コピー">${ic('copy', 'sm')}</button></div><div class="mmd-v">${mmdSvg.get(k) || '<span class="sk w"></span>'}</div><pre hidden><code>${esc(code)}</code></pre></div>`;
    } else if (asCardFor(lang, info, code)) {
      const fi = fileInfo(lang, info), n = code ? code.replace(/\n$/, '').split('\n').length : 0, k = hash(fi.name + '\u0000' + code);
      if (fileSrc.size > 300) fileSrc.clear();
      fileSrc.set(k, { name: fi.name, ext: fi.ext, lang: lang.toLowerCase(), code });
      out += `<div class="afc ${open ? 'live' : ''}" data-k="${k}" role="button" tabindex="0" aria-label="${esc(fi.name)}を開く"><span class="afi"><span>${esc(fi.ext.slice(0, 4))}</span></span><span class="afm"><b>${esc(fi.name)}</b><small>${esc(KIND[fi.ext] || fi.ext.toUpperCase())} · ${n}行${open ? ' · 作成中' : ''}</small></span><span class="afa"><button class="ib sm" data-act="fdl" aria-label="ダウンロード">${ic('download', 'sm')}</button><svg class="i sm chv"><use href="#i-chevr"/></svg></span></div>`;
    } else {
      const n = code ? code.replace(/\n$/, '').split('\n').length : 0;
      out += `<div class="code ${open ? 'open' : ''}" data-lang="${esc(lang)}"><div class="code-h"><span>${esc(lang)}</span>${n > 5 ? `<span class="ln">${n}行</span>` : ''}<span class="grow"></span>${lang === 'html' ? `<button class="ib sm" data-act="pv" aria-label="プレビュー">${ic('eye', 'sm')}</button>` : ''}<button class="ib sm" data-act="dl" aria-label="ファイルとして保存">${ic('download', 'sm')}</button><button class="ib sm" data-act="copy" aria-label="コピー">${ic('copy', 'sm')}</button></div><pre><code>${esc(code)}</code></pre></div>`;
    }
    last = re.lastIndex;
  }
  if (last < src.length) out += text(src.slice(last));
  out = out.replace(/\uE010(\d+)\uE011/g, (_, i) => { const x = math[+i]; return texHTML(x[0], x[1]); });
  out = out.replace(/\uE020([\d,]+)\uE021/g, (_, ns) => `<span class="cite">${ns.split(',').map((n) => { const so = sources && sources[+n - 1]; return so ? `<a href="${esc(so.url)}" target="_blank" rel="noopener noreferrer" title="${esc(so.title)}">${n}</a>` : `<i>${n}</i>`; }).join('')}</span>`);
  return out;
}
async function hydrateMermaid(root) {
  const nodes = [...root.querySelectorAll('.mmd[data-k]')].filter((n) => !mmdSvg.has(n.dataset.k)); if (!nodes.length) return;
  try { await mermaidReady(); } catch { nodes.forEach((n) => { n.querySelector('.mmd-v').innerHTML = '<span class="mmd-err">図を読み込めませんでした</span>'; }); return; }
  for (const n of nodes) {
    const k = n.dataset.k; if (mmdSvg.has(k)) { n.querySelector('.mmd-v').innerHTML = mmdSvg.get(k); continue; }
    try {
      const { svg } = await window.mermaid.render('mm' + k + Date.now().toString(36), mmdSrc.get(k) || '');
      mmdSvg.set(k, svg); if (n.isConnected) n.querySelector('.mmd-v').innerHTML = svg;
    } catch (e) {
      const msg = '<span class="mmd-err">図を描けませんでした。コードを確認してください</span>'; mmdSvg.set(k, msg);
      if (n.isConnected) { n.querySelector('.mmd-v').innerHTML = msg; n.querySelector('pre').hidden = false; }
      document.querySelectorAll('body > [id^="dmm"]').forEach((x) => x.remove());
    }
  }
}
function rerenderAll() {
  if (!S.chat || S.streaming) return;
  S.chat.msgs.forEach((m) => { if (m.role !== 'ai') return; const el = $('#thread').querySelector(`.msg.ai[data-id="${m.id}"]`); if (el) renderAiBody(el.querySelector('.ai-body'), m, false); });
}
function extractHtml(t) { const all = [...t.matchAll(/```html[^\n`]*\n([\s\S]*?)(```|$)/g)]; const l = all[all.length - 1]; return l ? { html: l[1], done: l[2] === '```' } : null; }

/* ---------- ライブプレビュー(/preview を sandbox で読み込み、postMessage で描画) ---------- */
function pvEnsureFrame() {
  const stage = $('#pvFrame'); if (stage.querySelector('iframe')) return;
  const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.setAttribute('title', 'プレビュー'); f.src = '/preview';
  f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff';
  stage.appendChild(f);
}
addEventListener('message', (e) => {
  const f = $('#pvFrame iframe'); if (!f || e.source !== f.contentWindow) return;
  if (e.data && typeof e.data.pcErr === 'string') { if (S.pv.errs.length < 5 && !S.pv.errs.includes(e.data.pcErr)) { S.pv.errs.push(e.data.pcErr); renderPvErr(); } return; }
  if (e.data && e.data.ready) { S.pv.ready = true; if (S.pv.pending) { f.contentWindow.postMessage(S.pv.pending, '*'); S.pv.pending = null; } }
});
function pvPost(msg) { if (msg.scripts && msg.force) { S.pv.errs = []; renderPvErr(); } const f = $('#pvFrame iframe'); if (!f) return; if (S.pv.ready) f.contentWindow.postMessage(msg, '*'); else S.pv.pending = msg; }
function pvStream(html, done, final) {
  if (S.pv.kind !== 'html') pvKind('html'); S.pv.html = html; $('#pvCode').textContent = html;
  if (!S.pv.open && innerWidth >= 1000) pvShow();
  if (!S.pv.open) { renderPvBtn(); return; }
  if (final) { pvPost({ html, scripts: true, force: true }); renderPvVer(); return; }
  const now = performance.now(); if (now - S.pv.last < 260) return; S.pv.last = now;
  pvPost({ html, scripts: false });
}
function pvShow() { renderPvVer(); pvEnsureFrame(); S.pv.open = true; $('#shell').classList.add('pv-open'); if (innerWidth <= 900) $('#shell').classList.remove('sb-open'); setSeg('#pvMode'); setSeg('#pvDev'); renderPvBtn(); }
function pvOpen(html, vi, name) {
  pvKind('html', name); S.pv.html = html; $('#pvCode').textContent = html;
  if (vi === undefined) vi = htmlVersions().findIndex((x) => x.html === html);
  S.pv.vi = vi; pvShow(); pvPost({ html, scripts: true, force: true });
}
function dlFile(f) { dlBlob(new Blob([f.code], { type: 'text/plain;charset=utf-8' }), f.name); }
function pvKind(kind, name, f) {
  S.pv.kind = kind; S.pv.name = name || ''; S.pv.file = f || null;
  const md_ = kind === 'file' && f && f.ext === 'md';
  $('#pvStage').classList.toggle('is-file', kind === 'file'); $('#pvStage').classList.toggle('is-md', !!md_);
  $('#pvDev').hidden = kind === 'file'; $('#pvMode').hidden = kind === 'file' && !md_;
  const nm = $('#pvName'); nm.hidden = !name; nm.textContent = name || '';
  if (kind === 'file') { S.pv.mode = md_ ? 'preview' : 'code'; $('#pvMode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.m === S.pv.mode)); $('#pvStage').classList.toggle('is-code', S.pv.mode === 'code'); }
  else { $('#pvStage').classList.toggle('is-code', S.pv.mode === 'code'); }
  $('#pvDl').setAttribute('aria-label', kind === 'file' ? 'ファイルを保存' : 'HTMLを保存');
}
function fileOpen(f) {
  if (f.ext === 'html' || f.lang === 'html') { const i = htmlVersions().findIndex((x) => x.html === f.code); return pvOpen(f.code, i, f.name); }
  pvKind('file', f.name, f); S.pv.html = f.code; $('#pvCode').textContent = f.code;
  if (f.ext === 'md') $('#pvDoc').innerHTML = md(f.code);
  pvShow(); setSeg('#pvMode'); $('#pvVer').hidden = true;
}
function pvClose() { S.pv.open = false; $('#shell').classList.remove('pv-open'); renderPvBtn(); }
function latestHtml() { const c = S.chat; if (!c) return null; for (let i = c.msgs.length - 1; i >= 0; i--) { const m = c.msgs[i]; if (m.role === 'ai') { const h = extractHtml(m.text); if (h && h.done) return h.html; } } return null; }
function htmlVersions() { const out = []; ((S.chat && S.chat.msgs) || []).forEach((m) => { if (m.role === 'ai') { const h = extractHtml(m.text || ''); if (h && h.done) out.push({ html: h.html, id: m.id }); } }); return out; }
function renderPvVer() {
  const v = htmlVersions(), box = $('#pvVer'), show = v.length > 1 && !S.streaming; box.hidden = !show; if (!show) return;
  const i = S.pv.vi >= 0 && S.pv.vi < v.length ? S.pv.vi : v.length - 1; S.pv.vi = i;
  $('#pvVn').textContent = (i + 1) + '/' + v.length; $('#pvPrev').disabled = i === 0; $('#pvNext').disabled = i === v.length - 1;
}
function renderPvErr() {
  const b = $('#pvErr'), n = S.pv.errs.length; b.hidden = !n;
  b.innerHTML = n ? `${ic('alert', 'sm')}<span class="em" title="${esc(S.pv.errs.join('\n'))}">${esc(S.pv.errs[0])}${n > 1 ? ' (+' + (n - 1) + ')' : ''}</span><button class="btn pri" data-fixerr>${ic('up', 'sm')}<span>修正を依頼</span></button>` : '';
}
function renderPvBtn() { const b = $('#btnPv'); b.classList.toggle('on', S.pv.open); b.style.display = (S.pv.open || latestHtml() || S.streaming) ? '' : 'none'; renderPvVer(); }
function pvStep(d) { const v = htmlVersions(); const i = Math.max(0, Math.min(v.length - 1, (S.pv.vi < 0 ? v.length - 1 : S.pv.vi) + d)); if (v[i]) pvOpen(v[i].html, i); }
$('#thread').addEventListener('keydown', (e) => { const c = e.target.closest && e.target.closest('.afc'); if (c && c === e.target && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); c.click(); } });
$('#pvPrev').onclick = () => pvStep(-1); $('#pvNext').onclick = () => pvStep(1);
$('#pvDl').onclick = () => {
  if (!S.pv.html) return;
  if (S.pv.kind === 'file' && S.pv.file) return dlFile(S.pv.file);
  const full = /<html[\s>]/i.test(S.pv.html) ? S.pv.html : '<!DOCTYPE html>\n<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>\n' + S.pv.html + '\n</body></html>';
  dlBlob(new Blob([full], { type: 'text/html' }), 'page' + (S.pv.vi >= 0 ? '-v' + (S.pv.vi + 1) : '') + '.html');
};
$('#pvErr').addEventListener('click', (e) => {
  if (!e.target.closest('[data-fixerr]')) return;
  if (S.streaming) return busyToast();
  const msg = 'プレビューでエラーが出ました。直した HTML 全体を出力してください。\n\n' + S.pv.errs.map((x) => '- ' + x).join('\n');
  if (S.text.trim() || S.edit || S.atts.length) { S.text = (S.text ? S.text + '\n\n' : '') + msg; input.value = S.text; autosize(); renderEditBar(); recount(true); toast('入力欄に追加しました', 'edit'); input.focus(); return; }
  S.text = msg; input.value = msg; autosize(); renderEditBar(); recount(true);
  if (innerWidth <= 900) pvClose();
  send();
});
$('#btnPv').onclick = () => { if (S.pv.open) return pvClose(); const h = latestHtml(); if (h) pvOpen(h); };
$('#pvClose').onclick = pvClose;
$('#pvRefresh').onclick = () => { if (S.pv.html) pvPost({ html: S.pv.html, scripts: true, force: true }); };
$('#pvCopy').onclick = (e) => { try { navigator.clipboard.writeText(S.pv.html); } catch { /* */ } const b = e.currentTarget; b.innerHTML = ic('check'); setTimeout(() => { b.innerHTML = ic('copy'); }, 1400); };
function setSeg(sel) { const seg = $(sel); const on = seg.querySelector('button.on'), hl = seg.querySelector('.hl'); if (on && hl) hl.style.transform = `translateX(${on.offsetLeft - 3}px)`; }
$('#pvMode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.pv.mode = b.dataset.m; $('#pvMode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); $('#pvStage').classList.toggle('is-code', S.pv.mode === 'code'); setSeg('#pvMode'); });
$('#pvDev').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.pv.device = b.dataset.d; $('#pvDev').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); $('#pvStage').classList.toggle('phone', S.pv.device === 'phone'); setSeg('#pvDev'); });
addEventListener('resize', () => { setSeg('#pvMode'); setSeg('#pvDev'); });

/* ---------- 設定 ---------- */
function closeModal() { const m = $('.modal-bg'); if (!m) return; m.classList.add('out'); setTimeout(() => m.remove(), 260); }
async function openSettings(tab) {
  closePop(); closeModal();
  const tabs = isOwner() ? [['budget', 'gauge', '予算'], ['models', 'sparkle', 'モデル'], ['memory', 'memory', 'メモリ'], ['users', 'users', 'ユーザー'], ['account', 'user', 'アカウント']] : [['account', 'user', 'アカウント'], ['memory', 'memory', 'メモリ']];
  tab = tabs.some((t) => t[0] === tab) ? tab : tabs[0][0];
  const bg = document.createElement('div'); bg.className = 'modal-bg'; bg.innerHTML = '<div class="modal"><nav class="m-nav"></nav><div class="m-main"></div></div>'; $('#layer').appendChild(bg);
  bg.addEventListener('pointerdown', (e) => { if (e.target === bg) closeModal(); });
  const nav = bg.querySelector('.m-nav'), main = bg.querySelector('.m-main');
  const draw = async (t) => {
    tab = t; nav.innerHTML = tabs.map((x) => `<button data-t="${x[0]}" class="${x[0] === t ? 'on' : ''}">${ic(x[1])}${x[2]}</button>`).join('') + '<div class="grow"></div><button data-x>' + ic('x') + '</button>';
    let html; try { html = await TABS[t](); } catch (e) { html = `<div class="auth-err on">${esc(e.message)}</div>`; }
    main.innerHTML = '<div>' + html + '</div>'; main.scrollTop = 0; bindTab(main, () => draw(t));
  };
  nav.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; if (b.hasAttribute('data-x')) closeModal(); else if (b.dataset.t) draw(b.dataset.t); });
  draw(tab);
}
const row = (lb, val, sub) => `<div class="row"><div class="lb">${lb}${sub ? `<small>${sub}</small>` : ''}</div>${val ? `<div class="val">${val}</div>` : ''}</div>`;
const TABS = {
  async budget() {
    const used = S.ledger.spent, pct = pctOf(used), c = S.config;
    return `<div class="m-title">${ic('gauge', 'sm')}予算</div><div class="group">
      ${row(ic('lock') + '<span>上限</span>', dm('$' + usd(S.cap).toFixed(2)) + ' 固定')}
      ${row(ic('gauge') + '<span>使用</span>', dm(fmtUSD(usd(used)) + ' · ' + fmtPct(pct) + '%'))}
      <div class="row"><div class="lb">${ic('reset')}<span>リセット</span></div><button class="btn dng" data-reset>${ic('reset', 'sm')}<span>使用額を0に</span></button></div>
      ${S.syncAvailable ? `<div class="row"><div class="lb">${ic('gauge')}<span>Consoleの実額<small>${S.syncRes ? 'Console ' + dm(fmtUSD(usd(S.syncRes.consoleNano))) + '(' + esc(S.syncRes.since) + '〜) / サイト ' + dm(fmtUSD(usd(S.syncRes.siteNano))) : '管理用キーで集計を取得(読み取りのみ)'}</small></span></div><div class="val"><button class="btn" data-sync>取得</button>${S.syncRes ? `<button class="btn pri" data-apply-sync aria-label="この額に合わせる">${ic('check', 'sm')}</button>` : ''}</div></div>` : ''}
      <div class="row"><div class="lb">${ic('edit')}<span>実額に合わせる<small>Console のコスト(USD)を入力</small></span></div><div class="val"><input class="n" style="width:86px" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.76" id="setSpent" aria-label="使用額(USD)"><button class="btn pri" data-setspent aria-label="反映">${ic('check', 'sm')}</button></div></div></div>
      <div class="group"><div class="row"><div class="lb">${ic(S.ledger.override ? 'unlock' : 'shield')}<span>最悪ケース制限<small>${S.ledger.override ? '解除中。出力は残額に収まるよう自動で絞られます' : '最大出力まで使った場合に残額を超える送信を止めます'}</small></span></div><button class="sw ${S.ledger.override ? '' : 'on'}" data-lim aria-label="最悪ケース制限"></button></div></div>
      <div class="m-title">${ic('sliders', 'sm')}動作</div><div class="group">
      <div class="row"><div class="lb">${ic('sliders')}<span>Effort</span></div><div class="seg3" data-cfg="effortMode"><button data-v="fixed" class="${c.effortMode === 'fixed' ? 'on' : ''}">中に固定</button><button data-v="select" class="${c.effortMode === 'select' ? 'on' : ''}">低・中・高</button></div></div>
      <div class="row"><div class="lb">${ic('bulb')}<span>思考<small>${c.thinking ? '考える過程の要約を表示します(思考ぶんも課金されます)' : '思考を使いません'}</small></span></div><div class="seg3" data-cfg="thinking"><button data-v="on" class="${c.thinking ? 'on' : ''}">オン</button><button data-v="off" class="${c.thinking ? '' : 'on'}">オフ</button></div></div>
      <div class="row"><div class="lb">${ic('shield')}<span>権限<small>${c.permission === 'auto' ? '検索を常に付け、使うかはClaudeが決めます' : '検索は送信ごとに自分で付けます'}</small></span></div><div class="seg3" data-cfg="permission"><button data-v="manual" class="${c.permission === 'manual' ? 'on' : ''}">手動</button><button data-v="auto" class="${c.permission === 'auto' ? 'on' : ''}">自動</button></div></div>
      <div class="row"><div class="lb">${ic('globe')}<span>Web検索<small>${c.searchUnlimited ? '内部の上限は' + S.searchLimit + '回。最悪ケースが大きくなります' : '1回の送信で使える最大回数'}</small></span></div><div class="seg3" data-cfg="searchMode"><button data-v="n" class="${c.searchUnlimited ? '' : 'on'}">回数</button><button data-v="inf" class="${c.searchUnlimited ? 'on' : ''}">制限なし</button></div></div>
      <div class="row" style="justify-content:flex-end"><div class="lb" style="justify-content:flex-end"><span style="color:var(--text-3);font-size:13px">最大</span><input class="n" type="number" inputmode="numeric" min="1" max="${S.searchLimit}" step="1" value="${c.searchMax}" data-smax ${c.searchUnlimited ? 'disabled' : ''} aria-label="最大検索回数"><span style="color:var(--text-3);font-size:13px">回</span></div></div></div>`;
  },
  async models() {
    return `<div class="m-title">${ic('tok', 'sm')}最大出力(max_tokens)</div>` + MODEL_KEYS.map((k) => {
      const m = MODELS[k], info = S.models[k] || { in: 0, out: 0, recMax: 0 }, cur = S.maxTokens[k], wc = cur * info.out;
      return `<div class="group"><div class="row"><div class="lb"><span class="mi ${k}" style="width:30px;height:30px;border-radius:10px;display:grid;place-items:center;color:#fff">${ic(m.icon, 'sm')}</span><span>${m.name}<small>${dm('$' + info.in / 1000 + ' / $' + info.out / 1000)} per 1M</small></span></div><div class="val" data-wc="${k}">${dm(fmtUSD(usd(wc)) + ' · ' + fmtPct(pctOf(wc)) + '%')}</div></div>
      <div class="row" style="justify-content:flex-end"><div class="seg3" data-mt="${k}">${S.presets.map((p) => `<button data-v="${p}" class="${p === cur ? 'on' : ''} ${p === info.recMax ? 'rec' : ''}">${fmtK(p)}</button>`).join('')}</div></div></div>`;
    }).join('') + `<div class="lkc" style="width:max-content"><span style="width:7px;height:7px;border-radius:50%;background:var(--good);display:inline-block"></span>推奨</div>`;
  },
  async memory() {
    const r = await req('/memories'); S.memCount = r.memories.length; renderMem();
    return `<div class="m-title">${ic('memory', 'sm')}メモリ ${r.memories.length}/${r.max}</div><div class="group"><div class="row"><div class="lb">${ic('memory')}<span>送信に使う<small>入力欄のスイッチでも切り替えられます</small></span></div><div class="seg3" data-memtog><button data-v="1" class="${S.mem ? 'on' : ''}">オン</button><button data-v="0" class="${S.mem ? '' : 'on'}">オフ</button></div></div></div>
      <div class="group">${r.memories.map((m) => `<div class="row"><div class="lb"><input class="t" value="${esc(m.text)}" maxlength="${r.maxChars}" data-medit="${esc(m.id)}" aria-label="メモ"></div><button class="btn dng" data-mdel="${esc(m.id)}" style="padding:0 10px;height:30px" aria-label="削除">${ic('trash', 'sm')}</button></div>`).join('')}
      <div class="row"><div class="lb"><input class="t" id="memNew" placeholder="覚えておくこと(入力欄の /remember でも追加)" maxlength="${r.maxChars}"></div><button class="btn pri" data-madd aria-label="追加">${ic('plus', 'sm')}</button></div></div><div class="auth-err" id="uErr"></div>`;
  },
  async users() {
    const us = (await req('/users')).users;
    return `<div class="m-title">${ic('users', 'sm')}ユーザー ${us.length}/2</div><div class="group">` + us.map((u) => `<div class="row" data-u="${esc(u.name)}"><div class="lb"><span class="av" style="width:30px;height:30px;font-size:13px">${esc(u.name[0])}</span><span>${esc(u.name)}<small>${u.role === 'owner' ? '最高権限者' : 'ユーザー'}</small></span></div>${u.role === 'owner' ? `<span class="val">${ic('crown')}</span>` : `<div class="val"><button class="ib sm" data-pw="${esc(u.name)}" aria-label="パスワード再設定">${ic('key', 'sm')}</button><button class="btn dng" data-rmu="${esc(u.name)}" style="padding:0 10px;height:30px">${ic('trash', 'sm')}</button></div>`}</div>`).join('') + `</div>` +
      (us.length < 2 ? `<div class="m-title">${ic('plus', 'sm')}追加</div><div class="group"><div class="row"><div class="lb"><input class="t" id="nuName" placeholder="ユーザー名(英数字3文字以上)" autocomplete="off"></div></div><div class="row"><div class="lb"><input class="t" id="nuPass" type="password" placeholder="パスワード(8文字以上)" autocomplete="new-password"></div><button class="btn pri" data-adduser>${ic('plus', 'sm')}</button></div></div>` : '') + `<div class="auth-err" id="uErr"></div>`;
  },
  async account() {
    let pks = []; if (PK_REG_OK) { try { pks = (await req('/passkeys')).passkeys; } catch { /* 空で */ } }
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const pkHTML = PK_REG_OK
      ? `<div class="m-title">${ic('finger', 'sm')}パスキー</div><div class="group">${pks.map((p) => `<div class="row pk-row"><div class="lb">${ic('finger')}<span class="nm">${esc(p.name)}<small>${fmtDate(p.created)}${p.lastUsed ? ' · ' + fmtDate(p.lastUsed) : ''}</small></span></div><button class="btn dng" data-pkdel="${esc(p.id)}" style="padding:0 10px;height:30px" aria-label="削除">${ic('trash', 'sm')}</button></div>`).join('')}<div class="row"><div class="lb"><span>${pks.length ? 'この端末を追加' : 'この端末で使う'}</span></div><button class="btn pri" data-pkadd aria-label="パスキーを追加">${ic('plus', 'sm')}</button></div></div>`
      : `<div class="m-title">${ic('finger', 'sm')}パスキー</div><div class="group"><div class="row"><div class="lb"><span>このブラウザは非対応です<small>Chrome / Safari の新しい版で使えます</small></span></div></div></div>`;
    const inst = standalone ? '' : S.installEv ? `<div class="row"><div class="lb">${ic('install')}<span>ホーム画面に追加</span></div><button class="btn pri" data-install>${ic('plus', 'sm')}</button></div>` : ios ? `<div class="row"><div class="lb">${ic('install')}<span>ホーム画面に追加<small>Safari の共有ボタン → ホーム画面に追加</small></span></div></div>` : '';
    return `<div class="m-title">${ic('user', 'sm')}アカウント</div><div class="group">${row('<span class="av" style="width:30px;height:30px;font-size:13px">' + esc(S.user[0]) + '</span><span>' + esc(S.user) + '<small>' + (isOwner() ? '最高権限者' : 'ユーザー') + '</small></span>', '')}</div>
      ${pkHTML}
      <div class="m-title">${ic('key', 'sm')}パスワード</div><div class="group"><div class="row"><div class="lb"><input class="t" id="pwCur" type="password" placeholder="現在" autocomplete="current-password"></div></div><div class="row"><div class="lb"><input class="t" id="pwNew" type="password" placeholder="新規(8文字以上)" autocomplete="new-password"></div><button class="btn pri" data-chpw>${ic('check', 'sm')}</button></div></div><div class="auth-err" id="uErr"></div>
      <div class="group">${inst}<div class="row"><div class="lb">${ic('download')}<span>全会話を保存<small>JSON</small></span></div><a class="btn" href="/api/export" download>${ic('download', 'sm')}</a></div></div>
      <button class="btn dng" data-logout>${ic('out', 'sm')}<span>ログアウト</span></button>`;
  },
};
function bindTab(main, redraw) {
  const fail = (x) => { const er = $('#uErr'); if (er) { er.textContent = x.message; er.classList.add('on'); } shake(main); };
  main.onclick = async (e) => {
    const q = (s) => e.target.closest(s);
    try {
      if (q('[data-lim]')) { await toggleLimiter(); redraw(); }
      if (q('[data-reset]')) {
        const b = q('[data-reset]');
        if (!b.classList.contains('arm')) { b.classList.add('arm'); b.querySelector('span').textContent = 'もう一度押して確定'; setTimeout(() => { if (b.isConnected) { b.classList.remove('arm'); b.querySelector('span').textContent = '使用額を0に'; } }, 3000); }
        else { S.ledger = (await req('/ledger/reset', { method: 'POST' })).ledger; renderBudget(); recount(true); redraw(); toast('使用額をリセットしました', 'reset'); }
      }
      if (q('[data-setspent]')) {
        const v = parseFloat($('#setSpent').value);
        if (!Number.isFinite(v) || v < 0) throw new Error('金額を入力してください');
        S.ledger = (await req('/ledger/set', { method: 'POST', body: { usd: v } })).ledger; renderBudget(); recount(true); redraw(); toast('使用額を $' + v.toFixed(2) + ' にしました', 'check');
      }
      if (q('[data-sync]')) { S.syncRes = await req('/ledger/sync', { method: 'POST', body: {} }); redraw(); }
      if (q('[data-apply-sync]') && S.syncRes) {
        S.ledger = (await req('/ledger/set', { method: 'POST', body: { usd: S.syncRes.consoleNano / 1e9 } })).ledger; renderBudget(); recount(true); toast('Console の実額に合わせました', 'check'); S.syncRes = null; redraw();
      }
      const mtg = q('[data-memtog] button');
      if (mtg) { S.mem = mtg.dataset.v === '1'; lsSet('pc.mem', S.mem ? '1' : '0'); renderMem(); recount(true); redraw(); }
      if (q('[data-madd]')) { const v = $('#memNew').value.trim(); if (!v) throw new Error('内容を入力してください'); await req('/memories', { method: 'POST', body: { text: v } }); redraw(); loadMemCount(); }
      const md_ = q('[data-mdel]'); if (md_) { await req('/memories/' + md_.dataset.mdel, { method: 'DELETE' }); redraw(); loadMemCount(); }
      const mt = q('[data-mt] button');
      if (mt) {
        const k = mt.parentElement.dataset.mt; const r = await req('/settings', { method: 'PUT', body: { maxTokens: { [k]: +mt.dataset.v } } }); S.maxTokens = r.maxTokens;
        mt.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === mt));
        const wc = S.maxTokens[k] * (S.models[k]?.out || 0); main.querySelector(`[data-wc="${k}"]`).innerHTML = dm(fmtUSD(usd(wc)) + ' · ' + fmtPct(pctOf(wc)) + '%'); recount(true);
      }
      if (q('[data-adduser]')) {
        const n = $('#nuName').value.trim(), p = $('#nuPass').value;
        if (!/^[A-Za-z0-9_.\-]{3,32}$/.test(n)) throw new Error('ユーザー名は3〜32文字の英数字です');
        if (p.length < 8) throw new Error('パスワードは8文字以上です');
        await req('/users', { method: 'POST', body: { name: n, password: p } }); toast('追加しました', 'check'); redraw();
      }
      const rm = q('[data-rmu]');
      if (rm) { if (!rm.classList.contains('arm')) { rm.classList.add('arm'); setTimeout(() => rm.isConnected && rm.classList.remove('arm'), 3000); } else { await req('/users/' + encodeURIComponent(rm.dataset.rmu), { method: 'DELETE' }); toast('削除しました', 'trash'); redraw(); } }
      const pw = q('[data-pw]');
      if (pw) { const r = pw.closest('.row'); if (!r.nextElementSibling || !r.nextElementSibling.classList.contains('pwrow')) { r.insertAdjacentHTML('afterend', `<div class="row pwrow"><div class="lb"><input class="t" type="password" placeholder="新しいパスワード" autocomplete="new-password"></div><button class="btn pri" data-setpw="${esc(pw.dataset.pw)}">${ic('check', 'sm')}</button></div>`); r.nextElementSibling.querySelector('input').focus(); } }
      const sp = q('[data-setpw]');
      if (sp) { const v = sp.closest('.row').querySelector('input').value; if (v.length < 8) throw new Error('パスワードは8文字以上です'); await req('/users/' + encodeURIComponent(sp.dataset.setpw) + '/password', { method: 'POST', body: { password: v } }); toast('更新しました', 'key'); redraw(); }
      if (q('[data-chpw]')) { const v = $('#pwNew').value; if (v.length < 8) throw new Error('パスワードは8文字以上です'); await req('/password', { method: 'POST', body: { current: $('#pwCur').value, next: v } }); toast('更新しました', 'key'); redraw(); }
      const cf = q('[data-cfg] button');
      if (cf) {
        const key = cf.parentElement.dataset.cfg, v = cf.dataset.v;
        await saveConfig(key === 'searchMode' ? { searchUnlimited: v === 'inf' } : key === 'thinking' ? { thinking: v === 'on' } : { [key]: v }); redraw();
      }
      if (q('[data-pkadd]')) { try { await passkeyAdd(); toast('パスキーを追加しました', 'finger'); redraw(); } catch (x) { if (!quiet(x)) throw (x instanceof ApiError ? x : new Error(pkMsg(x))); } }
      const pd = q('[data-pkdel]');
      if (pd) { if (!pd.classList.contains('arm')) { pd.classList.add('arm'); setTimeout(() => pd.isConnected && pd.classList.remove('arm'), 3000); } else { await req('/passkeys/' + encodeURIComponent(pd.dataset.pkdel), { method: 'DELETE' }); toast('削除しました', 'trash'); redraw(); } }
      if (q('[data-install]') && S.installEv) { S.installEv.prompt(); S.installEv = null; redraw(); }
      if (q('[data-logout]')) { closeModal(); logout(); }
    } catch (x) { fail(x); }
  };
  main.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing && e.target.id === 'memNew') { e.preventDefault(); main.querySelector('[data-madd]').click(); } };
  main.onchange = async (e) => {
    const me = e.target.closest('[data-medit]');
    if (me) { try { const v = me.value.trim(); if (!v) throw new Error('内容を入力してください'); await req('/memories/' + me.dataset.medit, { method: 'PATCH', body: { text: v } }); } catch (x) { fail(x); } return; }
    const n = e.target.closest('[data-smax]'); if (!n) return;
    const v = Math.max(1, Math.min(S.searchLimit, Math.round(+n.value || 1))); n.value = v;
    try { await saveConfig({ searchMax: v }); } catch (x) { fail(x); }
  };
}
async function saveConfig(patch) {
  const r = await req('/settings', { method: 'PUT', body: { config: patch } });
  S.config = r.config; S.searchMax = r.searchMaxUses; renderSearch(); recount(true);
}

/* ---------- スマホ: ズーム固定、キーボードとセーフエリアへの追従 ---------- */
const COARSE = matchMedia('(hover:none) and (pointer:coarse)').matches; // タッチ端末ではEnterは改行、送信はボタン
(function mobileFit() {
  const root = document.documentElement, vv = window.visualViewport; let maxH = 0, lastW = 0;
  const fit = () => {
    if (innerWidth !== lastW) { lastW = innerWidth; maxH = 0; }
    const h = vv ? vv.height : innerHeight; maxH = Math.max(maxH, h, innerHeight);
    root.style.setProperty('--app-h', h + 'px'); root.style.setProperty('--app-top', (vv ? vv.offsetTop : 0) + 'px');
    root.classList.toggle('kb', h < maxH - 120); // キーボード表示中
    if (document.activeElement === input) scrollEnd(true);
  };
  if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', () => { window.scrollTo(0, 0); fit(); }); }
  addEventListener('resize', fit); addEventListener('orientationchange', () => setTimeout(fit, 250)); fit();
  const sc = document.querySelector('#scroll'); let pinned = true;
  sc.addEventListener('scroll', () => { pinned = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 70; }, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(() => { if (pinned && S.chat && S.chat.msgs && S.chat.msgs.length) sc.scrollTop = sc.scrollHeight; }).observe(sc);
  const dock = document.querySelector('.dock');
  if (dock && window.ResizeObserver) new ResizeObserver(() => { root.style.setProperty('--dock-h', dock.offsetHeight + 'px'); scrollEnd(); }).observe(dock);
  // iOS Safari は user-scalable=no を無視するので、ピンチと二本指操作を止める
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1 || (e.scale && e.scale !== 1)) e.preventDefault(); }, { passive: false });
})();

/* ---------- PWA ---------- */
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEv = e; });
addEventListener('appinstalled', () => { S.installEv = null; });
if ('serviceWorker' in navigator) addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });

/* ---------- init ---------- */
autosize();
boot();
