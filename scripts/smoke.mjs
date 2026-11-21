// API の通し確認。`npm run dev:mock` を起動した状態で `npm run smoke`。
// 上限テストは CAP_USD=0.02 npm run dev:mock で起動して SMOKE=cap npm run smoke。
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
let cookie = '';
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

async function call(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'x-pc': '1', cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return r;
}
async function sse(path, body) {
  const r = await call(path, { method: 'POST', body });
  if (!r.ok) return { status: r.status, json: await r.json(), events: [] };
  const events = [];
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /event: (.*)/.exec(raw)?.[1]; const data = /data: (.*)/.exec(raw)?.[1];
      if (ev && data) events.push({ ev, data: JSON.parse(data) });
    }
  }
  return { status: 200, events };
}

console.log('認証');
let s = await (await call('/api/session')).json();
if (s.setup) {
  const r = await call('/api/setup', { method: 'POST', body: { name: 'owner', password: 'password123' } });
  ok(r.status === 200, 'setup で最高権限者を作成');
  ok((await call('/api/setup', { method: 'POST', body: { name: 'x1234', password: 'password123' } })).status === 409, '2回目の setup は拒否');
} else {
  const r = await call('/api/login', { method: 'POST', body: { name: 'owner', password: 'password123' } });
  ok(r.status === 200, 'login');
}
ok((await (await call('/api/session')).json()).user?.role === 'owner', 'セッション有効');
ok((await fetch(BASE + '/api/state')).status === 401, 'Cookie なしは 401');
ok((await fetch(BASE + '/api/logout', { method: 'POST' })).status === 403, 'x-pc なしの POST は 403');

const st = await (await call('/api/state')).json();
console.log(`  cap = $${st.capNano / 1e9}, spent = $${st.ledger.spent / 1e9}`);

if (process.env.SMOKE === 'cap') {
  console.log('上限(CAP_USD を小さくして起動した前提)');
  const q = await (await call('/api/quote', { method: 'POST', body: { text: 'こんにちは', search: false } })).json();
  console.log('  gate:', JSON.stringify(Object.fromEntries(Object.entries(q.models).map(([k, v]) => [k, v.gate]))));
  ok(q.models.fable.gate.ok === false, 'Fable の最悪ケースが残額超過でブロックされる');
  const r = await sse('/api/send', { model: 'fable', text: 'こんにちは' });
  ok(r.status === 402 && r.json.error === 'limiter', `制限中は送信が 402 limiter (${r.status})`);
  await call('/api/ledger/limiter', { method: 'POST', body: { override: true } });
  const r2 = await sse('/api/send', { model: 'sonnet', text: 'こんにちは' });
  const meta = r2.events.find((e) => e.ev === 'meta')?.data;
  const done = r2.events.find((e) => e.ev === 'done')?.data;
  console.log('  override: max_tokens =', meta?.maxTokens, 'cost =', done?.costNano / 1e9);
  ok(!!done, '解除すると送信できる');
  ok(done && done.ledger.spent <= st.capNano, `累計が上限を超えない ($${done?.ledger.spent / 1e9} <= $${st.capNano / 1e9})`);
  await call('/api/ledger/limiter', { method: 'POST', body: { override: false } });
  process.exit(fails ? 1 : 0);
}

console.log('見積もり');
const q1 = await (await call('/api/quote', { method: 'POST', body: { text: 'こんにちは、元気ですか', search: false } })).json();
ok(q1.models.sonnet.newTokens > 0, `Sonnet 新規トークン ${q1.models.sonnet.newTokens}`);
ok(q1.models.fable.worstNano > q1.models.sonnet.worstNano * 3, 'Fable の最悪ケースは Sonnet の数倍');
const q2 = await (await call('/api/quote', { method: 'POST', body: { text: 'こんにちは、元気ですか', search: true } })).json();
ok(q2.models.sonnet.worstNano > q1.models.sonnet.worstNano, '検索を付けると最悪ケースが増える');

console.log('添付');
const up = await (await call('/api/upload?model=sonnet', { method: 'POST', raw: new TextEncoder().encode('# メモ\nテスト用のテキストファイル。'.repeat(20)), headers: { 'x-filename': encodeURIComponent('メモ.md'), 'content-type': 'text/markdown' } })).json();
ok(up.id && up.tokens > 0, `アップロードとトークン数 ${up.tokens}`);

