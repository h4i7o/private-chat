import { MODEL_KEYS, MODELS, PRESETS, RESERVATION_TTL_MS, type ModelKey } from './pricing';

export interface LedgerView {
  spent: number;
  reserved: number;
  override: boolean;
  resets: number;
  byModel: Record<ModelKey, number>;
}

export async function readLedger(db: D1Database, now: number): Promise<LedgerView> {
  const [l, r, m] = await db.batch([
    db.prepare('SELECT spent, override, resets FROM ledger WHERE id = 1'),
    db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM reservations WHERE created_at > ?').bind(now - RESERVATION_TTL_MS),
    db.prepare('SELECT model, spent FROM ledger_models'),
  ]);
  const row = l.results[0] as { spent: number; override: number; resets: number };
  const byModel = { sonnet: 0, opus: 0, fable: 0 } as Record<ModelKey, number>;
  for (const x of m.results as { model: ModelKey; spent: number }[]) byModel[x.model] = x.spent;
  return {
    spent: row.spent,
    reserved: (r.results[0] as { s: number }).s,
    override: !!row.override,
    resets: row.resets,
    byModel,
  };
}

const RESERVED_SQL = '(SELECT COALESCE(SUM(amount), 0) FROM reservations WHERE created_at > ?4)';

/**
 * 最悪ケース分を原子的に予約する。
 * 通常: 残額 >= worst のときだけ worst を確保。
 * 制限解除中: 残額が minViable 以上なら「残額ぜんぶ」を確保(送信側が max_tokens をそれに合わせて絞る)。
 */
export async function reserve(
  db: D1Database,
  id: string,
  now: number,
  cap: number,
  worst: number,
  minViable: number,
): Promise<{ ok: true; amount: number; overridden: boolean } | { ok: false; why: 'cap' | 'worst' }> {
  const since = now - RESERVATION_TTL_MS;
  await db.prepare('DELETE FROM reservations WHERE created_at <= ?').bind(since).run();

  const a = await db
    .prepare(
      `INSERT INTO reservations (id, amount, created_at)
       SELECT ?1, ?2, ?3
       WHERE (SELECT spent FROM ledger WHERE id = 1) + ${RESERVED_SQL} + ?2 <= ?5`,
    )
    .bind(id, worst, now, since, cap)
    .run();
  if (a.meta.changes === 1) return { ok: true, amount: worst, overridden: false };

  const b = await db
    .prepare(
      `INSERT INTO reservations (id, amount, created_at)
       SELECT ?1, ?5 - l.spent - ${RESERVED_SQL}, ?3
       FROM ledger l
       WHERE l.id = 1 AND l.override = 1 AND ?5 - l.spent - ${RESERVED_SQL} >= ?2`,
    )
    .bind(id, minViable, now, since, cap)
    .run();
  if (b.meta.changes === 1) {
    const row = await db.prepare('SELECT amount FROM reservations WHERE id = ?').bind(id).first<{ amount: number }>();
    return { ok: true, amount: row!.amount, overridden: true };
  }

  const led = await readLedger(db, now);
  const remaining = cap - led.spent - led.reserved;
  return { ok: false, why: remaining < minViable ? 'cap' : 'worst' };
}

export function settleStatements(db: D1Database, id: string, model: ModelKey, actual: number): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM reservations WHERE id = ?').bind(id),
    db.prepare('UPDATE ledger SET spent = spent + ? WHERE id = 1').bind(actual),
    db.prepare('UPDATE ledger_models SET spent = spent + ? WHERE model = ?').bind(actual, model),
  ];
}

export async function readMaxTokens(db: D1Database): Promise<Record<ModelKey, number>> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'maxTokens'").first<{ value: string }>();
  const out = {} as Record<ModelKey, number>;
  let saved: Partial<Record<ModelKey, number>> = {};
  try { if (row) saved = JSON.parse(row.value); } catch { /* 既定値へ */ }
  for (const k of MODEL_KEYS) out[k] = PRESETS.includes(saved[k] as number) ? (saved[k] as number) : MODELS[k].recMax;
  return out;
}
