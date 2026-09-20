// Investor Intel: read views over the RWA underlying-registrant tables.
//
// Same contract as every other capture read module: pure functions over a
// PostgREST-shaped `db`, bounded by explicit row caps, and a FAILED read
// reported as a reason on an otherwise intact result rather than as an empty
// list. The tables are service-role only, so this runs inside `intel-capture`
// behind an authenticated Investor Intel membership check on the free
// `capture_views` surface.
//
// TWO VIEWS.
//   rwa_underlying_registrants   The board. Coverage first, then one row per
//                                tokenised asset whose underlying carries a
//                                provider-asserted SEC filer number.
//   rwa_asset_profile            ONE profile by rwa id, for the research
//                                workspace drawer.
//
// COVERAGE IS EXACT AND IS NOT THE LENGTH OF THE TABLE. The three headline
// numbers come from `intel_rwa_underlying_coverage`, a grouped view over the
// whole universe, so they stay right even when the row list below them is capped
// at ROW_CAP. A capped list says it was capped.
//
// WHAT WE COMPUTE AND SAY WE COMPUTE. `daysSinceLastPeriodic` is OUR
// subtraction: the read instant minus the newer of the latest annual and latest
// quarterly filing dates EDGAR published. It is labelled as our calculation and
// names its two inputs. `periodicState` compares it with a stated threshold that
// depends on which annual form the filer uses, because a 20-F filer has no
// quarterly obligation and judging it on a domestic cadence would report every
// foreign issuer as late.
//
// NOTHING HERE IS AN ISSUER FACT. Every row is about the company UNDERNEATH a
// token, asserted by CoinMarketCap and then read by us at EDGAR. Who issued the
// token is a different question, answered only by the dated hand assertions
// behind the `rwa_issuer_legitimacy` view.

import {
  MAP_COUNT_TABLE, PROFILE_TABLE, REGISTRANT_TABLE, RWA_UNDERLYING_CAPTURE_SCHEDULE,
} from './capture-rwa-underlyings.ts'

/** The grouped coverage view created alongside the tables. */
export const COVERAGE_VIEW = 'intel_rwa_underlying_coverage'

/** Rows the board serves at most. The coverage figures above it are exact
 * regardless, so a cap truncates the LIST and never the claim. */
export const ROW_CAP = 1000
/** Per-type count rows for one UTC day, plus the 'all' row. */
export const COUNT_CAP = 40

/** The asset types whose underlying can carry an SEC filer number. CoinMarketCap
 * publishes `cik` for tokenised EQUITIES and ETFs; a tokenised barrel of oil has
 * no registrant. Stated here so the coverage sentence names the right universe.
 */
export const REGISTRANT_ASSET_TYPES = ['stock', 'etf'] as const

/** Days since the newest periodic filing beyond which we call a filer overdue.
 *
 * A domestic filer lodges a 10-Q or a 10-K every quarter; a large accelerated
 * filer's 10-Q is due 40 days after quarter end and its 10-K 60 days after year
 * end, so 130 days without either is outside any normal cadence.
 *
 * A foreign private issuer files a 20-F or 40-F ANNUALLY and no 10-Q at all. Its
 * 20-F is due four months after its fiscal year end, so 500 days is the
 * equivalent line. Judging such a filer on the domestic threshold would print
 * "overdue" against every ADR in the table, which would be our error and not
 * their lateness.
 */
export const DOMESTIC_PERIODIC_DAYS = 130
export const FOREIGN_PERIODIC_DAYS = 500
export const FOREIGN_ANNUAL_FORMS = ['20-F', '20-F/A', '40-F', '40-F/A']

/** How far back the filings we read must reach before their silence about a
 * periodic report means anything. Mirrors ANNUAL_LOOKBACK_DAYS in the capture
 * lane and is restated here so the READ can reach the same verdict from a stored
 * row alone, without re-reading EDGAR.
 *
 * WHY THE STATE EXISTS. EDGAR's `filings.recent` holds about a thousand entries.
 * BANK OF AMERICA CORP and JPMORGAN CHASE & CO file so many prospectus
 * supplements that their own 10-K and 10-Q fall out of it, and on 2026-09-20 both
 * were stored with no annual and no quarterly date at all. Sorted by "days since
 * the last periodic filing", the two largest banks in the United States would
 * have led this board as its most delinquent filers. They are not late; we did
 * not look far enough back. That is OUR limitation and the board says so. */
export const RECENT_BLOCK_REACH_DAYS = 400

