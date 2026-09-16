import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  isNavProductType, navDirectoryRows, navAddress, decodeInt256, decodeAbiText, decodeRoundData,
  validateNavFeed, readNavRounds, type NavFeedCandidate,
} from './chainlink-nav.ts'

const word = (value: bigint | number): string => BigInt(value).toString(16).padStart(64, '0')

/** An ABI dynamic string return, encoded the way an aggregator returns one. */
function encodeString(value: string): string {
  const bytes = [...value].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  return '0x' + word(32) + word(value.length) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0')
}
/** A five-word roundData return: roundId, answer, startedAt, updatedAt, answeredInRound. */
function encodeRound(roundId: bigint, answer: bigint, updatedAt: number): string {
  const signed = answer < 0n ? (1n << 256n) + answer : answer
  return '0x' + word(roundId) + signed.toString(16).padStart(64, '0') + word(0) + word(updatedAt) + word(roundId)
}

const USTB: NavFeedCandidate = {
  mirrorName: 'USTB NAV per Share',
  address: '0x289b5036cd942e619e1ee48670f98d214e745aac',
  decimals: 6, heartbeatSeconds: 95400, porAuditor: 'Superstate',
}

/** A batching RPC fake. `answers` maps the eth_call id to its result hex. */
// deno-lint-ignore no-explicit-any
const rpc = (answers: Record<number, string | null>, calls?: any[]) =>
  (_url: string, body: unknown, _timeout: number): Promise<unknown> => {
    // deno-lint-ignore no-explicit-any
    const batch = (Array.isArray(body) ? body : [body]) as any[]
    calls?.push(...batch)
    return Promise.resolve(batch.map((entry) => {
      const result = answers[Number(entry.id)]
      return result == null ? { id: entry.id, error: { message: 'execution reverted' } } : { id: entry.id, result }
    }))
  }

Deno.test('both spellings of the mirror product type are matched and other product types are left out', () => {
  // Probed 2026-09-16: the same file carries 21 "NAVLink" rows and 2 "NAVLINK".
  assert(isNavProductType('NAVLink'))
  assert(isNavProductType('NAVLINK'))
  assert(isNavProductType('  navlink '))
  assert(!isNavProductType('Proof of Reserve'))
  assert(!isNavProductType('Price'))

  const rows = navDirectoryRows([
    { name: 'JTRSY NAV', proxyAddress: '0x0C2e4Df738e99e8db80012f5bb2a303f3f48Ca74', decimals: 6, heartbeat: 97200, docs: { productType: 'NAVLink', porAuditor: 'Centrifuge' } },
    { name: 'M NAV', proxyAddress: '0xC28198Df9aee1c4990994B35ff51eFA4C769e534', decimals: 8, heartbeat: 86400, docs: { productType: 'NAVLINK', porAuditor: 'M^0 Labs' } },
    { name: 'ETH / USD', proxyAddress: '0x' + 'b'.repeat(40), decimals: 8, heartbeat: 3600, docs: { productType: 'Price' } },
    { name: 'Some Reserve', proxyAddress: '0x' + 'c'.repeat(40), decimals: 8, docs: { productType: 'Proof of Reserve' } },
  ])
  eq(rows.length, 2)
  eq(rows.map((r) => r.mirrorName), ['JTRSY NAV', 'M NAV'])
  // A case-sensitive filter would have dropped the second one entirely.
  eq(rows[1].mirrorName, 'M NAV')
  // Addresses are normalised to lower case so the register joins on one form.
  eq(rows[0].address, '0x0c2e4df738e99e8db80012f5bb2a303f3f48ca74')
  eq(rows[0].heartbeatSeconds, 97200)
  eq(rows[0].porAuditor, 'Centrifuge')
})

Deno.test('a mirror row with no usable address or name is not a candidate', () => {
  eq(navAddress('0x' + 'A'.repeat(40)), '0x' + 'a'.repeat(40))
  eq(navAddress('0xnothex'), null)
  eq(navAddress(null), null)
  const rows = navDirectoryRows([
    { name: 'No address NAV', decimals: 6, docs: { productType: 'NAVLink' } },
    { proxyAddress: '0x' + 'd'.repeat(40), decimals: 6, docs: { productType: 'NAVLink' } },
  ])
  eq(rows.length, 0)
})

