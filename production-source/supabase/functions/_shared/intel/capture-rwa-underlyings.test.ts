import { strict as assert } from 'node:assert'
import {
  ANNUAL_FORMS, CURRENT_FORMS, INFO_CALLS_PER_RUN, MAP_COUNT_TABLE, MAP_PAGE, MAP_PAGES_PER_TYPE, MAP_TABLE,
  OLDER_PAGES_PER_FILER, PERIODIC_FORMS, PROFILE_BATCH,
  PROFILE_TABLE, QUARTERLY_FORMS, REGISTRANT_TABLE, RWA_UNDERLYING_CAPTURE_SCHEDULE,
  captureRwaAssetMap, captureRwaAssetProfiles, captureRwaUnderlyingRegistrants,
  cikDigits, compareNames, httpsOnly, latestFiling, needsOlderFilings, normalizeName, underlyingPolicy,
} from './capture-rwa-underlyings.ts'
import { normalizeSubmissions } from './rwa-sources/edgar.ts'
import { __resetRwaSourceStateForTests } from './rwa-sources/http.ts'
import { deps as sourceDeps, fakeFetch, EDGAR_AGENT } from './rwa-sources/test-support.ts'

// The WRITE PATH and the two rules that make this lane honest: a provider-asserted
// CIK is never stored as our own claim, and a name that differs is never hidden.

interface Written { table: string; rows: Record<string, unknown>[]; onConflict: string }

interface Updated { table: string; patch: Record<string, unknown>; column: string; values: unknown[] }

/** Columns Postgres would refuse a NULL in, per table.
 *
 * This is the whole of defect 4. `INSERT ... ON CONFLICT DO UPDATE` evaluates the
 * NOT NULL columns of the would-be INSERT row BEFORE it ever reaches the conflict
 * clause, so an upsert of `{rwa_id, registrant_checked_at}` against a table with a
 * NOT NULL `captured_at` fails the statement outright. On 2026-09-20 that left 25
 * registrant rows written and not one filer stamped, so the same 25 filers would
 * have been re-read for ever and the queue would never have advanced. The fake
 * enforces it, so a cursor must be advanced with an UPDATE or this file fails. */
const NOT_NULL: Record<string, string[]> = {
  [PROFILE_TABLE]: ['rwa_id', 'captured_at', 'scope'],
  [REGISTRANT_TABLE]: ['rwa_id', 'cik', 'checked_at', 'scope'],
  [MAP_COUNT_TABLE]: ['asset_type', 'snapshot_date', 'asset_count', 'with_tokens_count', 'captured_at'],
}

/**
 * A PostgREST-shaped fake. `seed` holds rows the queue reads back; `writes`
 * records every upsert and `updates` every UPDATE, which also mutates the seeded
 * rows so a cursor can be read back the way the next run would see it. Every
 * builder method returns `this`, so the chain the lane actually writes (select,
 * not, order, order, limit) is the chain exercised.
 */
// deno-lint-ignore no-explicit-any
function fakeDb(seed: Record<string, any[]> = {}, failing: Record<string, string> = {}) {
  const writes: Written[] = []
  const updates: Updated[] = []
  const reads: string[] = []
  const filters: { table: string; op: string; args: unknown[] }[] = []
  return {
    writes,
    updates,
    reads,
    filters,
    rowsFor(table: string) { return writes.filter((w) => w.table === table).flatMap((w) => w.rows) },
    conflictFor(table: string) { return writes.find((w) => w.table === table)?.onConflict ?? null },
    // deno-lint-ignore no-explicit-any
    seededRow(table: string, rwaId: number): any { return (seed[table] ?? []).find((r) => Number(r?.rwa_id) === rwaId) ?? null },
    from(table: string) {
      const builder = {
        // deno-lint-ignore no-explicit-any
        select(_columns?: string) { reads.push(table); return builder as any },
        not(...args: unknown[]) { filters.push({ table, op: 'not', args }); return builder },
        eq(...args: unknown[]) { filters.push({ table, op: 'eq', args }); return builder },
        order() { return builder },
        limit(count?: number) {
          if (failing[table]) return Promise.resolve({ data: null, error: { message: failing[table] } })
          const rows = seed[table] ?? []
          return Promise.resolve({ data: typeof count === 'number' ? rows.slice(0, count) : rows, error: null })
        },
        update(patch: Record<string, unknown>) {
          return {
            in(column: string, values: unknown[]) {
              if (failing[table]) return Promise.resolve({ error: { message: failing[table] } })
              updates.push({ table, patch, column, values })
              // An UPDATE touches rows that already exist and never supplies the
              // rest of their columns, so no NOT NULL check applies to it.
              for (const row of (seed[table] ?? [])) {
                if (values.some((v) => String(v) === String(row?.[column]))) Object.assign(row, patch)
              }
              return Promise.resolve({ error: null })
            },
          }
        },
        upsert(rows: Record<string, unknown>[], options: { onConflict: string }) {
          if (failing[table]) return Promise.resolve({ error: { message: failing[table] } })
          for (const column of NOT_NULL[table] ?? []) {
            if (rows.some((row) => row[column] == null)) {
              return Promise.resolve({ error: { message: `null value in column "${column}" of relation "${table}" violates not-null constraint` } })
            }
          }
          writes.push({ table, rows, onConflict: options.onConflict })
          return Promise.resolve({ error: null })
        },
      }
      return builder
    },
  }
}

