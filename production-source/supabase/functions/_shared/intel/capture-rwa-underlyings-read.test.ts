import { strict as assert } from 'node:assert'
import {
  COVERAGE_VIEW, DOMESTIC_PERIODIC_DAYS, FOREIGN_PERIODIC_DAYS, ROW_CAP,
  filerUrl, filingUrl, LOGO_BATCH_MAX, periodicStanding, readRwaAssetLogos, readRwaAssetProfile,
  readRwaUnderlyingRegistrants,
} from './capture-rwa-underlyings-read.ts'
import { MAP_COUNT_TABLE, PROFILE_TABLE, REGISTRANT_TABLE } from './capture-rwa-underlyings.ts'

// The read contract: coverage is EXACT and not the length of the list, a mismatch
// is surfaced rather than hidden, our day count names its inputs, and a failed
// read is a reason on an otherwise intact board.

// deno-lint-ignore no-explicit-any
function fakeDb(seed: Record<string, any[]> = {}, failing: Record<string, string> = {}) {
  return {
    from(table: string) {
      const builder = {
        // deno-lint-ignore no-explicit-any
        select() { return builder as any },
        not() { return builder },
        eq() { return builder },
        // The filters are ignored on purpose: these tests are about what the
        // view DOES with the rows, and the seed is already the rows it asked for.
        in() { return builder },
        order() { return builder },
        limit(count?: number) {
          if (failing[table]) return Promise.resolve({ data: null, error: { message: failing[table] } })
          const rows = seed[table] ?? []
          return Promise.resolve({ data: typeof count === 'number' ? rows.slice(0, count) : rows, error: null })
        },
      }
      return builder
    },
  }
}

const NOW = Date.parse('2026-09-20T15:20:00.000Z')

const coverage = [
  { asset_type: 'stock', tokenised_count: 420, profiled_count: 300, with_cik_count: 240, registrant_known_count: 90, registrant_not_found_count: 2, registrant_unavailable_count: 1, newest_profile_at: '2026-09-20T03:29:00.000Z', newest_registrant_at: '2026-09-20T03:47:00.000Z' },
  { asset_type: 'etf', tokenised_count: 60, profiled_count: 55, with_cik_count: 40, registrant_known_count: 12, registrant_not_found_count: 0, registrant_unavailable_count: 0, newest_profile_at: '2026-09-20T03:29:00.000Z', newest_registrant_at: '2026-09-20T03:47:00.000Z' },
  // A type with no registrant at all. It must not enter the headline counts.
  { asset_type: 'commodity', tokenised_count: 9, profiled_count: 9, with_cik_count: 0, registrant_known_count: 0, registrant_not_found_count: 0, registrant_unavailable_count: 0, newest_profile_at: '2026-09-20T03:29:00.000Z', newest_registrant_at: null },
]

const profile = (over: Record<string, unknown> = {}) => ({
  rwa_id: 11, provider: 'coinmarketcap', provider_capability: 'rwaInfo', slug: 'nvidia', symbol: 'NVDAX',
  name: 'Nvidia', asset_type: 'stock', cik: '0001045810', cik_field: 'cik', industry: 'Semiconductors',
  founded: '1993', employees: 36000, primary_exchange: 'NASDAQ', rwa_rank: 4, has_tokens: true,
  logo_url: 'https://cdn.example.test/nvda.png', website: 'https://www.nvidia.com', description: 'A company.',
  about_date_added: '2025-07-17T06:57:15.000Z', captured_at: '2026-09-20T03:29:00.000Z',
  provider_fetched_at: '2026-09-20T03:28:50.000Z', registrant_checked_at: '2026-09-20T03:47:00.000Z',
  scope: 'x'.repeat(90), ...over,
})

const registrant = (over: Record<string, unknown> = {}) => ({
  rwa_id: 11, cik: '0001045810', state: 'known', reason: null, registrant_name: 'NVIDIA CORP',
  sic: '3674', sic_description: 'Semiconductors', state_of_incorporation: 'DE', fiscal_year_end: '0126',
  exchanges: ['Nasdaq'], tickers: ['NVDA'],
  latest_annual_form: '10-K', latest_annual_date: '2026-02-21', latest_annual_accession: '0001045810-26-000002',
  latest_quarterly_form: '10-Q', latest_quarterly_date: '2026-08-27', latest_quarterly_accession: '0001045810-26-000010',
  latest_current_form: '8-K', latest_current_date: '2026-09-02', latest_current_accession: '0001045810-26-000011',
  filings_read: 3, asset_name: 'Nvidia', registrant_name_normalized: 'nvidiacorp', asset_name_normalized: 'nvidia',
  name_match: 'contained', source_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810',
  fetched_at: '2026-09-20T03:47:01.000Z', checked_at: '2026-09-20T03:47:00.000Z', scope: 'y'.repeat(90), ...over,
})

