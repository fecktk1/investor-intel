// Investor Intel — read one public post from X for a chart drawing.
//
// A drawing stores only the address of the post. This function reads the public
// oEmbed endpoint on the server, so the browser never contacts X and no member
// is exposed to X while reading a chart. The markup oEmbed returns is parsed for
// plain text only and never sent on; the response carries the author, the handle,
// the text and, when the byline gives one, the posting time.
//
// Reads nothing from the database and writes nothing. Intel membership is
// verified the same way as intel-asset-facts.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { requireIntelAccess } from '../_shared/intel/research-service.ts'
import { orgAuthzErrorResponse } from '../_shared/org-authz.ts'
import { tweetStatusUrl } from '../_shared/intel/chart-workspace-contract.ts'
import { fetchTweetEmbed } from './oembed.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } })

const STATUS: Record<string, number> = { invalid_tweet_url: 400, tweet_not_found: 404, tweet_refused: 403, tweet_embed_empty: 502, tweet_embed_unavailable: 503 }

export async function handleTweetEmbed(req: Request, clientFactory: typeof createClient = createClient, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { ...corsHeaders, 'Access-Control-Max-Age': '600' } })
  try {
    if (!req.headers.get('Authorization')) return json({ error: 'unauthorized' }, 401)
    const admin = clientFactory(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const orgId = typeof body.orgId === 'string' ? body.orgId : null
    // Verifies the user, then organization membership, then the Intel entitlement.
    await requireIntelAccess(req, clientFactory, admin, orgId)

    let url: string
    try { url = tweetStatusUrl(body.url) } catch { return json({ error: 'invalid_tweet_url' }, 400) }
    try { return json(await fetchTweetEmbed(url, fetchImpl)) } catch (e) {
      const reason = (e as Error)?.message || 'tweet_embed_unavailable'
      return json({ error: reason, url }, STATUS[reason] ?? 503)
    }
  } catch (e) {
    const denied = orgAuthzErrorResponse(e, corsHeaders)
    if (denied) return denied
    return json({ error: (e as Error)?.message || 'tweet_embed_failed' }, 500)
  }
}

if (import.meta.main) Deno.serve((req) => handleTweetEmbed(req))