const NOW = new Date('2026-09-20T15:20:00.000Z')
const CTX = { supabase: null, jobName: 'test', caller: 'test', kind: 'job' as const, maxCalls: 40 } as never
/** The enumeration ceiling is six types of forty pages, so a test that exercises
 * the paging needs a context whose call budget does not bind first. */
const WIDE_CTX = { supabase: null, jobName: 'test', caller: 'test', kind: 'job' as const, maxCalls: 300 } as never

/** A `rwaMap` page for one asset type. */
const mapPage = (assetType: string, ids: number[]) => ({
  data: {
    rwa_assets: ids.map((id) => ({
      rwa_id: id, slug: `asset-${id}`, symbol: `A${id}`, name: `Asset ${id}`,
      asset_type: assetType, has_tokens: true, rwa_rank: id,
    })),
  },
})

/** A request fake that answers from a list of payloads in order and records the
 * params it was asked with, so a credit ceiling and a batch size are assertable. */
function fakeRequest(answers: Record<string, unknown[]>) {
  const calls: { name: string; params: Record<string, unknown> }[] = []
  const cursor: Record<string, number> = {}
  const request = (name: string, params: Record<string, unknown> = {}) => {
    calls.push({ name, params })
    const list = answers[name] ?? []
    const index = cursor[name] ?? 0
    cursor[name] = index + 1
    const payload = list[index]
    return Promise.resolve(payload == null
      ? { payload: null, state: 'unavailable', reason: 'provider_unavailable', provenance: {}, receipt: null }
      : { payload, state: 'fresh', reason: null, provenance: { fetchedAt: '2026-09-20T15:19:00.000Z' }, receipt: null })
  }
  return { request: request as never, calls }
}

// ─── the name comparison ─────────────────────────────────────────────────────

Deno.test('normalisation folds case and punctuation but never shortens a legal form', () => {
  assert.equal(normalizeName('NVIDIA Corp.'), 'nvidiacorp')
  assert.equal(normalizeName('Nvidia corp'), 'nvidiacorp')
  // 'CORPORATION' must NOT collapse to 'CORP': that would be a fuzzy match.
  assert.notEqual(normalizeName('NVIDIA CORPORATION'), normalizeName('NVIDIA CORP'))
  assert.equal(normalizeName('   '), null)
})

Deno.test('a comparison is exact, containment or a stated difference, and never a score', () => {
  assert.equal(compareNames('NVIDIA Corp', 'Nvidia corp.').match, 'exact')
  assert.equal(compareNames('NVIDIA CORPORATION', 'Nvidia').match, 'contained')
  // The finding a curated list would hide: the provider's filer number points at
  // a company with an unrelated name.
  assert.equal(compareNames('SUNBETH GLOBAL CONCEPTS LIMITED', 'Tesla').match, 'differs')
  assert.equal(compareNames(null, 'Tesla').match, 'unknown')
  assert.equal(compareNames('Tesla, Inc.', null).match, 'unknown')
  // A two character name would be contained in almost anything, so containment
  // is not claimed on it.
  assert.equal(compareNames('Wide Registrant Name AB', 'AB').match, 'differs')
  // Both normalised strings travel with the verdict so it is reproducible.
  const compared = compareNames('NVIDIA CORP', 'Nvidia')
  assert.equal(compared.registrant, 'nvidiacorp')
  assert.equal(compared.asset, 'nvidia')
})

Deno.test('a CIK is ten digits or nothing, and an https guard drops an http logo', () => {
  assert.equal(cikDigits(1045810), '0001045810')
  assert.equal(cikDigits('CIK0001045810'), '0001045810')
  assert.equal(cikDigits('0'), null)
  assert.equal(cikDigits(''), null)
  assert.equal(cikDigits('12345678901'), null)
  assert.equal(httpsOnly('https://example.test/logo.png'), 'https://example.test/logo.png')
  assert.equal(httpsOnly('http://example.test/logo.png'), null)
})

Deno.test('the newest filing of a family is chosen by EDGAR filing date, amendments included', () => {
  const record = {
    cik: '0001045810', name: 'NVIDIA CORP', stateOfIncorporation: 'DE', formerNames: [],
    sic: '3674', sicDescription: 'Semiconductors', fiscalYearEnd: '0126', exchanges: ['Nasdaq'], tickers: ['NVDA'],
    recent: { count: 4, oldest: '2026-02-21', newest: '2026-09-02' }, olderFiles: [],
    filings: [
      { accessionNumber: '0001045810-26-000010', form: '10-Q', filingDate: '2026-08-27', primaryDocument: null },
      { accessionNumber: '0001045810-26-000002', form: '10-K', filingDate: '2026-02-21', primaryDocument: null },
      { accessionNumber: '0001045810-26-000004', form: '10-K/A', filingDate: '2026-03-04', primaryDocument: null },
      { accessionNumber: '0001045810-26-000011', form: '8-K', filingDate: '2026-09-02', primaryDocument: null },
    ],
  }
  assert.equal(latestFiling(record, ANNUAL_FORMS)?.form, '10-K/A')
  assert.equal(latestFiling(record, ANNUAL_FORMS)?.filingDate, '2026-03-04')
  assert.equal(latestFiling(record, QUARTERLY_FORMS)?.accessionNumber, '0001045810-26-000010')
  assert.equal(latestFiling(record, CURRENT_FORMS)?.filingDate, '2026-09-02')
  assert.equal(latestFiling(null, ANNUAL_FORMS), null)
  // A plain filing list answers the same question, which is what lets the lane
  // merge the recent block with the older pages it had to read.
  assert.equal(latestFiling(record.filings, QUARTERLY_FORMS)?.filingDate, '2026-08-27')
  assert.equal(latestFiling([], ANNUAL_FORMS), null)
})

