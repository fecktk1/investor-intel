import { strict as assert } from 'node:assert'
import { admissionDrift, admissionTimeline, knownFilerNames, renameHistory, type AdmissionSnapshot } from './rwa-admission-drift.ts'

const snapshot = (over: Partial<AdmissionSnapshot> & { accessionNumber: string }): AdmissionSnapshot => ({
  filingDate: null, signatureDate: null, submissionType: 'D/A', entityName: null, jurisdictionOfInc: 'DELAWARE',
  federalExemptions: [], minimumInvestmentAccepted: null, hasNonAccreditedInvestors: false,
  totalAmountSold: null, totalNumberAlreadyInvested: null,
  sourceUrl: 'https://www.sec.gov/Archives/edgar/data/2004367/x/primary_doc.xml', fetchedAt: '2026-09-16T14:00:00.000Z',
  ...over,
})

// The real series probed 2026-09-16 for EDGAR CIK 0002004367.
const SUPERSTATE_SERIES: AdmissionSnapshot[] = [
  snapshot({
    accessionNumber: '0002004367-24-000001', filingDate: '2024-01-02', submissionType: 'D',
    entityName: 'Superstate Short Duration US Government Securities Fund, a series of Superstate Asset Trust',
    federalExemptions: ['06c', '3C', '3C.1', '3C.7'], minimumInvestmentAccepted: 0, totalAmountSold: 0, totalNumberAlreadyInvested: 0,
  }),
  snapshot({
    accessionNumber: '0000945621-26-000632', filingDate: '2026-05-05',
    entityName: 'Superstate Short Duration US Government Securities Fund, a series of Superstate Asset Trust',
    federalExemptions: ['06c', '3C', '3C.7'], minimumInvestmentAccepted: 100000, totalAmountSold: 5923963438, totalNumberAlreadyInvested: 114,
  }),
  snapshot({
    accessionNumber: '0002004367-26-000008', filingDate: '2026-07-14',
    entityName: 'Invesco Short Duration US Government Securities Fund, a separate series of Superstate Asset Trust',
    federalExemptions: ['06c', '3C', '3C.7'], minimumInvestmentAccepted: 100000, totalAmountSold: 5923963438, totalNumberAlreadyInvested: 114,
  }),
]

Deno.test('a Form D term change produces a dated drift record naming both values', () => {
  const drift = admissionDrift(SUPERSTATE_SERIES, { kinds: ['term'] })
  const minimum = drift.find((d) => d.field === 'minimum_investment')!
  assert.equal(minimum.from, '0')
  assert.equal(minimum.to, '100000')
  // The old answer held until the earlier filing and the new one appears by the
  // later filing. The change is dated to a window, never to a point.
  assert.equal(minimum.heldUntil, '2024-01-02')
  assert.equal(minimum.changedBy, '2026-05-05')
  assert.equal(minimum.kind, 'term')
  assert.match(minimum.scope, /happened at or before it, not necessarily on it/)

  const exemptions = drift.find((d) => d.field === 'federal_exemptions')!
  assert.equal(exemptions.from, '06c, 3C, 3C.1, 3C.7')
  assert.equal(exemptions.to, '06c, 3C, 3C.7')
})

Deno.test('the rename and the term change are separate drift records on separate dates', () => {
  const drift = admissionDrift(SUPERSTATE_SERIES, { kinds: ['term'] })
  const rename = drift.find((d) => d.field === 'entity_name')!
  // The terms moved first, between the 2024 and 2026-05 filings.
  const minimum = drift.find((d) => d.field === 'minimum_investment')!
  assert.equal(minimum.changedBy, '2026-05-05')
  // The name moved later, between the 2026-05 and 2026-07 filings.
  assert.equal(rename.changedBy, '2026-07-14')
  assert.match(rename.from, /^Superstate Short Duration/)
  assert.match(rename.to, /^Invesco Short Duration/)
  // Comparing only the newest against the oldest would collapse these two
  // separate dated events into one undated claim.
  assert.notEqual(rename.changedBy, minimum.changedBy)
})

