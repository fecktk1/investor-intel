// Investor Intel — macro refresh (deterministic, multi-source, FREE).
//
// Replaces the prior Gemini-grounded fetch (which silently returned 0 rows,
// freezing the macro page) with deterministic data from FREE sources via
// per-metric fallback chains: Alpha Vantage + official keyless FRED/BLS +
// Yahoo Finance + CoinGecko + alternative.me. Every value is sourced from a
// real endpoint — no LLM grounding. Populates the GLOBAL macro store read by
// every workspace:
//   intel_macro_indicators (one row per metric, upserted on metric_key)
//   intel_macro_calendar   (upcoming FOMC + NFP, upserted)
// Shared-once; provider cost is flat regardless of user count.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET (auth).
//      ALPHAVANTAGE_API_KEY (optional — chain falls back to keyless sources),
//      FRED_API_KEY (optional — keyless fredgraph.csv used when absent).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { collectMacroIndicators, buildMacroCalendar } from '../_shared/macro-sources.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const cronOk = req.headers.get('x-cron-secret') === Deno.env.get('CRON_SECRET')
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    if (!cronOk) {
      const authHeader = req.headers.get('Authorization')
      if (!authHeader) return json({ error: 'unauthorized' }, 401)
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: { user } } = await userClient.auth.getUser()
      const { data: prof } = user ? await userClient.from('profiles').select('is_super_admin').eq('id', user.id).maybeSingle() : { data: null }
      if (!prof?.is_super_admin) return json({ error: 'forbidden' }, 403)
    }

    // 1. Indicators — resolved through multi-source fallback chains. Never
    //    throws on a single provider failure; a metric that fails everywhere
    //    is simply skipped so it can't blank the others.
    const { rows, sources, errors } = await collectMacroIndicators()
    let indicators = 0
    if (rows.length) {
      const stamp = new Date().toISOString()
      const upRows = rows.map((r) => ({ ...r, updated_at: stamp }))
      const { data, error } = await admin.from('intel_macro_indicators').upsert(upRows, { onConflict: 'metric_key' }).select('id')
      if (error) throw error
      indicators = data?.length || rows.length
    }

    // 2. Calendar — deterministic upcoming FOMC rate decisions + NFP releases
    //    (official published schedules; no provider call).
    let events = 0
    const cal = buildMacroCalendar()
    if (cal.length) {
      const stamp = new Date().toISOString()
      const calRows = cal.map((c) => ({ ...c, updated_at: stamp }))
      const { data, error } = await admin.from('intel_macro_calendar').upsert(calRows, { onConflict: 'event_key,scheduled_at' }).select('id')
      if (error) throw error
      events = data?.length || cal.length
    }

    return json({ ok: true, indicators, events, sources, errors })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'macro_cron_failed' }, 500)
  }
})
