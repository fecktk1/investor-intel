// Metadata-drift detection (v3.1, Batch 3 — CP-3 poll replacement).
//
// Our CoinGecko plan has NO webhooks/websockets, so contract-migration and
// metadata-drift alerts are POLL-sourced: snapshot a coin's platforms/symbol/
// name/logo, diff against the stored baseline, and emit metadata_drift_events on
// change. The alert bridge (metadata_migration trigger) fires intel_alert_events
// from those rows. Pure functions here are unit-tested; the edge fn does I/O.

import { stableHash } from './provider-fact-rag.ts'

export interface MetaBaseline {
  symbol?: string | null
  name?: string | null
  image?: string | null
  platforms?: Record<string, string> | null
}

export interface DriftEvent {
  drift_type: 'contract_migration' | 'symbol_change' | 'name_change' | 'logo_change'
  severity: number
  old_value: unknown
  new_value: unknown
}

function normPlatforms(p: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (p && typeof p === 'object') {
    for (const [k, v] of Object.entries(p)) {
      if (k && typeof v === 'string' && v.trim()) out[k.toLowerCase()] = v.trim().toLowerCase()
    }
  }
  return out
}

// Contract migration = a chain's contract address changed, or a chain was
// added/removed. (Pure additions on a brand-new baseline are NOT drift — the
// caller skips diffing when there is no prior baseline.)
export function platformsChanged(oldP: Record<string, string> | null | undefined, newP: Record<string, string> | null | undefined): { changed: boolean; detail: Record<string, { old: string | null; new: string | null }> } {
  const a = normPlatforms(oldP), b = normPlatforms(newP)
  const detail: Record<string, { old: string | null; new: string | null }> = {}
  const chains = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const c of chains) {
    const oldV = a[c] ?? null, newV = b[c] ?? null
    if (oldV !== newV) detail[c] = { old: oldV, new: newV }
  }
  return { changed: Object.keys(detail).length > 0, detail }
}

// Extract the comparable metadata shape from a CoinGecko /coins/{id} doc.
// deno-lint-ignore no-explicit-any
export function metaFromCoinDoc(doc: any): MetaBaseline {
  const image = doc?.image?.large || doc?.image?.small || doc?.image?.thumb || null
  return {
    symbol: doc?.symbol ? String(doc.symbol).toLowerCase() : null,
    name: doc?.name ? String(doc.name) : null,
    image: image ? String(image) : null,
    platforms: normPlatforms(doc?.platforms),
  }
}

export function detectMetadataDrift(baseline: MetaBaseline, next: MetaBaseline): DriftEvent[] {
  const out: DriftEvent[] = []
  const pc = platformsChanged(baseline.platforms, next.platforms)
  if (pc.changed) out.push({ drift_type: 'contract_migration', severity: 90, old_value: baseline.platforms ?? {}, new_value: next.platforms ?? {} })
  if (baseline.symbol && next.symbol && baseline.symbol !== next.symbol) {
    out.push({ drift_type: 'symbol_change', severity: 60, old_value: baseline.symbol, new_value: next.symbol })
  }
  if (baseline.name && next.name && baseline.name !== next.name) {
    out.push({ drift_type: 'name_change', severity: 40, old_value: baseline.name, new_value: next.name })
  }
  if (baseline.image && next.image && baseline.image !== next.image) {
    out.push({ drift_type: 'logo_change', severity: 30, old_value: baseline.image, new_value: next.image })
  }
  return out
}

// Stable dedup key per (chain:addr / ref, drift_type, new value) so the same
// drift is never double-recorded.
export function driftDedupKey(refKey: string, d: DriftEvent): string {
  return `${refKey}:${d.drift_type}:${stableHash(JSON.stringify(d.new_value))}`
}
