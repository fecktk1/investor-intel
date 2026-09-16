import { strict as assert } from 'node:assert'
import { legitimacyView } from './rwa-legitimacy.ts'
import { ALIAS_REVIEWED_AT } from './rwa-issuer-aliases.ts'
import { parseSdnCsv } from './rwa-sources/ofac.ts'
import { concentration } from './rwa-sources/blockscout.ts'
import { detectRestrictions } from './rwa-sources/sourcify.ts'
import type { AdmissionSnapshot } from './rwa-admission-drift.ts'

const at = Date.parse(ALIAS_REVIEWED_AT) + 1000
const USTB = 'token:eip155:1:0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e'
const ONDO = 'cmc-issuer:688ca4ccabae9b5b9fb3167a'

const lapsedLei = {
  lei: '2549003P4H6K2FQ3UV85', legalName: 'Superstate Limited', jurisdiction: 'VG',
  entityStatus: 'ACTIVE', registrationStatus: 'LAPSED', initialRegistrationDate: null,
  lastUpdateDate: null, nextRenewalDate: '2019-10-15T06:48:48Z', managingLou: null,
  corroborationLevel: null, registeredAs: null, legalAddressCountry: 'VG', headquartersCountry: 'VG',
}

const snapshot = (over: Partial<AdmissionSnapshot> & { accessionNumber: string }): AdmissionSnapshot => ({
  filingDate: null, signatureDate: null, submissionType: 'D/A', entityName: null, jurisdictionOfInc: 'DELAWARE',
  federalExemptions: [], minimumInvestmentAccepted: null, hasNonAccreditedInvestors: false,
  totalAmountSold: null, totalNumberAlreadyInvested: null,
  sourceUrl: 'https://www.sec.gov/Archives/edgar/data/2004367/x/primary_doc.xml', fetchedAt: '2026-09-16T14:00:00.000Z',
  ...over,
})

const SERIES: AdmissionSnapshot[] = [
  snapshot({ accessionNumber: '0002004367-24-000001', filingDate: '2024-01-02', submissionType: 'D', entityName: 'Superstate Short Duration US Government Securities Fund, a series of Superstate Asset Trust', federalExemptions: ['06c', '3C', '3C.1', '3C.7'], minimumInvestmentAccepted: 0, totalAmountSold: 0, totalNumberAlreadyInvested: 0 }),
  snapshot({ accessionNumber: '0000945621-26-000632', filingDate: '2026-05-05', entityName: 'Superstate Short Duration US Government Securities Fund, a series of Superstate Asset Trust', federalExemptions: ['06c', '3C', '3C.7'], minimumInvestmentAccepted: 100000, totalAmountSold: 5923963438, totalNumberAlreadyInvested: 114 }),
  snapshot({ accessionNumber: '0002004367-26-000008', filingDate: '2026-07-14', entityName: 'Invesco Short Duration US Government Securities Fund, a separate series of Superstate Asset Trust', federalExemptions: ['06c', '3C', '3C.7'], minimumInvestmentAccepted: 100000, totalAmountSold: 5923963438, totalNumberAlreadyInvested: 114 }),
]

Deno.test('an unmapped subject is given no legal facts even when register data is in hand', () => {
  const view = legitimacyView({
    subject: ONDO, at,
    // A register record and a sanctions list are supplied on purpose. Neither
    // may be attached to a subject whose identity was never asserted.
    lei: lapsedLei,
    sdn: parseSdnCsv('306,"BANCO NACIONAL DE CUBA",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- '),
    admissions: SERIES,
  })
  assert.equal(view.identity.state, 'deliberately_unmapped')
  assert.equal(view.identity.assertion, null)
  assert.equal(view.identity.legalName, null)
  assert.equal(view.identity.jurisdiction, null)
  assert.deepEqual(view.signals, [])
  assert.deepEqual(view.admission.timeline, [])
  assert.deepEqual(view.admission.termDrift, [])
  // What it DOES carry is why it was not mapped.
  assert.ok(view.identity.unmapped)
  assert.match(view.identity.unmapped!.evidence, /returned 0 records/)
})

