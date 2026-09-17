// Investor Intel — /v1/dex/meme/list DIAGNOSTIC. REMOVE THIS FILE.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS IS A ONE-OFF DIAGNOSTIC, NOT A CAPTURE LANE. It exists to answer ONE
// question that two deploys could not: which documented request body, if any,
// makes /v1/dex/meme/list return rows on this account. Delete this module, its
// test and its registration in `intel-capture/index.ts` the moment that question
// is answered. It is registered beside the capture lanes ONLY so it inherits
// their gate (the operational `x-cron-secret`, or a signed-in super admin), and
// it refuses to run unless that gate says which authority let it through.
//
// What it does NOT do:
//   * It writes nothing to `intel_meme_stage_snapshots`, `..._transitions` or any
//     other capture table. Its only write is the provider call receipt every
//     other provider call already writes (`provider_call_logs`), so a run that
//     spends credits can be audited the same way as any other.
//   * It does not go through the shared CMC transport for the meme variants, and
//     therefore not through the shared cache: the whole point is that each
//     variant is a LIVE call with a body the registry cannot express (an
//     unverified platform, a number where the registry sends a string, filter
//     objects it does not register). The bodies below are literal constants and
//     are echoed back verbatim; the API key travels in a header this module
//     never returns, logs or stores.
//   * It never retries, never pages, and never asks for more than the seven
//     calls below: six meme variants (1 credit each) plus one platform list.
//
// The history that made this necessary:
//   2026-09-15 03:57-12:37 UTC  {platformIds, interval, pageSize} → 200, 1 credit, three EMPTY arrays (40 calls)
//   2026-09-15 13:37 UTC on     {limit} alone                     → 403, no credit, 48 calls
//   2026-09-17 12:40 UTC (v18)  {platformIds, limit}              → 200, 1 credit, three EMPTY arrays
//   2026-09-17 12:48 UTC (v19)  {platformIds, protocol, limit}    → 200, 1 credit, three EMPTY arrays, both launchpads
// ─────────────────────────────────────────────────────────────────────────────

import { cmcApiKey } from '../market-assets/cmc-transport.ts'
import { cmcRows, planAllows } from '../market-assets/cmc-capabilities.ts'
import { CMC_DEX_NETWORKS } from '../market-assets/cmc-dex.ts'
import { readBoundedText, RequestBodyError } from './bounded-request.ts'
import { logProviderCall } from '../provider-budget.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import type { CaptureDeps, JobResult } from './capture-jobs.ts'

const BASE = 'https://pro-api.coinmarketcap.com'
const MEME_PATH = '/v1/dex/meme/list'
/** Hard ceiling. Six meme variants at one credit each, and the platform list. */
export const MEME_PROBE_MAX_CREDITS = 7
/** Only these two authorities exist in `intel-capture`'s capture half. The op
 * refuses without one, so registering it anywhere ungated still spends nothing. */
export const MEME_PROBE_AUTHORITIES = ['cron_secret', 'super_admin']

/**
 * The six bodies, in the order they are sent. Every field is documented by the
 * provider: `protocol`, `exclusive`, `limit` and the three MemeCoinFilterDTO
 * objects on the published request schema, and `platformIds` on the provider's
 * own academy examples for this endpoint. Nothing here is invented.
 *
 * Variant 4 asks about BNB Chain and Four.meme deliberately: its rows could not
 * be stored (BNB is not a verified network here) and nothing is stored anyway.
 * It is asked only to learn whether this endpoint answers ANY launchpad on this
 * account, which separates "wrong question" from "nothing published to us".
 */
export const MEME_PROBE_VARIANTS: { variant: number; label: string; body: Record<string, unknown> }[] = [
  { variant: 1, label: 'limit only', body: { limit: 25 } },
  { variant: 2, label: 'numeric platformIds', body: { platformIds: 16, limit: 25 } },
  { variant: 3, label: 'protocol without platform', body: { protocol: 1001, limit: 25 } },
  { variant: 4, label: 'bnb chain, four.meme', body: { platformIds: '56', protocol: 2001, limit: 25 } },
  {
    variant: 5,
    label: 'documented stage filters',
    body: { limit: 25, newCreationFilter: { minAge: 0 }, aboutGraduateFilter: { minAge: 0 }, graduateFilter: { minAge: 0 } },
  },
  { variant: 6, label: 'exclusive flag', body: { platformIds: '16', limit: 25, exclusive: 0 } },
]

const STAGES = ['newCreations', 'aboutGraduates', 'graduates'] as const
/** Every value shown is truncated. A provider row is public market data, but a
 * diagnostic still never returns an unbounded string it did not measure. */
