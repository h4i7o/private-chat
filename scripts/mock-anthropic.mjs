// 実APIを使わずに動作確認するための偽Anthropicサーバー。
// /v1/messages/count_tokens と /v1/messages(SSE)を、本物と同じ形式で返す。課金は発生しない。
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8788);

const est = (s) => {
  let c = 0, o = 0;
  for (const ch of s) (ch.codePointAt(0) >= 0x2e80 ? c++ : o++);
  return Math.ceil(c * 1.05 + o / 3);
};

function countBlock(b) {
  if (typeof b === 'string') return est(b);
  if (b.type === 'text') return est(b.text) + 4;
  if (b.type === 'image') return 1200;
  if (b.type === 'document') {
    if (b.source.type === 'text') return est(b.source.data) + 20;
    return Math.max(1800, Math.ceil((b.source.data.length * 0.75) / 2500) * 1800);
  }
  return 0;
}
function countRequest(body) {
  let n = body.system ? est(typeof body.system === 'string' ? body.system : JSON.stringify(body.system)) : 0;
  for (const m of body.messages ?? []) {
    n += 4;
    if (typeof m.content === 'string') n += est(m.content);
    else for (const b of m.content) n += countBlock(b);
  }
  return n;
}

const HTML_DEMO = `<style>
html,body{height:100%;margin:0}
body{display:grid;place-items:center;background:linear-gradient(135deg,#1d2b64,#f8cdda);font-family:-apple-system,system-ui,sans-serif;color:#fff}
.card{padding:28px 36px;border-radius:24px;background:rgba(255,255,255,.18);backdrop-filter:blur(14px);box-shadow:0 20px 60px rgba(0,0,0,.25);text-align:center}
h1{margin:0 0 6px;font-size:28px}button{margin-top:12px;border:0;border-radius:14px;padding:10px 18px;font-size:15px;background:#fff;color:#1d2b64;cursor:pointer}
</style>
<div class="card"><h1 id="n">0</h1><div>モック応答のHTMLデモ</div><button id="b">+1</button></div>
<script>
let n=0;document.getElementById('b').onclick=()=>{n++;document.getElementById('n').textContent=n};
</script>`;