console.log('送信(ストリーミング)');
const before = (await (await call('/api/state')).json()).ledger;
const r1 = await sse('/api/send', { model: 'sonnet', text: '時計のHTMLを作って', attachmentIds: [up.id], search: true });
const evs = r1.events.map((e) => e.ev);
ok(evs[0] === 'meta' && evs.includes('text') && evs.at(-1) === 'done', `イベント順 meta → text → done (${[...new Set(evs)].join(',')})`);
ok(evs.includes('status') && evs.includes('sources'), '検索のステータスと出典が届く');
const done = r1.events.at(-1).data;
const chatId = r1.events[0].data.chatId;
ok(done.costNano > 0, `課金額 $${(done.costNano / 1e9).toFixed(5)} (${done.pct.toFixed(4)}%)`);
ok(done.ledger.spent === before.spent + done.costNano, '台帳が実績ぶんだけ増える(整数で一致)');
ok(done.ledger.reserved === 0, '予約は精算後に 0');
const text = r1.events.filter((e) => e.ev === 'text').map((e) => e.data.t).join('');
ok(text.includes('```html'), 'HTML コードブロックを含む応答');

console.log('履歴・2ターン目');
const ch = await (await call(`/api/chats/${chatId}`)).json();
ok(ch.messages.length === 2 && ch.messages[0].atts.length === 1, 'チャット保存と添付の紐づけ');
const q3 = await (await call('/api/quote', { method: 'POST', body: { chatId, text: 'もう少し派手に', search: false } })).json();
ok(q3.models.sonnet.histTokens > 0, `履歴トークンが加算される (${q3.models.sonnet.histTokens})`);
ok(q3.models.sonnet.cacheWarm === true && q3.models.opus.cacheWarm === false, 'キャッシュが温まっているのは同じモデルだけ');
const r2 = await sse('/api/send', { chatId, model: 'sonnet', text: 'もう少し派手に' });
ok(r2.events.at(-1).ev === 'done', '2ターン目も完了');

console.log('停止(途中で切断)');
const ac = new AbortController();
const r3 = await fetch(BASE + '/api/send', { method: 'POST', signal: ac.signal, headers: { 'x-pc': '1', cookie, 'content-type': 'application/json' }, body: JSON.stringify({ chatId, model: 'sonnet', text: '長文で答えて' }) });
let got = 0;
try { for await (const c of r3.body) { got += c.length; if (got > 600) { ac.abort(); } } } catch {}
await new Promise((r) => setTimeout(r, 1500));
const after = (await (await call('/api/state')).json()).ledger;
ok(after.reserved === 0, '切断後に予約が解放される');
const ch2 = await (await call(`/api/chats/${chatId}`)).json();
const last = ch2.messages.at(-1);
ok(last.role === 'ai' && last.meta.stopped === true && last.meta.estimated === true, '停止した応答が見積もり課金で保存される');

console.log('権限・設定');
const rs = await call('/api/ledger/reset', { method: 'POST' });
ok((await rs.json()).ledger.spent === 0, 'リセットで累計が 0');
const ms = await call('/api/settings', { method: 'PUT', body: { maxTokens: { fable: 8000 } } });
ok((await ms.json()).maxTokens.fable === 8000, 'max_tokens を変更');
await call('/api/settings', { method: 'PUT', body: { maxTokens: { fable: 32000 } } });
ok((await call('/api/users', { method: 'POST', body: { name: 'guest01', password: 'guestpass1' } })).status === 200, 'ユーザー追加');
ok((await call('/api/users', { method: 'POST', body: { name: 'guest02', password: 'guestpass2' } })).status === 409, '3人目は拒否');
const owner = cookie;
cookie = '';
await call('/api/login', { method: 'POST', body: { name: 'guest01', password: 'guestpass1' } });
ok((await call('/api/ledger/reset', { method: 'POST' })).status === 403, '一般ユーザーはリセット不可');
ok((await call('/api/ledger/limiter', { method: 'POST', body: { override: true } })).status === 403, '一般ユーザーは制限を解除できない');
ok((await (await call('/api/chats')).json()).chats.length === 0, '他人のチャットは見えない');
ok((await call(`/api/chats/${chatId}`)).status === 404, '他人のチャットは開けない');
cookie = owner;
await call('/api/users/guest01', { method: 'DELETE' });

