// 金額はすべて nano-USD(1e-9 ドル)の整数。
// 「$/100万トークン」の値は、そのまま「micro-USD/トークン」になり、×1000 で nano-USD/トークンになる。

export const NANO = 1_000_000_000;

export type ModelKey = 'sonnet' | 'opus' | 'fable';

export interface ModelSpec {
  id: string;
  name: string;
  in: number;   // nano-USD / 入力トークン
  out: number;  // nano-USD / 出力トークン
  w5: number;   // 5分キャッシュ書き込み
  hit: number;  // キャッシュ読み出し
  recMax: number;
  medOut: number;   // 見込みの出力(表示用の期待値)
  think: number;    // 見込みの思考トークン
}

// 出典: platform.claude.com/docs/en/about-claude/pricing(2026-11 時点)
export const MODELS: Record<ModelKey, ModelSpec> = {
  sonnet: { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', in: 2000, out: 10000, w5: 2500, hit: 100, recMax: 16000, medOut: 1100, think: 300 },
  opus:   { id: 'claude-opus-5-5',   name: 'Opus 5.5',   in: 4000, out: 20000, w5: 5000, hit: 200, recMax: 16000, medOut: 1500, think: 700 },
  fable:  { id: 'claude-fable-5-2',  name: 'Fable 5.2',  in: 8000, out: 40000, w5: 10000, hit: 200, recMax: 32000, medOut: 2200, think: 1200 },
};

export const MODEL_KEYS = Object.keys(MODELS) as ModelKey[];
export const isModelKey = (k: unknown): k is ModelKey => typeof k === 'string' && k in MODELS;

export const SEARCH_NANO = 10_000_000;        // $0.01 / 検索
export const SEARCH_MAX_USES = 3;             // 1送信あたり
export const SEARCH_RESERVE_TOKENS = 20_000;  // 検索1回あたりに入力へ足される量の予約(上限は保証できないので多めに)
export const SEARCH_TOOL_OVERHEAD = 400;      // count_tokens は server tool を数えられないので定数で上乗せ
export const SEARCH_MAX_LIMIT = 20;           // 「制限なし」を選んでも、内部ではこの回数までに丸める(上限の保証を守るため)
export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];
export const EFFORT_FACTOR: Record<Effort, number> = { low: 0.6, medium: 1, high: 1.7 }; // 見込みの出力(思考込み)への係数。表示用の目安。
export const EFFORT = 'medium';
export const PRESETS = [4000, 8000, 16000, 32000, 64000];
export const RESERVATION_TTL_MS = 15 * 60 * 1000;
export const CACHE_TTL_MS = 5 * 60 * 1000;

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number };
}

/** 実際に使われたトークンから請求額を計算する。 */
export function costOf(m: ModelSpec, u: Usage): number {
  const searches = u.server_tool_use?.web_search_requests ?? 0;
  return (
    (u.input_tokens ?? 0) * m.in +
    (u.cache_creation_input_tokens ?? 0) * m.w5 +
    (u.cache_read_input_tokens ?? 0) * m.hit +
    (u.output_tokens ?? 0) * m.out +
    searches * SEARCH_NANO
  );
}

export interface Quote {
  inputTokens: number;
  newTokens: number;
  histTokens: number;
  cacheWarm: boolean;
  inputNano: number;     // 最悪(全部キャッシュ書き込み)での入力コスト
  expectedNano: number;
  worstNano: number;
  searchWorstNano: number;
  outMax: number;
}

export function makeQuote(
  m: ModelSpec,
  p: {
    histTokens: number; newTokens: number; cacheWarm: boolean; outMax: number; search: boolean;
    searchMax?: number;        // 既定 SEARCH_MAX_USES
    searchAuto?: boolean;      // 自動のときは、使うとは限らないので見込みには検索分を入れない(最悪ケースには入れる)
    effort?: Effort;
    expOut?: number;           // 見込みの出力トークンを直接指定(圧縮など)
  },
): Quote {
  const overhead = p.search ? SEARCH_TOOL_OVERHEAD : 0;
  const newT = p.newTokens + overhead;
  const total = p.histTokens + newT;
  // 最悪: キャッシュに当たらず、全量を書き込み価格で払う
  const inputNano = Math.ceil(total * m.w5);
  // 期待: 履歴はキャッシュ読み出し(温まっていれば)
  const expectedIn = p.cacheWarm ? p.histTokens * m.hit + newT * m.w5 : total * m.w5;
  const sN = p.search ? (p.searchMax ?? SEARCH_MAX_USES) : 0;
  const searchWorstNano = sN * (SEARCH_NANO + SEARCH_RESERVE_TOKENS * m.w5);
  const expectedNano = Math.ceil(
    expectedIn + (p.expOut ?? (m.medOut + m.think) * EFFORT_FACTOR[p.effort ?? 'medium']) * m.out + (p.search && !p.searchAuto ? SEARCH_NANO + 6000 * m.in : 0),
  );
  const worstNano = Math.ceil(inputNano + p.outMax * m.out + searchWorstNano);
  return {
    inputTokens: total,
    newTokens: newT,
    histTokens: p.histTokens,
    cacheWarm: p.cacheWarm,
    inputNano,
    expectedNano,
    worstNano,
    searchWorstNano,
    outMax: p.outMax,
  };
}
