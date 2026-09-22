// Investor Intel: the public demo's daily snapshot builder.
//
// POST {op:'build'} (optionally {cursor, force, maxEntries}) computes the
// response bodies the real Investor Intel pages receive for a declared list of
// requests and writes them to the public `intel-demo` bucket, latest.json last.
// See _shared/intel/demo-snapshot-builder.ts for what is built and the bounds,
// and _shared/intel/demo-snapshot-plan.ts for which requests.
//
// AUTHENTICATION, exactly like intel-capture's capture half: the operational
// `x-cron-secret` (pg_cron), or a signed-in super admin by hand. The work itself
// runs with the service role, in-process. It never signs in as, or mints a
// token for, any user, and it never calls a provider.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { buildDemoSnapshot, DEMO_BUCKET, type DemoStorage } from '../_shared/intel/demo-snapshot-builder.ts'
import { planDemoRequests } from '../_shared/intel/demo-snapshot-plan.ts'
import { cacheOnlyResearchReader } from '../_shared/intel/demo-snapshot-research.ts'
import { serviceRoleRestReplay, sharedFunctionReaders } from '../_shared/intel/demo-snapshot-shared.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret' }
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } })
}

// Edge Functions stop around 150 s; leave room for the manifest and the run row.
const BUDGET_MS = 110_000
const MAX_HOPS = 300

// deno-lint-ignore no-explicit-any
export function bucketStorage(admin: any): DemoStorage {
  const bucket = () => admin.storage.from(DEMO_BUCKET)
  return {
    async upload(path, text, { cacheSeconds }) {
      const { error } = await bucket().upload(path, new Blob([text], { type: 'application/json' }), {
        contentType: 'application/json', upsert: true, cacheControl: String(cacheSeconds),
      })
      if (error) throw new Error(`upload_failed:${String(error.message || error).slice(0, 120)}`)
    },
    async download(path) {
      const { data, error } = await bucket().download(path)
      if (error || !data) return null
      return await data.text()
    },
    async list(prefix) {
      const names: string[] = []
      for (let offset = 0; offset < 20_000; offset += 1000) {
        const { data, error } = await bucket().list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } })
        if (error) throw new Error(`list_failed:${String(error.message || error).slice(0, 120)}`)
        const page = Array.isArray(data) ? data : []
        for (const item of page) if (item?.name) names.push(String(item.name))
        if (page.length < 1000) break
      }
      return names
    },
    async remove(paths) {
      if (!paths.length) return
      const { error } = await bucket().remove(paths)
      if (error) throw new Error(`remove_failed:${String(error.message || error).slice(0, 120)}`)
    },
  }
}

export async function handleDemoSnapshot(req: Request, clientFactory = createClient): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { ...corsHeaders, 'Access-Control-Max-Age': '600' } })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    if (String(body.op || 'build') !== 'build') return json({ error: 'unsupported_op', ops: ['build'] }, 400)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    // Same gate as intel-capture's capture half: the cron secret, or a super admin.
    const cronSecret = Deno.env.get('CRON_SECRET')
    const cronOk = !!cronSecret && req.headers.get('x-cron-secret') === cronSecret
    if (!cronOk) {
      const authHeader = req.headers.get('Authorization')
      if (!authHeader) return json({ error: 'unauthorized' }, 401)
      const asUser = clientFactory(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: { user } } = await asUser.auth.getUser()
      const { data: profile } = user ? await asUser.from('profiles').select('is_super_admin').eq('id', user.id).maybeSingle() : { data: null }
      if (!profile?.is_super_admin) return json({ error: 'forbidden' }, 403)
    }

    const admin = clientFactory(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const research = cacheOnlyResearchReader(admin)
    const result = await buildDemoSnapshot({
      db: admin,
      storage: bucketStorage(admin),
      env: (key) => Deno.env.get(key),
      research,
      // Shared tables only (DEMO_REST_TABLES), refused before any request otherwise.
      rest: serviceRoleRestReplay(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),
      functions: sharedFunctionReaders(admin),
      planner: (db, now) => planDemoRequests(db, now, { research }),
    }, {
      trigger: cronOk ? 'cron' : 'super_admin',
      cursor: Number.isFinite(Number(body.cursor)) && body.cursor != null ? Number(body.cursor) : null,
      force: body.force === true && !cronOk,
      maxEntries: Number.isFinite(Number(body.maxEntries)) ? Number(body.maxEntries) : undefined,
      budgetMs: BUDGET_MS,
    })
    // A partial run hands on to the next invocation itself, so one trigger (the
    // cron tick or a super admin) builds the whole day. Bounded by a hop count.
    const hop = Number.isFinite(Number(body.hop)) ? Number(body.hop) : 0
    if (result.status === 'partial' && result.cursor != null && hop < MAX_HOPS && cronSecret) {
      const next = fetch(`${supabaseUrl}/functions/v1/intel-demo-snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'x-cron-secret': cronSecret },
        body: JSON.stringify({ op: 'build', cursor: result.cursor, hop: hop + 1 }),
      }).then((r) => r.body?.cancel()).catch((e) => console.error('intel_demo_snapshot_handoff_failed', String(e?.message || e)))
      // deno-lint-ignore no-explicit-any
      const runtime = (globalThis as any).EdgeRuntime
      if (runtime?.waitUntil) runtime.waitUntil(next)
    }
    console.info('intel_demo_snapshot_run', { date: result.date, status: result.status, planned: result.planned, written: result.written, skipped: result.skipped, failed: result.failed, cursor: result.cursor, latestWritten: result.latestWritten, durationMs: result.durationMs })
    return json({ ok: result.status !== 'failed', ...result, errors: result.errors.slice(0, 20) }, result.status === 'failed' ? 500 : 200)
  } catch (e) {
    return json({ error: (e as Error)?.message || 'intel_demo_snapshot_failed' }, 500)
  }
}

if (import.meta.main) Deno.serve((req) => handleDemoSnapshot(req))