function lastUserText(body) {
  const m = [...(body.messages ?? [])].reverse().find((x) => x.role === 'user');
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

let seqNo = 0;
function reply(body) {
  const t = lastUserText(body);
  if (t.startsWith('ここまでの会話を')) return '## 要約(モック)\n- 会話の要点: ' + (body.messages ?? []).filter((m) => m.role === 'user').length + ' 件のやり取り\n- 続きはここから再開できます';
  const attach = (body.messages ?? []).at(-1)?.content?.filter?.((b) => b.type !== 'text').length ?? 0;
  if (/html|ページ|時計|作って/i.test(t)) return '作成しました。\n\n```html\n' + HTML_DEMO + '\n```\n\n変更したい点があれば送ってください。';
  if (/ファイル作成|file card/i.test(t)) return 'ファイルを作りました。\n\n```python file=solve.py\n' + Array.from({ length: 24 }, (_, i) => `# line ${i + 1}\nprint(${i})`).join('\n') + '\n```\n\nメモも付けます。\n\n```markdown file=memo.md\n# メモ\n\n- 項目A\n- 項目B\n\n**太字**のテスト\n```\n\n短い断片は普通のブロックです。\n\n```js\nconsole.log(1)\n```';
  if (/数式|math/i.test(t)) return '二次方程式の解は $x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}$ です。\n\n$$\\int_0^1 x^2\\,dx=\\frac13$$\n\n流れ図:\n\n```mermaid\nflowchart LR\n  A[入力] --> B{判定}\n  B -->|はい| C[出力]\n  B -->|いいえ| D[やり直し]\n```\n\n価格は$5と$10です。';
  if (/長文|long/i.test(t)) return 'これは長い応答のテストです。'.repeat(400);
  return [
    `**モック応答**です(${body.model})。`,
    '',
    `- effort: ${body.output_config?.effort ?? '(未指定)'}`,
    `- max_tokens: ${body.max_tokens}`,
    `- 添付ブロック: ${attach}`,
    `- メモリ: ${/覚えていること/.test(typeof body.system === 'string' ? body.system : '') ? 'あり' : 'なし'}`,
    `- 思考: ${body.thinking ? body.thinking.type + '/' + body.thinking.display : 'なし'}`,
    `- 受け取った文: ${t.slice(0, 60)}`,
    `- 応答番号: ${++seqNo}`,
  ].join('\n');
}

const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s)); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!req.headers['x-api-key']) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'x-api-key がありません' } })); }
  if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
  const body = JSON.parse((await readBody(req)) || '{}');

  if (url.pathname === '/v1/messages/count_tokens') {
    if (body.tools?.some((t) => t.type?.startsWith('web_search'))) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'server tools are not supported' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ input_tokens: countRequest(body) }));
  }

  if (url.pathname === '/v1/messages') {
    const inTok = countRequest(body) + (body.tools ? 400 : 0);
    const useSearch = !!body.tools?.some((t) => t.type?.startsWith('web_search'));
    let text = reply(body);
    let reason = 'end_turn';
    const maxChars = body.max_tokens * 3;
    if (text.length > maxChars) { text = text.slice(0, maxChars); reason = 'max_tokens'; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_mock_' + Date.now().toString(36) });
    let closed = false;
    res.on('close', () => { closed = true; });
    const think = Number(process.env.MOCK_THINK_MS || 400);
    send(res, 'message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 0, cache_creation_input_tokens: inTok, cache_read_input_tokens: 0, output_tokens: 1 } } });
    await new Promise((r) => setTimeout(r, think));
    let idx = 0;
    let searches = 0;
    if (useSearch && !closed) {
      searches = 1;
      send(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} } });
      send(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: '{"query":"mock"}' } });
      send(res, 'content_block_stop', { type: 'content_block_stop', index: idx++ });
      send(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [
        { type: 'web_search_result', title: 'モック結果 A', url: 'https://example.com/a', page_age: null, encrypted_content: 'x' },
        { type: 'web_search_result', title: 'モック結果 B', url: 'https://example.org/b', page_age: null, encrypted_content: 'y' },
      ] } });
      send(res, 'content_block_stop', { type: 'content_block_stop', index: idx++ });
      await new Promise((r) => setTimeout(r, 300));
    }
    if (body.thinking && !closed) {
      send(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } });
      for (const part of ['まず問いの意図を整理する。', '次に根拠を確かめる。', '最後に簡潔にまとめる。']) {
        send(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: part } });
        await new Promise((r) => setTimeout(r, 60));
      }
      send(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: 'sig' } });
      send(res, 'content_block_stop', { type: 'content_block_stop', index: idx++ });
    }
    send(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
    const step = 6;
    const citeAt = useSearch ? Math.floor(text.length / 2) : -1;
    let cited = false;
    for (let i = 0; i < text.length && !closed; i += step) {
      send(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: text.slice(i, i + step) } });
      if (!cited && citeAt >= 0 && i + step >= citeAt) {
        cited = true;
        send(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://example.com/a', title: 'モック結果 A', cited_text: 'x', encrypted_index: 'e' } } });
        send(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://example.org/b', title: 'モック結果 B', cited_text: 'y', encrypted_index: 'f' } } });
      }
      await new Promise((r) => setTimeout(r, Number(process.env.MOCK_DELAY_MS || 12)));
    }
    if (closed) return;
    send(res, 'content_block_stop', { type: 'content_block_stop', index: idx });
    const outTok = est(text) + 150; // 思考ぶんを上乗せ
    send(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { input_tokens: 0, cache_creation_input_tokens: inTok, cache_read_input_tokens: 0, output_tokens: Math.min(outTok, body.max_tokens), ...(searches ? { server_tool_use: { web_search_requests: searches } } : {}) } });
    send(res, 'message_stop', { type: 'message_stop' });
    return res.end();
  }
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`[mock-anthropic] http://127.0.0.1:${PORT}`));