export interface Coverage { from: string | null; to: string | null; count: number; truncated?: boolean }
export interface ViewResult { view: string; asOf: string | null; coverage: Coverage; reason?: string | null; [key: string]: unknown }

const num = (v: unknown): number | null => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const int = (v: unknown): number | null => { const n = num(v); return n == null ? null : Math.trunc(n) }
const str = (v: unknown, max = 2000): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const list = (v: unknown, max = 40): string[] | null => (Array.isArray(v) ? v.map((x) => str(x, max)).filter((x): x is string => !!x) : null)
const emptyCoverage = (): Coverage => ({ from: null, to: null, count: 0 })

// deno-lint-ignore no-explicit-any
async function readRows(build: () => any): Promise<{ rows: any[]; reason: string | null }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

const PROFILE_COLUMNS = 'rwa_id,provider,provider_capability,slug,symbol,name,asset_type,cik,cik_field,industry,founded,employees,primary_exchange,rwa_rank,has_tokens,logo_url,website,description,about_date_added,captured_at,provider_fetched_at,registrant_checked_at,scope'
const REGISTRANT_COLUMNS = 'rwa_id,cik,state,reason,registrant_name,sic,sic_description,state_of_incorporation,fiscal_year_end,exchanges,tickers,latest_annual_form,latest_annual_date,latest_annual_accession,latest_quarterly_form,latest_quarterly_date,latest_quarterly_accession,latest_current_form,latest_current_date,latest_current_accession,filings_read,recent_filings_count,recent_oldest_date,recent_newest_date,older_pages_read,asset_name,registrant_name_normalized,asset_name_normalized,name_match,source_url,fetched_at,checked_at,scope'

/** The filer's own EDGAR browse page. Rebuilt here rather than trusted from the
 * row so a link the board renders is always an sec.gov URL. */
export const filerUrl = (cik: unknown): string | null => {
  const digits = String(cik ?? '').replace(/\D/g, '')
  return digits.length === 10 ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${digits}&type=&dateb=&owner=include&count=40` : null
}

/** One filing's public index page, so an accession number is clickable. */
export const filingUrl = (cik: unknown, accession: unknown): string | null => {
  const digits = String(cik ?? '').replace(/\D/g, '')
  const acc = String(accession ?? '').trim()
  if (digits.length !== 10 || !/^\d{10}-\d{2}-\d{6}$/.test(acc)) return null
  return `https://www.sec.gov/Archives/edgar/data/${Number(digits)}/${acc.replace(/-/g, '')}/`
}

/**
 * OUR calculation, from EDGAR's two dates.
 *
 * Returns the day count since the newer of the latest annual and latest
 * quarterly filing, the threshold it was judged against, and which of the two
 * dates the count came from, so the figure can always name its input.
 */
export function periodicStanding(
  row: {
    latest_annual_date?: unknown; latest_quarterly_date?: unknown; latest_annual_form?: unknown
    recent_oldest_date?: unknown; recent_filings_count?: unknown; older_pages_read?: unknown
  } | null,
  at: number,
): {
  days: number | null; from: string | null; basis: 'annual' | 'quarterly' | null; thresholdDays: number
  state: 'current' | 'overdue' | 'unknown' | 'not_in_read_filings'
  readBackTo: string | null; readBackDays: number | null
} {
  const annual = str(row?.latest_annual_date, 10)
  const quarterly = str(row?.latest_quarterly_date, 10)
  const foreign = FOREIGN_ANNUAL_FORMS.includes(String(row?.latest_annual_form || ''))
  // A filer with no quarterly report at all is judged on the annual line, which
  // is also the right line for a foreign private issuer's 20-F.
  const thresholdDays = foreign || !quarterly ? FOREIGN_PERIODIC_DAYS : DOMESTIC_PERIODIC_DAYS
  // How far back the filings we actually read reach. A row captured before this
  // was recorded carries nothing here and keeps the old 'unknown'.
  const readBackTo = str(row?.recent_oldest_date, 10)
  const readBackAt = readBackTo ? Date.parse(`${readBackTo}T00:00:00.000Z`) : NaN
  const readBackDays = Number.isFinite(readBackAt) ? Math.max(0, Math.floor((at - readBackAt) / 86_400_000)) : null
  const candidates: { date: string; basis: 'annual' | 'quarterly' }[] = []
  if (annual) candidates.push({ date: annual, basis: 'annual' })
  if (quarterly) candidates.push({ date: quarterly, basis: 'quarterly' })
  if (!candidates.length) {
    // NOT LATE, NOT LOOKED AT. The filings we read do not reach back a year, so
    // an annual report could not have been among them however punctual the
    // filer is. There is nothing to subtract, and nothing to allege.
    const state = readBackDays != null && readBackDays < RECENT_BLOCK_REACH_DAYS ? 'not_in_read_filings' : 'unknown'
    return { days: null, from: null, basis: null, thresholdDays, state, readBackTo, readBackDays }
  }
  candidates.sort((a, b) => b.date.localeCompare(a.date))
  const newest = candidates[0]
  const parsed = Date.parse(`${newest.date}T00:00:00.000Z`)
  if (!Number.isFinite(parsed)) return { days: null, from: null, basis: null, thresholdDays, state: 'unknown', readBackTo, readBackDays }
  // A future filing date is not a negative age: it is a date we cannot subtract
  // meaningfully, so the count is clamped at zero and the filer reads as current.
  const days = Math.max(0, Math.floor((at - parsed) / 86_400_000))
  return { days, from: newest.date, basis: newest.basis, thresholdDays, state: days > thresholdDays ? 'overdue' : 'current', readBackTo, readBackDays }
}