// ─── the map op ──────────────────────────────────────────────────────────────

Deno.test('the map op enumerates the universe at zero credits and stores TRUE per-type counts', async () => {
  const { request, calls } = fakeRequest({
    rwaMap: [
      mapPage('stock', [1, 2, 3]),
      mapPage('commodity', [4]),
      mapPage('currency', [5]),
      mapPage('government_security', [6]),
      mapPage('etf', [7, 8]),
      mapPage('real_estate', [9]),
    ],
  })
  const db = fakeDb()
  const result = await captureRwaAssetMap(db, CTX, NOW, { request })

  assert.equal(result.credits, 0)
  // One page per type, because every page came back short of the ceiling.
  assert.equal(calls.length, 6)
  assert.equal(calls[0].params.limit, MAP_PAGE)
  assert.equal(db.conflictFor(MAP_TABLE), 'rwa_id')
  assert.equal(db.rowsFor(MAP_TABLE).length, 9)

  const counts = db.rowsFor(MAP_COUNT_TABLE)
  const stock = counts.find((r) => r.asset_type === 'stock')!
  assert.equal(stock.asset_count, 3)
  assert.equal(stock.with_tokens_count, 3)
  // The 'all' row is derived from the pages already fetched, never a seventh call.
  const all = counts.find((r) => r.asset_type === 'all')!
  assert.equal(all.asset_count, 9)
  assert.equal(db.conflictFor(MAP_COUNT_TABLE), 'asset_type,snapshot_date')
})

Deno.test('a duplicate id across pages cannot double a count', async () => {
  // Two full pages for one type, the second repeating an id from the first, then
  // short pages for the rest.
  const first = mapPage('stock', Array.from({ length: MAP_PAGE }, (_, i) => i + 1))
  const second = mapPage('stock', [1, 9001])
  const { request } = fakeRequest({ rwaMap: [first, second, mapPage('commodity', []), mapPage('currency', []), mapPage('government_security', []), mapPage('etf', []), mapPage('real_estate', [])] })
  const db = fakeDb()
  await captureRwaAssetMap(db, CTX, NOW, { request })
  const stock = db.rowsFor(MAP_COUNT_TABLE).find((r) => r.asset_type === 'stock')!
  assert.equal(stock.asset_count, MAP_PAGE + 1)
})

Deno.test('an unavailable provider is an error with a reason, never an empty universe', async () => {
  const { request } = fakeRequest({ rwaMap: [] })
  const db = fakeDb()
  const result = await captureRwaAssetMap(db, CTX, NOW, { request })
  assert.equal(result.error, 'provider_unavailable')
  assert.equal(db.rowsFor(MAP_TABLE).length, 0)
  assert.equal(db.rowsFor(MAP_COUNT_TABLE).length, 0)
})

Deno.test('a disabled policy row stops each op with a named skip', async () => {
  const policy = [
    { provider: 'coinmarketcap', feature: 'rwa_asset_map', enabled: false },
    { provider: 'coinmarketcap', feature: 'rwa_asset_profiles', enabled: false },
    { provider: 'primary-sources', feature: 'rwa_underlying_registrants', enabled: false },
  ]
  const { request } = fakeRequest({})
  assert.equal((await captureRwaAssetMap(fakeDb(), CTX, NOW, { request, policy })).skipped, 'policy_disabled')
  assert.equal((await captureRwaAssetProfiles(fakeDb(), CTX, NOW, { request, policy })).skipped, 'policy_disabled')
  assert.equal((await captureRwaUnderlyingRegistrants(fakeDb(), NOW, { request, policy })).skipped, 'policy_disabled')
  // The EDGAR op answers to 'primary-sources', so a CoinMarketCap row of the same
  // feature name must not be what disables it.
  assert.equal(underlyingPolicy(policy, 'rwa_underlying_registrants', 'coinmarketcap').enabled, true)
})

// ─── the profile op ──────────────────────────────────────────────────────────

const profilePayload = (rows: Record<string, unknown>[]) => ({ data: { rwa_assets: rows } })