console.log('動作設定(Effort・権限・検索)');
let stt = await (await call('/api/state')).json();
ok(stt.config.effortMode === 'fixed' && stt.config.permission === 'manual' && stt.config.searchMax === 3 && stt.searchMaxUses === 3, '初期値は Effort中固定 / 手動 / 最大3回');
const qa = await (await call('/api/quote', { method: 'POST', body: { text: 'テスト', search: false, effort: 'high' } })).json();
const qb = await (await call('/api/quote', { method: 'POST', body: { text: 'テスト', search: false, effort: 'low' } })).json();
ok(qa.models.sonnet.expectedNano === qb.models.sonnet.expectedNano, '固定のあいだは effort を送っても見込みは変わらない');
ok((await call('/api/settings', { method: 'PUT', body: { config: { effortMode: 'select' } } })).status === 200, 'Effort を選択式にする');
const qh = await (await call('/api/quote', { method: 'POST', body: { text: 'テスト', search: false, effort: 'high' } })).json();
const ql = await (await call('/api/quote', { method: 'POST', body: { text: 'テスト', search: false, effort: 'low' } })).json();
ok(qh.models.sonnet.expectedNano > ql.models.sonnet.expectedNano, '選択式なら 高 > 低 で見込みが変わる');
ok(qh.models.sonnet.worstNano === ql.models.sonnet.worstNano, '最悪ケース(上限の保証)は effort で変わらない');
const re = await sse('/api/send', { model: 'sonnet', text: 'effort確認', effort: 'low' });
ok(/effort: low/.test(re.events.filter((e) => e.ev === 'text').map((e) => e.data.t).join('')), '選んだ effort が API に渡る');
ok((await call('/api/settings', { method: 'PUT', body: { config: { searchMax: 99 } } })).status === 400, '検索回数の上限を超える指定は拒否');
await call('/api/settings', { method: 'PUT', body: { config: { searchMax: 5 } } });
const q5 = await (await call('/api/quote', { method: 'POST', body: { text: 'テスト', search: true } })).json();
ok(q5.models.sonnet.worstNano > q2.models.sonnet.worstNano, '検索回数を増やすと最悪ケースが増える');
await call('/api/settings', { method: 'PUT', body: { config: { searchUnlimited: true } } });
stt = await (await call('/api/state')).json();
ok(stt.searchMaxUses === 20, '制限なしは内部で20回に丸められる');
await call('/api/settings', { method: 'PUT', body: { config: { permission: 'auto', searchUnlimited: false, searchMax: 3 } } });
const qauto = await (await call('/api/quote', { method: 'POST', body: { text: 'テスト', search: false } })).json();
ok(qauto.models.sonnet.worstNano > q1.models.sonnet.worstNano, '自動のときは検索なしの指定でも最悪ケースに検索分が入る');
const rauto = await sse('/api/send', { model: 'sonnet', text: '自動で検索できる?', search: false });
ok(rauto.events.some((e) => e.ev === 'sources'), '自動のときは検索スイッチなしでも検索が使われる');
await call('/api/settings', { method: 'PUT', body: { config: { effortMode: 'fixed', permission: 'manual', searchMax: 3, searchUnlimited: false } } });

console.log('チャット管理(名前・ピン・検索・書き出し)');
const c1 = (await sse('/api/send', { model: 'sonnet', text: 'りんごについて教えて' })).events[0].data.chatId;
const c2 = (await sse('/api/send', { model: 'sonnet', text: 'バナナについて教えて' })).events[0].data.chatId;
ok((await (await call(`/api/chats/${c1}`, { method: 'PATCH', body: { title: '果物メモ' } })).json()).chat.title === '果物メモ', 'タイトルを変更');
ok((await call(`/api/chats/${c1}`, { method: 'PATCH', body: { title: '   ' } })).status === 400, '空のタイトルは拒否');
await call(`/api/chats/${c1}`, { method: 'PATCH', body: { pinned: true } });
let list = (await (await call('/api/chats')).json()).chats;
ok(list[0].id === c1 && list[0].pinned === 1, 'ピン留めした会話が先頭に来る');
const hit = (await (await call('/api/chats?q=' + encodeURIComponent('バナナ'))).json()).chats;
ok(hit.length >= 1 && hit.every((h) => h.id === c2 || h.id !== c1) && hit.some((h) => h.id === c2 && /バナナ/.test(h.snip ?? '')), '本文の検索と抜粋');
const md = await call(`/api/chats/${c1}/export?format=md`);
const mdt = await md.text();
ok(md.headers.get('content-disposition')?.includes('attachment') && mdt.includes('# 果物メモ') && mdt.includes('りんご'), 'Markdown の書き出し');
const js = await (await call(`/api/chats/${c1}/export?format=json`)).json();
ok(js.messages.length === 2, 'JSON の書き出し');
ok((await (await call('/api/export')).json()).chats.length >= 2, '全会話の書き出し');
const other = cookie; cookie = '';
await call('/api/users', { method: 'POST', body: { name: 'x', password: 'y' } });
cookie = other;

