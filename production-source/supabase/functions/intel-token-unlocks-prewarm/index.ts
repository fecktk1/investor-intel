// Token-unlock pre-warm. Cron-only (x-cron-secret). Walks the auto-served
// universe (market_assets) in throttled batches, warming token_unlocks from
// Mobula's bulk multi-metadata. Each symbol is recorded in token_unlock_sync so
// it refreshes ~monthly and zero-unlock tokens are not re-queried within the
// window. Reads cached tables + Mobula only; never runs on a page render path.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { fetchMobulaMultiUnlocks } from '../_shared/mobula-client.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}
const clampN = (v: unknown, def: number, lo: number, hi: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : def
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    if (!Deno.env.get('CRON_SECRET') || req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return json({ error: 'forbidden' }, 401)
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json().catch(() => ({}))
    const batch = clampN(body?.batch, 120, 1, 400)   // assets per run
    const chunk = clampN(body?.chunk, 30, 1, 50)      // assets per Mobula multi-metadata call
    const nowMs = Date.now()

    const { data: due, error } = await supabase.rpc('intel_due_unlock_assets', { p_limit: batch })
    if (error) return json({ error: error.message }, 500)
    const assets = (due || []) as Array<{ symbol: string; normalized_symbol: string | null; name: string | null }>
    if (!assets.length) return json({ ok: true, due: 0, withUnlocks: 0, unlockRows: 0 })

    const nowIso = new Date(nowMs).toISOString()
    const staleIso = new Date(nowMs + 30 * 24 * 3600 * 1000).toISOString()
    const syncRows: Array<{ symbol: string; checked_at: string; unlock_count: number }> = []
    const unlockUpserts: Array<Record<string, unknown>> = []

    for (let i = 0; i < assets.length; i += chunk) {
      const slice = assets.slice(i, i + chunk)
      // Request by name when present (more reliable resolution), else symbol.
      const reqList = slice.map((a) => a.name || a.normalized_symbol || a.symbol).filter(Boolean) as string[]
      const map = await fetchMobulaMultiUnlocks(reqList, nowMs)
      for (const a of slice) {
        const nkey = String(a.normalized_symbol || a.symbol || '').toLowerCase().replace(/^\$/, '').trim()
        if (!nkey || !map.has(nkey)) continue
        const events = map.get(nkey)!
        syncRows.push({ symbol: nkey, checked_at: nowIso, unlock_count: events.length })
        for (const u of events.slice(0, 24)) {
          unlockUpserts.push({
            token: nkey, token_symbol: nkey, unlock_date: u.unlock_date, amount: u.amount,
            canonical_asset_keys: u.canonical_asset_keys || [], scheduled_at: new Date(u.ts).toISOString(),
            pct_supply: null, provider: 'mobula', source_ref: `mobula:unlocks:${nkey}:${u.unlock_date}`,
            fetched_at: nowIso, stale_after: staleIso, confidence: 0.7,
          })
        }
      }
    }

    let unlockRows = 0
    for (let i = 0; i < unlockUpserts.length; i += 200) {
      const { error: e } = await supabase.from('token_unlocks').upsert(unlockUpserts.slice(i, i + 200), { onConflict: 'token,unlock_date,provider' })
      if (e) throw e
      unlockRows += Math.min(200, unlockUpserts.length - i)
    }
    for (let i = 0; i < syncRows.length; i += 200) {
      const { error: syncError } = await supabase.from('token_unlock_sync').upsert(syncRows.slice(i, i + 200), { onConflict: 'symbol' })
      if (syncError) throw syncError
    }

    return json({ ok: true, due: assets.length, checked: syncRows.length, unresolved: assets.length - syncRows.length, withUnlocks: syncRows.filter((r) => r.unlock_count > 0).length, unlockRows })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'prewarm_failed' }, 500)
  }
})
