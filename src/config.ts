import { SEARCH_MAX_LIMIT, SEARCH_MAX_USES, EFFORTS, type Effort } from './pricing';

// 最高権限者が決める動作設定。初期値は「Effort 中で固定 / 権限 手動 / 検索 最大3回」。
export interface Config {
  effortMode: 'fixed' | 'select';   // fixed: 中に固定 / select: 低・中・高から選べる
  permission: 'manual' | 'auto';    // manual: 検索は送信ごとにON/OFF / auto: Claudeが判断して検索
  searchMax: number;                // 1送信あたりの最大検索回数 (1〜SEARCH_MAX_LIMIT)
  searchUnlimited: boolean;         // 「制限なし」。内部では SEARCH_MAX_LIMIT 回までに丸める(上限の保証を守るため)
  thinking: boolean;                // 思考(adaptive)を使い、要約を表示する。思考ぶんの出力も課金対象
}

export const DEFAULT_CONFIG: Config = { effortMode: 'fixed', permission: 'manual', searchMax: SEARCH_MAX_USES, searchUnlimited: false, thinking: true };

export const searchMaxOf = (c: Config) => (c.searchUnlimited ? SEARCH_MAX_LIMIT : c.searchMax);

export function effortOf(c: Config, requested: unknown): Effort {
  return c.effortMode === 'select' && EFFORTS.includes(requested as Effort) ? (requested as Effort) : 'medium';
}

export async function readConfig(db: D1Database): Promise<Config> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'config'").first<{ value: string }>();
  let saved: Partial<Config> = {};
  try { if (row) saved = JSON.parse(row.value); } catch { /* 既定値へ */ }
  return normalize({ ...DEFAULT_CONFIG, ...saved });
}

function normalize(c: Config): Config {
  const n = Math.round(Number(c.searchMax));
  return {
    effortMode: c.effortMode === 'select' ? 'select' : 'fixed',
    permission: c.permission === 'auto' ? 'auto' : 'manual',
    searchMax: Number.isFinite(n) ? Math.min(SEARCH_MAX_LIMIT, Math.max(1, n)) : SEARCH_MAX_USES,
    searchUnlimited: !!c.searchUnlimited,
    thinking: c.thinking !== false,
  };
}

/** 一部だけ書き換える。不正な値はエラーメッセージを返す。 */
export function patchConfig(prev: Config, p: any): Config | string {
  if (!p || typeof p !== 'object') return '設定が不正です';
  const next = { ...prev };
  if (p.effortMode !== undefined) { if (p.effortMode !== 'fixed' && p.effortMode !== 'select') return 'Effort の設定が不正です'; next.effortMode = p.effortMode; }
  if (p.permission !== undefined) { if (p.permission !== 'manual' && p.permission !== 'auto') return '権限の設定が不正です'; next.permission = p.permission; }
  if (p.searchMax !== undefined) {
    const n = Number(p.searchMax);
    if (!Number.isInteger(n) || n < 1 || n > SEARCH_MAX_LIMIT) return `検索回数は 1〜${SEARCH_MAX_LIMIT} の整数で指定してください`;
    next.searchMax = n;
  }
  if (p.searchUnlimited !== undefined) { if (typeof p.searchUnlimited !== 'boolean') return '検索の設定が不正です'; next.searchUnlimited = p.searchUnlimited; }
  if (p.thinking !== undefined) { if (typeof p.thinking !== 'boolean') return '思考の設定が不正です'; next.thinking = p.thinking; }
  return normalize(next);
}
