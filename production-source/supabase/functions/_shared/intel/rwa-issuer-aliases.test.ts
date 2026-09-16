import { strict as assert } from 'node:assert'
import {
  ALIAS_ASSERTIONS, ALIAS_REVIEWED_AT, ALIAS_REVIEW_EXPIRES, NAME_COLLISIONS, UNMAPPED, VERIFIED_ENTITIES,
  aliasProblems, aliasState, collisionsFor, resolveAlias, unmappedRecord,
} from './rwa-issuer-aliases.ts'

const at = Date.parse(ALIAS_REVIEWED_AT) + 1000

Deno.test('the alias map is structurally sound, dated and reviewable', () => {
  assert.deepEqual(aliasProblems(), [])
  assert.ok(ALIAS_ASSERTIONS.length > 0)
})

Deno.test('an unmapped issuer stays unmapped rather than being fuzzy matched to a legal entity', () => {
  // Ondo is the case that motivated the whole map: GLEIF returns unrelated
  // Spanish and French companies for a full-text search and nothing at all for
  // the exact legal name.
  const ondo = 'cmc-issuer:688ca4ccabae9b5b9fb3167a'
  assert.equal(resolveAlias(ondo, at), null)
  assert.equal(aliasState(ondo, at), 'deliberately_unmapped')
  const record = unmappedRecord(ondo)!
  assert.equal(record.reason, 'name_not_an_identifier')
  // The non-mapping carries the probe that stopped it, so it can be re-run.
  assert.match(record.evidence, /returned 0 records/)
  assert.match(record.evidence, /SARL MOGABURE|AUTOBUSES/)
  // No assertion anywhere may claim this subject.
  assert.equal(ALIAS_ASSERTIONS.some((a) => a.subject === ondo), false)
})

Deno.test('a mismatch of legal form blocks a mapping that a name alone would have made', () => {
  // The PAX Gold terms name a national association; GLEIF holds only an LLC.
  const paxos = 'cmc-issuer:68904c24abae9b5b9fb35815'
  assert.equal(aliasState(paxos, at), 'deliberately_unmapped')
  assert.equal(unmappedRecord(paxos)!.reason, 'legal_form_mismatch')
  assert.match(unmappedRecord(paxos)!.evidence, /national association and a limited liability company are different legal forms/)
})

Deno.test('every issuer with no register record is recorded as unmapped with its own probe', () => {
  for (const subject of ['cmc-issuer:68904e9cabae9b5b9fb358ac', 'cmc-issuer:68905a7babae9b5b9fb35a8d', 'cmc-issuer:68904cceabae9b5b9fb35839']) {
    const record = unmappedRecord(subject)!
    assert.equal(record.reason, 'no_register_record')
    assert.match(record.evidence, /returned 0 records/)
  }
  // Never reviewed is a different state from reviewed and not mappable.
  assert.equal(aliasState('cmc-issuer:not-a-real-issuer', at), 'unknown')
})

Deno.test('a mapping resolves only on an exact subject and carries what was compared', () => {
  const ustb = 'token:eip155:1:0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e'
  const mapping = resolveAlias(ustb, at)!
  assert.equal(mapping.entity.cik, '0002004367')
  assert.equal(aliasState(ustb, at), 'mapped')
  assert.match(mapping.evidence, /Probed 2026-09-16/)
  assert.match(mapping.evidence, /formerNames/)
  assert.ok(mapping.assertedBy)
  // Case is irrelevant, but a different address is a different subject.
  assert.ok(resolveAlias(ustb.toUpperCase(), at))
  assert.equal(resolveAlias('token:eip155:1:0x43415eb6ff9db7e26a15b704e7a3edce97d31c4f', at), null)
  // A partial subject never resolves.
  assert.equal(resolveAlias('token:eip155:1', at), null)
})

Deno.test('an expired assertion stops resolving but keeps its words', () => {
  const ustb = 'token:eip155:1:0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e'
  const after = Date.parse(ALIAS_REVIEW_EXPIRES) + 1000
  assert.equal(resolveAlias(ustb, after), null)
  assert.equal(aliasState(ustb, after), 'expired')
  // Before the review existed it is equally not a mapping.
  assert.equal(aliasState(ustb, Date.parse(ALIAS_REVIEWED_AT) - 1000), 'expired')
  assert.ok(ALIAS_ASSERTIONS.find((a) => a.subject === ustb))
})

Deno.test('a shared name stem is surfaced for review and never joined to a token', () => {
  const ustb = 'token:eip155:1:0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e'
  const collisions = collisionsFor(ustb)
  assert.equal(collisions.length, 1)
  assert.equal(collisions[0].stem, 'Superstate')
  const statuses = collisions[0].entities.map((e) => e.registrationStatus).sort()
  // One issued and one lapsed record share the stem, which is exactly why
  // neither may be asserted from the name.
  assert.deepEqual(statuses, ['ISSUED', 'LAPSED'])
  assert.match(collisions[0].note, /NEITHER has been shown to be the sponsor/)
  assert.match(collisions[0].note, /a shared name stem is not a relationship/)
  // A collision is not an assertion.
  assert.equal(ALIAS_ASSERTIONS.some((a) => a.entity.lei === '2549003P4H6K2FQ3UV85'), false)
})

Deno.test('a verified register record is not by itself a claim that a token belongs to it', () => {
  const lapsed = VERIFIED_ENTITIES.find((e) => e.lei === '254900AG86JY01ULWX64')!
  assert.equal(lapsed.legalName, 'Hashnote Master Fund LP')
  assert.equal(lapsed.registrationStatus, 'LAPSED')
  // Nothing is mapped to it.
  assert.equal(ALIAS_ASSERTIONS.some((a) => a.entity.lei === lapsed.lei), false)
  // And the deliberate non-mappings outnumber the assertions, which is the
  // posture this map is supposed to have.
  assert.ok(UNMAPPED.length >= ALIAS_ASSERTIONS.length)
  assert.ok(NAME_COLLISIONS.length > 0)
})
