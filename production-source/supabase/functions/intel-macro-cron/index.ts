// Investor Intel — macro refresh (pg_cron, service-role).
//
// ONE shared, Google-grounded fetch per day populates the global macro store
// (intel_macro_calendar + intel_macro_indicators) that every workspace reads.
// Shared-once, not per-user — keeps provider cost flat regardless of user count.
// Grounding ties values to live web sources (verified, not fabricated).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { callGeminiGrounded, isGroundedError } from '../_shared/gemini-ground.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }
const isoOrNull = (s: any) => { if (!s) return null; const d = new Date(String(s)); return Number.isNaN(d.getTime()) ? null : d.toISOString() }
const dateOrNull = (s: any) => { const iso = isoOrNull(s); return iso ? iso.slice(0, 10) : null }

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

    const geminiKey = Deno.env.get('GEMINI_API_KEY')
    if (!geminiKey) return json({ error: 'GEMINI_API_KEY not configured' }, 500)

    // 1. Economic calendar (next ~3 weeks).
    let events = 0
    const gCal = await callGeminiGrounded({
      apiKey: geminiKey,
      systemInstruction: 'You are an economic-calendar assistant. Use live web search to find SCHEDULED macro releases with real published dates. Respond with ONLY a JSON object. This is information, not financial advice.',
      parts: [{ text: 'List upcoming scheduled US/global macroeconomic events in the next 21 days: FOMC meetings & rate decisions, CPI, PPI, PCE, jobs report (NFP), unemployment, and GDP releases. Return {"events":[{"event_key":"fomc|cpi|ppi|pce|nfp|gdp|rate_decision|unemployment","title":"","country":"US","importance":"high|medium|low","scheduled_at":"ISO 8601 datetime","period":"","forecast":"","previous":""}]}. Use only real published schedules and cite sources.' }],
      temperature: 0,
    })
    if (!isGroundedError(gCal) && gCal.json && Array.isArray((gCal.json as any).events)) {
      const srcUrl = gCal.citations?.[0]?.url || null
      const rows = (gCal.json as any).events.map((e: any) => ({
        event_key: String(e?.event_key || 'event').slice(0, 40),
        title: String(e?.title || '').slice(0, 200) || 'Macro event',
        country: e?.country ? String(e.country).slice(0, 8) : 'US',
        importance: ['high', 'medium', 'low'].includes(e?.importance) ? e.importance : null,
        scheduled_at: isoOrNull(e?.scheduled_at),
        period: e?.period ? String(e.period).slice(0, 60) : null,
        forecast: e?.forecast != null ? String(e.forecast).slice(0, 60) : null,
        previous: e?.previous != null ? String(e.previous).slice(0, 60) : null,
        source_url: srcUrl, raw: { via: 'gemini' }, updated_at: new Date().toISOString(),
      })).filter((r: any) => r.scheduled_at)
      if (rows.length) {
        const { data, error } = await admin.from('intel_macro_calendar').upsert(rows, { onConflict: 'event_key,scheduled_at' }).select('id')
        if (error) throw error
        events = data?.length || rows.length
      }
    }

    // 2. Current macro indicators.
    let indicators = 0
    const gInd = await callGeminiGrounded({
      apiKey: geminiKey,
      systemInstruction: 'You report current macro indicator values from live web search. Respond with ONLY a JSON object. Be factual; this is information, not financial advice.',
      parts: [{ text: 'Give the latest published values (with as-of dates) for: US federal funds target rate upper bound; US CPI year-over-year; US core CPI year-over-year; US unemployment rate; US 10-year Treasury yield; US Dollar Index (DXY); Bitcoin dominance percent; Crypto Fear & Greed Index. Return {"indicators":[{"metric_key":"fed_funds_rate|cpi_yoy|core_cpi_yoy|unemployment|us10y|dxy|btc_dominance|fear_greed","label":"","value":"","unit":"","as_of":"YYYY-MM-DD","period":"","trend":"up|down|flat"}]}. Cite sources.' }],
      temperature: 0,
    })
    if (!isGroundedError(gInd) && gInd.json && Array.isArray((gInd.json as any).indicators)) {
      const srcUrl = gInd.citations?.[0]?.url || null
      const rows = (gInd.json as any).indicators.map((m: any) => ({
        metric_key: String(m?.metric_key || '').slice(0, 40),
        label: String(m?.label || m?.metric_key || '').slice(0, 80) || 'Indicator',
        value: m?.value != null ? String(m.value).slice(0, 40) : null,
        unit: m?.unit ? String(m.unit).slice(0, 16) : null,
        as_of: dateOrNull(m?.as_of),
        period: m?.period ? String(m.period).slice(0, 40) : null,
        trend: ['up', 'down', 'flat'].includes(m?.trend) ? m.trend : null,
        source_url: srcUrl, raw: { via: 'gemini' }, updated_at: new Date().toISOString(),
      })).filter((r: any) => r.metric_key && r.value != null)
      if (rows.length) {
        const { data, error } = await admin.from('intel_macro_indicators').upsert(rows, { onConflict: 'metric_key' }).select('id')
        if (error) throw error
        indicators = data?.length || rows.length
      }
    }

    return json({ ok: true, events, indicators })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'macro_cron_failed' }, 500)
  }
})