Deno.test('the profile op stores the provider assertion with the field it came from', async () => {
  const { request, calls } = fakeRequest({
    rwaInfo: [profilePayload([{
      rwa_id: 11, slug: 'nvidia', symbol: 'NVDAX', name: 'Nvidia', asset_type: 'stock',
      cik: 1045810, industry: 'Semiconductors', founded: '1993', employees: 36000,
      primary_exchange: 'NASDAQ', rwa_rank: 4, has_tokens: true,
      website: 'https://www.nvidia.com',
      about: { logo: 'https://cdn.example.test/nvda.png', website: 'https://www.nvidia.com', date_added: '2025-07-17T06:57:15.000Z', description: 'A company.' },
    }])],
  })
  const db = fakeDb({ [MAP_TABLE]: [{ rwa_id: 11, profiled_at: null }] })
  const result = await captureRwaAssetProfiles(db, CTX, NOW, { request })

  assert.equal(result.credits, 1)
  assert.equal(calls[0].params.rwa_id, '11')
  const row = db.rowsFor(PROFILE_TABLE)[0]
  assert.equal(row.cik, '0001045810')
  // The assertion is attributed: provider, capability and the exact field.
  assert.equal(row.provider, 'coinmarketcap')
  assert.equal(row.provider_capability, 'rwaInfo')
  assert.equal(row.cik_field, 'cik')
  assert.equal(row.logo_url, 'https://cdn.example.test/nvda.png')
  assert.equal(row.employees, 36000)
  // And it says in words whose filer number it is.
  assert.match(String(row.scope), /UNDERLYING LISTED COMPANY/)
  assert.match(String(row.scope), /not of the firm that issued the token/)
  // The queue cursor advances so the next run moves on, and it advances through
  // an UPDATE of rows that already exist rather than through an upsert that would
  // have to invent every other column of them.
  const stamp = db.updates.find((u) => u.table === MAP_TABLE)!
  assert.deepEqual(stamp.patch, { profiled_at: NOW.toISOString() })
  assert.equal(stamp.column, 'rwa_id')
  assert.equal(db.seededRow(MAP_TABLE, 11).profiled_at, NOW.toISOString())
})

Deno.test('the profile op is bounded by its stated credit ceiling and batches ids', async () => {
  const ids = Array.from({ length: INFO_CALLS_PER_RUN * PROFILE_BATCH + 500 }, (_, i) => i + 1)
  const { request, calls } = fakeRequest({
    rwaInfo: Array.from({ length: INFO_CALLS_PER_RUN + 4 }, () => profilePayload([])),
  })
  const db = fakeDb({ [MAP_TABLE]: ids.map((rwa_id) => ({ rwa_id, profiled_at: null })) })
  const result = await captureRwaAssetProfiles(db, CTX, NOW, { request })
  // The queue read is capped at the ceiling, so however long the universe is the
  // run spends exactly the credits the policy row states.
  assert.equal(calls.length, INFO_CALLS_PER_RUN)
  assert.equal(result.credits, INFO_CALLS_PER_RUN)
  assert.equal(String(calls[0].params.rwa_id).split(',').length, PROFILE_BATCH)
})

Deno.test('an asset the provider will not describe still advances the queue, so the lane cannot stall', async () => {
  const { request } = fakeRequest({ rwaInfo: [profilePayload([])] })
  const db = fakeDb({ [MAP_TABLE]: [{ rwa_id: 77, profiled_at: null }] })
  await captureRwaAssetProfiles(db, CTX, NOW, { request })
  assert.equal(db.rowsFor(PROFILE_TABLE).length, 0)
  assert.deepEqual(db.updates.find((u) => u.table === MAP_TABLE)!.values, [77])
  assert.equal(db.seededRow(MAP_TABLE, 77).profiled_at, NOW.toISOString())
})

Deno.test('the queue asks about an asset whose has_tokens the map never learned, so the lane cannot stall', async () => {
  const { request } = fakeRequest({ rwaInfo: [profilePayload([{ rwa_id: 77, name: 'Mystery', asset_type: 'stock', has_tokens: false }])] })
  const db = fakeDb({ [MAP_TABLE]: [{ rwa_id: 77, profiled_at: null }] })
  await captureRwaAssetProfiles(db, CTX, NOW, { request })
  // IS NOT FALSE, never IS TRUE. An `eq('has_tokens', true)` queue would be empty
  // for ever whenever rwaMap omits the field, while the lane looked healthy.
  const filter = db.filters.find((f) => f.table === MAP_TABLE)!
  assert.equal(filter.op, 'not')
  assert.deepEqual(filter.args, ['has_tokens', 'is', false])
  // And rwaInfo's own answer is what gets stored, so the map's unknown is settled.
  assert.equal(db.rowsFor(PROFILE_TABLE)[0].has_tokens, false)
})

Deno.test('an unenumerated universe is a named skip, not an error', async () => {
  const { request } = fakeRequest({})
  const result = await captureRwaAssetProfiles(fakeDb({ [MAP_TABLE]: [] }), CTX, NOW, { request })
  assert.equal(result.skipped, 'no_mapped_assets')
  assert.equal(result.credits, 0)
})

// ─── the EDGAR op ────────────────────────────────────────────────────────────