// ─── our own day count ───────────────────────────────────────────────────────

Deno.test('the day count is ours, names the date it came from and states its threshold', () => {
  const standing = periodicStanding({ latest_annual_date: '2026-02-21', latest_quarterly_date: '2026-08-27', latest_annual_form: '10-K' }, NOW)
  // Counted from the LATER of the two dates, and it says which one.
  assert.equal(standing.from, '2026-08-27')
  assert.equal(standing.basis, 'quarterly')
  assert.equal(standing.days, 24)
  assert.equal(standing.thresholdDays, DOMESTIC_PERIODIC_DAYS)
  assert.equal(standing.state, 'current')
})

Deno.test('a filer past the window is overdue, and a foreign annual filer is judged on the annual line', () => {
  const late = periodicStanding({ latest_annual_date: '2025-02-21', latest_quarterly_date: '2025-05-02', latest_annual_form: '10-K' }, NOW)
  assert.equal(late.state, 'overdue')
  assert.ok((late.days ?? 0) > DOMESTIC_PERIODIC_DAYS)
  // A 20-F filer lodges no 10-Q. Judging it on the domestic line would print
  // "overdue" against every ADR, which would be our error, not its lateness.
  const foreign = periodicStanding({ latest_annual_date: '2026-04-30', latest_quarterly_date: null, latest_annual_form: '20-F' }, NOW)
  assert.equal(foreign.thresholdDays, FOREIGN_PERIODIC_DAYS)
  assert.equal(foreign.state, 'current')
  assert.equal(foreign.basis, 'annual')
})

Deno.test('no periodic filing read is unknown, not a zero, and a future date is not a negative age', () => {
  const none = periodicStanding({ latest_annual_date: null, latest_quarterly_date: null }, NOW)
  assert.equal(none.days, null)
  assert.equal(none.state, 'unknown')
  const ahead = periodicStanding({ latest_annual_date: '2027-01-01', latest_quarterly_date: null, latest_annual_form: '10-K' }, NOW)
  assert.equal(ahead.days, 0)
  assert.equal(ahead.state, 'current')
})