console.log('再生成と版の切り替え');
const rg = await sse('/api/send', { chatId: c1, model: 'sonnet', regenId: (await (await call(`/api/chats/${c1}`)).json()).messages[1].id });
ok(rg.events.at(-1).ev === 'done' && rg.events.at(-1).data.ver === 2, '再生成が完了して第2版になる');
let cc = await (await call(`/api/chats/${c1}`)).json();
ok(cc.messages.length === 2 && cc.messages[1].vers === 2 && cc.messages[1].ver === 2, '会話は2発言のまま、版が2つ');
const v2text = cc.messages[1].text;
const sw = await (await call(`/api/messages/${cc.messages[1].id}/version`, { method: 'POST', body: { n: 1 } })).json();
ok(sw.ver === 1 && sw.text !== v2text, '第1版に切り替えられる');
await sse('/api/send', { chatId: c1, model: 'sonnet', regenId: cc.messages[1].id });
cc = await (await call(`/api/chats/${c1}`)).json();
ok(cc.messages[1].vers === 3, '版が積み上がる');
const rid = rg.events.at(-1).data.rid;
ok(typeof rid === 'string' && rid.startsWith('req_'), 'リクエストIDが返る');

console.log('編集して送り直し');
const ed = await sse('/api/send', { chatId: c1, model: 'sonnet', editMsgId: cc.messages[0].id, text: 'いちごについて教えて' });
ok(ed.events.at(-1).ev === 'done', '編集の送信が完了');
cc = await (await call(`/api/chats/${c1}`)).json();
ok(cc.messages.length === 2 && cc.messages[0].text === 'いちごについて教えて' && cc.chat.title.includes('いちご'), '発言が置き換わり、最初の発言ならタイトルも変わる');

console.log('/compact');
await sse('/api/send', { chatId: c1, model: 'sonnet', text: 'もう1つ質問。' + '長い前置きです。'.repeat(400) });
const qc = await (await call('/api/quote', { method: 'POST', body: { chatId: c1, compact: true, text: '' } })).json();
ok(qc.models.sonnet.histTokens > 0 && qc.models.sonnet.worstNano > 0, `圧縮の見積もり (履歴 ${qc.models.sonnet.histTokens} トークン)`);
ok((await sse('/api/send', { model: 'sonnet', compact: true })).status === 400, 'チャットなしの圧縮は拒否');
const cp = await sse('/api/send', { chatId: c1, model: 'sonnet', compact: true });
ok(cp.events.at(-1).ev === 'done' && cp.events.at(-1).data.compacted === true, '圧縮が完了');
cc = await (await call(`/api/chats/${c1}`)).json();
ok(cc.messages.filter((m) => m.compacted).length === 4 && cc.messages.at(-1).meta.kind === 'summary' && cc.messages.at(-1).compacted === false, '元の発言は残り(圧縮済み印)、末尾に要約が入る');
const afterC = await (await call('/api/quote', { method: 'POST', body: { chatId: c1, text: 'つづき', search: false } })).json();
ok(afterC.models.sonnet.histTokens < qc.models.sonnet.histTokens, `圧縮後は履歴トークンが減る (${qc.models.sonnet.histTokens} → ${afterC.models.sonnet.histTokens})`);
const next = await sse('/api/send', { chatId: c1, model: 'sonnet', text: 'つづきを教えて' });
ok(next.events.at(-1).ev === 'done', '圧縮後も会話を続けられる');
ok((await call('/api/quote', { method: 'POST', body: { chatId: c1, editMsgId: cc.messages[0].id, text: 'x' } })).status === 404, '圧縮済みの発言は編集できない');

