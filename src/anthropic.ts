import type { Env } from './types';

const VERSION = '2023-06-01';

function headers(env: Env): HeadersInit {
  return { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': VERSION };
}
const base = (env: Env) => (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');

export class UpstreamError extends Error {
  constructor(public status: number, public body: string) {
    super(`upstream ${status}`);
  }
}

/** POST /v1/messages/count_tokens。無料(推定値)。server tool(web search)は数えられない。 */
export async function countTokens(env: Env, body: Record<string, unknown>): Promise<number> {
  const r = await fetch(`${base(env)}/v1/messages/count_tokens`, { method: 'POST', headers: headers(env), body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new UpstreamError(r.status, t);
  return (JSON.parse(t) as { input_tokens: number }).input_tokens;
}

export async function openStream(env: Env, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
  const r = await fetch(`${base(env)}/v1/messages`, { method: 'POST', headers: headers(env), body: JSON.stringify({ ...body, stream: true }), signal });
  if (!r.ok) throw new UpstreamError(r.status, await r.text());
  return r;
}

/** SSE をイベント単位に分解する。 */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: any }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
        let event = 'message';
        const data: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (!data.length) continue;
        try { yield { event, data: JSON.parse(data.join('\n')) }; } catch { /* 壊れた断片は無視 */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}
