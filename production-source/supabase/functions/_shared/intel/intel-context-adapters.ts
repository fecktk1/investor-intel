// Investor adapter — Explain This context routing + similarity reuse.
//
// Deterministic, no AI: tokenizes the question (core), matches against the user's
// CACHED surfaces (watchlist, holdings, narratives, alerts, saved research, news,
// theses, wallet summaries, Intel Signals) with one indexed read each, and returns
// a compact routed_context for grounding. routed_context is passed to the model IN
// MEMORY ONLY — never persisted. For similarity, only HMAC-hashed norm-hash +
// shingles are stored (org-scoped research_artifacts), never raw questions.

import { tokenizeQuestion, hashQuestion, jaccard, EXPLAIN_SIMILARITY, type QuestionHashes } from '../core-intel/context-router.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function hashSecret(): string {
  return Deno.env.get('INTEL_HASH_SECRET') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || 'intel-dev-secret'
}

export async function computeQuestionHashes(question: unknown, orgId: string): Promise<QuestionHashes> {
  return await hashQuestion(question, hashSecret(), orgId)
}

export interface RoutedContext {
  routed_context: Record<string, unknown>
  matched_surfaces: string[]
}

const cap = <T>(rows: T[] | null | undefined, n: number): T[] => (rows || []).slice(0, n)

/** Route a question to the user's cached context. DB reads only — never providers. */
export async function routeExplainContext(supabase: DB, { orgId, question, entity }: { orgId: string; question: unknown; entity?: Any }): Promise<RoutedContext> {
  const { symbols, terms } = tokenizeQuestion(question)
  const symSet = new Set(symbols.map((s) => s.toUpperCase()))
  if (entity?.display_symbol) symSet.add(String(entity.display_symbol).toUpperCase().replace(/^\$/, ''))
  const matched: string[] = []
  const ctx: Record<string, unknown> = {}

  const safe = async <T>(p: Promise<T>): Promise<T | null> => { try { return await p } catch { return null } }

  const [wl, theses, alerts, saved, narr, sigs] = await Promise.all([
    safe(supabase.from('watchlist_items').select('item_type, label, entity:entities(display_symbol, canonical_ref_key, entity_kind)').eq('org_id', orgId).limit(100)),
    safe(supabase.from('intel_theses').select('title, bull_thesis, bear_thesis, what_would_confirm, what_would_invalidate, entity:entities(display_symbol)').eq('org_id', orgId).order('created_at', { ascending: false }).limit(20)),
    safe(supabase.from('intel_alert_events').select('payload, fired_at').eq('org_id', orgId).is('private_owner_id', null).order('fired_at', { ascending: false }).limit(20)),
    safe(supabase.from('saved_research').select('title, tags, created_at').eq('org_id', orgId).order('created_at', { ascending: false }).limit(20)),
    safe(supabase.from('narrative_state').select('signal_class, lifecycle_stage, global_priority_score, narrative_taxonomy!inner(slug, name)').order('global_priority_score', { ascending: false }).limit(60)),
    safe(supabase.from('intel_signal_state').select('subject_type, subject_id, display_symbol, direction, confidence, why_it_matters, what_to_watch_next, score_delta').order('global_score', { ascending: false }).limit(120)),
  ])

  // Watchlist matches (by symbol)
  const wlRows = cap((wl as Any)?.data, 100).filter((i: Any) => {
    const s = String(i.entity?.display_symbol || i.label || '').toUpperCase().replace(/^\$/, '')
    return s && symSet.has(s)
  })
  if (wlRows.length) { matched.push('watchlist'); ctx.watchlist_matches = wlRows.map((i: Any) => ({ type: i.item_type, symbol: i.entity?.display_symbol || i.label })) }

  // Theses (title or entity symbol mentions a token/term in the question)
  const thRows = cap((theses as Any)?.data, 20).filter((t: Any) => {
    const sym = String(t.entity?.display_symbol || '').toUpperCase()
    const title = String(t.title || '').toLowerCase()
    return (sym && symSet.has(sym)) || terms.some((w) => title.includes(w))
  })
  if (thRows.length) { matched.push('theses'); ctx.related_theses = thRows.slice(0, 3).map((t: Any) => ({ title: t.title, confirm: t.what_would_confirm, invalidate: t.what_would_invalidate })) }

  // Recent alerts on the asked symbols
  const alRows = cap((alerts as Any)?.data, 20).filter((a: Any) => symSet.has(String(a.payload?.symbol || '').toUpperCase()))
  if (alRows.length) { matched.push('alerts'); ctx.recent_alerts = alRows.slice(0, 5).map((a: Any) => ({ ...a.payload, fired_at: a.fired_at })) }

  // Saved research titles matching question terms
  const svRows = cap((saved as Any)?.data, 20).filter((r: Any) => terms.some((w) => String(r.title || '').toLowerCase().includes(w)))
  if (svRows.length) { matched.push('saved_research'); ctx.saved_research_titles = svRows.slice(0, 5).map((r: Any) => r.title) }

  // Narratives matching question terms (name/slug)
  const naRows = cap((narr as Any)?.data, 60).filter((n: Any) => {
    const name = String(n.narrative_taxonomy?.name || '').toLowerCase()
    const slug = String(n.narrative_taxonomy?.slug || '').toLowerCase()
    return terms.some((w) => name.includes(w) || slug.includes(w))
  })
  if (naRows.length) { matched.push('narratives'); ctx.related_narratives = naRows.slice(0, 4).map((n: Any) => ({ slug: n.narrative_taxonomy?.slug, name: n.narrative_taxonomy?.name, stage: n.lifecycle_stage, signal: n.signal_class })) }

  // Stored Intel Signals for the asked symbols (the reusable backbone — no AI)
  const sgRows = cap((sigs as Any)?.data, 120).filter((s: Any) =>
    (s.subject_type === 'asset' && symSet.has(String(s.display_symbol || '').toUpperCase())) ||
    (s.subject_type === 'narrative' && naRows.some((n: Any) => n.narrative_taxonomy?.slug === s.subject_id)))
  if (sgRows.length) { matched.push('signals'); ctx.intel_signals = sgRows.slice(0, 5).map((s: Any) => ({ subject: s.display_symbol || s.subject_id, direction: s.direction, confidence: s.confidence, why_it_matters: s.why_it_matters, watch_next: s.what_to_watch_next })) }

  return { routed_context: ctx, matched_surfaces: matched }
}

