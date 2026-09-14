// Investor Intel — Narrative Radar read API (cache-only, like intel-markets).
//
// modes:
//   feed    (default) — narrative_feed(orgId): global narratives ranked per user
//                       (followed/watchlist/custom-source boosts) + summary counts.
//   detail  + slug    — narrative_detail(slug) + the shared AI brief (if any).
//   history + slug    — narrative_score_history(slug, days) for charts.
//   debug   + slug    — narrative_debug(slug) (super-admin only).
//
// All RPCs run under the CALLER's JWT (SECURITY DEFINER funcs check get_my_org_id /
// auth.uid). Reads never call a live provider. Failures remain explicit.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { readNarrativeBrief } from '../_shared/intel/narrative-brief-read.ts'
import { readNarrativeHistory } from '../_shared/intel/narrative-history-read.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }
const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'unauthorized' }, 401)
    const u = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
    const { data: { user } } = await u.auth.getUser()
    if (!user) return json({ error: 'unauthorized' }, 401)

    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const mode = String(body.mode || 'feed')
    const orgId = typeof body.orgId === 'string' ? body.orgId : null
    const slug = typeof body.slug === 'string' ? body.slug : null

    if (mode === 'detail' && slug) {
      const { data: detail, error } = await u.rpc('narrative_detail', { p_slug: slug })
      if (error) return json({ error: error.message }, 400)
      if (!detail) return json({ error: 'not_found' }, 404)
      // shared AI brief (global, reused) — may be absent until the brief cron runs.
      return json({ ...detail, ...await readNarrativeBrief(u, slug) })
    }

    if (mode === 'history' && slug) {
      const days = Math.max(1, Math.min(365, Number(body.days) || 30))
      return json(await readNarrativeHistory(u, slug, days, body.before))
    }

    if (mode === 'debug' && slug) {
      const { data, error } = await u.rpc('narrative_debug', { p_slug: slug })
      if (error) return json({ error: error.message }, 403)
      return json({ debug: data })
    }

    // feed (default)
    if (!orgId) return json({ error: 'orgId required' }, 400)
    const limit = Math.max(1, Math.min(200, Number(body.limit) || 80))
    const { data: rows, error } = await u.rpc('narrative_feed', { p_org_id: orgId, p_limit: limit })
    if (error) return json({ error: error.message }, 400)
    const list = rows || []

    // summary-row counts by the 5 display statuses (computed here; narratives are few)
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
    return json({ narratives: list, summary, count: list.length })
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