console.log('パスキー(サーバー側)');
const po = await (await call('/api/passkey/login/options', { method: 'POST' })).json();
ok(po.challenge && po.rpId, 'ログイン用チャレンジを発行');
const bad = await call('/api/passkey/login/verify', { method: 'POST', body: { id: 'x', clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' } });
ok(bad.status === 401, '不正なパスキー応答は 401');
const ro = await (await call('/api/passkeys/options', { method: 'POST' })).json();
ok(ro.rp?.id && ro.pubKeyCredParams.length === 2 && ro.authenticatorSelection.userVerification === 'required', '登録オプションに必須項目がある');
ok((await (await call('/api/passkeys')).json()).passkeys.length === 0, '一覧は空');

console.log('使用額の手動設定');
const ls = await call('/api/ledger/set', { method: 'POST', body: { usd: 0.76 } });
const lj = await ls.json();
ok(ls.status === 200 && lj.ledger.spent === 760000000, '使用額を $0.76 に設定(整数のnano-USDで一致)');
ok((await call('/api/ledger/set', { method: 'POST', body: { usd: 999 } })).status === 400, '上限超えは拒否');
ok((await call('/api/ledger/set', { method: 'POST', body: { usd: -1 } })).status === 400, '負の値は拒否');
const mt = Object.values(lj.ledger.byModel).reduce((a, b) => a + b, 0);
ok(Math.abs(mt - 760000000) <= 3, `モデル別の合計が新しい合計に合う (${mt})`);

console.log('思考・引用');
const th = await sse('/api/send', { model: 'sonnet', text: '思考の確認' });
const thTxt = th.events.filter((e) => e.ev === 'text').map((e) => e.data.t).join('');
ok(/思考: adaptive\/summarized/.test(thTxt), '思考(要約表示)をAPIに依頼する');
ok(th.events.some((e) => e.ev === 'think'), '思考の要約がストリームで届く');
const thChat = await (await call(`/api/chats/${th.events[0].data.chatId}`)).json();
ok(/整理する/.test(thChat.messages[1].meta.think ?? ''), '思考の要約が保存される');
await call('/api/settings', { method: 'PUT', body: { config: { thinking: false } } });
const th2 = await sse('/api/send', { model: 'sonnet', text: '思考なし確認' });
ok(/思考: なし/.test(th2.events.filter((e) => e.ev === 'text').map((e) => e.data.t).join('')), '設定で思考をオフにできる');
await call('/api/settings', { method: 'PUT', body: { config: { thinking: true, permission: 'auto' } } });
const ct = await sse('/api/send', { model: 'sonnet', text: '調べて引用して' });
const cites = ct.events.filter((e) => e.ev === 'cite');
ok(cites.length === 2 && cites[0].data.at > 0 && cites[0].data.i === 0 && cites[1].data.i === 1, '引用(出典番号と本文の位置)が届く');
const ctChat = await (await call(`/api/chats/${ct.events[0].data.chatId}`)).json();
ok(Array.isArray(ctChat.messages[1].meta.cites) && ctChat.messages[1].meta.cites.length === 2, '引用が保存される');
await call('/api/settings', { method: 'PUT', body: { config: { permission: 'manual' } } });

console.log('メモリ');
ok((await call('/api/memories', { method: 'POST', body: { text: '   ' } })).status === 400, '空のメモは拒否');
const mm = await (await call('/api/memories', { method: 'POST', body: { text: '呼び名はハイト。回答は結論から。' } })).json();
ok(!!mm.memory?.id, 'メモを追加');
const onr = await sse('/api/send', { model: 'sonnet', text: 'メモリ確認' });
ok(/メモリ: あり/.test(onr.events.filter((e) => e.ev === 'text').map((e) => e.data.t).join('')), 'メモリがオンのときは送信に含まれる');
const offr = await sse('/api/send', { model: 'sonnet', text: 'メモリ確認2', memory: false });
ok(/メモリ: なし/.test(offr.events.filter((e) => e.ev === 'text').map((e) => e.data.t).join('')), '送信ごとにオフにできる');
const qOn = await (await call('/api/quote', { method: 'POST', body: { text: 'テスト', memory: true } })).json();
const qOff = await (await call('/api/quote', { method: 'POST', body: { text: 'テスト', memory: false } })).json();
ok(qOn.models.sonnet.newTokens > qOff.models.sonnet.newTokens, `メモリのトークンが見積もりに入る (${qOff.models.sonnet.newTokens} → ${qOn.models.sonnet.newTokens})`);
ok((await call(`/api/memories/${mm.memory.id}`, { method: 'PATCH', body: { text: '呼び名はハイト' } })).status === 200, 'メモを編集');
ok((await (await call('/api/memories')).json()).memories[0].text === '呼び名はハイト', '編集が反映される');
await call(`/api/memories/${mm.memory.id}`, { method: 'DELETE' });
ok((await (await call('/api/memories')).json()).memories.length === 0, 'メモを削除');

console.log('Console実額の確認');
ok((await call('/api/ledger/sync', { method: 'POST', body: {} })).status === 400, '管理用キーがなければ案内して終わる');
const stx = await (await call('/api/state')).json();
ok(stx.syncAvailable === false, '管理用キーがないと同期ボタンは出さない');

console.log(fails ? `\n失敗 ${fails} 件` : '\nすべて成功');
process.exit(fails ? 1 : 0);