Deno.test('a mapped subject carries its dated term drift and both of its names', () => {
  const view = legitimacyView({
    subject: USTB, at, admissions: SERIES,
    submissions: {
      cik: '0002004367',
      name: 'Invesco Short Duration US Government Securities Fund, a separate series of Superstate Asset Trust',
      stateOfIncorporation: 'DE',
      formerNames: [{ name: 'Superstate Short Duration US Government Securities Fund, a series of Superstate Asset Trust', from: '2024-01-02T05:00:00.000Z', to: '2026-07-07T04:00:00.000Z' }],
      filings: [],
    },
  })
  assert.equal(view.identity.state, 'mapped')
  assert.equal(view.identity.assertion?.entity.cik, '0002004367')
  const minimum = view.admission.termDrift.find((d) => d.field === 'minimum_investment')!
  assert.equal(minimum.from, '0')
  assert.equal(minimum.to, '100000')
  assert.equal(minimum.changedBy, '2026-05-05')
  const rename = view.admission.termDrift.find((d) => d.field === 'entity_name')!
  assert.equal(rename.changedBy, '2026-07-14')
  // Current terms are simply the newest filing, not a curated answer.
  assert.equal(view.admission.current?.accessionNumber, '0002004367-26-000008')
  assert.equal(view.admission.renames.length, 1)
})

Deno.test('a lapsed registration and a sanctions screening are pointers carrying their own scope', () => {
  const view = legitimacyView({
    subject: USTB, at,
    lei: lapsedLei,
    sdn: parseSdnCsv('306,"BANCO NACIONAL DE CUBA",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- '),
  })
  const registration = view.signals.find((s) => s.type === 'lei_registration')!
  assert.equal(registration.level, 'unmaintained')
  assert.equal(registration.status, 'LAPSED')
  assert.ok(registration.sourceUrl.startsWith('https://'))
  assert.match(registration.scope, /not a finding about the entity's licensing/)

  const sanctions = view.signals.find((s) => s.type === 'sanctions_name_pointer')!
  // The mapped entity is not on the list, and that is stated as no match rather
  // than as a clearance.
  assert.equal(sanctions.level, 'no_exact_match')
  assert.match(sanctions.scope, /not a sanctions clearance/)
  // Every signal must carry both a scope and a primary source to open.
  for (const signal of view.signals) {
    assert.ok(signal.scope.length > 60)
    assert.ok(signal.sourceUrl.startsWith('https://'))
  }
})

Deno.test('token level facts survive an unmapped issuer and a zero share stays zero', () => {
  const view = legitimacyView({
    subject: ONDO, at,
    holdersCount: 0,
    concentration: concentration([{ address: '0x' + 'a'.repeat(40), value: 0n }], 1000n, { tiers: [1, 5, 10] }),
    concentrationCapturedAt: '2026-09-16T14:00:00.000Z',
    restrictions: detectRestrictions([{ type: 'function', name: 'kycRegistry' }, { type: 'function', name: 'pause' }]),
  })
  // Not knowing who issues a token does not stop us describing the token.
  assert.equal(view.identity.state, 'deliberately_unmapped')
  assert.equal(view.concentration?.tiers[0].share, 0)
  assert.equal(view.concentration?.holdersCount, 0)
  assert.equal(view.restrictions?.kycGated, true)
  assert.equal(view.restrictions?.pausable, true)
  // And a figure from the explorer never becomes exportable.
  assert.equal(view.concentration?.exportAllowed, false)
})

Deno.test('a failed source states its own reason without emptying what did load', () => {
  const view = legitimacyView({
    subject: USTB, at,
    admissions: SERIES,
    reasons: { edgar: null, gleif: 'user_agent_required', blockscout: 'http_500', ofac: 'timeout' },
  })
  assert.deepEqual(view.unavailable.map((u) => u.source).sort(), ['blockscout', 'gleif', 'ofac'])
  assert.equal(view.unavailable.find((u) => u.source === 'gleif')?.reason, 'user_agent_required')
  // The admission series that DID load is untouched by the other failures.
  assert.equal(view.admission.timeline.length, 3)
  assert.ok(view.admission.termDrift.length > 0)
})

Deno.test('a name collision is surfaced on a mapped subject without becoming a mapping', () => {
  const view = legitimacyView({ subject: USTB, at })
  assert.equal(view.identity.collisions.length, 1)
  assert.equal(view.identity.collisions[0].stem, 'Superstate')
  // The lapsed record appears as something to review, not as this token's issuer.
  assert.equal(view.identity.assertion?.entity.lei ?? null, null)
  assert.equal(view.identity.assertion?.entity.cik, '0002004367')
})

Deno.test('an expired mapping loses its legal facts the same way an unmapped one never had them', () => {
  const view = legitimacyView({ subject: USTB, at: Date.parse('2026-10-01T00:00:00.000Z'), lei: lapsedLei, admissions: SERIES })
  assert.equal(view.identity.state, 'expired')
  assert.deepEqual(view.signals, [])
  assert.deepEqual(view.admission.timeline, [])
})
