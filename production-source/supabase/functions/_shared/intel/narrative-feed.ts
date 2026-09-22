// Investor Intel: the Narrative Radar response shapes, shared by intel-narratives
// and the public demo's snapshot reader (./narrative-public-read.ts).

const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0)

/** Summary-row counts by the 5 display statuses (narratives are few). */
// deno-lint-ignore no-explicit-any
export function narrativeFeedSummary(list: any[]) {
  const summary = {
    heating_up: 0, early: 0, crowded: 0, cooling: 0, dormant: 0,
    bullish: 0, bearish: 0, high_risk: 0, followed: 0,
  }
  for (const r of list) {
    const ds = String(r.display_status || '')
    if (ds in summary) (summary as Record<string, number>)[ds]++
    if (r.signal_class === 'bullish') summary.bullish++
    if (r.signal_class === 'bearish') summary.bearish++
    if (num(r.risk_score) >= 60) summary.high_risk++
    if (r.is_followed) summary.followed++
  }
  return summary
}

/** The feed response intel-narratives returns for a list of feed rows. */
// deno-lint-ignore no-explicit-any
export function narrativeFeedResponse(rows: any[] | null | undefined) {
  const list = rows || []
  return { narratives: list, summary: narrativeFeedSummary(list), count: list.length }
}
