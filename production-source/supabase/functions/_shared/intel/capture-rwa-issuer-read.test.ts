// deno-lint-ignore-file no-explicit-any
import { strict as assert } from 'node:assert'
import { readRwaIssuerLegitimacy } from './capture-rwa-issuer-read.ts'
import { ALIAS_ASSERTIONS, ALIAS_REVIEWED_AT, ALIAS_V2_REVIEWED_AT, assertionsAsOf } from './rwa-issuer-aliases.ts'
import { CONCENTRATION_TABLE, DRIFT_TABLE, ENTITY_TABLE, FILING_TABLE, RESTRICTION_TABLE, RWA_ISSUER_CAPTURE_SCHEDULE, SIGNAL_TABLE } from './capture-rwa-issuer.ts'

const at = Date.parse(ALIAS_REVIEWED_AT) + 1000
// Five years past every assertion. The board treats that as no different from
// one second past: an assertion does not lapse because a date arrived.
const YEARS_LATER = Date.parse('2031-01-01T00:00:00.000Z')
const USTB = ALIAS_ASSERTIONS.find((a) => a.subjectLabel === 'USTB')!
const CIK = USTB.entity.cik!
const ADDRESS = '0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e'

/** A chainable PostgREST-shaped fake. Every terminal call resolves to the rows
 * configured for that table, or to the error configured for it. */
function fakeDb(tables: Record<string, Record<string, unknown>[]>, failing: Record<string, string> = {}) {
  return {
    from(table: string) {
      const result = failing[table]
        ? { data: null, error: { message: failing[table] } }
        : { data: tables[table] ?? [], error: null }
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'in', 'eq', 'order', 'limit', 'gt']) {
        chain[method] = () => chain
      }
      // The read modules `await` the built query, so the chain is a thenable.
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve)
      return chain
    },
  }
}

const concentrationRow = (over: Record<string, unknown> = {}) => ({
  chain: 'ethereum', contract_address: ADDRESS, captured_at: '2026-09-16T14:00:00.000Z',
  holders_count: 78, total_supply: '47680474964580',
  top1_share: 0, top5_share: 0, top10_share: 0,
  holders_read: 50, truncated: true,
  source_url: 'https://eth.blockscout.com/api/v2/tokens/x/holders',
  export_allowed: false, scope: 'Share of reported total supply held by the largest addresses on one page of holders.',
  ...over,
})

Deno.test('the board lists deliberate non-mappings even when every table is empty', async () => {
  const result = await readRwaIssuerLegitimacy(fakeDb({}), {}, at)
  assert.equal(result.view, 'rwa_issuer_legitimacy')
  // An empty capture is a real, successful read.
  assert.equal(result.asOf, null)
  assert.equal(result.reason, null)
  // The refusals are part of the answer, not an absence to hide.
  const unmapped = result.unmapped as { subjectLabel: string; evidence: string }[]
  assert.ok(unmapped.length >= 5)
  assert.ok(unmapped.some((u) => u.subjectLabel === 'Ondo' && /returned 0 records/.test(u.evidence)))
  // Mapped subjects are still listed, from the alias map, with no invented data.
  const subjects = result.subjects as { subjectLabel: string; admission: { timeline: unknown[] } }[]
  assert.equal(subjects.length, assertionsAsOf(at).length)
  assert.equal(subjects[0].admission.timeline.length, 0)
  // Nothing captured is a stated state with its schedule, not a blank board.
  assert.ok((result.subjects as { captured: boolean }[]).every((s) => s.captured === false))
  assert.deepEqual(result.schedule, RWA_ISSUER_CAPTURE_SCHEDULE)
})