Deno.test('a feed whose on-chain description disagrees with the mirror is refused rather than displayed', async () => {
  // The real 2026-09-16 disagreement: the mirror says "USCC NAV per Share" and
  // the chain says "USCC NAV". Those are not the same feed name.
  const uscc: NavFeedCandidate = { ...USTB, mirrorName: 'USCC NAV per Share', address: '0x' + 'a'.repeat(40) }
  const refused = await validateNavFeed(uscc, {
    rpcCall: rpc({ 1: encodeString('USCC NAV'), 2: '0x' + word(6), 3: encodeRound(100n, 11739247n, 1_757_000_000) }),
  })
  eq(refused.state, 'refused')
  eq(refused.reason, 'description_mismatch')
  // The disagreement itself is retained so a reviewer can see both sides.
  eq(refused.onChainDescription, 'USCC NAV')

  // The same feed, with a description that matches exactly, is validated.
  const ok = await validateNavFeed(USTB, {
    rpcCall: rpc({ 1: encodeString('USTB NAV per Share'), 2: '0x' + word(6), 3: encodeRound(100n, 11_212_488n, 1_757_000_000) }),
  })
  eq(ok.state, 'validated')
  eq(ok.reason, undefined)
  eq(ok.latest?.nav, 11.212488)
})

Deno.test('a validation refuses a wrong scale, an unreadable chain and a non-positive nav', async () => {
  const wrongScale = await validateNavFeed(USTB, {
    rpcCall: rpc({ 1: encodeString('USTB NAV per Share'), 2: '0x' + word(8), 3: encodeRound(1n, 1n, 1_757_000_000) }),
  })
  eq(wrongScale.state, 'refused')
  eq(wrongScale.reason, 'decimals_mismatch')

  const noDescription = await validateNavFeed(USTB, { rpcCall: rpc({ 1: null, 2: '0x' + word(6), 3: encodeRound(1n, 1n, 1) }) })
  eq(noDescription.state, 'refused')
  eq(noDescription.reason, 'no_on_chain_description')

  const zeroNav = await validateNavFeed(USTB, {
    rpcCall: rpc({ 1: encodeString('USTB NAV per Share'), 2: '0x' + word(6), 3: encodeRound(1n, 0n, 1_757_000_000) }),
  })
  eq(zeroNav.state, 'refused')
  eq(zeroNav.reason, 'non_positive_nav')

  // A transport failure is a named refusal, never a throw.
  const down = await validateNavFeed(USTB, { rpcCall: () => Promise.reject(new Error('rpc_5xx')) })
  eq(down.state, 'refused')
  eq(down.reason, 'rpc_5xx')

  // A mirror row with no decimals cannot be scaled, so it never reaches the chain.
  const noDecimals = await validateNavFeed({ ...USTB, decimals: null }, { rpcCall: () => Promise.reject(new Error('should not be called')) })
  eq(noDecimals.state, 'refused')
  eq(noDecimals.reason, 'mirror_decimals_missing')
})

Deno.test('a negative reported answer decodes as negative instead of an astronomical positive', () => {
  eq(decodeInt256(word(5)), 5n)
  // The same word read unsigned would be about 1.2e77 instead of minus five.
  eq(decodeInt256(word((1n << 256n) - 5n)), -5n)
  eq(decodeInt256('not a word'), null)
  const negative = decodeRoundData(encodeRound(1n, -1_000_000n, 1_757_000_000), 6)
  eq(negative?.nav, -1)
  eq(decodeAbiText(encodeString('JAAA NAV')), 'JAAA NAV')
  // A round the aggregator never wrote reports updatedAt zero and is not a dated
  // observation, so it decodes to null rather than to a 1970 reading.
  eq(decodeRoundData(encodeRound(1n, 1n, 0), 6), null)
})

Deno.test('history is walked back within the phase, returned oldest first, and unwritten rounds are dropped', async () => {
  // Round ids are phase-encoded, so the walk is a decrement from the latest.
  const latestId = (1n << 64n) + 500n
  const validated = await validateNavFeed(USTB, {
    rpcCall: rpc({ 1: encodeString('USTB NAV per Share'), 2: '0x' + word(6), 3: encodeRound(latestId, 11_212_488n, 1_757_952_000) }),
  })
  eq(validated.state, 'validated')

  // deno-lint-ignore no-explicit-any
  const asked: any[] = []
  const rounds = await readNavRounds(validated, {
    rpcCall: rpc({
      1: encodeRound(latestId - 1n, 11_209_249n, 1_757_865_600),
      2: encodeRound(latestId - 2n, 11_208_160n, 1_757_779_200),
      // An unwritten round below the phase floor: dropped, not dated.
      3: encodeRound(latestId - 3n, 0n, 0),
    }, asked),
  }, 4)

  eq(asked.length, 3)
  eq(rounds.length, 3)
  // Oldest first is the order the realized-yield maths reads.
  eq(rounds.map((r) => r.updatedAt), [1_757_779_200, 1_757_865_600, 1_757_952_000])
  eq(rounds.at(-1)?.nav, 11.212488)

  // A failed history read leaves the latest round standing on its own rather
  // than filling the gap with guesses.
  const alone = await readNavRounds(validated, { rpcCall: () => Promise.reject(new Error('down')) }, 4)
  eq(alone.length, 1)
  // A refused feed has no history to read at all.
  eq((await readNavRounds({ candidate: USTB, state: 'refused', reason: 'description_mismatch' }, { rpcCall: rpc({}) }, 4)).length, 0)
})
