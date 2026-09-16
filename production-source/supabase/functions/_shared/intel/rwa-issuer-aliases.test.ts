import { strict as assert } from 'node:assert'
import {
  ALIAS_ASSERTIONS, ALIAS_REVIEWED_AT, ALIAS_REVIEW_EXPIRES, ALIAS_V2_REVIEWED_AT, ALIAS_V2_REVIEW_EXPIRES, ALIAS_V2_VERSION, ALIAS_VERSION, ALIAS_VERSIONS,
  NAME_COLLISIONS, UNMAPPED, VERIFIED_ENTITIES,
  aliasProblems, aliasState, assertionsAsOf, collisionsFor, currentAssertions, resolveAlias, unmappedAsOf, unmappedRecord,
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

// ── rwa-issuer-alias-2 ──────────────────────────────────────────────────────

const OUSG = 'token:eip155:1:0x1b19c19393e2d034d8ff31ff34c81252fcbbee92'
const atV2 = Date.parse(ALIAS_V2_REVIEWED_AT) + 1000

Deno.test('version 2 maps OUSG to its SEC filer only inside its own window, on the issuer published statement', () => {
  const mapping = resolveAlias(OUSG, atV2)!
  assert.equal(mapping.version, ALIAS_V2_VERSION)
  assert.equal(mapping.entity.cik, '0001957431')
  assert.equal(mapping.entity.lei ?? null, null)
  assert.equal(mapping.basis, 'issuer_published_identifier')
  assert.match(mapping.evidence, /The issuer of OUSG, Ondo I LP/)
  assert.match(mapping.evidence, /0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92/)
  // It did not exist during version 1, and it expires with version 2.
  assert.equal(resolveAlias(OUSG, at), null)
  assert.equal(resolveAlias(OUSG, Date.parse(ALIAS_V2_REVIEW_EXPIRES)), null)
  assert.equal(Date.parse(ALIAS_V2_REVIEW_EXPIRES) - Date.parse(ALIAS_V2_REVIEWED_AT), 7 * 86_400_000)
})

Deno.test('a replay lists only the mappings that existed then, and an expired version stops resolving on its own date', () => {
  assert.deepEqual(assertionsAsOf(at).map((a) => a.subjectLabel), ['USTB', 'BUIDL'])
  assert.deepEqual(assertionsAsOf(atV2).map((a) => a.subjectLabel), ['USTB', 'BUIDL', 'OUSG'])
  // Between the two expiries, version 1 has lapsed and version 2 has not.
  const between = Date.parse(ALIAS_REVIEW_EXPIRES) + 1000
  assert.deepEqual(currentAssertions(between).map((a) => a.subjectLabel), ['OUSG'])
  assert.equal(aliasState('token:eip155:1:0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e', between), 'expired')
  assert.equal(aliasState(OUSG, between), 'mapped')
})

Deno.test('version 2 re-probes every refusal without editing version 1, and records USDY as a new refusal', () => {
  const ondo = 'cmc-issuer:688ca4ccabae9b5b9fb3167a'
  // Version 1 words are untouched for replay.
  assert.equal(unmappedRecord(ondo, at)!.version, ALIAS_VERSION)
  assert.match(unmappedRecord(ondo, at)!.evidence, /SARL MOGABURE/)
  // As of version 2 the newest probe is read, and the answer is still no.
  const latest = unmappedRecord(ondo, atV2)!
  assert.equal(latest.version, ALIAS_V2_VERSION)
  assert.equal(latest.reason, 'name_not_an_identifier')
  // A register record for an Ondo entity exists now, and is still not attached
  // to an issuer string that spans several issuers.
  assert.match(latest.evidence, /984500Z0Q6A5E8BE2B61/)
  assert.equal(aliasState(ondo, atV2), 'deliberately_unmapped')
  assert.equal(ALIAS_ASSERTIONS.some((a) => a.entity.lei === '984500Z0Q6A5E8BE2B61'), false)

  const usdy = 'token:eip155:1:0x96f6ef951840721adbf46ac996b59e0235cb985c'
  assert.equal(aliasState(usdy, at), 'unknown')
  assert.equal(aliasState(usdy, atV2), 'deliberately_unmapped')
  assert.equal(unmappedRecord(usdy, atV2)!.reason, 'issuer_changed_over_time')

  const board = unmappedAsOf(atV2)
  assert.deepEqual(board.map((u) => u.subjectLabel), ['Ondo', 'Paxos', 'Tether Holdings', 'Matrixdock', 'Comtech Gold', 'USDY'])
  assert.ok(board.every((u) => u.version === ALIAS_V2_VERSION))
  assert.equal(unmappedAsOf(at).length, 5)
  assert.deepEqual(ALIAS_VERSIONS.map((v) => v.version), [ALIAS_VERSION, ALIAS_V2_VERSION])
})