/** One board row, with our computed standing folded in. */
// deno-lint-ignore no-explicit-any
export function registrantRow(profile: any, registrant: any, at: number) {
  const standing = periodicStanding(registrant, at)
  const cik = str(profile?.cik, 10) ?? str(registrant?.cik, 10)
  return {
    rwaId: int(profile?.rwa_id),
    slug: str(profile?.slug, 120),
    symbol: str(profile?.symbol, 40),
    name: str(profile?.name, 300),
    assetType: str(profile?.asset_type, 40),
    rwaRank: int(profile?.rwa_rank),
    logoUrl: str(profile?.logo_url, 500),
    industry: str(profile?.industry, 200),
    // The provider's assertion, kept labelled as one wherever it travels.
    cik,
    cikProvider: str(profile?.provider, 40),
    cikField: str(profile?.cik_field, 40),
    cikAssertedAt: str(profile?.captured_at, 40),
    // The exchange the provider names, with EDGAR's own list beside it rather
    // than merged into it.
    primaryExchange: str(profile?.primary_exchange, 120),
    edgarExchanges: list(registrant?.exchanges),
    edgarTickers: list(registrant?.tickers, 20),
    filerUrl: filerUrl(cik),
    // Null until the EDGAR half of the lane has reached this asset. A board that
    // has not looked yet says so instead of implying a clean result.
    registrant: registrant
      ? {
        state: str(registrant.state, 20),
        reason: str(registrant.reason, 120),
        name: str(registrant.registrant_name, 500),
        sic: str(registrant.sic, 10),
        sicDescription: str(registrant.sic_description, 200),
        stateOfIncorporation: str(registrant.state_of_incorporation, 20),
        fiscalYearEnd: str(registrant.fiscal_year_end, 8),
        filingsRead: int(registrant.filings_read) ?? 0,
        // WHAT WAS ACTUALLY READ, so an absent annual report can be read as our
        // limit rather than as the filer's lateness. Null on a row captured
        // before the span was recorded.
        filingsCovered: {
          count: int(registrant.recent_filings_count),
          oldest: str(registrant.recent_oldest_date, 10),
          newest: str(registrant.recent_newest_date, 10),
          olderPagesRead: int(registrant.older_pages_read),
        },
        annual: {
          form: str(registrant.latest_annual_form, 20),
          filingDate: str(registrant.latest_annual_date, 10),
          accessionNumber: str(registrant.latest_annual_accession, 25),
          url: filingUrl(cik, registrant.latest_annual_accession),
        },
        quarterly: {
          form: str(registrant.latest_quarterly_form, 20),
          filingDate: str(registrant.latest_quarterly_date, 10),
          accessionNumber: str(registrant.latest_quarterly_accession, 25),
          url: filingUrl(cik, registrant.latest_quarterly_accession),
        },
        current: {
          form: str(registrant.latest_current_form, 20),
          filingDate: str(registrant.latest_current_date, 10),
          accessionNumber: str(registrant.latest_current_accession, 25),
          url: filingUrl(cik, registrant.latest_current_accession),
        },
        nameMatch: str(registrant.name_match, 20) ?? 'unknown',
        assetNameCompared: str(registrant.asset_name, 300),
        registrantNameNormalized: str(registrant.registrant_name_normalized, 300),
        assetNameNormalized: str(registrant.asset_name_normalized, 300),
        sourceUrl: str(registrant.source_url, 500),
        fetchedAt: str(registrant.fetched_at, 40),
        checkedAt: str(registrant.checked_at, 40),
        scope: str(registrant.scope),
      }
      : null,
    // OUR figure, never EDGAR's. The client labels it as our calculation.
    periodic: standing,
    scope: str(profile?.scope),
  }
}

