// Investor Intel public demo: the Narrative Radar as a visitor with nothing
// followed sees it, read with the service role from the shared narrative tables.
//
// intel-narratives answers the feed and the detail through two SECURITY DEFINER
// functions that need a signed-in member (narrative_feed checks the caller's
// workspace, narrative_detail checks auth.uid()). The demo has no member and the
// snapshot builder never acts as one, so this module computes the same rows
// those functions return for a member with no follows, no watchlist, no book,
// no private sources and no interactions:
//   * every personal term in the ranking is zero, so relevance_score is 0,
//     final_rank is global_priority_score - 0.15 * risk_score, is_followed and
//     from_user_source are false and relevance_labels is empty;
//   * everything else (the taxonomy, the scores, the drivers, the ranked source
//     list, the chatter blob, the category cap and the order) follows the SQL.
// Nothing here reads a personal table. The history and the shared brief use the
// same readers intel-narratives uses.

import { narrativeFeedResponse } from './narrative-feed.ts'
import { readNarrativeBrief } from './narrative-brief-read.ts'
import { readNarrativeHistory } from './narrative-history-read.ts'
import { readAllRows } from './paged-read.ts'

// deno-lint-ignore no-explicit-any
type Db = any
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>

const FEED_STATE_COLUMNS = [
  'momentum_score', 'chatter_score', 'price_confirmation_score', 'volume_confirmation_score', 'breadth_score', 'freshness_score',
  'crowding_score', 'risk_score', 'confidence_score', 'global_priority_score', 'signal_class', 'lifecycle_stage', 'prev_stage',
  'onchain_status', 'onchain_summary', 'leaders', 'laggards', 'related_chains', 'related_assets', 'source_drivers', 'score_delta',
  'brief_artifact_ref', 'last_brief_at', 'scored_at',
]
const LIVE = ['active', 'surfaced']

const numOrNull = (v: unknown) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
// ORDER BY x DESC NULLS LAST
const descNullsLast = (a: number | null, b: number | null) => (a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : b - a)
const byName = (a: unknown, b: unknown) => String(a ?? '').localeCompare(String(b ?? ''), 'en')

/** narrative_feed(p_org_id, p_limit) for a member with no personal signal. */
export function publicFeedRows(taxonomy: Row[], states: Row[], limit = 80): Row[] {
  const stateBy = new Map(states.map((s) => [String(s.narrative_id), s]))
  const feed = taxonomy.filter((t) => LIVE.includes(String(t.status))).map((t) => {
    const s = stateBy.get(String(t.id)) || {}
    const row: Row = { slug: t.slug, name: t.name, parent_category: t.parent_category ?? null, origin: t.origin ?? null, status: t.status, chains: t.chains ?? null }
    for (const column of FEED_STATE_COLUMNS) row[column] = s[column] ?? null
    row.is_followed = false
    row.from_user_source = false
    row.relevance_score = 0
    row.final_rank = (numOrNull(s.global_priority_score) ?? 0) - (numOrNull(s.risk_score) ?? 0) * 0.15
    row.clarity_labels = s.clarity_labels ?? []
    row.relevance_labels = []
    return row
  })
  const rank = (a: Row, b: Row) => descNullsLast(a.final_rank, b.final_rank)
    || descNullsLast(numOrNull(a.global_priority_score), numOrNull(b.global_priority_score)) || byName(a.name, b.name)
  // A narrative with no parent category is its own entity; at most 4 slots.
  const groups = new Map<string, Row[]>()
  for (const row of feed) {
    const group = String(row.parent_category ?? `slug:${row.slug}`)
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group)!.push(row)
  }
  const slot = new Map<Row, number>()
  for (const rows of groups.values()) [...rows].sort(rank).forEach((row, i) => slot.set(row, Math.min(i + 1, 4)))
  return feed.sort((a, b) => slot.get(a)! - slot.get(b)! || rank(a, b)).slice(0, Math.max(1, Math.min(limit, 200)))
}

/** The intel-narratives feed body ({ mode: 'feed' }), and each row's id for planning. */
export async function readPublicNarrativeFeed(db: Db, limit = 80): Promise<{ body: Row; ids: Map<string, string> }> {
  const taxonomy = await readAllRows(() => db.from('narrative_taxonomy').select('id,slug,name,parent_category,origin,status,chains').in('status', LIVE).order('id'))
  const states = await readAllRows(() => db.from('narrative_state').select(['narrative_id', 'clarity_labels', ...FEED_STATE_COLUMNS].join(',')).order('narrative_id'))
  const rows = publicFeedRows(taxonomy, states, limit)
  return { body: narrativeFeedResponse(rows), ids: new Map(taxonomy.map((t) => [String(t.slug), String(t.id)])) }
}