Deno.test('growth in amount sold is activity and is never reported as an admission term change', () => {
  // BUIDL filed identical terms in 2024 and 2026 while its sales grew.
  const buidl: AdmissionSnapshot[] = [
    snapshot({ accessionNumber: '0002014390-24-000001', filingDate: '2024-03-18', submissionType: 'D', entityName: 'BlackRock USD Institutional Digital Liquidity Fund Ltd.', jurisdictionOfInc: 'VIRGIN ISLANDS, BRITISH', federalExemptions: ['06c', '3C', '3C.7'], minimumInvestmentAccepted: 100000, totalAmountSold: 0, totalNumberAlreadyInvested: 0 }),
    snapshot({ accessionNumber: '0002013810-26-000002', filingDate: '2026-07-27', entityName: 'BlackRock USD Institutional Digital Liquidity Fund Ltd.', jurisdictionOfInc: 'VIRGIN ISLANDS, BRITISH', federalExemptions: ['06c', '3C', '3C.7'], minimumInvestmentAccepted: 100000, totalAmountSold: 5135523412, totalNumberAlreadyInvested: 28 }),
  ]
  assert.deepEqual(admissionDrift(buidl, { kinds: ['term'] }), [])
  const activity = admissionDrift(buidl, { kinds: ['activity'] })
  assert.deepEqual(activity.map((d) => d.field).sort(), ['amount_sold', 'investor_count'])
  assert.equal(activity.every((d) => d.kind === 'activity'), true)
})

Deno.test('a value the filing stopped stating is not reported as a changed term', () => {
  const series = [
    snapshot({ accessionNumber: '0002004367-24-000001', filingDate: '2024-01-02', minimumInvestmentAccepted: 5000 }),
    snapshot({ accessionNumber: '0002004367-25-000001', filingDate: '2025-01-02', minimumInvestmentAccepted: null }),
  ]
  // Unknown is not a change, and dating one would invent an event.
  assert.deepEqual(admissionDrift(series).filter((d) => d.field === 'minimum_investment'), [])
})

Deno.test('a minimum moving away from zero is a real change rather than a filled in blank', () => {
  const series = [
    snapshot({ accessionNumber: '0001957431-24-000001', filingDate: '2024-01-19', minimumInvestmentAccepted: 0 }),
    snapshot({ accessionNumber: '0001957431-25-000001', filingDate: '2025-01-21', minimumInvestmentAccepted: 5000 }),
  ]
  const drift = admissionDrift(series, { kinds: ['term'] })
  assert.equal(drift.length, 1)
  assert.equal(drift[0].from, '0')
  assert.equal(drift[0].to, '5000')
})

Deno.test('the series reads oldest first whatever order the filings arrive in', () => {
  const shuffled = [SUPERSTATE_SERIES[2], SUPERSTATE_SERIES[0], SUPERSTATE_SERIES[1]]
  assert.deepEqual(admissionTimeline(shuffled).map((s) => s.filingDate), ['2024-01-02', '2026-05-05', '2026-07-14'])
})

Deno.test('a rename keeps both names so a token carrying the old one can still be matched', () => {
  const record = {
    cik: '0002004367',
    name: 'Invesco Short Duration US Government Securities Fund, a separate series of Superstate Asset Trust',
    stateOfIncorporation: 'DE',
    formerNames: [{ name: 'Superstate Short Duration US Government Securities Fund, a series of Superstate Asset Trust', from: '2024-01-02T05:00:00.000Z', to: '2026-07-07T04:00:00.000Z' }],
    filings: [],
  }
  const renames = renameHistory(record)
  assert.equal(renames.length, 1)
  assert.match(renames[0].from, /^Superstate/)
  assert.match(renames[0].to, /^Invesco/)
  assert.equal(renames[0].usedUntil, '2026-07-07T04:00:00.000Z')
  assert.match(renames[0].scope, /Both names are kept/)
  // Both names remain matchable, which is what lets a token whose metadata has
  // not caught up still resolve.
  assert.equal(knownFilerNames(record).length, 2)
  assert.equal(renameHistory(null).length, 0)
})
