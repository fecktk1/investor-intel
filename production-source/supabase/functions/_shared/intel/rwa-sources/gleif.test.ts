import { strict as assert } from 'node:assert'
import { fetchLeiRecord, fetchLeiRelationship, leiRegistrationSignal, normalizeLeiRecord, LEI_PATTERN } from './gleif.ts'
import { __resetRwaSourceStateForTests } from './http.ts'
import { deps, fakeFetch } from './test-support.ts'

// Shapes copied from live responses probed 2026-09-16.
const superstateLimited = {
  data: {
    id: '2549003P4H6K2FQ3UV85',
    attributes: {
      lei: '2549003P4H6K2FQ3UV85',
      entity: { legalName: { name: 'Superstate Limited' }, jurisdiction: 'VG', status: 'ACTIVE', legalAddress: { country: 'VG' } },
      registration: { status: 'LAPSED', initialRegistrationDate: '2018-10-15T06:48:48Z', lastUpdateDate: '2022-03-11T16:12:48Z', nextRenewalDate: '2019-10-15T06:48:48Z' },
    },
  },
}
const superstateInc = {
  data: {
    id: '254900RYEZ47C0C0YO93',
    attributes: {
      lei: '254900RYEZ47C0C0YO93',
      entity: { legalName: { name: 'SUPERSTATE INC.' }, jurisdiction: 'US-DE', status: 'ACTIVE' },
      registration: { status: 'ISSUED', nextRenewalDate: '2027-06-12T18:34:48Z' },
    },
  },
}
const url = (lei: string) => `https://api.gleif.org/api/v1/lei-records/${lei}`

Deno.test('a lapsed registration is reported as lapsed while the entity itself stays active', async () => {
  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({ [url('2549003P4H6K2FQ3UV85')]: { body: superstateLimited } })
  const result = await fetchLeiRecord('2549003P4H6K2FQ3UV85', deps(impl))
  assert.equal(result.state, 'known')
  assert.equal(result.record?.registrationStatus, 'LAPSED')
  // The two statuses are genuinely different facts and both survive.
  assert.equal(result.record?.entityStatus, 'ACTIVE')
  assert.equal(result.record?.jurisdiction, 'VG')

  const signal = leiRegistrationSignal(result.record)
  assert.equal(signal.level, 'unmaintained')
  assert.equal(signal.status, 'LAPSED')
  assert.ok(signal.sourceUrl.includes('2549003P4H6K2FQ3UV85'))
  // A lapsed signal must point at a primary source and disclaim what it is not.
  assert.match(signal.scope, /not a finding about the entity's licensing, solvency, conduct/)
  assert.match(signal.scope, /not advice/)
})

Deno.test('a maintained registration is not dressed up as an endorsement', async () => {
  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({ [url('254900RYEZ47C0C0YO93')]: { body: superstateInc } })
  const result = await fetchLeiRecord('254900RYEZ47C0C0YO93', deps(impl))
  const signal = leiRegistrationSignal(result.record)
  assert.equal(signal.level, 'maintained')
  assert.match(signal.scope, /does not establish that the entity is authorised, regulated or suitable/)
})

Deno.test('two entities sharing a name stem stay separate records with separate statuses', () => {
  const lapsed = normalizeLeiRecord(superstateLimited.data)
  const issued = normalizeLeiRecord(superstateInc.data)
  assert.notEqual(lapsed?.lei, issued?.lei)
  assert.notEqual(lapsed?.jurisdiction, issued?.jurisdiction)
  assert.equal(lapsed?.registrationStatus, 'LAPSED')
  assert.equal(issued?.registrationStatus, 'ISSUED')
})

Deno.test('a malformed LEI never reaches the network and an absent record is not a failure', async () => {
  __resetRwaSourceStateForTests()
  const { impl, calls } = fakeFetch({})
  for (const bad of ['', 'not-an-lei', '254900RYEZ47C0C0YO9', 'lowercase0000000000']) {
    const result = await fetchLeiRecord(bad, deps(impl))
    assert.equal(result.state, 'unavailable')
    assert.equal(result.reason, 'invalid_lei')
  }
  assert.equal(calls.length, 0)
  assert.equal(LEI_PATTERN.test('254900RYEZ47C0C0YO93'), true)

  __resetRwaSourceStateForTests()
  const missing = fakeFetch({ [url('254900RYEZ47C0C0YO94')]: { status: 404, body: { errors: [] } } })
  const absent = await fetchLeiRecord('254900RYEZ47C0C0YO94', deps(missing.impl))
  // Not in the register is a real answer about the register.
  assert.equal(absent.state, 'not_found')
  assert.equal(absent.reason, null)
})

Deno.test('a missing parent relationship is recorded as none while a child count keeps a real zero', async () => {
  __resetRwaSourceStateForTests()
  const none = fakeFetch({ [`${url('254900RYEZ47C0C0YO93')}/direct-parent`]: { status: 404, body: { errors: [] } } })
  const parent = await fetchLeiRelationship('254900RYEZ47C0C0YO93', 'direct-parent', deps(none.impl))
  assert.equal(parent.state, 'none')
  assert.equal(parent.reason, null)

  __resetRwaSourceStateForTests()
  const children = fakeFetch({ [`${url('529900VBK42Y5HHRMD23')}/direct-children`]: { body: { meta: { pagination: { total: 125 } } } } })
  const counted = await fetchLeiRelationship('529900VBK42Y5HHRMD23', 'direct-children', deps(children.impl))
  assert.equal(counted.state, 'known')
  assert.equal(counted.childCount, 125)

  __resetRwaSourceStateForTests()
  const empty = fakeFetch({ [`${url('529900VBK42Y5HHRMD24')}/direct-children`]: { body: { meta: { pagination: { total: 0 } } } } })
  const zero = await fetchLeiRelationship('529900VBK42Y5HHRMD24', 'direct-children', deps(empty.impl))
  // Zero children is a measurement, not a missing value.
  assert.equal(zero.childCount, 0)
})

Deno.test('an entity with no registration status asserts nothing about itself', () => {
  const signal = leiRegistrationSignal(null)
  assert.equal(signal.level, 'unknown')
  assert.equal(signal.status, null)
  assert.match(signal.scope, /Nothing is asserted/)
})