export interface SimilarExplainHit { artifact: Any; similarity: number; kind: 'exact' | 'shingle' }

/** Find a recent same-asset explain answer similar to this question (7d window).
 *  Exact norm-hash match OR Jaccard over HMAC-hashed shingles ≥ 0.8. No AI.
 *
 *  subjectKey pins reuse to ONE asset (migration 286). Market-page explains all
 *  share entity_id IS NULL and a near-identical question template, so without this
 *  the shingle match crosses assets (a stored ZEC answer served on every asset
 *  page). When subjectKey is present we require an exact explain_subject_key match;
 *  when it is null (a fungible educational "what is X" question with no asset) we
 *  keep the entity-pool behaviour. */
export async function similarRecentExplain(supabase: DB, { orgId, entityId, subjectKey, hashes }: { orgId: string; entityId: string | null; subjectKey?: string | null; hashes: QuestionHashes }): Promise<SimilarExplainHit | null> {
  try {
    let q = supabase.from('research_artifacts')
      .select('*')
      .eq('org_id', orgId).eq('artifact_type', 'explain').eq('status', 'ready')
      .not('question_norm_hash', 'is', null)
      .gte('created_at', new Date(Date.now() - 7 * 86_400_000).toISOString())
      .order('created_at', { ascending: false }).limit(15)
    q = entityId ? q.eq('entity_id', entityId) : q.is('entity_id', null)
    // Asset-scoped reuse: only ever match within the SAME asset. (If the column is
    // absent pre-migration this throws → caught below → no reuse, which is safe.)
    if (subjectKey) q = q.eq('explain_subject_key', subjectKey)
    const { data } = await q
    for (const row of (data || []) as Any[]) {
      if (row.question_norm_hash === hashes.question_norm_hash) return { artifact: row, similarity: 1, kind: 'exact' }
      const sim = jaccard(hashes.question_shingles, Array.isArray(row.question_shingles) ? row.question_shingles : [])
      if (sim >= EXPLAIN_SIMILARITY) return { artifact: row, similarity: sim, kind: 'shingle' }
    }
  } catch { /* pre-migration columns absent → no reuse */ }
  return null
}