Deno.test('every link the board renders is an sec.gov URL built from the stored identifiers', () => {
  assert.equal(filerUrl('0001045810'), 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=&dateb=&owner=include&count=40')
  assert.equal(filerUrl('bad'), null)
  assert.equal(filingUrl('0001045810', '0001045810-26-000002'), 'https://www.sec.gov/Archives/edgar/data/1045810/000104581026000002/')
  assert.equal(filingUrl('0001045810', 'not-an-accession'), null)
})

// ─── the board ───────────────────────────────────────────────────────────────

Deno.test('coverage is exact over the whole universe and counts only equities and funds', async () => {
  const result = await readRwaUnderlyingRegistrants(fakeDb({
    [COVERAGE_VIEW]: coverage,
    [PROFILE_TABLE]: [profile()],
    [REGISTRANT_TABLE]: [registrant()],
    [MAP_COUNT_TABLE]: [
      { asset_type: 'stock', snapshot_date: '2026-09-20', asset_count: 900, with_tokens_count: 420, captured_at: '2026-09-20T03:11:00.000Z' },
      { asset_type: 'stock', snapshot_date: '2026-09-19', asset_count: 880, with_tokens_count: 410, captured_at: '2026-09-19T03:11:00.000Z' },
    ],
  }), {}, NOW)

  // 240 + 40 of 420 + 60, 90 + 12 confirmed. The commodity row is excluded.
  assert.equal(result.universe.tokenised, 480)
  assert.equal(result.universe.withCik, 280)
  assert.equal(result.universe.confirmed, 102)
  assert.equal(result.universe.notFoundAtEdgar, 2)
  // And the coverage claim is NOT the length of the list, which is one row here.
  assert.equal(result.rows.length, 1)
  // True per-type counts for the newest enumerated day only.
  assert.equal(result.mapCountsDate, '2026-09-20')
  assert.equal(result.mapCounts.length, 1)
  assert.equal(result.mapCounts[0].assetCount, 900)
})

Deno.test('a row carries the provider assertion, the registrant we read and our computed standing', async () => {
  const result = await readRwaUnderlyingRegistrants(fakeDb({
    [COVERAGE_VIEW]: coverage, [PROFILE_TABLE]: [profile()], [REGISTRANT_TABLE]: [registrant()],
  }), {}, NOW)
  const row = result.rows[0]
  assert.equal(row.cik, '0001045810')
  assert.equal(row.cikProvider, 'coinmarketcap')
  assert.equal(row.cikField, 'cik')
  assert.equal(row.cikAssertedAt, '2026-09-20T03:29:00.000Z')
  assert.equal(row.registrant.name, 'NVIDIA CORP')
  assert.equal(row.registrant.annual.url, 'https://www.sec.gov/Archives/edgar/data/1045810/000104581026000002/')
  // The provider's exchange and EDGAR's own list sit side by side, unmerged.
  assert.equal(row.primaryExchange, 'NASDAQ')
  assert.deepEqual(row.edgarExchanges, ['Nasdaq'])
  assert.equal(row.periodic.basis, 'quarterly')
  assert.equal(row.periodic.days, 24)
})

Deno.test('a mismatch reaches the board with both normalised strings, and is never dropped', async () => {
  const result = await readRwaUnderlyingRegistrants(fakeDb({
    [COVERAGE_VIEW]: coverage,
    [PROFILE_TABLE]: [profile()],
    [REGISTRANT_TABLE]: [registrant({ registrant_name: 'SUNBETH GLOBAL CONCEPTS LIMITED', registrant_name_normalized: 'sunbethglobalconceptslimited', name_match: 'differs' })],
  }), {}, NOW)
  const row = result.rows[0]
  assert.equal(row.registrant.nameMatch, 'differs')
  assert.equal(row.registrant.registrantNameNormalized, 'sunbethglobalconceptslimited')
  assert.equal(row.registrant.assetNameNormalized, 'nvidia')
})

Deno.test('a profile whose filer number has not been read yet is null rather than a clean result', async () => {
  const result = await readRwaUnderlyingRegistrants(fakeDb({
    [COVERAGE_VIEW]: coverage, [PROFILE_TABLE]: [profile({ registrant_checked_at: null })], [REGISTRANT_TABLE]: [],
  }), {}, NOW)
  assert.equal(result.rows[0].registrant, null)
  assert.equal(result.rows[0].periodic.state, 'unknown')
  assert.equal(result.rows[0].periodic.days, null)
})

Deno.test('a failed read is a reason on an intact board, never an empty list presented as a finding', async () => {
  const result = await readRwaUnderlyingRegistrants(fakeDb(
    { [COVERAGE_VIEW]: coverage, [PROFILE_TABLE]: [profile()] },
    { [REGISTRANT_TABLE]: 'permission denied for table' },
  ), {}, NOW)
  assert.match(String(result.reason), /intel_rwa_underlying_registrants:permission denied/)
  // The profile row still lands, with its registrant absent rather than invented.
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].registrant, null)
})

Deno.test('a capped list says it was capped and the row cap is published', async () => {
  const rows = Array.from({ length: ROW_CAP + 5 }, (_, i) => profile({ rwa_id: i + 1, rwa_rank: i + 1 }))
  const result = await readRwaUnderlyingRegistrants(fakeDb({ [COVERAGE_VIEW]: coverage, [PROFILE_TABLE]: rows, [REGISTRANT_TABLE]: [] }), {}, NOW)
  assert.equal(result.rows.length, ROW_CAP)
  assert.equal(result.coverage.truncated, true)
  assert.equal(result.rowCap, ROW_CAP)
  // The headline is unaffected by the cap.
  assert.equal(result.universe.tokenised, 480)
})

Deno.test('an empty universe is an empty coverage rather than a zero claim', async () => {
  const result = await readRwaUnderlyingRegistrants(fakeDb({}), {}, NOW)
  assert.equal(result.asOf, null)
  assert.equal(result.coverage.count, 0)
  assert.equal(result.universe.tokenised, 0)
  assert.equal(result.rows.length, 0)
  // The schedule travels with an empty board so it can say when it fills.
  assert.equal((result.schedule as Record<string, { utc: string }>).rwa_asset_map.utc, '03:11')
})

// ─── the single profile view ─────────────────────────────────────────────────