/**
 * The board.
 *
 * Three independent reads: the exact coverage aggregate, the profiles carrying a
 * provider-asserted filer number, and the registrant records. One unavailable
 * read degrades to its own stated reason rather than blanking the board.
 */
// deno-lint-ignore no-explicit-any
export async function readRwaUnderlyingRegistrants(db: any, params: Record<string, unknown> = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const at = now instanceof Date ? now.getTime() : now
  const reasons: string[] = []
  const collect = <T>(result: { rows: T[]; reason: string | null }, source: string): T[] => {
    if (result.reason) reasons.push(`${source}:${result.reason}`)
    return result.rows
  }

  const [coverageRead, countRead, profileRead, registrantRead] = await Promise.all([
    readRows(() => db.from(COVERAGE_VIEW).select('asset_type,tokenised_count,profiled_count,with_cik_count,registrant_known_count,registrant_not_found_count,registrant_unavailable_count,newest_profile_at,newest_registrant_at').limit(COUNT_CAP)),
    readRows(() => db.from(MAP_COUNT_TABLE).select('asset_type,snapshot_date,asset_count,with_tokens_count,pages_read,truncated,captured_at').order('snapshot_date', { ascending: false }).limit(COUNT_CAP)),
    readRows(() => db.from(PROFILE_TABLE).select(PROFILE_COLUMNS).not('cik', 'is', null).order('rwa_rank', { ascending: true, nullsFirst: false }).limit(ROW_CAP)),
    readRows(() => db.from(REGISTRANT_TABLE).select(REGISTRANT_COLUMNS).limit(ROW_CAP)),
  ])

  const coverageRows = collect(coverageRead, COVERAGE_VIEW)
  const countRows = collect(countRead, MAP_COUNT_TABLE)
  const profileRows = collect(profileRead, PROFILE_TABLE)
  const registrantRows = collect(registrantRead, REGISTRANT_TABLE)

  const byId = new Map(registrantRows.map((r) => [int(r?.rwa_id), r]))
  const rows = profileRows.map((profile) => registrantRow(profile, byId.get(int(profile?.rwa_id)) ?? null, at))

  // The headline numbers, over the WHOLE universe, from the grouped view.
  const registrantTypes = new Set<string>(REGISTRANT_ASSET_TYPES)
  const wanted = coverageRows.filter((r) => registrantTypes.has(String(r?.asset_type)))
  const sum = (key: string, from = wanted) => from.reduce((total, r) => total + (int(r?.[key]) ?? 0), 0)
  const universe = {
    // Tokenised equities and funds in the enumerated universe.
    tokenised: sum('tokenised_count'),
    profiled: sum('profiled_count'),
    withCik: sum('with_cik_count'),
    confirmed: sum('registrant_known_count'),
    notFoundAtEdgar: sum('registrant_not_found_count'),
    edgarUnavailable: sum('registrant_unavailable_count'),
    // Every type, so the reader can see what the two counted types leave out.
    allTypes: coverageRows.map((r) => ({
      assetType: str(r?.asset_type, 40),
      tokenised: int(r?.tokenised_count) ?? 0,
      profiled: int(r?.profiled_count) ?? 0,
      withCik: int(r?.with_cik_count) ?? 0,
      confirmed: int(r?.registrant_known_count) ?? 0,
    })),
    assetTypes: [...REGISTRANT_ASSET_TYPES],
  }

  // True per-type counts for the newest enumerated day, as the map op wrote
  // them: a COUNT of enumerated ids rather than the length of a list page.
  const newestDate = countRows.map((r) => str(r?.snapshot_date, 10)).filter((v): v is string => !!v).sort().at(-1) ?? null
  // A count that stopped at the enumeration page ceiling is a FLOOR, and it
  // travels with `truncated` so the page can say "at least N" rather than
  // printing a capped number as a total. A row written before the column existed
  // carries null, and a null is not a claim either way.
  const mapCounts = countRows.filter((r) => str(r?.snapshot_date, 10) === newestDate).map((r) => ({
    assetType: str(r?.asset_type, 40),
    assetCount: int(r?.asset_count) ?? 0,
    withTokensCount: int(r?.with_tokens_count) ?? 0,
    pagesRead: int(r?.pages_read),
    truncated: r?.truncated === true,
  }))
  const countsTruncated = mapCounts.some((r) => r.truncated)

  const stamps = [
    ...coverageRows.map((r) => str(r?.newest_profile_at, 40)),
    ...coverageRows.map((r) => str(r?.newest_registrant_at, 40)),
  ].filter((v): v is string => !!v).sort()

  return {
    view: 'rwa_underlying_registrants',
    asOf: stamps.at(-1) ?? null,
    coverage: stamps.length
      ? { from: stamps[0], to: stamps.at(-1)!, count: rows.length, truncated: profileRows.length >= ROW_CAP || registrantRows.length >= ROW_CAP }
      : { ...emptyCoverage(), count: rows.length },
    reason: reasons.length ? reasons.join(' ').slice(0, 400) : null,
    universe,
    mapCounts,
    mapCountsDate: newestDate,
    // The enumeration stopped at its page ceiling for at least one asset type, so
    // every count above is a floor. The board prints "at least" rather than a
    // total when this is true.
    countsTruncated,
    rows,
    // How our own day count is judged, so the client never invents a threshold.
    thresholds: {
      domesticDays: DOMESTIC_PERIODIC_DAYS, foreignDays: FOREIGN_PERIODIC_DAYS, foreignAnnualForms: FOREIGN_ANNUAL_FORMS,
      recentBlockReachDays: RECENT_BLOCK_REACH_DAYS,
    },
    rowCap: ROW_CAP,
    // When the three ops run, so an empty board can say when it fills.
    schedule: RWA_UNDERLYING_CAPTURE_SCHEDULE,
  }
}