/** narrative_detail's ranked source list: relevance, source quality and recency. */
export function rankNarrativeSources(signals: Row[], now: number, max = 24): Row[] {
  // A row with no clock has a NULL rank_score in SQL, and ORDER BY ... DESC
  // puts NULLs first.
  const score = (x: Row): number | null => {
    const at = Date.parse(String(x.observed_at ?? x.fetched_at ?? ''))
    if (!Number.isFinite(at)) return null
    const ageDays = (now - at) / 86_400_000
    return (numOrNull(x.relevance_score) ?? 40) * 0.4 + (numOrNull(x.source_quality_score) ?? 45) * 0.3 + Math.max(0, 100 - ageDays * 8) * 0.3
  }
  return signals
    .filter((x) => x.source_url != null && (x.relevance_score == null || Number(x.relevance_score) >= 30))
    .map((x) => ({ x, rank: score(x) }))
    .sort((a, b) => (a.rank == null ? (b.rank == null ? 0 : -1) : b.rank == null ? 1 : b.rank - a.rank))
    .slice(0, max)
    .map(({ x }) => ({
      signal_kind: x.signal_kind, provider: x.provider, scoring_role: x.scoring_role, url: x.source_url, title: x.title,
      author_handle: x.author_handle, snippet: x.snippet, bias: x.bias, source_quality_score: x.source_quality_score,
      relevance_score: x.relevance_score, domain: x.source_domain, observed_at: x.observed_at,
    }))
}

/** narrative_detail(slug) for a visitor, plus the shared brief: the intel-narratives
 * detail body ({ mode: 'detail', slug }). Null when the narrative is not live. */
export async function readPublicNarrativeDetail(db: Db, slug: string, now = Date.now()): Promise<Row | null> {
  const { data: taxonomy, error } = await db.from('narrative_taxonomy').select('*').eq('slug', slug).in('status', LIVE).maybeSingle()
  if (error) throw new Error('narrative_public_read_failed:taxonomy')
  if (!taxonomy?.id) return null
  const id = taxonomy.id
  const { membership_rules: _rules, ...taxonomyOut } = taxonomy
  const { data: state } = await db.from('narrative_state').select('*').eq('narrative_id', id).maybeSingle()
  const stateOut = state ? (({ debug: _debug, ...rest }) => rest)(state) : null
  const drivers = await readAllRows(() => db.from('narrative_source_drivers').select('*').eq('narrative_id', id).order('last_seen_at', { ascending: false, nullsFirst: false }).order('id'))
  const signals = await readAllRows(() => db.from('narrative_signals')
    .select('signal_kind,provider,scoring_role,source_url,title,author_handle,snippet,bias,source_quality_score,relevance_score,source_domain,observed_at,fetched_at')
    .eq('narrative_id', id).not('source_url', 'is', null).order('id'))
  // Prefer the Grok chatter aggregate; fall back to any provider's.
  const chatterRow = async (grok: boolean) => {
    let q = db.from('narrative_signals').select('strength,bias,raw').eq('narrative_id', id).eq('signal_kind', 'social_chatter')
    q = grok ? q.eq('provider', 'grok') : q
    const { data } = await q.order('fetched_at', { ascending: false }).limit(1).maybeSingle()
    return data || null
  }
  const chatter = (await chatterRow(true)) || (await chatterRow(false))
  const detail = {
    taxonomy: taxonomyOut,
    state: stateOut,
    drivers,
    sources: rankNarrativeSources(signals, now),
    chatter: chatter ? { strength: chatter.strength, bias: chatter.bias, raw: chatter.raw } : null,
    is_followed: false,
  }
  // Same shape as intel-narratives: { ...detail, ...await readNarrativeBrief(u, slug) }.
  return { ...detail, ...await readNarrativeBrief(db, slug) }
}

/** The intel-narratives body for one request, or null when it is not a shared read. */
export async function readPublicNarratives(db: Db, body: Row, now = Date.now()): Promise<{ status: number; body: unknown } | null> {
  const mode = String(body?.mode || 'feed')
  const slug = typeof body?.slug === 'string' ? body.slug : null
  if (mode === 'feed') {
    const limit = Math.max(1, Math.min(200, Number(body.limit) || 80))
    return { status: 200, body: (await readPublicNarrativeFeed(db, limit)).body }
  }
  if (mode === 'detail' && slug) {
    const detail = await readPublicNarrativeDetail(db, slug, now)
    return detail ? { status: 200, body: detail } : null
  }
  if (mode === 'history' && slug) {
    const days = Math.max(1, Math.min(365, Number(body.days) || 30))
    return { status: 200, body: await readNarrativeHistory(db, slug, days, body.before) }
  }
  // debug is super-admin only; anything else is not part of the demo.
  return null
}
