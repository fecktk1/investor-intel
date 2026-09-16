import { strict as assert } from 'node:assert'
import { fetchSdnIndex, normalizeEntityName, parseSdnCsv, screenLegalEntity } from './ofac.ts'
import { __resetRwaSourceStateForTests } from './http.ts'
import { deps, fakeFetch } from './test-support.ts'

// Column order copied from the live publication probed 2026-09-16, where `-0-`
// stands in for an empty field.
const SDN_CSV = [
  '36,"AEROCARIBBEAN AIRLINES",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
  '306,"BANCO NACIONAL DE CUBA",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"a.k.a. \'BNC\'."',
  '9001,"SOME PERSON","individual","UKRAINE",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
  '9002,"EXAMPLE HOLDINGS, LLC",-0- ,"SDGT",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
].join('\n')

Deno.test('individuals are dropped at parse time so no natural person can ever be screened or shown', () => {
  const index = parseSdnCsv(SDN_CSV)
  assert.equal(index.entities, 3)
  assert.equal(index.individualsSkipped, 1)
  // The person is not merely skipped at match time: they are not in the index.
  const serialized = JSON.stringify([...index.byName.entries()])
  assert.equal(serialized.includes('SOME PERSON'), false)
  assert.equal(screenLegalEntity('Some Person', index).state, 'no_exact_match')
})

Deno.test('an exact legal entity name matches and is worded as a pointer rather than an accusation', () => {
  const index = parseSdnCsv(SDN_CSV)
  const result = screenLegalEntity('Banco Nacional de Cuba', index)
  assert.equal(result.state, 'exact_match')
  assert.equal(result.matches[0].entNum, '306')
  assert.equal(result.matches[0].program, 'CUBA')
  assert.match(result.scope, /NOT proof that this is the same organisation/)
  assert.match(result.scope, /not a determination, not an allegation of wrongdoing/i)
  assert.match(result.scope, /not legal or investment advice/)
  assert.equal(result.sourceUrl, 'https://sanctionssearch.ofac.treas.gov/')
})

Deno.test('a near miss never matches, because there is no safe threshold for a sanctions pointer', () => {
  const index = parseSdnCsv(SDN_CSV)
  for (const near of ['Banco Nacional de Cuba S.A.', 'Banco Nacional', 'Banco Nacionale de Cuba', 'Aerocaribbean']) {
    assert.equal(screenLegalEntity(near, index).state, 'no_exact_match', `${near} must not match`)
  }
})

Deno.test('punctuation and case are normalised away while the legal form is preserved', () => {
  assert.equal(normalizeEntityName('Example Holdings, LLC'), normalizeEntityName('EXAMPLE HOLDINGS LLC'))
  assert.equal(normalizeEntityName('Paxos Trust Company, LLC'), normalizeEntityName('PAXOS TRUST COMPANY LLC'))
  const index = parseSdnCsv(SDN_CSV)
  assert.equal(screenLegalEntity('EXAMPLE HOLDINGS LLC', index).state, 'exact_match')
})

Deno.test('two real entities that differ only by legal form never collapse onto one key', () => {
  // Probed 2026-09-16: Superstate Limited is a British Virgin Islands record
  // whose GLEIF registration is LAPSED, while SUPERSTATE INC. is a US Delaware
  // record whose registration is ISSUED. They are different legal persons.
  // Stripping the legal form would merge them and could attach a sanctions
  // publication to the wrong company.
  assert.notEqual(normalizeEntityName('Superstate Limited'), normalizeEntityName('SUPERSTATE INC.'))
  assert.notEqual(normalizeEntityName('Superstate Limited'), normalizeEntityName('Superstate'))
  assert.notEqual(normalizeEntityName('Superstate Limited'), normalizeEntityName('Superstate Asset Trust'))
})

Deno.test('no match is stated as no match and never as a sanctions clearance', () => {
  const index = parseSdnCsv(SDN_CSV)
  const result = screenLegalEntity('BlackRock USD Institutional Digital Liquidity Fund Ltd.', index)
  assert.equal(result.state, 'no_exact_match')
  assert.match(result.scope, /not a sanctions clearance/)
  assert.match(result.scope, /Only the SDN list was compared/)
})

Deno.test('an unavailable publication is not screened rather than silently reported as clear', async () => {
  const notScreened = screenLegalEntity('Anything Ltd', null)
  assert.equal(notScreened.state, 'not_screened')
  assert.match(notScreened.scope, /Nothing is asserted either way/)

  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({ 'https://www.treasury.gov/ofac/downloads/sdn.csv': { status: 503, body: '' } })
  const failed = await fetchSdnIndex(deps(impl))
  assert.equal(failed.state, 'unavailable')
  assert.equal(failed.reason, 'http_503')
  assert.equal(failed.index, null)

  // A publication that parsed to nothing is a failed read, not an empty list.
  __resetRwaSourceStateForTests()
  const empty = fakeFetch({ 'https://www.treasury.gov/ofac/downloads/sdn.csv': { body: '' } })
  const nothing = await fetchSdnIndex(deps(empty.impl))
  assert.equal(nothing.state, 'unavailable')
  assert.equal(nothing.reason, 'empty_publication')
})

Deno.test('a quoted name containing a comma survives parsing intact', () => {
  const index = parseSdnCsv(SDN_CSV)
  const entry = [...index.byName.values()].flat().find((e) => e.entNum === '9002')!
  assert.equal(entry.name, 'EXAMPLE HOLDINGS, LLC')
})