Deno.test('a failed table read states its reason and never empties the rest of the board', async () => {
  const db = fakeDb(
    { [CONCENTRATION_TABLE]: [concentrationRow()] },
    { [FILING_TABLE]: 'relation does not exist', [SIGNAL_TABLE]: 'permission denied' },
  )
  const result = await readRwaIssuerLegitimacy(db, {}, at)
  assert.match(String(result.reason), /relation does not exist/)
  assert.match(String(result.reason), /permission denied/)
  // What did load is still there.
  const subjects = result.subjects as { concentration: { holdersCount: number } | null; signals: unknown[] }[]
  const ustb = subjects.find((s) => (s as unknown as { subject: string }).subject === USTB.subject)!
  assert.equal(ustb.concentration?.holdersCount, 78)
  assert.deepEqual(ustb.signals, [])
})

Deno.test('a concentration share of zero survives the read as zero rather than as unknown', async () => {
  const db = fakeDb({ [CONCENTRATION_TABLE]: [concentrationRow()] })
  const result = await readRwaIssuerLegitimacy(db, {}, at)
  const subjects = result.subjects as { subject: string; concentration: { tiers: { topN: number; share: number | null }[]; exportAllowed: boolean; truncated: boolean } | null }[]
  const ustb = subjects.find((s) => s.subject === USTB.subject)!
  assert.deepEqual(ustb.concentration?.tiers.map((t) => t.share), [0, 0, 0])
  for (const tier of ustb.concentration!.tiers) assert.notEqual(tier.share, null)
  // The unverified licence travels with the figure out of the table.
  assert.equal(ustb.concentration?.exportAllowed, false)
  assert.equal(ustb.concentration?.truncated, true)
})

Deno.test('a stated minimum of zero survives the read and the newest filing is the current one', async () => {
  const db = fakeDb({
    [FILING_TABLE]: [
      { cik: CIK, accession_number: '0002004367-24-000001', filing_date: '2024-01-02', submission_type: 'D', entity_name: 'Superstate Short Duration US Government Securities Fund', jurisdiction_of_inc: 'DELAWARE', federal_exemptions: ['06c', '3C', '3C.1', '3C.7'], minimum_investment_accepted: 0, has_non_accredited_investors: false, total_amount_sold: 0, total_investors: 0, source_url: 'https://www.sec.gov/x', fetched_at: '2026-09-16T14:00:00.000Z' },
      { cik: CIK, accession_number: '0002004367-26-000008', filing_date: '2026-07-14', submission_type: 'D/A', entity_name: 'Invesco Short Duration US Government Securities Fund', jurisdiction_of_inc: 'DELAWARE', federal_exemptions: ['06c', '3C', '3C.7'], minimum_investment_accepted: 100000, has_non_accredited_investors: false, total_amount_sold: 5923963438, total_investors: 114, source_url: 'https://www.sec.gov/y', fetched_at: '2026-09-16T14:00:00.000Z' },
    ],
  })
  const result = await readRwaIssuerLegitimacy(db, {}, at)
  const subjects = result.subjects as { subject: string; admission: { timeline: { minimumInvestmentAccepted: number | null; filingDate: string }[]; current: { accessionNumber: string } | null } }[]
  const ustb = subjects.find((s) => s.subject === USTB.subject)!
  // Oldest first, and the 2024 zero minimum is a real term, not a blank.
  assert.deepEqual(ustb.admission.timeline.map((f) => f.filingDate), ['2024-01-02', '2026-07-14'])
  assert.equal(ustb.admission.timeline[0].minimumInvestmentAccepted, 0)
  assert.equal(ustb.admission.current?.accessionNumber, '0002004367-26-000008')
})

Deno.test('an unresolved proxy reaches the reader as unresolved and claims no capability', async () => {
  const db = fakeDb({
    [RESTRICTION_TABLE]: [{
      chain: 'ethereum', contract_address: ADDRESS, implementation_address: null, state: 'proxy_unresolved',
      kyc_gated: false, pausable: false, freezable: false, matched_members: null,
      source_url: 'https://eth.blockscout.com/api/v2/addresses/x',
      scope: 'This token is a proxy contract and its implementation could not be resolved, so its transfer restrictions were NOT read.',
      fetched_at: '2026-09-16T14:00:00.000Z',
    }],
  })
  const result = await readRwaIssuerLegitimacy(db, {}, at)
  const subjects = result.subjects as { subject: string; restrictions: { state: string; kycGated: boolean } | null }[]
  const ustb = subjects.find((s) => s.subject === USTB.subject)!
  assert.equal(ustb.restrictions?.state, 'proxy_unresolved')
  assert.equal(ustb.restrictions?.kycGated, false)
  assert.match(String((ustb.restrictions as unknown as { scope: string }).scope), /could not be resolved/)
})