const submissions = (over: Record<string, unknown> = {}) => ({
  cik: '1045810', name: 'NVIDIA CORP', sic: '3674', sicDescription: 'Semiconductors and Related Devices',
  stateOfIncorporation: 'DE', fiscalYearEnd: '0126', exchanges: ['Nasdaq'], tickers: ['NVDA'], formerNames: [],
  filings: {
    recent: {
      accessionNumber: ['0001045810-26-000011', '0001045810-26-000010', '0001045810-26-000002'],
      form: ['8-K', '10-Q', '10-K'],
      filingDate: ['2026-09-02', '2026-08-27', '2026-02-21'],
      primaryDocument: ['x.htm', 'y.htm', 'z.htm'],
    },
  },
  ...over,
})

const edgarUrl = (cik: string) => `https://data.sec.gov/submissions/CIK${cik}.json`
const laneDeps = (impl: unknown) => ({ request: (() => Promise.resolve(null)) as never, sources: sourceDeps(impl, { userAgent: EDGAR_AGENT }) })

Deno.test('the EDGAR op stores what we read, keeps the clocks apart and reports zero credits', async () => {
  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({ [edgarUrl('0001045810')]: { body: submissions() } })
  const db = fakeDb({ [PROFILE_TABLE]: [{ rwa_id: 11, cik: '0001045810', name: 'Nvidia', symbol: 'NVDAX', registrant_checked_at: null }] })
  const result = await captureRwaUnderlyingRegistrants(db, NOW, laneDeps(impl))

  assert.equal(result.credits, 0)
  assert.equal(result.ciks, 1)
  const row = db.rowsFor(REGISTRANT_TABLE)[0]
  assert.equal(row.state, 'known')
  assert.equal(row.registrant_name, 'NVIDIA CORP')
  assert.equal(row.sic, '3674')
  assert.equal(row.state_of_incorporation, 'DE')
  assert.equal(row.fiscal_year_end, '0126')
  // The annual report is found even though it is not the newest filing overall.
  assert.equal(row.latest_annual_form, '10-K')
  assert.equal(row.latest_annual_date, '2026-02-21')
  assert.equal(row.latest_annual_accession, '0001045810-26-000002')
  assert.equal(row.latest_quarterly_date, '2026-08-27')
  assert.equal(row.latest_current_form, '8-K')
  // EDGAR's dates and our clocks are separate columns and never merged.
  assert.equal(row.checked_at, NOW.toISOString())
  assert.notEqual(row.fetched_at, row.latest_annual_date)
  assert.equal(row.name_match, 'contained')
  assert.equal(row.registrant_name_normalized, 'nvidiacorp')
  assert.equal(row.asset_name_normalized, 'nvidia')
  assert.match(String(row.source_url), /^https:\/\/www\.sec\.gov\//)
  assert.equal(db.conflictFor(REGISTRANT_TABLE), 'rwa_id')
  // The cursor advances on the profile row, through an UPDATE. The fake refuses
  // an upsert that omits the table's NOT NULL columns, exactly as Postgres does,
  // so an upsert here would leave this assertion failing.
  const cursor = db.updates.find((u) => u.table === PROFILE_TABLE)!
  assert.deepEqual(cursor.patch, { registrant_checked_at: NOW.toISOString() })
  assert.deepEqual(cursor.values, [11])
  assert.equal(db.seededRow(PROFILE_TABLE, 11).registrant_checked_at, NOW.toISOString())
  assert.equal(result.partial, undefined, 'the stamp does not fail the statement')
  // The span of what was read travels with the row, so an absent report can be
  // told apart from a filer that did not file one.
  assert.equal(row.recent_filings_count, 3)
  assert.equal(row.recent_oldest_date, '2026-02-21')
  assert.equal(row.recent_newest_date, '2026-09-02')
  assert.equal(row.older_pages_read, 0)
})

Deno.test('a mismatch is stored as a finding rather than dropped', async () => {
  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({ [edgarUrl('0001045810')]: { body: submissions({ name: 'SUNBETH GLOBAL CONCEPTS LIMITED' }) } })
  const db = fakeDb({ [PROFILE_TABLE]: [{ rwa_id: 11, cik: '0001045810', name: 'Nvidia', symbol: 'NVDAX', registrant_checked_at: null }] })
  await captureRwaUnderlyingRegistrants(db, NOW, laneDeps(impl))
  const row = db.rowsFor(REGISTRANT_TABLE)[0]
  assert.equal(row.name_match, 'differs')
  assert.equal(row.registrant_name, 'SUNBETH GLOBAL CONCEPTS LIMITED')
  // Nothing about the row is suppressed because the names disagree.
  assert.equal(row.state, 'known')
  assert.equal(row.latest_annual_date, '2026-02-21')
})

Deno.test('a filer EDGAR does not know is not_found, which is not the same as a failed read', async () => {
  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({ [edgarUrl('0009999999')]: { status: 404, body: { error: 'not found' } } })
  const db = fakeDb({ [PROFILE_TABLE]: [{ rwa_id: 12, cik: '0009999999', name: 'Ghost Co', symbol: 'GHOST', registrant_checked_at: null }] })
  const result = await captureRwaUnderlyingRegistrants(db, NOW, laneDeps(impl))
  const row = db.rowsFor(REGISTRANT_TABLE)[0]
  assert.equal(row.state, 'not_found')
  assert.equal(row.registrant_name, null)
  assert.equal(row.name_match, 'unknown')
  // A 404 is a finding about the provider's number, so the op does not fail.
  assert.equal(result.error, undefined)
})

Deno.test('one EDGAR read serves every asset sharing a filer number', async () => {
  __resetRwaSourceStateForTests()
  const fake = fakeFetch({ [edgarUrl('0001045810')]: { body: submissions() } })
  const db = fakeDb({
    [PROFILE_TABLE]: [
      { rwa_id: 11, cik: '0001045810', name: 'Nvidia', symbol: 'NVDAX', registrant_checked_at: null },
      { rwa_id: 12, cik: '0001045810', name: 'NVIDIA CORP', symbol: 'NVDA.T', registrant_checked_at: null },
    ],
  })
  const result = await captureRwaUnderlyingRegistrants(db, NOW, laneDeps(fake.impl))
  assert.equal(result.ciks, 1)
  assert.equal(fake.calls.length, 1)
  const rows = db.rowsFor(REGISTRANT_TABLE)
  assert.equal(rows.length, 2)
  // Each asset keeps its OWN comparison against the one registrant name.
  assert.equal(rows.find((r) => r.rwa_id === 11)!.name_match, 'contained')
  assert.equal(rows.find((r) => r.rwa_id === 12)!.name_match, 'exact')
})

Deno.test('no asserted CIK is a named skip, and a failed queue read is a reason', async () => {
  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({})
  assert.equal((await captureRwaUnderlyingRegistrants(fakeDb({ [PROFILE_TABLE]: [] }), NOW, laneDeps(impl))).skipped, 'no_asserted_ciks')
  const failed = await captureRwaUnderlyingRegistrants(fakeDb({}, { [PROFILE_TABLE]: 'permission denied' }), NOW, laneDeps(impl))
  assert.equal(failed.error, 'permission denied')
})

Deno.test('the schedule this lane reports matches the cron jobs the migration schedules', async () => {
  const sql = await Deno.readTextFile(new URL('../../../migrations/20260920152000_intel_rwa_underlying_registrants.sql', import.meta.url))
  for (const entry of Object.values(RWA_UNDERLYING_CAPTURE_SCHEDULE)) {
    assert.ok(sql.includes(`cron.schedule('${entry.job}', '${entry.cron}'`), `migration is missing ${entry.job} at ${entry.cron}`)
    const [minute, hour] = entry.cron.split(' ')
    assert.equal(entry.utc, `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`)
  }
  // Three ops, three jobs, and the tables the lane names are the tables created.
  for (const table of [MAP_TABLE, MAP_COUNT_TABLE, PROFILE_TABLE, REGISTRANT_TABLE]) {
    assert.ok(sql.includes(`public.${table}`), `migration is missing ${table}`)
  }
})

// ─── the enumeration stops where the universe stops, or says it did not ──────

Deno.test('the map op pages past 1,000 rows a type and does not stop at four pages', async () => {
  // PRODUCTION, 2026-09-20: four pages of 250 stored "stock 1000" while the
  // provider's own total_size reported 4,812. Six full pages here would have been
  // capped at four before this change, and the count would have read 1000.
  const full = (n: number) => mapPage('stock', Array.from({ length: MAP_PAGE }, (_, i) => n * MAP_PAGE + i + 1))
  const { request, calls } = fakeRequest({
    rwaMap: [full(0), full(1), full(2), full(3), full(4), mapPage('stock', [9001]),
      mapPage('commodity', []), mapPage('currency', []), mapPage('government_security', []), mapPage('etf', []), mapPage('real_estate', [])],
  })
  const db = fakeDb()
  const result = await captureRwaAssetMap(db, WIDE_CTX, NOW, { request })
  assert.equal(calls.filter((c) => c.params.asset_type === 'stock').length, 6)
  const stock = db.rowsFor(MAP_COUNT_TABLE).find((r) => r.asset_type === 'stock')!
  assert.equal(stock.asset_count, MAP_PAGE * 5 + 1)
  // A type that ran out of assets is NOT truncated, and says so.
  assert.equal(stock.truncated, false)
  assert.equal(stock.pages_read, 6)
  assert.equal(result.truncatedTypes, undefined)
  assert.equal(result.pageCeiling, MAP_PAGES_PER_TYPE)
})

Deno.test('a type that reaches the page ceiling records a FLOOR, never a total', async () => {
  // Every page full, right up to the ceiling: the provider has more and we
  // stopped. The count is then "at least N", and the row must say so.
  const pages = Array.from({ length: MAP_PAGES_PER_TYPE }, (_, page) =>
    mapPage('stock', Array.from({ length: MAP_PAGE }, (_, i) => page * MAP_PAGE + i + 1)))
  const { request, calls } = fakeRequest({
    rwaMap: [...pages, mapPage('commodity', [1000001]), mapPage('currency', []), mapPage('government_security', []), mapPage('etf', []), mapPage('real_estate', [])],
  })
  const db = fakeDb()
  const result = await captureRwaAssetMap(db, WIDE_CTX, NOW, { request })
  // The safety ceiling holds: a runaway type cannot page for ever.
  assert.equal(calls.filter((c) => c.params.asset_type === 'stock').length, MAP_PAGES_PER_TYPE)
  const counts = db.rowsFor(MAP_COUNT_TABLE)
  const stock = counts.find((r) => r.asset_type === 'stock')!
  assert.equal(stock.truncated, true)
  assert.equal(stock.asset_count, MAP_PAGE * MAP_PAGES_PER_TYPE)
  // A type that finished is not tainted by one that did not.
  assert.equal(counts.find((r) => r.asset_type === 'commodity')!.truncated, false)
  // The 'all' row sums a floor and is therefore a floor too.
  assert.equal(counts.find((r) => r.asset_type === 'all')!.truncated, true)
  assert.deepEqual(result.truncatedTypes, ['stock'])
})

// ─── the resume cursors, which an upsert cannot write ────────────────────────

Deno.test('a cursor is advanced by UPDATE, because an upsert of two columns fails the NOT NULL check', async () => {
  // The production failure of 2026-09-20 15:57 UTC, reproduced: the fake refuses
  // an INSERT ... ON CONFLICT whose would-be row lacks captured_at, exactly as
  // Postgres does, because the NOT NULL columns are evaluated before the conflict
  // clause is ever reached. 25 registrant rows were written and not one filer was
  // stamped, so the same 25 would have been re-read every day for ever.
  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({ [edgarUrl('0001045810')]: { body: submissions() } })
  const db = fakeDb({ [PROFILE_TABLE]: [{ rwa_id: 11, cik: '0001045810', name: 'Nvidia', symbol: 'NVDAX', registrant_checked_at: null }] })
  const result = await captureRwaUnderlyingRegistrants(db, NOW, laneDeps(impl))
  assert.equal(result.partial, undefined)
  assert.equal(db.updates.filter((u) => u.table === PROFILE_TABLE).length, 1)
  assert.equal(db.writes.filter((w) => w.table === PROFILE_TABLE).length, 0, 'the cursor is never written through an upsert')
  assert.equal(db.seededRow(PROFILE_TABLE, 11).registrant_checked_at, NOW.toISOString())
})

Deno.test('a cursor that cannot be written is a stated reason, and the capture is still kept', async () => {
  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({ [edgarUrl('0001045810')]: { body: submissions() } })
  // The queue read succeeds and only the cursor write fails, which is the shape
  // of a permission or constraint problem on that one column.
  const db = fakeDb({ [PROFILE_TABLE]: [{ rwa_id: 11, cik: '0001045810', name: 'Nvidia', symbol: 'NVDAX', registrant_checked_at: null }] })
  const guarded = {
    ...db,
    from(table: string) {
      const builder = db.from(table)
      if (table !== PROFILE_TABLE) return builder
      return { ...builder, update: () => ({ in: () => Promise.resolve({ error: { message: 'permission denied for column' } }) }) }
    },
  }
  const result = await captureRwaUnderlyingRegistrants(guarded as never, NOW, laneDeps(impl))
  assert.match(String(result.partial), /queue:permission denied/)
  assert.equal(db.rowsFor(REGISTRANT_TABLE).length, 1, 'the registrant row is still written')
})

// ─── a recent block too short to hold a 10-K is not a finding about the filer ─

/** A filer whose `recent` block is all prospectus supplements: what EDGAR
 * actually returns for a large bank. No 10-K, no 10-Q, and a block that starts
 * weeks rather than years ago. */
const bankSubmissions = (over: Record<string, unknown> = {}) => ({
  cik: '0000019617', name: 'JPMORGAN CHASE & CO', sic: '6021', sicDescription: 'National Commercial Banks',
  stateOfIncorporation: 'DE', fiscalYearEnd: '1231', exchanges: ['NYSE'], tickers: ['JPM'], formerNames: [],
  filings: {
    recent: {
      accessionNumber: ['0000019617-26-000900', '0000019617-26-000899'],
      form: ['424B2', '424B2'],
      filingDate: ['2026-09-18', '2026-08-01'],
      primaryDocument: ['a.htm', 'b.htm'],
    },
    files: [
      { name: 'CIK0000019617-submissions-001.json', filingCount: 1000, filingFrom: '2025-01-02', filingTo: '2026-07-31' },
      { name: 'CIK0000019617-submissions-002.json', filingCount: 1000, filingFrom: '2023-01-03', filingTo: '2025-01-01' },
      { name: '../../../etc/passwd', filingCount: 1, filingFrom: null, filingTo: '2099-01-01' },
    ],
  },
  ...over,
})

const pageUrl = (name: string) => `https://data.sec.gov/submissions/${name}`
const olderPage = {
  accessionNumber: ['0000019617-26-000150', '0000019617-26-000040'],
  form: ['10-Q', '10-K'],
  filingDate: ['2026-05-02', '2026-02-14'],
  primaryDocument: ['q.htm', 'k.htm'],
}

Deno.test('a filer whose 10-K fell out of the recent block is read from the older page, not reported as absent', async () => {
  __resetRwaSourceStateForTests()
  const fake = fakeFetch({
    [edgarUrl('0000019617')]: { body: bankSubmissions() },
    [pageUrl('CIK0000019617-submissions-001.json')]: { body: olderPage },
  })
  const db = fakeDb({ [PROFILE_TABLE]: [{ rwa_id: 21, cik: '0000019617', name: 'JPMorgan Chase & Co', symbol: 'JPMX', registrant_checked_at: null }] })
  const result = await captureRwaUnderlyingRegistrants(db, NOW, laneDeps(fake.impl))
  const row = db.rowsFor(REGISTRANT_TABLE)[0]
  assert.equal(row.latest_annual_form, '10-K')
  assert.equal(row.latest_annual_date, '2026-02-14')
  assert.equal(row.latest_quarterly_date, '2026-05-02')
  assert.equal(row.older_pages_read, 1, 'it stopped as soon as both forms were in hand')
  // The span of the recent block is stored whatever the outcome.
  assert.equal(row.recent_filings_count, 2)
  assert.equal(row.recent_oldest_date, '2026-08-01')
  assert.equal(row.recent_newest_date, '2026-09-18')
  assert.equal(result.olderPages, 1)
  assert.equal(result.ciks, 1)
  assert.equal(result.requests, 2)
  // A name EDGAR did not publish in the documented shape is never turned into a
  // path: the traversal entry in `files` is dropped rather than requested.
  assert.ok(!fake.calls.some((call: { url: string }) => String(call.url).includes('passwd')))
})

Deno.test('an older page is never read for a filer whose recent block already answered', async () => {
  __resetRwaSourceStateForTests()
  const base = submissions()
  const fake = fakeFetch({
    [edgarUrl('0001045810')]: {
      body: submissions({
        filings: { recent: base.filings.recent, files: [{ name: 'CIK0001045810-submissions-001.json', filingCount: 10, filingFrom: '2020-01-01', filingTo: '2024-01-01' }] },
      }),
    },
  })
  const db = fakeDb({ [PROFILE_TABLE]: [{ rwa_id: 11, cik: '0001045810', name: 'Nvidia', symbol: 'NVDAX', registrant_checked_at: null }] })
  const result = await captureRwaUnderlyingRegistrants(db, NOW, laneDeps(fake.impl))
  assert.equal(fake.calls.length, 1, 'one request, because the recent block held both reports')
  assert.equal(result.olderPages, 0)
  assert.equal(db.rowsFor(REGISTRANT_TABLE)[0].older_pages_read, 0)
})

Deno.test('the older-page budget is bounded, and a filer we still cannot answer for is left honest', async () => {
  __resetRwaSourceStateForTests()
  // Three older pages offered and none of them carries a periodic report.
  const empty = { accessionNumber: ['0000019617-26-000001'], form: ['424B2'], filingDate: ['2026-07-01'], primaryDocument: ['x.htm'] }
  const fake = fakeFetch({
    [edgarUrl('0000019617')]: { body: bankSubmissions() },
    [pageUrl('CIK0000019617-submissions-001.json')]: { body: empty },
    [pageUrl('CIK0000019617-submissions-002.json')]: { body: empty },
  })
  const db = fakeDb({ [PROFILE_TABLE]: [{ rwa_id: 21, cik: '0000019617', name: 'JPMorgan Chase & Co', symbol: 'JPMX', registrant_checked_at: null }] })
  const result = await captureRwaUnderlyingRegistrants(db, NOW, laneDeps(fake.impl))
  assert.equal(result.olderPages, OLDER_PAGES_PER_FILER, 'at most two, however many pages are offered')
  const row = db.rowsFor(REGISTRANT_TABLE)[0]
  assert.equal(row.latest_annual_date, null)
  // Still stored, still stamped, and the span says how far we looked, so the read
  // view can say "not in the filings read" instead of alleging lateness.
  assert.equal(row.recent_oldest_date, '2026-08-01')
  assert.equal(db.seededRow(PROFILE_TABLE, 21).registrant_checked_at, NOW.toISOString())
})

Deno.test('needsOlderFilings asks only when the block is too short to have held the form', () => {
  const base = bankSubmissions()
  const short = normalizeSubmissions(base, { forms: PERIODIC_FORMS, limit: 200 })!
  // Nothing found and the block starts weeks ago: worth one more request.
  assert.equal(needsOlderFilings(short, short.filings, NOW.getTime()), true)
  // The same block with both reports already in hand: no request at all.
  assert.equal(needsOlderFilings(short, [
    { accessionNumber: 'a', form: '10-K', filingDate: '2026-02-14', primaryDocument: null },
    { accessionNumber: 'b', form: '10-Q', filingDate: '2026-05-02', primaryDocument: null },
  ], NOW.getTime()), false)
  // A block that DOES reach back years and still shows no annual report is a real
  // finding about the filer, and buying more pages would not change it.
  const deep = normalizeSubmissions({ ...base, filings: { ...base.filings, recent: { ...base.filings.recent, filingDate: ['2026-09-18', '2019-01-04'] } } }, { forms: PERIODIC_FORMS, limit: 200 })!
  assert.equal(needsOlderFilings(deep, deep.filings, NOW.getTime()), false)
  // A filer EDGAR offers no older pages for cannot be asked again.
  const none = normalizeSubmissions({ ...base, filings: { recent: base.filings.recent } }, { forms: PERIODIC_FORMS, limit: 200 })!
  assert.equal(needsOlderFilings(none, none.filings, NOW.getTime()), false)
})
