import { strict as assert } from 'node:assert'
import {
  CONCENTRATION_TABLE, ENTITY_TABLE, FILING_TABLE, PROXY_UNRESOLVED_SCOPE, RESTRICTION_TABLE, SIGNAL_TABLE,
  captureRwaIssuerRegistry, captureRwaTokenConcentration, lanePolicy, tokenSubject,
} from './capture-rwa-issuer.ts'
import { ALIAS_ASSERTIONS } from './rwa-issuer-aliases.ts'
import { __resetRwaSourceStateForTests } from './rwa-sources/http.ts'
import { deps as sourceDeps, fakeFetch, EDGAR_AGENT } from './rwa-sources/test-support.ts'

// The WRITE PATH. These tests exercise what actually puts rows in tables, which
// is otherwise the least verified part of the lane.

interface Written { table: string; rows: Record<string, unknown>[]; onConflict: string }

/** A PostgREST-shaped fake that records every upsert and can be made to fail. */
function fakeDb(failing: Record<string, string> = {}) {
  const writes: Written[] = []
  return {
    writes,
    rowsFor(table: string) { return writes.filter((w) => w.table === table).flatMap((w) => w.rows) },
    conflictFor(table: string) { return writes.find((w) => w.table === table)?.onConflict ?? null },
    from(table: string) {
      return {
        upsert(rows: Record<string, unknown>[], options: { onConflict: string }) {
          if (failing[table]) return Promise.resolve({ error: { message: failing[table] } })
          writes.push({ table, rows, onConflict: options.onConflict })
          return Promise.resolve({ error: null })
        },
      }
    },
  }
}

const USTB = ALIAS_ASSERTIONS.find((a) => a.subjectLabel === 'USTB')!
const ADDRESS = tokenSubject(USTB)!.address
const TOKEN = `https://eth.blockscout.com/api/v2/tokens/${ADDRESS}`
const ADDR = `https://eth.blockscout.com/api/v2/addresses/${ADDRESS}`
const IMPL = '0xb3ac55dd09aa70e9bfbb12f45cd38a1f1597588c'
const sourcify = (address: string) => `https://sourcify.dev/server/v2/contract/1/${address}?fields=abi`

const tokenBody = { holders_count: '78', total_supply: '47680474964580', decimals: '6', symbol: 'USTB', name: 'Invesco Short Duration US Government Securities Fund' }
const holdersBody = { items: [{ address: { hash: '0x' + 'a'.repeat(40) }, value: '4768047496458' }] }
const restrictedAbi = { abi: ['kycRegistry', 'setKYCRegistry', 'KYC_CONFIGURER_ROLE', 'pause', 'unpause'].map((name) => ({ type: 'function', name })) }

const laneDeps = (impl: unknown) => ({ request: (() => Promise.resolve(null)) as never, sources: sourceDeps(impl, { userAgent: EDGAR_AGENT }) })
const NOW = new Date('2026-09-16T14:37:00.000Z')

Deno.test('a capture writes on its hour key so a second run in the same hour lands on the same row', async () => {
  __resetRwaSourceStateForTests()
  const routes = {
    [ADDR]: { body: { proxy_type: 'eip1967', implementations: [{ address_hash: IMPL, name: 'FundToken' }] } },
    [TOKEN + '/holders']: { body: holdersBody },
    [TOKEN]: { body: tokenBody },
    [sourcify(IMPL)]: { body: restrictedAbi },
  }
  const first = fakeDb()
  const a = await captureRwaTokenConcentration(first, NOW, laneDeps(fakeFetch(routes).impl), { subjects: [USTB] })
  __resetRwaSourceStateForTests()
  const second = fakeDb()
  // Twenty three minutes later, still the same hour.
  const b = await captureRwaTokenConcentration(second, new Date('2026-09-16T14:59:59.000Z'), laneDeps(fakeFetch(routes).impl), { subjects: [USTB] })

  assert.equal(a.capturedAt, '2026-09-16T14:00:00.000Z')
  assert.equal(b.capturedAt, a.capturedAt)
  // Same primary key and an upsert, so a retried run rewrites one row rather
  // than inventing a second measurement of an unchanged board.
  assert.equal(first.conflictFor(CONCENTRATION_TABLE), 'chain,contract_address,captured_at')
  assert.equal(first.rowsFor(CONCENTRATION_TABLE)[0].captured_at, second.rowsFor(CONCENTRATION_TABLE)[0].captured_at)
})

