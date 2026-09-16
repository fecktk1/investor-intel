import { strict as assert } from 'node:assert'
import { cikKey, fetchFormD, fetchSubmissions, formDFilings, formDUrl, normalizeSubmissions, parseFormD } from './edgar.ts'
import { __resetRwaSourceStateForTests } from './http.ts'
import { deps, fakeFetch, EDGAR_AGENT } from './test-support.ts'

// Trimmed from the live filing probed 2026-09-16 (CIK 0002004367, the 2024 D).
// relatedPersonsList is kept in the fixture ON PURPOSE: the test asserts that
// the parser refuses to surface the natural persons it names.
const formD2024 = `<?xml version="1.0"?>
<edgarSubmission>
  <schemaVersion>X0708</schemaVersion>
  <submissionType>D</submissionType>
  <primaryIssuer>
    <cik>0002004367</cik>
    <entityName>Superstate Short Duration US Government Securities Fund, a series of Superstate Asset Trust</entityName>
    <jurisdictionOfInc>DELAWARE</jurisdictionOfInc>
    <issuerPreviousNameList><value>None</value></issuerPreviousNameList>
    <entityType>Other</entityType>
    <yearOfInc><withinFiveYears>true</withinFiveYears><value>2023</value></yearOfInc>
  </primaryIssuer>
  <relatedPersonsList>
    <relatedPersonInfo>
      <relatedPersonName><firstName>Ian</firstName><lastName>Pilgrim</lastName></relatedPersonName>
      <relatedPersonAddress><street1>Williams House</street1><city>Hamilton</city></relatedPersonAddress>
      <relatedPersonRelationshipList><relationship>Director</relationship></relatedPersonRelationshipList>
    </relatedPersonInfo>
  </relatedPersonsList>
  <offeringData>
    <federalExemptionsExclusions><item>06c</item><item>3C</item><item>3C.1</item><item>3C.7</item></federalExemptionsExclusions>
    <minimumInvestmentAccepted>0</minimumInvestmentAccepted>
    <hasNonAccreditedInvestors>false</hasNonAccreditedInvestors>
    <totalAmountSold>0</totalAmountSold>
    <totalNumberAlreadyInvested>0</totalNumberAlreadyInvested>
  </offeringData>
  <signatureDate>2024-01-02</signatureDate>
</edgarSubmission>`

const submissions2004367 = {
  cik: '0002004367',
  name: 'Invesco Short Duration US Government Securities Fund, a separate series of Superstate Asset Trust',
  stateOfIncorporation: 'DE',
  formerNames: [{ name: 'Superstate Short Duration US Government Securities Fund, a series of Superstate Asset Trust', from: '2024-01-02T05:00:00.000Z', to: '2026-07-07T04:00:00.000Z' }],
  filings: {
    recent: {
      accessionNumber: ['0002004367-26-000008', '0000945621-26-000632', '0002004367-24-000001', '0002004367-24-000009'],
      form: ['D/A', 'D/A', 'D', '8-K'],
      filingDate: ['2026-07-14', '2026-05-05', '2024-01-02', '2024-06-01'],
      primaryDocument: ['xslFormDX01/primary_doc.xml', 'xslFormDX01/primary_doc.xml', 'xslFormDX01/primary_doc.xml', 'doc.htm'],
    },
  },
}

Deno.test('a renamed entity is detected through formerNames and both names are retained', async () => {
  __resetRwaSourceStateForTests()
  const url = 'https://data.sec.gov/submissions/CIK0002004367.json'
  const { impl } = fakeFetch({ [url]: { body: submissions2004367 } })
  const result = await fetchSubmissions('2004367', deps(impl, { userAgent: EDGAR_AGENT }))
  assert.equal(result.state, 'known')
  // The current name.
  assert.match(result.record!.name!, /^Invesco Short Duration/)
  // And the one it filed under before, with the dates it applied.
  assert.equal(result.record!.formerNames.length, 1)
  assert.match(result.record!.formerNames[0].name, /^Superstate Short Duration/)
  assert.equal(result.record!.formerNames[0].to, '2026-07-07T04:00:00.000Z')
})