Deno.test('the read reports an explicit withdrawal, and never one the calendar invented', async () => {
  const db = fakeDb({ [ENTITY_TABLE]: [{ entity_key: `cik:${CIK}`, cik: CIK, legal_name: 'Invesco Short Duration US Government Securities Fund', jurisdiction: 'DE', registration_status: null, entity_status: null, source_url: 'https://data.sec.gov/x', fetched_at: '2026-09-16T14:00:00.000Z' }] })
  const current = await readRwaIssuerLegitimacy(db, {}, at)
  assert.equal((current.review as { lapsed: boolean; lapsedAt: string | null }).lapsed, false)
  assert.equal((current.review as { lapsedAt: string | null }).lapsedAt, null)
  assert.equal((current.subjects as { state: string }[])[0].state, 'mapped')

  // Five years on, with nothing withdrawn, the board still asserts the mapping.
  const later = await readRwaIssuerLegitimacy(db, {}, YEARS_LATER)
  assert.equal((later.review as { lapsed: boolean }).lapsed, false)
  assert.equal((later.subjects as { state: string }[])[0].state, 'mapped')
  assert.equal((later.subjects as Record<string, any>[])[0].identity.lapsedAt, null)
  assert.equal((later.subjects as Record<string, any>[])[0].identity.legalName, 'Invesco Short Duration US Government Securities Fund')
  // The board publishes no expiry to watch, because there is none.
  assert.equal('expiresAt' in (later.review as Record<string, unknown>), false)
  assert.equal((later.review as { versions: Record<string, unknown>[] }).versions.every((v) => !('expiresAt' in v)), true)
})

Deno.test('asking for one subject narrows the board without hiding the refusals', async () => {
  const db = fakeDb({ [CONCENTRATION_TABLE]: [concentrationRow()] })
  const result = await readRwaIssuerLegitimacy(db, { subject: USTB.subject }, at)
  assert.equal((result.subjects as unknown[]).length, 1)
  assert.ok((result.unmapped as unknown[]).length >= 5)
})