Deno.test('the drawer view reads one profile by rwa id and carries the description', async () => {
  const result = await readRwaAssetProfile(fakeDb({ [PROFILE_TABLE]: [profile()], [REGISTRANT_TABLE]: [registrant()] }), { rwaId: 11 }, NOW)
  assert.equal(result.profile?.rwaId, 11)
  assert.equal(result.profile?.description, 'A company.')
  assert.equal(result.profile?.website, 'https://www.nvidia.com')
  assert.equal(result.profile?.employees, 36000)
  assert.equal(result.profile?.registrant?.name, 'NVIDIA CORP')
  assert.equal(result.asOf, '2026-09-20T03:29:00.000Z')
})

Deno.test('a missing rwa id is a named reason, and an uncaptured asset is a null profile not an error', async () => {
  const missing = await readRwaAssetProfile(fakeDb({}), {}, NOW)
  assert.equal(missing.reason, 'rwa_id_required')
  assert.equal(missing.profile, null)
  const uncaptured = await readRwaAssetProfile(fakeDb({ [PROFILE_TABLE]: [], [REGISTRANT_TABLE]: [] }), { rwaId: 99 }, NOW)
  assert.equal(uncaptured.reason, null)
  assert.equal(uncaptured.profile, null)
  assert.equal(uncaptured.asOf, null)
})

// ─── rwa_asset_logos ──────────────────────────────────────────────────────────
//
// The batch a list of rows reads once per page instead of once per row.

Deno.test('the logo batch answers a map keyed by rwa id and leaves an unprofiled id out of it', async () => {
  const db = fakeDb({
    [PROFILE_TABLE]: [
      { rwa_id: 11, symbol: 'NVDA', name: 'NVIDIA Corp', logo_url: 'https://s2.coinmarketcap.com/static/img/rwa/nvda.png', captured_at: '2026-09-20T03:29:00.000Z' },
      { rwa_id: 1, symbol: 'GOLD', name: 'Gold', logo_url: null, captured_at: '2026-09-20T03:30:00.000Z' },
    ],
  })
  const view = await readRwaAssetLogos(db, { rwaIds: [11, 1, 999] }, NOW)
  assert.equal(view.view, 'rwa_asset_logos')
  const logos = view.logos as Record<string, { logoUrl: string | null; symbol: string | null }>
  assert.equal(logos['11'].logoUrl, 'https://s2.coinmarketcap.com/static/img/rwa/nvda.png')
  assert.equal(logos['11'].symbol, 'NVDA')
  // Profiled, but the provider published no image: a null, not an absence.
  assert.equal(logos['1'].logoUrl, null)
  // Never profiled: absent from the map entirely, because "we have no image for
  // this asset" is not the same claim as "this asset has no image".
  assert.equal(logos['999'], undefined)
  // The newest profile clock behind the answer, and the provider that published
  // the images, so the surface attributes them without naming one itself.
  assert.equal(view.asOf, '2026-09-20T03:30:00.000Z')
  assert.equal(view.source, 'coinmarketcap')
})

Deno.test('the logo batch refuses an empty ask, caps a large one and drops a non-https image', async () => {
  const empty = await readRwaAssetLogos(fakeDb(), {}, NOW)
  assert.equal(empty.reason, 'rwa_ids_required')
  assert.deepEqual(empty.logos, {})

  const many = await readRwaAssetLogos(fakeDb(), { rwaIds: Array.from({ length: 400 }, (_, i) => i + 1) }, NOW)
  assert.equal(many.asked, LOGO_BATCH_MAX)

  // An http or data URL is never put into an <img> on our page.
  const db = fakeDb({
    [PROFILE_TABLE]: [
      { rwa_id: 7, symbol: 'X', name: 'X', logo_url: 'http://example.com/x.png', captured_at: '2026-09-20T03:29:00.000Z' },
    ],
  })
  const view = await readRwaAssetLogos(db, { rwaIds: [7] }, NOW)
  assert.equal((view.logos as Record<string, { logoUrl: string | null }>)['7'].logoUrl, null)
})

Deno.test('a failed logo read is a reason on an empty map, never a thrown error', async () => {
  const view = await readRwaAssetLogos(fakeDb({}, { [PROFILE_TABLE]: 'permission denied' }), { rwaIds: [11] }, NOW)
  assert.equal(view.reason, 'permission denied')
  assert.deepEqual(view.logos, {})
})