Deno.test('a failed explorer read writes no concentration row rather than a row that reads as complete', async () => {
  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({
    [ADDR]: { body: { proxy_type: null, implementations: [] } },
    [TOKEN + '/holders']: { status: 500, body: {} },
    [TOKEN]: { body: tokenBody },
    [sourcify(ADDRESS)]: { body: restrictedAbi },
  })
  const db = fakeDb()
  const result = await captureRwaTokenConcentration(db, NOW, laneDeps(impl), { subjects: [USTB] })
  // No partial row of zeros: an unknown distribution is absent, not flat.
  assert.equal(db.rowsFor(CONCENTRATION_TABLE).length, 0)
  // And the lane says why rather than reporting a clean run.
  assert.match(String(result.partial), /blockscout:http_500/)
  assert.equal(result.error, undefined)
})

Deno.test('the explorer export_allowed false survives the write', async () => {
  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({
    [ADDR]: { body: { proxy_type: null, implementations: [] } },
    [TOKEN + '/holders']: { body: holdersBody },
    [TOKEN]: { body: tokenBody },
    [sourcify(ADDRESS)]: { body: restrictedAbi },
  })
  const db = fakeDb()
  await captureRwaTokenConcentration(db, NOW, laneDeps(impl), { subjects: [USTB] })
  const row = db.rowsFor(CONCENTRATION_TABLE)[0]
  // Redistribution terms could not be verified, so the figure never becomes
  // exportable on its way into the table.
  assert.equal(row.export_allowed, false)
  assert.equal(row.top1_share, 10)
  assert.match(String(row.scope), /redistribution terms could not be verified/)
})

Deno.test('a proxy whose implementation resolves is read at the implementation and records it', async () => {
  __resetRwaSourceStateForTests()
  const { impl, calls } = fakeFetch({
    [ADDR]: { body: { proxy_type: 'eip1967', implementations: [{ address_hash: IMPL, name: 'FundToken' }] } },
    [TOKEN + '/holders']: { body: holdersBody },
    [TOKEN]: { body: tokenBody },
    [sourcify(IMPL)]: { body: restrictedAbi },
  })
  const db = fakeDb()
  await captureRwaTokenConcentration(db, NOW, laneDeps(impl), { subjects: [USTB] })
  const row = db.rowsFor(RESTRICTION_TABLE)[0]
  assert.equal(row.state, 'restricted')
  assert.equal(row.kyc_gated, true)
  assert.equal(row.pausable, true)
  // The contract whose source was actually read is recorded, so the claim is
  // checkable against the right contract.
  assert.equal(row.implementation_address, IMPL)
  // Sourcify was asked about the implementation, never the proxy.
  assert.ok(calls.some((c) => c.url === sourcify(IMPL)))
  assert.equal(calls.some((c) => c.url === sourcify(ADDRESS)), false)
})

Deno.test('a proxy whose implementation cannot be resolved claims nothing and is never called unrestricted', async () => {
  __resetRwaSourceStateForTests()
  const { impl, calls } = fakeFetch({
    // A declared proxy with no readable implementation.
    [ADDR]: { body: { proxy_type: 'eip1967', implementations: [] } },
    [TOKEN + '/holders']: { body: holdersBody },
    [TOKEN]: { body: tokenBody },
  })
  const db = fakeDb()
  await captureRwaTokenConcentration(db, NOW, laneDeps(impl), { subjects: [USTB] })
  const row = db.rowsFor(RESTRICTION_TABLE)[0]
  // The whole point: this must NOT be no_restriction_found.
  assert.equal(row.state, 'proxy_unresolved')
  assert.notEqual(row.state, 'no_restriction_found')
  assert.equal(row.kyc_gated, false)
  assert.equal(row.pausable, false)
  assert.equal(row.freezable, false)
  assert.equal(row.implementation_address, null)
  assert.equal(row.matched_members, null)
  assert.equal(row.scope, PROXY_UNRESOLVED_SCOPE)
  assert.match(String(row.scope), /not evidence that transfers are unrestricted/)
  // No source is read at all, because reading the proxy would invite exactly
  // the false negative this branch exists to prevent.
  assert.equal(calls.some((c) => c.url.includes('sourcify')), false)
})

Deno.test('a token that is not a proxy is read at its own address', async () => {
  __resetRwaSourceStateForTests()
  const { impl, calls } = fakeFetch({
    [ADDR]: { body: { proxy_type: null, implementations: [] } },
    [TOKEN + '/holders']: { body: holdersBody },
    [TOKEN]: { body: tokenBody },
    [sourcify(ADDRESS)]: { body: restrictedAbi },
  })
  const db = fakeDb()
  await captureRwaTokenConcentration(db, NOW, laneDeps(impl), { subjects: [USTB] })
  assert.equal(db.rowsFor(RESTRICTION_TABLE)[0].implementation_address, null)
  assert.ok(calls.some((c) => c.url === sourcify(ADDRESS)))
})