Deno.test('a subject with no mapping in force withholds every legal fact but keeps the token facts', async () => {
  const entity = { entity_key: `cik:${CIK}`, cik: CIK, legal_name: 'Invesco Short Duration US Government Securities Fund', jurisdiction: 'DE', registration_status: 'ISSUED', entity_status: 'ACTIVE', source_url: 'https://data.sec.gov/x', fetched_at: '2026-09-16T14:00:00.000Z' }
  const filing = { cik: CIK, accession_number: '0002004367-26-000008', filing_date: '2026-07-14', submission_type: 'D/A', entity_name: 'Invesco', jurisdiction_of_inc: 'DELAWARE', federal_exemptions: ['06c'], minimum_investment_accepted: 100000, has_non_accredited_investors: false, total_amount_sold: 1, total_investors: 1, source_url: 'https://www.sec.gov/y', fetched_at: '2026-09-16T14:00:00.000Z' }
  const signal = { entity_key: `cik:${CIK}`, signal_type: 'sanctions_name_pointer', level: 'no_match', status: null, source_url: 'https://www.treasury.gov/x', scope: 'A name screen is a pointer and not a determination.', fetched_at: '2026-09-16T14:00:00.000Z' }
  const drift = { cik: CIK, from_accession: 'a', to_accession: 'b', field: 'minimum_investment', kind: 'term', from_value: '0', to_value: '100000', held_until: '2024-01-02', changed_by: '2026-05-05', scope: 'x' }
  const db = fakeDb({ [ENTITY_TABLE]: [entity], [FILING_TABLE]: [filing], [SIGNAL_TABLE]: [signal], [DRIFT_TABLE]: [drift], [CONCENTRATION_TABLE]: [concentrationRow()] })

  const current = (await readRwaIssuerLegitimacy(db, {}, at)).subjects as Record<string, any>[]
  const live = current.find((s) => s.subject === USTB.subject)!
  assert.equal(live.identity.registrationStatus, 'ISSUED')
  assert.equal(live.admission.timeline.length, 1)
  assert.equal(live.signals.length, 1)
  assert.equal(live.collisions.length, 1)

  // Years later the mapping is still in force and every legal fact still shows.
  const wayLater = (await readRwaIssuerLegitimacy(db, {}, YEARS_LATER)).subjects as Record<string, any>[]
  const stillLive = wayLater.find((s) => s.subject === USTB.subject)!
  assert.equal(stillLive.state, 'mapped')
  assert.equal(stillLive.legalFactsWithheld, false)
  assert.equal(stillLive.identity.registrationStatus, 'ISSUED')
  assert.equal(stillLive.signals.length, 1)

  // The guard is reached by an instant before the assertion existed, which is
  // the replay case. Nothing else reaches it while no lapse is recorded.
  const before = await readRwaIssuerLegitimacy(db, {}, Date.parse(ALIAS_REVIEWED_AT) - 1000)
  assert.deepEqual(before.subjects, [])
  assert.deepEqual(before.collisions, [])

  // The board keeps the recorded words of every assertion it lists.
  const listed = (await readRwaIssuerLegitimacy(db, {}, at)).subjects as Record<string, any>[]
  const ustbRow = listed.find((s) => s.subject === USTB.subject)!
  assert.equal(ustbRow.identity.lapsedAt, null)
  assert.equal(ustbRow.identity.lapseReason, null)
  assert.match(ustbRow.identity.evidence, /Probed 2026-09-16/)
  // Token-level facts do not depend on knowing the legal entity.
  assert.equal(ustbRow.concentration?.holdersCount, 78)
})

Deno.test('a read after version 2 lists OUSG and the re-probed refusals, and names no expiry at all', async () => {
  const atV2 = Date.parse(ALIAS_V2_REVIEWED_AT) + 1000
  const result = await readRwaIssuerLegitimacy(fakeDb({}), {}, atV2)
  const subjects = result.subjects as { subjectLabel: string; state: string }[]
  assert.deepEqual(subjects.map((s) => s.subjectLabel), ['USTB', 'BUIDL', 'OUSG'])
  const unmapped = result.unmapped as { subjectLabel: string; version: string }[]
  assert.deepEqual(unmapped.map((u) => u.subjectLabel), ['Ondo', 'Paxos', 'Tether Holdings', 'Matrixdock', 'Comtech Gold', 'USDY'])
  const review = result.review as { lapsedAt: string | null; lapsed: boolean; versions: { version: string }[] }
  assert.equal(review.lapsedAt, null)
  assert.equal(review.lapsed, false)
  assert.equal(review.versions.length, 2)

  // Version 2 did not re-read USTB or BUIDL, and saying nothing about a subject
  // is not withdrawing it, so all three stay mapped for as long as you look.
  const wayLater = await readRwaIssuerLegitimacy(fakeDb({}), {}, YEARS_LATER)
  assert.deepEqual((wayLater.subjects as { subjectLabel: string; state: string }[]).map((s) => `${s.subjectLabel}:${s.state}`), ['USTB:mapped', 'BUIDL:mapped', 'OUSG:mapped'])
  assert.equal((wayLater.review as { lapsed: boolean }).lapsed, false)
  // A replay before version 2 does not show a mapping that did not exist yet.
  const before = await readRwaIssuerLegitimacy(fakeDb({}), {}, at)
  assert.equal((before.subjects as unknown[]).length, 2)
  assert.equal(ALIAS_ASSERTIONS.length, 3)
})
