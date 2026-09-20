import { strict as assert } from 'node:assert'
import {
  cikKey, fetchFormD, fetchSubmissionPage, fetchSubmissions, filingBlock, formDFilings, formDUrl,
  normalizeSubmissions, parseFormD, submissionPageUrl,
} from './edgar.ts'
import { __resetRwaSourceStateForTests } from './http.ts'
import { deps, deps as sourceDeps, fakeFetch, EDGAR_AGENT } from './test-support.ts'

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

// ─── the span of a filings block, and the older pages ────────────────────────

Deno.test('a filings block reports the span it covered, not only the rows it kept', () => {
  const block = filingBlock({
    accessionNumber: ['a1', 'a2', 'a3'],
    form: ['424B2', '10-K', '424B2'],
    filingDate: ['2026-09-18', '2026-02-14', '2025-11-02'],
    primaryDocument: ['a.htm', 'b.htm', 'c.htm'],
  }, { forms: ['10-K'], limit: 200 })
  assert.equal(block.filings.length, 1, 'only the wanted form is kept')
  assert.equal(block.filings[0].form, '10-K')
  // The SPAN is measured over every entry scanned, because it describes the block
  // and not the filtered view of it. Without that, "no 10-K here" cannot be told
  // apart from "this filer has no 10-K".
  assert.equal(block.count, 3)
  assert.equal(block.oldest, '2025-11-02')
  assert.equal(block.newest, '2026-09-18')
  // An empty block is a real answer with no span, never a throw.
  assert.deepEqual(filingBlock({}), { filings: [], count: 0, oldest: null, newest: null })
  // A date the provider did not publish in the documented shape is not a span.
  assert.equal(filingBlock({ accessionNumber: ['a'], form: ['10-K'], filingDate: ['whenever'] }).oldest, null)
})

Deno.test('a submissions record carries its recent span and the older pages EDGAR names', () => {
  const record = normalizeSubmissions({
    cik: '0000019617', name: 'JPMORGAN CHASE & CO',
    filings: {
      recent: { accessionNumber: ['a1'], form: ['424B2'], filingDate: ['2026-09-18'], primaryDocument: ['a.htm'] },
      files: [
        { name: 'CIK0000019617-submissions-002.json', filingCount: 1000, filingFrom: '2023-01-03', filingTo: '2025-01-01' },
        { name: 'CIK0000019617-submissions-001.json', filingCount: 1000, filingFrom: '2025-01-02', filingTo: '2026-07-31' },
        // NOT a name EDGAR publishes. It never becomes a URL.
        { name: '../../../etc/passwd', filingCount: 1, filingFrom: null, filingTo: '2099-01-01' },
      ],
    },
  })!
  assert.deepEqual(record.recent, { count: 1, oldest: '2026-09-18', newest: '2026-09-18' })
  // Newest period first, so a follow-up starts with the page adjoining `recent`.
  assert.deepEqual(record.olderFiles.map((f) => f.name), ['CIK0000019617-submissions-001.json', 'CIK0000019617-submissions-002.json'])
  assert.equal(record.olderFiles[0].from, '2025-01-02')
  assert.equal(record.olderFiles[0].count, 1000)
  // A filer with no older pages is an empty list, not a missing field.
  assert.deepEqual(normalizeSubmissions({ cik: '0001045810', filings: { recent: {} } })!.olderFiles, [])
})

Deno.test('only a file name EDGAR published in the documented shape becomes a URL', () => {
  assert.equal(submissionPageUrl('CIK0000019617-submissions-001.json'), 'https://data.sec.gov/submissions/CIK0000019617-submissions-001.json')
  // A name from a response is DATA, never a path. Nothing the document says can
  // send a request outside this one directory of data.sec.gov.
  for (const bad of ['../../../etc/passwd', 'CIK0000019617-submissions-001.json?x=1', 'https://evil.test/a.json', 'CIK19617-submissions-001.json', '', null, 42]) {
    assert.equal(submissionPageUrl(bad), null, String(bad))
  }
})

Deno.test('an older submissions page reads as a bare block and states its own span', async () => {
  __resetRwaSourceStateForTests()
  const url = 'https://data.sec.gov/submissions/CIK0000019617-submissions-001.json'
  const { impl } = fakeFetch({
    [url]: {
      body: {
        accessionNumber: ['0000019617-26-000150', '0000019617-26-000040', '0000019617-25-000900'],
        form: ['10-Q', '10-K', '424B2'],
        filingDate: ['2026-05-02', '2026-02-14', '2025-06-01'],
        primaryDocument: ['q.htm', 'k.htm', 'p.htm'],
      },
    },
  })
  const page = await fetchSubmissionPage('CIK0000019617-submissions-001.json', sourceDeps(impl, { userAgent: EDGAR_AGENT }), { forms: ['10-K', '10-Q'], limit: 200 })
  assert.equal(page.state, 'known')
  assert.deepEqual(page.filings.map((f) => f.form), ['10-Q', '10-K'])
  assert.equal(page.count, 3)
  assert.equal(page.oldest, '2025-06-01')
  assert.equal(page.sourceUrl, url)

  // A name that cannot become a URL is a stated reason and issues no request.
  const refused = await fetchSubmissionPage('../../../etc/passwd', sourceDeps(impl, { userAgent: EDGAR_AGENT }))
  assert.equal(refused.state, 'unavailable')
  assert.equal(refused.reason, 'invalid_submission_page')
  assert.equal(refused.sourceUrl, null)
})