Deno.test('a Form D parses to admission terms while the natural persons it names are never surfaced', () => {
  const terms = parseFormD(formD2024)!
  assert.equal(terms.entityName, 'Superstate Short Duration US Government Securities Fund, a series of Superstate Asset Trust')
  assert.equal(terms.jurisdictionOfInc, 'DELAWARE')
  assert.deepEqual(terms.federalExemptions, ['06c', '3C', '3C.1', '3C.7'])
  // A stated minimum of zero is a real term, not a missing value.
  assert.equal(terms.minimumInvestmentAccepted, 0)
  assert.equal(terms.hasNonAccreditedInvestors, false)
  assert.equal(terms.totalAmountSold, 0)
  assert.equal(terms.totalNumberAlreadyInvested, 0)
  // The filing literally contains a director's name and address. Nothing on the
  // parsed shape may carry it, in any field, at any depth.
  const serialized = JSON.stringify(terms)
  for (const person of ['Ian', 'Pilgrim', 'Williams House', 'Hamilton', 'Director']) {
    assert.equal(serialized.includes(person), false, `parsed Form D must not carry "${person}"`)
  }
})

Deno.test('the filing literal None is not mistaken for a previous name', () => {
  const terms = parseFormD(formD2024)!
  assert.deepEqual(terms.issuerPreviousNames, [])
})

Deno.test('only Form D filings enter the admission series and they arrive newest first', () => {
  const record = normalizeSubmissions(submissions2004367)!
  const filings = formDFilings(record)
  assert.deepEqual(filings.map((f) => f.form), ['D/A', 'D/A', 'D'])
  assert.deepEqual(filings.map((f) => f.filingDate), ['2026-07-14', '2026-05-05', '2024-01-02'])
})

Deno.test('a filing reference is built only from a well formed CIK and accession number', () => {
  assert.equal(cikKey('2004367'), '0002004367')
  assert.equal(cikKey('CIK0002004367'), '0002004367')
  assert.equal(cikKey('not a cik'), null)
  assert.equal(
    formDUrl('2004367', '0002004367-24-000001'),
    'https://www.sec.gov/Archives/edgar/data/2004367/000200436724000001/primary_doc.xml',
  )
  assert.equal(formDUrl('2004367', 'nonsense'), null)
})

Deno.test('an unreadable or absent filing is a stated reason rather than empty terms', async () => {
  __resetRwaSourceStateForTests()
  const url = 'https://www.sec.gov/Archives/edgar/data/2004367/000200436724000001/primary_doc.xml'

  const missing = fakeFetch({ [url]: { status: 404, body: '' } })
  const absent = await fetchFormD('2004367', '0002004367-24-000001', deps(missing.impl, { userAgent: EDGAR_AGENT }))
  assert.equal(absent.state, 'not_found')

  __resetRwaSourceStateForTests()
  const garbage = fakeFetch({ [url]: { body: '<html>not a filing</html>' } })
  const unreadable = await fetchFormD('2004367', '0002004367-24-000001', deps(garbage.impl, { userAgent: EDGAR_AGENT }))
  assert.equal(unreadable.state, 'unavailable')
  assert.equal(unreadable.reason, 'unreadable_form_d')
  assert.equal(unreadable.terms, null)

  // And with no agent configured the call is refused before it is made.
  __resetRwaSourceStateForTests()
  const noAgent = fakeFetch({ [url]: { body: formD2024 } })
  const refused = await fetchFormD('2004367', '0002004367-24-000001', deps(noAgent.impl))
  assert.equal(refused.state, 'unavailable')
  assert.equal(refused.reason, 'user_agent_required')
  assert.equal(noAgent.calls.length, 0)
})