Deno.test('a write failure stops the lane with the error rather than reporting a clean run', async () => {
  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({
    [ADDR]: { body: { proxy_type: null, implementations: [] } },
    [TOKEN + '/holders']: { body: holdersBody },
    [TOKEN]: { body: tokenBody },
    [sourcify(ADDRESS)]: { body: restrictedAbi },
  })
  const db = fakeDb({ [CONCENTRATION_TABLE]: 'permission denied' })
  const result = await captureRwaTokenConcentration(db, NOW, laneDeps(impl), { subjects: [USTB] })
  assert.match(String(result.error), /permission denied/)
  assert.equal(result.rows, 0)
})

Deno.test('a disabled policy skips the lane and writes nothing at all', async () => {
  const db = fakeDb()
  const disabled = [{ provider: 'primary-sources', feature: 'rwa_token_concentration', enabled: false }]
  const result = await captureRwaTokenConcentration(db, NOW, { request: (() => Promise.resolve(null)) as never, policy: disabled }, { subjects: [USTB] })
  assert.equal(result.skipped, 'policy_disabled')
  assert.equal(db.writes.length, 0)
  // A missing row means enabled: these lanes have no cron to run away with.
  assert.equal(lanePolicy([], 'rwa_token_concentration').enabled, true)
  assert.equal(lanePolicy(disabled, 'rwa_token_concentration').enabled, false)
})

Deno.test('every risk signal the registry lane writes carries a scope the schema will accept', async () => {
  __resetRwaSourceStateForTests()
  const cik = USTB.entity.cik!
  const { impl } = fakeFetch({
    'https://www.treasury.gov/ofac/downloads/sdn.csv': { body: '306,"BANCO NACIONAL DE CUBA",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ' },
    [`https://data.sec.gov/submissions/CIK${cik}.json`]: {
      body: { cik, name: 'Invesco Short Duration US Government Securities Fund, a separate series of Superstate Asset Trust', stateOfIncorporation: 'DE', formerNames: [], filings: { recent: { accessionNumber: [], form: [], filingDate: [], primaryDocument: [] } } },
    },
  })
  const db = fakeDb()
  const result = await captureRwaIssuerRegistry(db, NOW, laneDeps(impl), { subjects: [USTB] })
  assert.equal(result.error, undefined)
  const signals = db.rowsFor(SIGNAL_TABLE)
  assert.ok(signals.length > 0)
  for (const signal of signals) {
    // The schema refuses a scope below 60 characters, so the lane may never
    // build one. A pointer without "what this does not mean" is the defect.
    assert.ok(String(signal.scope).length >= 60, `scope too short: ${signal.scope}`)
    assert.ok(String(signal.source_url).startsWith('https://'))
    assert.ok(String(signal.level).length > 0)
  }
  // The sanctions pointer reports no match, and says that is not a clearance.
  const sanctions = signals.find((s) => s.signal_type === 'sanctions_name_pointer')!
  assert.equal(sanctions.level, 'no_exact_match')
  assert.match(String(sanctions.scope), /not a sanctions clearance/)
  // An entity row is written for the mapped subject only.
  assert.equal(db.rowsFor(ENTITY_TABLE).length, 1)
  assert.equal(db.rowsFor(ENTITY_TABLE)[0].cik, cik)
  // No filings were offered, so no admission rows are invented.
  assert.equal(db.rowsFor(FILING_TABLE).length, 0)
})

Deno.test('the registry lane refuses EDGAR honestly when no descriptive user agent is configured', async () => {
  __resetRwaSourceStateForTests()
  const { impl, calls } = fakeFetch({ 'https://www.treasury.gov/ofac/downloads/sdn.csv': { body: '306,"BANCO NACIONAL DE CUBA",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ' } })
  const db = fakeDb()
  // No userAgent supplied and none in the environment under test.
  const result = await captureRwaIssuerRegistry(db, NOW, { request: (() => Promise.resolve(null)) as never, sources: sourceDeps(impl) }, { subjects: [USTB] })
  assert.match(String(result.partial), /edgar:user_agent_required/)
  // The entity row is still written from the dated assertion, so a missing
  // setting degrades to less evidence and never to a wrong identity.
  assert.equal(db.rowsFor(ENTITY_TABLE).length, 1)
  assert.equal(calls.some((c) => c.url.includes('data.sec.gov')), false)
})

Deno.test('the lane captures mapped subjects only and never an unmapped issuer', async () => {
  const db = fakeDb()
  const empty = await captureRwaTokenConcentration(db, NOW, laneDeps(fakeFetch({}).impl), { subjects: [] })
  assert.equal(empty.skipped, 'no_mapped_tokens')
  assert.equal(db.writes.length, 0)
  // Only token subjects reach the concentration lane; a CMC issuer subject has
  // no contract and is filtered out rather than guessed at.
  assert.equal(tokenSubject({ ...USTB, subject: 'cmc-issuer:688ca4ccabae9b5b9fb3167a' }), null)
})