/**
 * ONE stored profile by rwa id, for the research workspace drawer.
 *
 * Deliberately narrow: the descriptive fields the provider published plus, when
 * the EDGAR half has reached it, the registrant record and our computed
 * standing. It spends nothing: this is a database read of an already captured
 * row, never a provider call on a reader's behalf.
 */
// deno-lint-ignore no-explicit-any
export async function readRwaAssetProfile(db: any, params: Record<string, unknown> = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const at = now instanceof Date ? now.getTime() : now
  const rwaId = int(params.rwaId ?? params.rwa_id)
  if (rwaId == null || rwaId < 1) {
    return { view: 'rwa_asset_profile', asOf: null, coverage: emptyCoverage(), reason: 'rwa_id_required', profile: null }
  }
  const [profileRead, registrantRead] = await Promise.all([
    readRows(() => db.from(PROFILE_TABLE).select(PROFILE_COLUMNS).eq('rwa_id', rwaId).limit(1)),
    readRows(() => db.from(REGISTRANT_TABLE).select(REGISTRANT_COLUMNS).eq('rwa_id', rwaId).limit(1)),
  ])
  const reasons: string[] = []
  if (profileRead.reason) reasons.push(`${PROFILE_TABLE}:${profileRead.reason}`)
  if (registrantRead.reason) reasons.push(`${REGISTRANT_TABLE}:${registrantRead.reason}`)
  const profile = profileRead.rows[0] ?? null
  // A read that succeeded and found nothing is not a failure: this asset has not
  // been profiled yet, and the drawer says that rather than showing an error.
  const row = profile ? registrantRow(profile, registrantRead.rows[0] ?? null, at) : null
  const asOf = str(profile?.captured_at, 40) ?? null
  return {
    view: 'rwa_asset_profile',
    asOf,
    coverage: asOf ? { from: asOf, to: asOf, count: row ? 1 : 0 } : { ...emptyCoverage(), count: 0 },
    reason: reasons.length ? reasons.join(' ').slice(0, 400) : null,
    profile: row
      ? {
        ...row,
        description: str(profile?.description, 20000),
        website: str(profile?.website, 500),
        founded: str(profile?.founded, 40),
        employees: int(profile?.employees),
        aboutDateAdded: str(profile?.about_date_added, 40),
        providerFetchedAt: str(profile?.provider_fetched_at, 40),
      }
      : null,
    schedule: RWA_UNDERLYING_CAPTURE_SCHEDULE,
  }
}

export const RWA_UNDERLYING_CAPTURE_VIEWS: Record<string, (
  // deno-lint-ignore no-explicit-any
  db: any, body: Record<string, unknown>, now: number
) => Promise<ViewResult>> = {
  rwa_underlying_registrants: (db, body, now) => readRwaUnderlyingRegistrants(db, body, now),
  rwa_asset_profile: (db, body, now) => readRwaAssetProfile(db, body, now),
}
