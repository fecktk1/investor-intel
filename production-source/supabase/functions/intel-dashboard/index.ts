// Investor Intel — home dashboard digest (scope-aware).
// scope='all'      → everything notable (global + custom)
// scope='chain'    → a single chain: its news/movers/projects + your followed items on it
// scope='following'→ only the user's custom-followed items
// Also returns followed_chains + per-chain projects for the chain/project selectors.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { CHAINS } from '../_shared/chains.ts'
import { makeCostWriter } from '../_shared/intel/intel-cost-writer.ts'
import { recordCostEvent } from '../_shared/core-intel/cost-ledger.ts'
import { assembleBriefEvidencePack } from '../_shared/intel/brief-evidence-pack.ts'
import {requireIntelAccess} from '../_shared/intel/research-service.ts'
import {orgAuthzErrorResponse} from '../_shared/org-authz.ts'
import {dashboardSourceReads} from '../_shared/intel/dashboard-reads.ts'
import {assembleDashboardCore} from '../_shared/intel/dashboard-core.ts'
import {readDashboardPicture} from '../_shared/intel/dashboard-picture.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200, timing = '') { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control':'private, no-store', ...(timing?{'Server-Timing':timing}:{}) } }) }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: {...corsHeaders, 'Access-Control-Max-Age': '600'} })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'No authorization header' }, 401)
    const { orgId, scope = 'all', chain = null, section = 'full' } = await req.json() || {}
    if (!orgId) return json({ error: 'orgId required' }, 400)
    if (!['all', 'chain', 'following'].includes(scope) || !['core', 'picture', 'grounding', 'full'].includes(section)
      || (chain != null && !CHAINS.some(c => c.id === chain))) return json({ error: 'Invalid dashboard scope' }, 400)

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
    const accessAdmin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const actor=await requireIntelAccess(req,createClient,accessAdmin,orgId)
    if(!actor.userId)return json({error:'Unauthorized'},401)
    const auth={user:{id:actor.userId}}

    if(section==='picture'){
      const result=await readDashboardPicture(supabase,orgId,auth.user.id)
      return json({intelligence_grounding:result.picture,generated_at:result.picture.assembled_at},200,result.timing)
    }

    // Independent cached evidence lane: callers can paint the desk while this
    // stored-data assembly completes. Verify identity/org before privileged reads.
    if (section === 'grounding') {
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const intelligence_grounding = await assembleBriefEvidencePack(admin, { orgId, userId: auth.user.id, maxAssets: 6 })
      return json({ intelligence_grounding, generated_at: new Date().toISOString() })
    }
    const batch=dashboardSourceReads(supabase,orgId,auth.user.id,scope,chain)
    // Assembled in _shared/intel/dashboard-core.ts, shared with the public demo.
    const body=await assembleDashboardCore({
      supabase, accessAdmin, batch, orgId, scope, chain, section, beKey: Deno.env.get('BIRDEYE_API_KEY'),
      // Bucketed cost-ledger event (no write-amplification): this render made ZERO
      // provider calls (cacheOnly + maxCalls:0). Record the avoidance, collapsed per
      // org+hour. Uses a service-role client ONLY for the ledger write, never for reads.
      recordCost: async (event) => {
        const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
        await recordCostEvent(makeCostWriter(admin), event as any, { precision: 'bucketed', nowMs: Date.now() })
      },
      grounding: async (watchlistSymbols) => {
        const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
        return await assembleBriefEvidencePack(admin, { orgId, userId: auth.user.id, watchlistSymbols, maxAssets: 6 })
      },
    })
    return json(body,200,batch.timing())
  } catch (e) {
    const denied=orgAuthzErrorResponse(e,corsHeaders);if(denied)return denied
    return json({ error: (e as Error)?.message || 'dashboard_failed' }, 400)
  }
})
