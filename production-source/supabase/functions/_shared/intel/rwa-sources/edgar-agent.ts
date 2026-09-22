// Investor Intel: ONE resolved User-Agent for every SEC EDGAR read.
//
// data.sec.gov answers 403 to an anonymous client, and the SEC fair access
// policy asks every automated client to declare who it is and how to reach it,
// with a ceiling of 10 requests per second. Two lanes read EDGAR: the issuer
// registry lane (`capture-rwa-issuer.ts`, through `rwa-sources/http.ts`) and the
// advertised yield reader (`sec-nmfp-yield.ts`, through `capture-rwa-yield.ts`).
// Before this module they disagreed: the first refused to call without a
// configured agent, the second sent a hardcoded contact address that is not
// published anywhere by the product. Both now use the value resolved here.
//
// PRECEDENCE, the same as every other operating setting (see
// `_shared/market-assets/cmc-operating-settings.ts`, where the environment wins
// over the ledger row):
//   1. the `SEC_EDGAR_USER_AGENT` environment variable on the Edge Function;
//   2. `config.SEC_EDGAR_USER_AGENT` on the `provider_quota_budgets` row with
//      provider 'coinmarketcap', data_type 'cmc_operating_profile' and
//      period_start 1970-01-01. The Edge secret store is full, and a contact
//      string is operating policy rather than a credential, so the row is the
//      supported place to set it without a deploy;
//   3. nothing. There is deliberately NO hardcoded fallback: a contact address
//      the product has not published is not a descriptive agent, and a call
//      made with one would misstate who is asking. The lanes then report
//      `user_agent_required` instead of calling EDGAR.
//
// A value is used only when it is COMPLIANT: printable, bounded, and carrying a
// contact email address. A non-compliant environment value does not block a
// compliant row value; it is skipped and named in `rejected`.
//
// NEVER THROWS. An unreadable row resolves to no agent, which the callers turn
// into a named reason.

export const EDGAR_AGENT_ENV = 'SEC_EDGAR_USER_AGENT'

/** The ledger row that carries non-secret operating policy. */
export const EDGAR_AGENT_PROFILE_ROW = {
  table: 'provider_quota_budgets',
  provider: 'coinmarketcap',
  dataType: 'cmc_operating_profile',
  periodStart: '1970-01-01T00:00:00Z',
} as const

export type EdgarAgentSource = 'env' | 'operating_profile'

export interface EdgarAgentResolution {
  userAgent: string | null
  source: EdgarAgentSource | null
  /** Places a value was found but refused, e.g. ['env:no_contact_address']. */
  rejected: string[]
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/

/** Why a candidate agent is refused, or null when it is compliant. */
export function edgarAgentProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'not_text'
  const agent = value.trim()
  if (!agent) return 'empty'
  if (agent.length < 12 || agent.length > 200) return 'length'
  // Control characters would let a configured value inject a header line.
  if ([...agent].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) return 'control_character'
  if (!EMAIL.test(agent)) return 'no_contact_address'
  // The declaration must name a client, not consist of the address alone.
  if (agent.replace(EMAIL, '').replace(/[()<>\s,;:-]+/g, '').length < 3) return 'no_client_name'
  return null
}

/** The compliant, trimmed agent, or null. */
export const compliantEdgarAgent = (value: unknown): string | null =>
  edgarAgentProblem(value) == null ? String(value).trim() : null

// deno-lint-ignore no-explicit-any
const _glob = globalThis as any
function envValue(name: string): string | undefined {
  try { const v = _glob?.Deno?.env?.get?.(name); if (v) return String(v) } catch { /* permission-gated */ }
  const v = _glob?.process?.env?.[name]
  return v ? String(v) : undefined
}

// One read per client per minute, mirroring the operating settings cache, so a
// run that reads EDGAR from two lanes does not query the ledger twice.
const CACHE_MS = 60_000
const cache = new WeakMap<object, { expires: number; promise: Promise<string | null> }>()

/** `config.SEC_EDGAR_USER_AGENT` from the operating profile row, unvalidated. */
// deno-lint-ignore no-explicit-any
export function loadEdgarAgentFromProfile(db: any, now = Date.now()): Promise<string | null> {
  if (!db || typeof db !== 'object' || typeof db.from !== 'function') return Promise.resolve(null)
  const hit = cache.get(db)
  if (hit && hit.expires > now) return hit.promise
  const promise = (async () => {
    try {
      const { data, error } = await db.from(EDGAR_AGENT_PROFILE_ROW.table).select('config')
        .eq('provider', EDGAR_AGENT_PROFILE_ROW.provider)
        .eq('data_type', EDGAR_AGENT_PROFILE_ROW.dataType)
        .eq('period_start', EDGAR_AGENT_PROFILE_ROW.periodStart)
        .maybeSingle()
      if (error) return null
      const value = data?.config?.[EDGAR_AGENT_ENV]
      return typeof value === 'string' ? value : null
    } catch { return null }
  })()
  cache.set(db, { expires: now + CACHE_MS, promise })
  return promise
}

/** Resolve the agent: environment first, then the operating profile row. */
export async function resolveEdgarUserAgent(
  // deno-lint-ignore no-explicit-any
  db: any,
  options: { env?: (name: string) => string | undefined; now?: number } = {},
): Promise<EdgarAgentResolution> {
  const rejected: string[] = []
  const fromEnv = (options.env ?? envValue)(EDGAR_AGENT_ENV)
  if (fromEnv != null && fromEnv !== '') {
    const problem = edgarAgentProblem(fromEnv)
    if (!problem) return { userAgent: fromEnv.trim(), source: 'env', rejected }
    rejected.push(`env:${problem}`)
  }
  const fromRow = await loadEdgarAgentFromProfile(db, options.now ?? Date.now())
  if (fromRow != null && fromRow !== '') {
    const problem = edgarAgentProblem(fromRow)
    if (!problem) return { userAgent: fromRow.trim(), source: 'operating_profile', rejected }
    rejected.push(`operating_profile:${problem}`)
  }
  return { userAgent: null, source: null, rejected }
}