const cut = (value: unknown, max = 120): string => {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** The first row of the first non-empty stage array, key by key, each value cut
 * to 120 characters. This is what says whether a non-empty answer is even the
 * shape this platform reads. */
// deno-lint-ignore no-explicit-any
function firstRow(data: any): { stage: string; keys: string[]; row: Record<string, string> } | null {
  for (const stage of STAGES) {
    const list = Array.isArray(data?.[stage]) ? data[stage] : []
    const row = list[0]
    if (!row || typeof row !== 'object') continue
    const keys = Object.keys(row).slice(0, 40)
    return { stage, keys, row: Object.fromEntries(keys.map((key) => [key, cut(row[key])])) }
  }
  return null
}

export interface MemeProbeAnswer {
  variant: number; label: string; body: Record<string, unknown>
  status: number | null; credit: number | null; errorCode: string | null; errorMessage: string | null
  lengths: Record<string, number | null> | null; sample: ReturnType<typeof firstRow>
  bytes: number | null; latencyMs: number; unreadable?: string
}

/** ONE live call with ONE literal body. No cache, no reservation, no retry. */
async function probeVariant(
  // deno-lint-ignore no-explicit-any
  db: any, key: string, entry: typeof MEME_PROBE_VARIANTS[number], fetchImpl: typeof fetch,
): Promise<MemeProbeAnswer> {
  const started = Date.now()
  const answer: MemeProbeAnswer = {
    variant: entry.variant, label: entry.label, body: entry.body,
    status: null, credit: null, errorCode: null, errorMessage: null,
    lengths: null, sample: null, bytes: null, latencyMs: 0,
  }
  try {
    const response = await fetchImpl(`${BASE}${MEME_PATH}`, {
      method: 'POST',
      headers: { 'X-CMC_PRO_API_KEY': key, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(entry.body), signal: AbortSignal.timeout(8000), redirect: 'error',
    })
    answer.status = response.status
    let raw = ''
    try { raw = await readBoundedText(response, 2_000_000) } catch (e) {
      answer.unreadable = e instanceof RequestBodyError ? e.message : 'unreadable_response'
    }
    answer.bytes = raw.length
    // deno-lint-ignore no-explicit-any
    let parsed: any = null
    try { parsed = raw ? JSON.parse(raw) : null } catch { answer.unreadable = cut(raw, 200) || 'empty_body' }
    if (parsed) {
      const credit = Number(parsed?.status?.credit_count)
      answer.credit = Number.isFinite(credit) ? credit : null
      answer.errorCode = parsed?.status?.error_code == null ? null : cut(parsed.status.error_code, 20)
      answer.errorMessage = parsed?.status?.error_message == null ? null : cut(parsed.status.error_message, 200)
      // `lengths` is only reported when the answer HAS a board: a stage that is
      // not an array is null (absent), never a zero that would read as "empty".
      const data = parsed?.data
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        answer.lengths = Object.fromEntries(STAGES.map((stage) => [stage, Array.isArray(data[stage]) ? data[stage].length : null]))
        answer.sample = firstRow(data)
      }
    }
  } catch (e) {
    answer.unreadable = cut((e as Error)?.message || 'request_failed', 200)
  }
  answer.latencyMs = Date.now() - started
  // The same receipt every other provider call writes: this diagnostic's spend
  // is auditable in `provider_call_logs` beside the lane it is diagnosing.
  await logProviderCall(db, {
    provider: 'coinmarketcap', dataType: 'attention', endpoint: MEME_PATH, calls: 1,
    creditsOrCu: answer.credit, cacheStatus: answer.status === 200 && !answer.unreadable ? 'live' : 'error',
    statusCode: answer.status ?? undefined, latencyMs: answer.latencyMs, responseSizeBytes: answer.bytes ?? undefined,
    caller: `intel-capture-meme-probe-${entry.variant}`, suppressionReason: answer.unreadable ? 'probe_unreadable' : undefined,
  })
  return answer
}

export interface MemePlatformAnswer { chain: string; platform: string; hardcodedId: number; publishedId: number | null; publishedName: string | null; dexerTxHashFormat: string | null; matches: boolean }

/**
 * What /v1/dex/platform/list publishes for the four networks `CMC_DEX_NETWORKS`
 * hardcodes. The provider's own examples resolve `platformIds` from this list
 * rather than hardcoding it, so a published id that differs from ours would
 * explain an answer that is always empty. Read through the shared transport: the
 * capability is registered, cacheable for a day and costs at most one credit.
 */
// deno-lint-ignore no-explicit-any
export function memePlatformComparison(payload: any): MemePlatformAnswer[] {
  const rows = cmcRows('dexPlatforms', payload).rows as Record<string, unknown>[]
  return CMC_DEX_NETWORKS.map((network) => {
    // Match on the provider's own name, never on our id: matching on the id
    // would assume exactly the fact being tested.
    const row = rows.find((r) => String(r?.n ?? r?.name ?? '').trim().toLowerCase() === network.platform)
      ?? rows.find((r) => String(r?.n ?? r?.name ?? '').trim().toLowerCase().startsWith(network.platform))
    const publishedId = row && Number.isFinite(Number(row.id)) ? Number(row.id) : null
    return {
      chain: network.chain, platform: network.platform, hardcodedId: network.platformId,
      publishedId, publishedName: row ? cut(row.n ?? row.name, 60) : null,
      dexerTxHashFormat: row?.dexerTxHashFormat == null ? null : cut(row.dexerTxHashFormat, 60),
      matches: publishedId === network.platformId,
    }
  })
}

/**
 * The diagnostic run. Six meme variants plus one platform list, at most seven
 * credits, nothing stored, every answer reported with the body that produced it.
 */
export async function probeMemeVariants(
  // deno-lint-ignore no-explicit-any
  db: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  _now = new Date(), plan = 'basic', deps?: CaptureDeps, _body?: unknown,
  authority?: unknown, fetchImpl: typeof fetch = globalThis.fetch,
): Promise<JobResult> {
  const job = 'meme_probe'
  // The gate, restated where it can be tested: no authority, no call, no write.
  if (!MEME_PROBE_AUTHORITIES.includes(String(authority ?? ''))) return { job, rows: 0, credits: 0, skipped: 'unauthorized' }
  if (!planAllows(plan, 'startup')) return { job, rows: 0, credits: 0, skipped: 'plan_below_startup' }
  const key = cmcApiKey()
  if (!key) return { job, rows: 0, credits: 0, skipped: 'credential_unavailable' }

  let credits = 0
  const variants: MemeProbeAnswer[] = []
  for (const entry of MEME_PROBE_VARIANTS) {
    if (credits >= MEME_PROBE_MAX_CREDITS - 1) break
    const answer = await probeVariant(db, key, entry, fetchImpl)
    // A refused call is not charged by the provider; a 200 is one credit whether
    // or not it carried rows. The provider's own count wins when it gives one.
    credits += answer.credit ?? (answer.status === 200 ? 1 : 0)
    variants.push(answer)
  }

  // The platform list goes through the shared transport, so it is cached, keyed
  // and reconciled like every other registered read.
  let platforms: MemePlatformAnswer[] | null = null
  let platformReason: string | null = null
  try {
    const list = await deps?.request('dexPlatforms', {}, ctxFor('meme-probe', 1))
    if (!list?.payload) platformReason = list?.reason || 'provider_unavailable'
    else {
      platforms = memePlatformComparison(list.payload)
      if (list.receipt?.origin === 'live') credits += 1
    }
  } catch (e) { platformReason = cut((e as Error)?.message || 'platform_list_failed', 120) }

  const answered = variants.filter((v) => v.status === 200 && v.lengths)
  const withRows = answered.filter((v) => STAGES.some((stage) => (v.lengths?.[stage] ?? 0) > 0))
  console.info(JSON.stringify({
    intel_meme_probe: {
      credits, variants: variants.map((v) => ({ variant: v.variant, label: v.label, body: v.body, status: v.status, credit: v.credit, lengths: v.lengths, errorCode: v.errorCode })),
      platforms, platformReason,
    },
  }))
  return {
    job, rows: 0, credits, diagnostic: true,
    variants, platforms, platformReason,
    answered: answered.length, withRows: withRows.map((v) => v.variant),
    ...(withRows.length ? {} : { skipped: 'no_variant_returned_rows' }),
  }
}

/** Registered beside the capture lanes so it inherits their gate. REMOVE with
 * the rest of this module once the question it asks has been answered. */
export const MEME_PROBE_OPS: Record<string, (
  // deno-lint-ignore no-explicit-any
  admin: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext, now: Date, plan: string, deps: CaptureDeps, body: unknown, authority: unknown
) => Promise<JobResult>> = {
  meme_probe: (admin, ctxFor, now, plan, deps, body, authority) => probeMemeVariants(admin, ctxFor, now, plan, deps, body, authority),
}
