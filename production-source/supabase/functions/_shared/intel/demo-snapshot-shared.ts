// Investor Intel public demo: the SHARED data of the secondary pages (My Intel,
// Narratives, News, Macro, DeFi, Market context, Discovery).
//
// Two mechanisms, and only these two:
//   * in-process shared readers with the service role (the dashboard digest, the
//     Narrative Radar, the DeFi explorer), which compute exactly the body the
//     page's Edge Function returns for a visitor with nothing saved, and the
//     shared argument-only RPCs (DEMO_SHARED_RPCS);
//   * REST GET replays of the allowlisted shared tables (DEMO_REST_TABLES), with
//     every personal table, owner filter, embed and personal column refused.
// Nothing here signs in as anyone, and nothing here calls a provider: every
// source is a table the capture and curation jobs already wrote.

import { assembleDashboardCore } from './dashboard-core.ts'
import { publicDashboardSourceReads } from './dashboard-reads.ts'
import { readPublicDashboardPicture } from './dashboard-picture.ts'
import { readPublicNarrativeFeed, readPublicNarratives } from './narrative-public-read.ts'
import { readPublicDefiBrowse } from '../defi-public-browse.ts'
import { demoRestRefusal } from './demo-snapshot-key.ts'
import {
  currentRegimeRequest, dashboardRequests, defiBrowseRequest, DEFI_MAX_PAGES, DEFI_PAGE_SIZE, macroRequests, NARRATIVE_DETAILS,
  narrativeDetailRequests, narrativeFeedRequest, newsRequests, recentlyDiscoveredRequest, researchWorkspaceRequests,
  type SharedDemoRequest,
} from './demo-snapshot-requests.ts'
import type { FunctionReader, RestReplay } from './demo-snapshot-builder.ts'

// deno-lint-ignore no-explicit-any
type Db = any

/** intel-dashboard for the default view: section 'core' or 'picture'. */
export function publicDashboardReader(db: Db): FunctionReader {
  return async (body, now) => {
    if ((body.scope ?? 'all') !== 'all' || body.chain != null) return null
    if (body.section === 'picture') {
      const result = await readPublicDashboardPicture(db, new Date(now))
      // intel-dashboard: { intelligence_grounding: picture, generated_at: picture.assembled_at }.
      return { status: 200, body: { intelligence_grounding: result.picture, generated_at: result.picture.assembled_at } }
    }
    if (body.section !== 'core') return null
    // No member: no cost-ledger write and no private evidence pack, and with no
    // followed chain and no watchlist token the chain quotes and movers read nothing.
    const out = await assembleDashboardCore({
      supabase: db, accessAdmin: db, batch: publicDashboardSourceReads(db), orgId: null,
      scope: 'all', chain: null, section: 'core', beKey: undefined,
    })
    return { status: 200, body: out }
  }
}

/** The in-process readers, by Edge Function name. */
export function sharedFunctionReaders(db: Db): Record<string, FunctionReader> {
  return {
    'intel-dashboard': publicDashboardReader(db),
    'intel-narratives': (body, now) => readPublicNarratives(db, body, now),
    'intel-defi-browse': (body, now) => readPublicDefiBrowse(db, body, now),
  }
}

/** A REST replay over PostgREST with the service role. Refuses anything the
 * allowlist refuses before a request is made. */
export function serviceRoleRestReplay(supabaseUrl: string, serviceKey: string, fetchImpl: typeof fetch = fetch): RestReplay {
  const base = String(supabaseUrl || '').replace(/\/+$/, '')
  return async (table, query) => {
    const refusal = demoRestRefusal(table, query)
    if (refusal) throw new Error(`rest_refused:${refusal}`)
    const response = await fetchImpl(`${base}/rest/v1/${table}?${query}`, {
      method: 'GET',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: 'application/json', Prefer: 'count=exact' },
    })
    if (!response.ok) { await response.body?.cancel(); return null }
    const rows = await response.json().catch(() => null)
    if (!Array.isArray(rows)) return null
    const total = Number(String(response.headers.get('content-range') || '').split('/')[1])
    return { rows, count: Number.isFinite(total) ? total : null }
  }
}

/**
 * The shared-data part of the day's plan. The narrative feed is read once (with
 * the same reader the entry uses) to name the top narratives and their ids, and
 * the DeFi explorer's totals decide how many pages exist.
 */
export async function planSharedRequests(db: Db, now: number): Promise<SharedDemoRequest[]> {
  const out: SharedDemoRequest[] = [
    ...dashboardRequests(), currentRegimeRequest(), ...macroRequests(), ...newsRequests(),
    recentlyDiscoveredRequest(), ...researchWorkspaceRequests(), narrativeFeedRequest(),
  ]
  try {
    const { body, ids } = await readPublicNarrativeFeed(db)
    const slugs = (Array.isArray(body.narratives) ? body.narratives : []).map((row: { slug?: unknown }) => String(row?.slug || '')).filter(Boolean)
    for (const slug of slugs.slice(0, NARRATIVE_DETAILS)) out.push(...narrativeDetailRequests(slug, ids.get(slug) || null))
  } catch { /* no narratives today: the feed entry says so */ }
  for (const view of ['vaults', 'lending'] as const) {
    out.push(defiBrowseRequest(view, 0))
    try {
      const first = await readPublicDefiBrowse(db, defiBrowseRequest(view, 0).body, now)
      // deno-lint-ignore no-explicit-any
      const total = Number((first?.body as any)?.total || 0)
      const pages = Math.min(DEFI_MAX_PAGES, Math.ceil(total / DEFI_PAGE_SIZE))
      for (let page = 1; page < pages; page++) out.push(defiBrowseRequest(view, page))
    } catch { /* the first page alone */ }
  }
  return out
}
