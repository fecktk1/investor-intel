// Investor Intel — retention tier policy (pure; mirrors migration 224/227 SQL).
//
// This is the single source of truth for the tier vocabulary + intervals, kept
// in TS so it is unit-testable (prune-map tests prove retain_forever / evergreen
// / important / historic rows are NEVER eligible for the standard prune). The SQL
// _intel_prune_predicate() encodes the same rules; keep them in lockstep.

export type RetentionTier = 'media' | 'low_value' | 'standard' | 'important' | 'historic' | 'evergreen'

// Operator decision #15 + #1: 15-month baseline (NOT 180 days). Day-fallbacks use 456, not 450.
export const TIER_DAYS: Record<RetentionTier, number | null> = {
  media: 7,
  low_value: 45,        // 30–60d band
  standard: 456,        // ~15 months
  important: 1095,      // 3 years
  historic: 1095,       // 3 years minimum (may be permanent)
  evergreen: null,      // never standard-prune
}

// Tiers a standard prune must never touch.
export const PROTECTED_TIERS: ReadonlySet<RetentionTier> = new Set(['important', 'historic', 'evergreen'])

export interface RetentionRow {
  retention_tier?: string | null
  retain_forever?: boolean | null
  retain_until?: string | null   // ISO
  // the row's age reference timestamp (fetched_at / created_at / snapshot_at)
  age_ts?: string | null         // ISO
}

/** TRUE when a standard prune is allowed to delete this row. Conservative: any
 *  ambiguity (missing age, future retain_until, protected tier, retain_forever)
 *  resolves to PROTECTED. */
export function isPruneEligible(row: RetentionRow, tier: RetentionTier, nowMs: number): boolean {
  if (row.retain_forever === true) return false
  const t = (row.retention_tier as RetentionTier) || tier
  if (PROTECTED_TIERS.has(t)) return false
  if (row.retain_until && new Date(row.retain_until).getTime() > nowMs) return false
  const days = TIER_DAYS[tier]
  if (days == null) return false                 // evergreen interval
  if (!row.age_ts) return false                  // unknown age → never prune
  const ageMs = nowMs - new Date(row.age_ts).getTime()
  if (!isFinite(ageMs)) return false
  return ageMs > days * 86_400_000
}

/** Partition a set of rows into eligible / protected for a dry-run preview. */
export function prunePreview<T extends RetentionRow>(rows: T[], tier: RetentionTier, nowMs: number): { eligible: T[]; protected_: T[] } {
  const eligible: T[] = []; const protected_: T[] = []
  for (const r of rows) (isPruneEligible(r, tier, nowMs) ? eligible : protected_).push(r)
  return { eligible, protected_ }
}
