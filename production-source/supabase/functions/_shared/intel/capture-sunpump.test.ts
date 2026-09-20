import { assertEquals as eq, assert, assertAlmostEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  captureSunpumpStages, classifyStage, bondingProgressPct, curveFdvUsd, decodeTransaction, eventRefsFrom,
  dexQuotesFrom, decodeAbiString, tokensFromWord, dataWords, addressFromWord, addressFromLog,
  hexToBase58Check, base58CheckToHex, base58Encode, base58Decode, hexToBytes, sha256, mergeExisting,
  sunpumpPolicy, trxUsdPrice, chunk, __resetSunpumpNameCacheForTests,
  SUNPUMP_CAPTURE_OPS, SUNPUMP_JOB, SUNPUMP_SOURCE, SUNPUMP_POLICY_PROVIDER, SUNPUMP_CHAIN, SUNPUMP_LAUNCHPAD,
  SUNPUMP_PROXY, SUNPUMP_PROXY_HEX, SUNPUMP_PROXY_LOG_ADDRESS, SUNPUMP_IMPLEMENTATION, SUNPUMP_IMPLEMENTATION_HEX,
  SUNPUMP_MAX_CALLS, KEYLESS_MAX_CALLS, TX_INFO_CAP, NAME_CALL_CAP, TOPICS, EVENT_SIGNATURES, LIFECYCLE_EVENTS,
  TOKEN_SUPPLY, TOTAL_SALE, VIRTUAL_TOKEN_RESERVE, VIRTUAL_TRX_RESERVE, LAUNCH_TRX_RESERVE, CURVE_K,
  TRON_ADDRESS_SHAPE, TRX_PRICE_MAX_AGE_MS,
} from './capture-sunpump.ts'
import { PAD_LABELS, CHAIN_LABELS, PAD_CHAINS, CHAIN_LOG_PADS } from './launchpad-registry.ts'
import { readMemeGraduation } from './capture-meme-read.ts'

const HOUR = 3_600_000
const NOW = new Date(Math.floor((Date.now() - 7 * 86_400_000) / HOUR) * HOUR)
const CAPTURED = NOW.toISOString()
const hourBefore = (n: number) => new Date(NOW.getTime() - n * HOUR).toISOString()

// ─── Addresses verified on chain, 2026-09-17 ─────────────────────────────────
// Every pair below was read out of a live TronGrid answer; the transaction that
// carried each one is named on the fixture that uses it.
const TOKEN_LAUNCHED = 'TEDJZjYojq5WCM5RpW7N89Zw3PpKQtgjam'          // 41 2e8af87d…
const TOKEN_LAUNCHED_HEX = '2e8af87d9f479f8659bb215f716b3cebeb42a6bb'
const TOKEN_CREATED = 'TUPFixViRqQHNEtJkozmuxqYVE7BAPmfsV'           // 41 c9fe850c…
const TOKEN_CREATED_HEX = 'c9fe850ce17b5f9f4437e6deaef38f3f85db3d0c'
const TOKEN_TRADED = 'TJopiVZVbBTz8AoeRz7yf33ps4VucFZ73M'            // 41 60f2c909…
const TOKEN_TRADED_HEX = '60f2c9098cc50d5895d5e2a7b3ea4d81155d338d'
const PAIR = 'TCWhkRw7Bfgt53RzR49KQtztK8omMCpTUe'                    // 41 1be524d1…
const PAIR_HEX = '1be524d1e620f215414f3cee197fddf78e05b85c'
const CREATOR_HEX = 'cccb89e1d3114e6bc147a326b81f3410eb8610a2'

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const reserveWord = (tokens: number) => (BigInt(Math.round(tokens * 1e6)) * (10n ** 12n)).toString(16).padStart(64, '0')

// ─── SHA-256, which base58check is only as trustworthy as ────────────────────

Deno.test('sha256 matches the published vectors', () => {
  const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  eq(hex(sha256(new Uint8Array(0))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  eq(hex(sha256(new TextEncoder().encode('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  // 56 bytes exercises the second padding block, which is where a hand-written
  // implementation usually goes wrong.
  eq(
    hex(sha256(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  )
})

// ─── hex ⇄ base58check ───────────────────────────────────────────────────────

Deno.test('hexToBase58Check reproduces the two SunPump contract addresses', () => {
  // The proxy: read out of `wallet/getcontract` and confirmed as the emitter of
  // every event log this lane decodes.
  eq(hexToBase58Check(SUNPUMP_PROXY_HEX), SUNPUMP_PROXY)
  eq(hexToBase58Check(SUNPUMP_IMPLEMENTATION_HEX), SUNPUMP_IMPLEMENTATION)
  // The log form of the proxy is the same 20 bytes with the 0x41 prefix stripped.
  eq(SUNPUMP_PROXY_HEX, `41${SUNPUMP_PROXY_LOG_ADDRESS}`)
  eq(addressFromLog(SUNPUMP_PROXY_LOG_ADDRESS), SUNPUMP_PROXY)
})

Deno.test('base58check round-trips, and a flipped character does not', () => {
  for (const [hex, base58] of [[SUNPUMP_PROXY_HEX, SUNPUMP_PROXY], [SUNPUMP_IMPLEMENTATION_HEX, SUNPUMP_IMPLEMENTATION], [`41${TOKEN_LAUNCHED_HEX}`, TOKEN_LAUNCHED]]) {
    eq(hexToBase58Check(hex), base58)
    eq(base58CheckToHex(base58), hex)
  }
  // The checksum is the whole point: a single changed character has to fail,
  // otherwise a mangled address would be stored as if it were real.
  const broken = `${SUNPUMP_PROXY.slice(0, -1)}${SUNPUMP_PROXY.endsWith('w') ? 'x' : 'w'}`
  eq(base58CheckToHex(broken), null)
  // and base58 has no 0, O, I or l, so a string containing one is not an address.
  eq(base58Decode('TTfvyrAz86hbZk5iDpKD78pqLGgi8C7AA0'), null)
})

Deno.test('base58 encode and decode agree on leading zero bytes', () => {
  eq(base58Encode(new Uint8Array([0, 0, 1])), '112')
  eq([...(base58Decode('112') ?? [])], [0, 0, 1])
  eq([...(hexToBytes('0x41Ff') ?? [])], [0x41, 0xff], 'a 0x prefix and mixed case are both accepted: the value is the same bytes')
  eq([...(hexToBytes('41ff') ?? [])], [0x41, 0xff])
  eq(hexToBytes('41f'), null, 'an odd-length string is not bytes')
})

Deno.test('a word or a log address that is not an address yields null, never a repaired string', () => {
  eq(addressFromWord(word(TOKEN_LAUNCHED_HEX)), TOKEN_LAUNCHED)
  eq(addressFromWord(`0x${word(TOKEN_LAUNCHED_HEX)}`), TOKEN_LAUNCHED)
  eq(addressFromWord('deadbeef'), null, 'a short word is not an address')
  eq(addressFromWord(null), null)
  eq(addressFromLog(''), null)
  eq(addressFromLog(TOKEN_LAUNCHED_HEX), TOKEN_LAUNCHED)
  assert(TRON_ADDRESS_SHAPE.test(TOKEN_LAUNCHED))
  assert(!TRON_ADDRESS_SHAPE.test(SUNPUMP_PROXY_HEX))
})

// ─── Topic0 ──────────────────────────────────────────────────────────────────

Deno.test('every topic0 is 32 bytes, distinct, and matches the prefixes read off the contract', () => {
  const values = Object.values(TOPICS)
  eq(new Set(values).size, values.length, 'two events sharing a topic0 would misfile every row')
  for (const topic of values) assert(/^[0-9a-f]{64}$/.test(topic), topic)
  // The two prefixes the contract research produced. They are four bytes of a
  // keccak hash, so a match also pins the ARGUMENT TYPES: keccak of a different
  // type list would not collide here.
  assert(TOPICS.TokenCreate.startsWith('1ff0a01c'))
  assert(TOPICS.TokenPurchased.startsWith('63abb625'))
  // And every signature has a hash, so a new event cannot be half-added.
  for (const name of Object.keys(EVENT_SIGNATURES)) assert(name in TOPICS, name)
  eq(LIFECYCLE_EVENTS.length, 3)
  for (const name of LIFECYCLE_EVENTS) assert(name in TOPICS, name)
})

// ─── Log decoding, from fixtures rebuilt out of real transactions ────────────

/** tx 43a80fba683d31d3d416a297b49735d643be7d07e38e046d028417307ea340fb —
 *  a creation with a dev buy in the same transaction. TokenCreate has NO indexed
 *  arguments; TokenPurchased indexes token and buyer. */
const CREATE_LOGS = [
  { address: TOKEN_CREATED_HEX, topics: ['ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'], data: word('1') },
  {
    address: SUNPUMP_PROXY_LOG_ADDRESS,
    topics: [TOPICS.TokenCreate],
    data: word(TOKEN_CREATED_HEX) + word('19ae8') + word(CREATOR_HEX),
  },
  {
    address: SUNPUMP_PROXY_LOG_ADDRESS,
    topics: [TOPICS.TokenPurchased, word(TOKEN_CREATED_HEX), word(CREATOR_HEX)],
    data: word('1e3660') + word('4e20') + word('cd13acd3d036185aba7') + '00000000000000000000000000000000000000000375087eff8f4c338c7a5459',
  },
]

/** tx c85af11695b4bc73fe3c1e69dabba4fde0460a421e36812f3cdb94abe6e8c0d9 —
 *  LaunchPending does NOT index its token: it is the single word of `data`. */
const PENDING_LOGS = [
  { address: SUNPUMP_PROXY_LOG_ADDRESS, topics: [TOPICS.LaunchPending], data: word(TOKEN_LAUNCHED_HEX) },
  {
    address: SUNPUMP_PROXY_LOG_ADDRESS,
    topics: [TOPICS.TokenPurchased, word(TOKEN_LAUNCHED_HEX), word(CREATOR_HEX)],
    data: word('29f433d5') + word('2faf080') + word('1269c1a273bddf7fe34c7') + '000000000000000000000000000000000000000000e07a4670c9b837dde4307b',
  },
]

/** tx 058eb53a1effb0f5ae18c66f6b6a6d28fae6df0db06ad7843466c5a24a6ca30c —
 *  TokenLaunched INDEXES its token and carries NO `data` key at all, and the
 *  SunSwap V2 pair emits the canonical Mint in the same transaction. */
const LAUNCH_LOGS = [
  { address: PAIR_HEX, topics: [TOPICS.PairMint, word(CREATOR_HEX)], data: word('a69332d63daf3dd7e4307b') + word('174876e800') },
  { address: SUNPUMP_PROXY_LOG_ADDRESS, topics: [TOPICS.TokenLaunched, word(TOKEN_LAUNCHED_HEX)] },
]

Deno.test('TokenCreate is decoded out of data words, not topics', () => {
  const decoded = decodeTransaction(CREATE_LOGS)
  eq(decoded.lifecycle.length, 1)
  eq(decoded.lifecycle[0].kind, 'TokenCreate')
  eq(decoded.lifecycle[0].token, TOKEN_CREATED)
  // 0x19ae8 is 105,192, one below the tokenCount of 105,193 read off the
  // contract on the same day, which is what a zero-based index should be.
  eq(decoded.lifecycle[0].tokenIndex, 105192)
  eq(decoded.lifecycle[0].creator, hexToBase58Check(`41${CREATOR_HEX}`))
  eq(decoded.trades.length, 1)
  eq(decoded.trades[0].kind, 'TokenPurchased')
  eq(decoded.trades[0].token, TOKEN_CREATED)
  assertAlmostEquals(decoded.trades[0].tokenReserveTokens ?? 0, 1_069_939_471.9955842, 1e-3)
  // The TRC-20 Transfer on the token contract is not a SunPump event and is not
  // counted as one, and it is not counted as an unknown proxy log either.
  eq(decoded.unknownProxyLogs, 0)
  eq(decoded.pair, null)
})

Deno.test('LaunchPending is decoded out of data, and TokenLaunched out of a topic with no data at all', () => {
  const pending = decodeTransaction(PENDING_LOGS)
  eq(pending.lifecycle.map((e) => e.kind), ['LaunchPending'])
  eq(pending.lifecycle[0].token, TOKEN_LAUNCHED)
  assertAlmostEquals(pending.trades[0].tokenReserveTokens ?? 0, 271_376_811.70390177, 1e-3)

  const launched = decodeTransaction(LAUNCH_LOGS)
  eq(launched.lifecycle.map((e) => e.kind), ['TokenLaunched'])
  eq(launched.lifecycle[0].token, TOKEN_LAUNCHED)
  eq(launched.trades.length, 0)
  // The pair is recovered from the Uniswap V2 Mint the pair itself emits.
  // Cross-checked against DexScreener, which publishes this same pairAddress.
  eq(launched.pair, PAIR)
})

Deno.test('a proxy log with an unrecognised topic0 is counted, never guessed at', () => {
  const decoded = decodeTransaction([
    { address: SUNPUMP_PROXY_LOG_ADDRESS, topics: ['a'.repeat(64)], data: word(TOKEN_CREATED_HEX) },
    { address: SUNPUMP_PROXY_LOG_ADDRESS, topics: [], data: '' },
  ])
  eq(decoded.lifecycle.length, 0)
  eq(decoded.trades.length, 0)
  eq(decoded.unknownProxyLogs, 2)
  eq(decodeTransaction(null).lifecycle.length, 0, 'a missing log array is not a throw')
})

Deno.test('dataWords and tokensFromWord refuse anything that is not a clean 32-byte word', () => {
  eq(dataWords(undefined), [])
  eq(dataWords('abc'), [])
  eq(dataWords(word('1') + word('2')).length, 2)
  eq(tokensFromWord('zz'), null)
  eq(tokensFromWord(word('0')), 0)
  // Precision: 1e27 exceeds what a float can hold exactly, so the conversion
  // splits integer and fraction through BigInt rather than dividing a Number.
  eq(tokensFromWord(reserveWord(1_070_000_000)), 1_070_000_000)
  // Anything absurd is refused instead of making a wild percentage downstream.
  eq(tokensFromWord('f'.repeat(64)), null)
})

// ─── Curve maths, pinned to the constants and to three live observations ─────

Deno.test('the curve constants are the ones read off the contract', () => {
  eq(TOKEN_SUPPLY, 1_000_000_000)
  eq(TOTAL_SALE, 800_000_000)
  eq(VIRTUAL_TOKEN_RESERVE, 70_000_000)
  eq(VIRTUAL_TRX_RESERVE, 35_000)
  eq(LAUNCH_TRX_RESERVE, 138_000)
  eq(CURVE_K, 35_000 * 1_070_000_000)
})

Deno.test('bonding progress is 0 at creation and about 100 at the graduation threshold', () => {
  // A brand-new token: the reserve is supply PLUS the virtual reserve, so the
  // brief's formula without the subtraction would read -8.74% here.
  eq(bondingProgressPct(TOKEN_SUPPLY + VIRTUAL_TOKEN_RESERVE), 0)
  eq((TOKEN_SUPPLY - (TOKEN_SUPPLY + VIRTUAL_TOKEN_RESERVE)) / TOTAL_SALE * 100, -8.75, 'the un-corrected formula, kept as the reason for the correction')
  // Live, tx 43a80fba…: a dev buy of about 60,500 tokens.
  assertAlmostEquals(bondingProgressPct(1_069_939_471.9955842) ?? 0, 0.007566, 1e-5)
  // Live, tx c85af11…: the buy that made the contract emit LaunchPending.
  assertAlmostEquals(bondingProgressPct(271_376_811.70390177) ?? 0, 99.8279, 1e-3)
  // The stated threshold, 200,000,000 real tokens left, is exactly 100%.
  eq(bondingProgressPct(200_000_000 + VIRTUAL_TOKEN_RESERVE), 100)
  eq(bondingProgressPct(null), null)
})

Deno.test('the constant product ties the token reserve to LAUNCH_TRX_RESERVE', () => {
  // k / tokenReserve is the TRX side of the curve. At the reserve observed when
  // the contract emitted LaunchPending it is 138,001 TRX, which is the
  // LAUNCH_TRX_RESERVE constant to five figures — that agreement is the evidence
  // the invariant below is the right one to price against.
  assertAlmostEquals(CURVE_K / 271_376_811.70390177, LAUNCH_TRX_RESERVE, 5)
  eq(CURVE_K / (TOKEN_SUPPLY + VIRTUAL_TOKEN_RESERVE), VIRTUAL_TRX_RESERVE)
})

Deno.test('curve fdv prices the whole supply off the invariant, and is null without both inputs', () => {
  // At creation: 35,000 / 1.07e9 TRX a token across 1e9 tokens = 32,710 TRX.
  assertAlmostEquals(curveFdvUsd(TOKEN_SUPPLY + VIRTUAL_TOKEN_RESERVE, 1) ?? 0, 32_710.28, 0.05)
  // At a TRX price of 0.334 (the quote our own market_assets held on the day).
  assertAlmostEquals(curveFdvUsd(TOKEN_SUPPLY + VIRTUAL_TOKEN_RESERVE, 0.334269) ?? 0, 10_934.5, 1)
  // At the graduation threshold the curve is worth about 138,000 TRX of float,
  // so the fdv is a large multiple of the starting one.
  assert((curveFdvUsd(271_376_811.7, 1) ?? 0) > 500_000)
  eq(curveFdvUsd(null, 1), null)
  eq(curveFdvUsd(1_070_000_000, null), null, 'no TRX price is no fdv, never a zero')
  eq(curveFdvUsd(0, 1), null)
})

// ─── Stage rules ─────────────────────────────────────────────────────────────

Deno.test('the three stage rules, and what a null percentage means', () => {
  const at = (launched: boolean, pending: boolean, pct: number | null) => classifyStage({ launched, pending }, pct)
  eq(at(true, false, null), 'graduates', 'a TokenLaunched log needs no percentage')
  eq(at(true, true, 12), 'graduates', 'launched outranks pending')
  eq(at(false, true, 12), 'aboutGraduates', 'the contract said it is about to migrate; a percentage does not overrule it')
  eq(at(false, false, 79.999), 'newCreations')
  eq(at(false, false, 80), 'aboutGraduates', 'the threshold is inclusive')
  eq(at(false, false, 99.9), 'aboutGraduates')
  // "We did not read a trade for it" is a new creation, never a near-graduate.
  eq(at(false, false, null), 'newCreations')
  eq(at(false, false, 0), 'newCreations')
})

// ─── Response readers ────────────────────────────────────────────────────────

Deno.test('eventRefsFrom keeps the transaction and the block clock and ignores the empty result object', () => {
  const read = eventRefsFrom({
    data: [
      { event_name: 'TokenLaunched', transaction_id: 'abc', block_timestamp: 1789546206000, result: {}, result_type: {} },
      { event_name: 'TokenLaunched', transaction_id: '', block_timestamp: 1 },
      { event_name: 'TokenLaunched', transaction_id: 'def', block_timestamp: 'nope' },
    ],
    meta: { fingerprint: 'FP' },
  })
  eq(read.refs.length, 1)
  eq(read.refs[0], { eventName: 'TokenLaunched', transactionId: 'abc', blockTimestampMs: 1789546206000 })
  eq(read.fingerprint, 'FP')
  eq(eventRefsFrom(null).refs, [])
})

Deno.test('dexQuotesFrom keeps the deepest pair per token and drops a row whose address is not TRON', () => {
  const quotes = dexQuotesFrom([
    { chainId: 'tron', baseToken: { address: TOKEN_LAUNCHED, name: 'The Justin Sun Prize', symbol: 'TJSP' }, priceUsd: '0.00003416', marketCap: 34161, fdv: 34161, pairAddress: PAIR, liquidity: { usd: 10 } },
    { chainId: 'tron', baseToken: { address: TOKEN_LAUNCHED, symbol: 'SHALLOW' }, priceUsd: '9', pairAddress: 'x', liquidity: { usd: 1 } },
    { chainId: 'tron', baseToken: { address: '0xnot-a-tron-address' }, priceUsd: '1' },
  ])
  eq(quotes.size, 1)
  eq(quotes.get(TOKEN_LAUNCHED)?.symbol, 'TJSP')
  eq(quotes.get(TOKEN_LAUNCHED)?.pair, PAIR)
  eq(quotes.get(TOKEN_LAUNCHED)?.marketCap, 34161)
  eq(dexQuotesFrom(null).size, 0)
})

Deno.test('decodeAbiString reads a constant-call string return and refuses anything else', () => {
  const encoded = word('20') + word('4') + '5445535400000000000000000000000000000000000000000000000000000000'
  eq(decodeAbiString(encoded), 'TEST')
  eq(decodeAbiString(`0x${encoded}`), 'TEST')
  eq(decodeAbiString(word('20') + word('0')), null, 'an empty string is no name')
  eq(decodeAbiString(word('40') + word('4')), null, 'a non-standard offset is not decoded on a guess')
  eq(decodeAbiString(''), null)
  eq(decodeAbiString(null), null)
})

// ─── Policy ──────────────────────────────────────────────────────────────────

Deno.test('the policy row is this lane own, and a missing row is not a disabled lane', () => {
  eq(SUNPUMP_POLICY_PROVIDER, 'trongrid')
  eq(SUNPUMP_SOURCE, 'trongrid')
  eq(SUNPUMP_JOB, 'sunpump_stages')
  eq(sunpumpPolicy(undefined), { enabled: true, cadenceSeconds: 3600, maxCalls: SUNPUMP_MAX_CALLS })
  // A CoinGecko row for a different feature must never answer for this lane.
  eq(sunpumpPolicy([{ provider: 'coingecko', feature: 'launchpad_stages', cadence_seconds: 60, enabled: false, max_credits: 1 }] as never),
    { enabled: true, cadenceSeconds: 3600, maxCalls: SUNPUMP_MAX_CALLS })
  eq(sunpumpPolicy([{ provider: 'trongrid', feature: 'sunpump_stages', cadence_seconds: 7200, enabled: false, max_credits: 12 }] as never),
    { enabled: false, cadenceSeconds: 7200, maxCalls: 12 })
})

// ─── Registry labels the page prints ─────────────────────────────────────────

Deno.test('the page is handed a name for the pad and for the chain', () => {
  eq(PAD_LABELS[SUNPUMP_LAUNCHPAD], 'SunPump')
  eq(CHAIN_LABELS[SUNPUMP_CHAIN], 'TRON')
  eq(PAD_CHAINS[SUNPUMP_LAUNCHPAD], SUNPUMP_CHAIN)
  eq(CHAIN_LOG_PADS.map((p) => p.launchpad), ['sunpump'])
  // The CoinGecko lane's own labels are untouched by the merge.
  eq(PAD_LABELS['pump-fun'], 'Pump.fun')
  eq(CHAIN_LABELS['eip155:56'], 'BNB Chain')
})

// ─── A fake database, shaped like PostgREST ──────────────────────────────────
// Copied from capture-launchpads.test.ts, which is where the write contract these
// lanes share is already pinned.

// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, writes: Record<string, any[]> = {}, errors: Record<string, string> = {}) {
  const compare = (a: unknown, b: unknown) => {
    const [x, y] = [Number(a), Number(b)]
    return Number.isFinite(x) && Number.isFinite(y) ? x - y : String(a ?? '').localeCompare(String(b ?? ''))
  }
  return {
    upserts: writes,
    tables,
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const filters: [string, string, any][] = []
      let ordering: { column: string; ascending: boolean } | null = null
      const run = (max: number | null) => {
        if (errors[table]) return { data: null, error: { message: errors[table] } }
        let rows = [...(tables[table] || [])]
        for (const [key, op, operand] of filters) {
          rows = rows.filter((row) => {
            const v = row?.[key]
            if (op === 'eq') return String(v ?? '') === String(operand ?? '')
            if (op === 'lt') return compare(v, operand) < 0
            if (op === 'gte') return compare(v, operand) >= 0
            // deno-lint-ignore no-explicit-any
            if (op === 'in') return (operand as any[]).some((o) => String(o) === String(v))
            return true
          })
        }
        if (ordering) rows.sort((a, b) => compare(a?.[ordering!.column], b?.[ordering!.column]) * (ordering!.ascending ? 1 : -1))
        return { data: max == null ? rows : rows.slice(0, max), error: null }
      }
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        // deno-lint-ignore no-explicit-any
        eq: (k: string, v: any) => { filters.push([k, 'eq', v]); return q },
        // deno-lint-ignore no-explicit-any
        lt: (k: string, v: any) => { filters.push([k, 'lt', v]); return q },
        // deno-lint-ignore no-explicit-any
        gte: (k: string, v: any) => { filters.push([k, 'gte', v]); return q },
        // deno-lint-ignore no-explicit-any
        in: (k: string, v: any[]) => { filters.push([k, 'in', v]); return q },
        // deno-lint-ignore no-explicit-any
        order: (column: string, options: any = {}) => { ordering = { column, ascending: options?.ascending !== false }; return q },
        limit: (max: number) => Promise.resolve(run(max)),
        // deno-lint-ignore no-explicit-any
        upsert: (rows: any[]) => { (writes[table] ||= []).push(...rows); (tables[table] ||= []).push(...rows); return Promise.resolve({ error: null }) },
      }
      return q
    },
  }
}

const ctxFor = (name: string, maxCalls: number) => ({ jobName: 'test', caller: name, kind: 'job' as const, maxCalls })

const TRX_ROW = { normalized_symbol: 'TRX', current_price: 0.334269, last_refreshed_at: hourBefore(0) }

interface AskLog { path: string; endpoint: string; cacheKey: string }
function fakeTron(route: (path: string) => unknown) {
  const calls: AskLog[] = []
  // deno-lint-ignore no-explicit-any
  const tron = (path: string, opts: any) => {
    calls.push({ path, endpoint: opts.endpoint, cacheKey: opts.cacheKey })
    return Promise.resolve(route(path))
  }
  return { calls, tron }
}

const eventPage = (rows: { event: string; tx: string; at: number }[]) => ({
  data: rows.map((r) => ({ event_name: r.event, transaction_id: r.tx, block_timestamp: r.at, result: {}, result_type: {} })),
  meta: {},
})

/** One chain, three feeds and three transactions, exactly as the live endpoints
 * shape them: a creation with a dev buy, a pending with the buy that tipped it,
 * and a launch with the pair mint. */
function sunpumpWorld() {
  const at = NOW.getTime() - 5 * 60_000
  return (path: string) => {
    if (path.includes('event_name=TokenCreate')) return eventPage([{ event: 'TokenCreate', tx: 'tx-create', at }])
    if (path.includes('event_name=LaunchPending')) return eventPage([{ event: 'LaunchPending', tx: 'tx-pending', at: at + 1 }])
    if (path.includes('event_name=TokenLaunched')) return eventPage([{ event: 'TokenLaunched', tx: 'tx-launch', at: at + 2 }])
    if (path.includes('value=tx-create')) return { blockTimeStamp: at, log: CREATE_LOGS }
    if (path.includes('value=tx-pending')) return { blockTimeStamp: at + 1, log: PENDING_LOGS }
    if (path.includes('value=tx-launch')) return { blockTimeStamp: at + 2, log: LAUNCH_LOGS }
    return null
  }
}

const deps = (tron: ReturnType<typeof fakeTron>['tron'], extra: Record<string, unknown> = {}) => ({
  request: () => Promise.resolve(null),
  tron,
  keyed: true,
  dex: () => Promise.resolve(null),
  constantCall: () => Promise.resolve(null),
  sleep: () => Promise.resolve(),
  ...extra,
})

// ─── The lane ────────────────────────────────────────────────────────────────

Deno.test('one run writes a row per contract, on the TRON chain, under the SunPump launchpad', async () => {
  __resetSunpumpNameCacheForTests()
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({ market_assets: [TRX_ROW] }, writes)
  const { calls, tron } = fakeTron(sunpumpWorld())
  const result = await captureSunpumpStages(db, ctxFor, NOW, 'basic', deps(tron))

  eq(result.job, SUNPUMP_JOB)
  eq(result.credits, 0, 'this lane spends no CoinMarketCap credit')
  eq(result.capturedAt, CAPTURED)
  eq(result.contracts, 2, 'the creation and the token that pended and then launched')
  // Three event feeds plus three transactions.
  eq(calls.filter((c) => c.endpoint === '/v1/contracts/{address}/events').length, 3)
  eq(calls.filter((c) => c.endpoint === '/wallet/gettransactioninfobyid').length, 3)

  const rows = (writes.intel_meme_stage_snapshots || []) as Record<string, unknown>[]
  eq(rows.length, 2)
  for (const row of rows) {
    eq(row.chain, SUNPUMP_CHAIN)
    eq(row.source, SUNPUMP_SOURCE)
    eq(row.launchpad, SUNPUMP_LAUNCHPAD)
    eq(row.platform_id, null, 'a CMC DEX platform id is never invented for TRON')
    eq(row.first_seen_at, CAPTURED)
    assert(TRON_ADDRESS_SHAPE.test(String(row.contract_address)))
  }
  const graduate = rows.find((r) => r.contract_address === TOKEN_LAUNCHED)!
  eq(graduate.stage, 'graduates')
  // The SOURCE's clock, from the block, not our capture hour.
  eq(graduate.completed_at, new Date(NOW.getTime() - 5 * 60_000 + 2).toISOString())
  assert(graduate.completed_at !== CAPTURED)
  eq(graduate.migration_pool, PAIR)
  // It pended and launched in the same window, so a trade WAS read for it.
  assertAlmostEquals(Number(graduate.graduation_pct), 99.8279, 1e-3)

  const creation = rows.find((r) => r.contract_address === TOKEN_CREATED)!
  eq(creation.stage, 'newCreations')
  eq(creation.completed_at, null)
  eq(creation.migration_pool, null)
  assertAlmostEquals(Number(creation.graduation_pct), 0.007566, 1e-5)
  eq(creation.price, null, 'a curve price is not a market price; price stays null before graduation')
  // fdv IS published before graduation, derived from the curve and our own TRX quote.
  assertAlmostEquals(Number(creation.fdv), 10_934.5, 2)
  eq(result.trxPriceAt, hourBefore(0))
})

Deno.test('graduation_pct is null for a contract whose trade we did not read, and is never a zero', async () => {
  __resetSunpumpNameCacheForTests()
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({ market_assets: [TRX_ROW] }, writes)
  const at = NOW.getTime() - 60_000
  const { tron } = fakeTron((path: string) => {
    if (path.includes('event_name=TokenLaunched')) return eventPage([{ event: 'TokenLaunched', tx: 'tx-launch', at }])
    if (path.includes('event_name=')) return eventPage([])
    if (path.includes('value=tx-launch')) return { blockTimeStamp: at, log: LAUNCH_LOGS }
    return null
  })
  await captureSunpumpStages(db, ctxFor, NOW, 'basic', deps(tron))
  const rows = (writes.intel_meme_stage_snapshots || []) as Record<string, unknown>[]
  eq(rows.length, 1)
  eq(rows[0].stage, 'graduates')
  eq(rows[0].graduation_pct, null, 'not 0 — we did not read a trade, so we do not know')
  eq(rows[0].fdv, null, 'no reserve and no market quote is no fdv')
})

Deno.test('a trade for a contract no lifecycle event named does not invent a cohort member', async () => {
  __resetSunpumpNameCacheForTests()
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({ market_assets: [TRX_ROW] }, writes)
  const at = NOW.getTime() - 60_000
  const strayTrade = {
    address: SUNPUMP_PROXY_LOG_ADDRESS,
    topics: [TOPICS.TokenPurchased, word(TOKEN_TRADED_HEX), word(CREATOR_HEX)],
    data: word('1') + word('1') + word('1') + reserveWord(900_000_000),
  }
  const { tron } = fakeTron((path: string) => {
    if (path.includes('event_name=TokenCreate')) return eventPage([{ event: 'TokenCreate', tx: 'tx-create', at }])
    if (path.includes('event_name=')) return eventPage([])
    if (path.includes('value=tx-create')) return { blockTimeStamp: at, log: [...CREATE_LOGS, strayTrade] }
    return null
  })
  await captureSunpumpStages(db, ctxFor, NOW, 'basic', deps(tron))
  const rows = (writes.intel_meme_stage_snapshots || []) as Record<string, unknown>[]
  eq(rows.map((r) => r.contract_address), [TOKEN_CREATED])
  eq(rows.length, 1, `${TOKEN_TRADED} only traded; it was never created in this window`)
})

Deno.test('keyless the run is capped at six paced calls and says so', async () => {
  __resetSunpumpNameCacheForTests()
  const db = fakeDb({ market_assets: [TRX_ROW] })
  const at = NOW.getTime() - 60_000
  // Ten transactions are named; keyless only three feed reads plus three
  // transactions fit, so the run must stop rather than open all ten.
  const many = Array.from({ length: 10 }, (_, i) => ({ event: 'TokenCreate', tx: `tx-${i}`, at: at - i }))
  const { calls, tron } = fakeTron((path: string) => {
    if (path.includes('event_name=TokenCreate')) return eventPage(many)
    if (path.includes('event_name=')) return eventPage([])
    if (path.includes('value=tx-')) return { blockTimeStamp: at, log: CREATE_LOGS }
    return null
  })
  let paced = 0
  const result = await captureSunpumpStages(db, ctxFor, NOW, 'basic',
    deps(tron, { keyed: false, sleep: () => { paced += 1; return Promise.resolve() } }))

  eq(KEYLESS_MAX_CALLS, 6)
  eq(result.keyless, true)
  eq(result.calls, 6, 'three event feeds and three transactions, and not one more')
  eq(calls.length, 6)
  eq(paced, 5, 'every live call after the first is paced')
  eq(result.callBudgetExhausted, true)
  // Keyed, the same world opens far more of them.
  __resetSunpumpNameCacheForTests()
  const keyedRun = await captureSunpumpStages(fakeDb({ market_assets: [TRX_ROW] }), ctxFor, NOW, 'basic', deps(fakeTron((path: string) => {
    if (path.includes('event_name=TokenCreate')) return eventPage(many)
    if (path.includes('event_name=')) return eventPage([])
    if (path.includes('value=tx-')) return { blockTimeStamp: at, log: CREATE_LOGS }
    return null
  }).tron))
  eq(keyedRun.keyless, false)
  eq(keyedRun.txInfos, 10)
  assert(Number(keyedRun.calls) > 6)
  assert(Number(keyedRun.calls) <= SUNPUMP_MAX_CALLS)
})

Deno.test('a row another lane already wrote for this hour is merged, not overwritten', () => {
  const theirs = {
    platform_id: null, chain: 'tron', contract_address: TOKEN_CREATED, captured_at: CAPTURED,
    stage: 'aboutGraduates', name: 'Theirs', symbol: null, price: 1, market_cap: null,
    first_seen_at: hourBefore(3), source: 'coingecko', launchpad: 'other',
    graduation_pct: null, completed_at: null, migration_pool: null, fdv: null,
  }
  const mine = {
    platform_id: null, chain: 'tron', contract_address: TOKEN_CREATED, captured_at: CAPTURED,
    stage: 'newCreations', name: 'Mine', symbol: 'MINE', price: 2, market_cap: 3,
    first_seen_at: CAPTURED, source: 'trongrid', launchpad: 'sunpump',
    graduation_pct: 4, completed_at: null, migration_pool: null, fdv: 5,
  }
  const merged = mergeExisting(theirs, mine)
  // Theirs wins on everything it already said.
  eq(merged.stage, 'aboutGraduates')
  eq(merged.source, 'coingecko')
  eq(merged.launchpad, 'other')
  eq(merged.name, 'Theirs')
  eq(merged.price, 1)
  eq(merged.first_seen_at, hourBefore(3))
  // Ours fills only the gaps.
  eq(merged.symbol, 'MINE')
  eq(merged.market_cap, 3)
  eq(merged.graduation_pct, 4)
  eq(merged.fdv, 5)
})

Deno.test('a same-hour row from another lane is filled, not moved, and writes no transition', async () => {
  __resetSunpumpNameCacheForTests()
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({
    market_assets: [TRX_ROW],
    intel_meme_stage_snapshots: [{
      platform_id: null, chain: 'tron', contract_address: TOKEN_CREATED, captured_at: CAPTURED,
      stage: 'aboutGraduates', name: 'Theirs', symbol: null, price: 1, market_cap: null,
      first_seen_at: hourBefore(9), source: 'coingecko', launchpad: 'other',
      graduation_pct: null, completed_at: null, migration_pool: null, fdv: null,
    }],
  }, writes)
  const at = NOW.getTime() - 60_000
  const { tron } = fakeTron((path: string) => {
    if (path.includes('event_name=TokenCreate')) return eventPage([{ event: 'TokenCreate', tx: 'tx-create', at }])
    if (path.includes('event_name=')) return eventPage([])
    if (path.includes('value=tx-create')) return { blockTimeStamp: at, log: CREATE_LOGS }
    return null
  })
  const result = await captureSunpumpStages(db, ctxFor, NOW, 'basic', deps(tron))
  eq(result.merged, 1)
  eq(result.transitions, 0, 'the stage is not ours to move, so there is no transition either')
  const written = (writes.intel_meme_stage_snapshots || []) as Record<string, unknown>[]
  eq(written.length, 1)
  eq(written[0].stage, 'aboutGraduates')
  eq(written[0].source, 'coingecko')
  assertAlmostEquals(Number(written[0].graduation_pct), 0.007566, 1e-5)
})

Deno.test('a stage move against our own previous snapshot writes a transition with first_seen_at carried forward', async () => {
  __resetSunpumpNameCacheForTests()
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({
    market_assets: [TRX_ROW],
    intel_meme_stage_snapshots: [{
      chain: 'tron', contract_address: TOKEN_LAUNCHED, captured_at: hourBefore(6),
      stage: 'newCreations', first_seen_at: hourBefore(6), source: 'trongrid', launchpad: 'sunpump',
    }],
  }, writes)
  const at = NOW.getTime() - 60_000
  const { tron } = fakeTron((path: string) => {
    if (path.includes('event_name=TokenLaunched')) return eventPage([{ event: 'TokenLaunched', tx: 'tx-launch', at }])
    if (path.includes('event_name=')) return eventPage([])
    if (path.includes('value=tx-launch')) return { blockTimeStamp: at, log: LAUNCH_LOGS }
    return null
  })
  const result = await captureSunpumpStages(db, ctxFor, NOW, 'basic', deps(tron))
  eq(result.transitions, 1)
  const moves = (writes.intel_meme_stage_transitions || []) as Record<string, unknown>[]
  eq(moves.length, 1)
  eq(moves[0].from_stage, 'newCreations')
  eq(moves[0].to_stage, 'graduates')
  eq(moves[0].source, 'trongrid')
  eq(moves[0].launchpad, 'sunpump')
  eq(moves[0].hours_since_first_seen, 6)
  const rows = (writes.intel_meme_stage_snapshots || []) as Record<string, unknown>[]
  eq(rows[0].first_seen_at, hourBefore(6), 'first_seen_at is carried forward, never reset to now')
})

Deno.test('a disabled policy row stops the lane, and a fresh capture keeps it inside its cadence', async () => {
  const off = fakeDb({ provider_schedule_policy: [{ provider: 'trongrid', feature: 'sunpump_stages', cadence_seconds: 3600, enabled: false, max_credits: 40 }] })
  eq((await captureSunpumpStages(off, ctxFor, NOW, 'basic', deps(fakeTron(() => null).tron))).skipped, 'policy_disabled')

  const fresh = fakeDb({ intel_meme_stage_snapshots: [{ chain: 'tron', contract_address: TOKEN_CREATED, captured_at: CAPTURED, source: 'trongrid' }] })
  const { calls, tron } = fakeTron(sunpumpWorld())
  const result = await captureSunpumpStages(fresh, ctxFor, new Date(NOW.getTime() + 60_000), 'basic', deps(tron))
  eq(result.skipped, 'within_cadence')
  eq(calls.length, 0, 'a skipped run asks nothing')
})

Deno.test('a CoinGecko capture in this hour does not make the TronGrid lane skip its own run', async () => {
  __resetSunpumpNameCacheForTests()
  const db = fakeDb({
    market_assets: [TRX_ROW],
    intel_meme_stage_snapshots: [{ chain: 'solana', contract_address: 'x', captured_at: CAPTURED, source: 'coingecko' }],
  })
  const { calls, tron } = fakeTron(sunpumpWorld())
  const result = await captureSunpumpStages(db, ctxFor, new Date(NOW.getTime() + 60_000), 'basic', deps(tron))
  eq(result.skipped, undefined)
  assert(calls.length > 0)
})

Deno.test('an empty window is a result, not an error, and an unreadable feed is', async () => {
  const empty = fakeDb({ market_assets: [TRX_ROW] })
  const emptyRun = await captureSunpumpStages(empty, ctxFor, NOW, 'basic', deps(fakeTron(() => eventPage([])).tron))
  eq(emptyRun.rows, 0)
  eq(emptyRun.skipped, 'no_sunpump_events')
  eq(emptyRun.error, undefined)

  const down = await captureSunpumpStages(fakeDb({ market_assets: [TRX_ROW] }), ctxFor, NOW, 'basic', deps(fakeTron(() => null).tron))
  eq(down.error, 'sunpump_events_unavailable')
  eq(down.rows, 0)
})

Deno.test('a stale or absent TRX quote leaves fdv null instead of pricing against it', async () => {
  __resetSunpumpNameCacheForTests()
  const stale = { normalized_symbol: 'TRX', current_price: 0.334269, last_refreshed_at: new Date(NOW.getTime() - TRX_PRICE_MAX_AGE_MS - HOUR).toISOString() }
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({ market_assets: [stale] }, writes)
  const result = await captureSunpumpStages(db, ctxFor, NOW, 'basic', deps(fakeTron(sunpumpWorld()).tron))
  eq(result.partial, 'trx_price_stale')
  const creation = ((writes.intel_meme_stage_snapshots || []) as Record<string, unknown>[]).find((r) => r.contract_address === TOKEN_CREATED)!
  eq(creation.fdv, null)

  eq((await trxUsdPrice(fakeDb({}), NOW.getTime())).reason, 'trx_price_absent')
  eq((await trxUsdPrice(fakeDb({}, {}, { market_assets: 'boom' }), NOW.getTime())).reason, 'boom')
})

Deno.test('DexScreener enriches a graduate and names it, and the constant call is capped', async () => {
  __resetSunpumpNameCacheForTests()
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({ market_assets: [TRX_ROW] }, writes)
  let dexCalls = 0
  const named: string[] = []
  const result = await captureSunpumpStages(db, ctxFor, NOW, 'basic', deps(fakeTron(sunpumpWorld()).tron, {
    dex: (addresses: string[]) => {
      dexCalls += 1
      eq(addresses, [TOKEN_LAUNCHED], 'only a graduated token has a market to quote')
      return Promise.resolve([{ chainId: 'tron', baseToken: { address: TOKEN_LAUNCHED, name: 'The Justin Sun Prize', symbol: 'TJSP' }, priceUsd: '0.00003416', marketCap: 34161, fdv: 34161, pairAddress: PAIR, liquidity: { usd: 100 } }])
    },
    constantCall: (token: string, selector: string) => { named.push(`${token}:${selector}`); return Promise.resolve(selector === 'name()' ? 'New Token' : 'NEW') },
  }))
  eq(dexCalls, 1)
  eq(result.dexCalls, 1)
  const rows = (writes.intel_meme_stage_snapshots || []) as Record<string, unknown>[]
  const graduate = rows.find((r) => r.contract_address === TOKEN_LAUNCHED)!
  eq(graduate.symbol, 'TJSP')
  eq(graduate.name, 'The Justin Sun Prize')
  eq(graduate.price, 0.00003416)
  eq(graduate.market_cap, 34161)
  eq(graduate.fdv, 34161, 'a graduated token is priced by its market, not by the curve')
  // The graduate was named by DexScreener for free, so only the creation costs
  // constant calls — two of them, name and symbol.
  eq(named, [`${TOKEN_CREATED}:name()`, `${TOKEN_CREATED}:symbol()`])
  eq(result.nameCalls, 2)
  assert(Number(result.nameCalls) <= NAME_CALL_CAP)
  const creation = rows.find((r) => r.contract_address === TOKEN_CREATED)!
  eq(creation.name, 'New Token')
  eq(creation.symbol, 'NEW')
})

Deno.test('the name cache spends nothing on a token it already named', async () => {
  __resetSunpumpNameCacheForTests()
  let nameCalls = 0
  const run = () => captureSunpumpStages(fakeDb({ market_assets: [TRX_ROW] }), ctxFor, NOW, 'basic',
    deps(fakeTron(sunpumpWorld()).tron, { constantCall: () => { nameCalls += 1; return Promise.resolve('NAME') } }))
  await run()
  const first = nameCalls
  assert(first > 0)
  await run()
  eq(nameCalls, first, 'the second run asks nothing: a name does not change')
})

Deno.test('the op is registered under the name the cron job posts', () => {
  eq(Object.keys(SUNPUMP_CAPTURE_OPS), ['sunpump_stages'])
  assert(typeof SUNPUMP_CAPTURE_OPS.sunpump_stages === 'function')
  eq(TX_INFO_CAP, 24)
  eq(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
})

// ─── The read half ───────────────────────────────────────────────────────────

Deno.test('the read names trongrid as a source and prints SunPump on TRON', async () => {
  const db = fakeDb({
    intel_meme_stage_snapshots: [
      {
        platform_id: null, chain: 'tron', contract_address: TOKEN_LAUNCHED, captured_at: CAPTURED,
        stage: 'graduates', name: 'The Justin Sun Prize', symbol: 'TJSP', price: 0.00003416, market_cap: 34161,
        first_seen_at: hourBefore(4), source: 'trongrid', launchpad: 'sunpump',
        graduation_pct: 99.83, completed_at: hourBefore(1), migration_pool: PAIR, fdv: 34161,
      },
      {
        platform_id: null, chain: 'tron', contract_address: TOKEN_CREATED, captured_at: CAPTURED,
        stage: 'newCreations', name: null, symbol: null, price: null, market_cap: null,
        first_seen_at: CAPTURED, source: 'trongrid', launchpad: 'sunpump',
        graduation_pct: 0.0076, completed_at: null, migration_pool: null, fdv: 10934,
      },
    ],
    intel_meme_stage_transitions: [],
  })
  const result = await readMemeGraduation(db, { days: 7 }, NOW.getTime() + 60_000)
  eq(result.sources, [{ source: 'trongrid', latestCapturedAt: CAPTURED, rows: 2 }])
  // deno-lint-ignore no-explicit-any
  const pads = result.launchpads as any[]
  eq(pads.length, 1)
  eq(pads[0].key, 'sunpump')
  eq(pads[0].label, 'SunPump', 'the page must never print a raw pad id at a reader')
  eq(pads[0].chain, 'tron')
  eq(pads[0].contracts, 2)
  // deno-lint-ignore no-explicit-any
  const chains = result.chains as any[]
  eq(chains[0].label, 'TRON')
  // One of the two contracts was first seen inside the window and graduated.
  eq(result.cohort, { firstSeenInWindow: 2, graduatedInWindow: 1 })
  eq(result.graduationRate, 0.5)
  // deno-lint-ignore no-explicit-any
  const graduates = (result.funnel as any[]).find((row) => row.stage === 'graduates')
  eq(graduates.count, 1)
  eq(graduates.contracts[0].launchpadLabel, 'SunPump')
  eq(graduates.contracts[0].migrationPool, PAIR)
})

Deno.test('the read can be filtered down to the trongrid source alone', async () => {
  const db = fakeDb({
    intel_meme_stage_snapshots: [
      { chain: 'tron', contract_address: TOKEN_CREATED, captured_at: CAPTURED, stage: 'newCreations', first_seen_at: CAPTURED, source: 'trongrid', launchpad: 'sunpump' },
      { chain: 'solana', contract_address: 'SoLaNaAddressThatIsNotReadHere111111111111', captured_at: CAPTURED, stage: 'newCreations', first_seen_at: CAPTURED, source: 'coingecko', launchpad: 'pump-fun' },
    ],
    intel_meme_stage_transitions: [],
  })
  const all = await readMemeGraduation(db, { days: 7 }, NOW.getTime() + 60_000)
  eq((all.sources as unknown[]).length, 2)
  const mine = await readMemeGraduation(db, { days: 7, source: 'trongrid' }, NOW.getTime() + 60_000)
  eq(mine.sources, [{ source: 'trongrid', latestCapturedAt: CAPTURED, rows: 1 }])
  eq((mine.launchpads as unknown[]).length, 1)
})

Deno.test('a CoinMarketCap row in this hour does not make the TronGrid lane skip either', async () => {
  // The companion of the CoinGecko case above. Three lanes write this table at
  // :37, :41 and :43; each measures its OWN cadence, against rows whose `source`
  // is its own. Proven in production on 2026-09-17: this lane wrote 3 rows at the
  // 14:00 capture hour in which the CoinGecko lane had already written 116.
  __resetSunpumpNameCacheForTests()
  const db = fakeDb({
    market_assets: [TRX_ROW],
    intel_meme_stage_snapshots: [
      { chain: 'solana', contract_address: 'So11111111111111111111111111111111111111112', captured_at: CAPTURED, source: 'coinmarketcap' },
    ],
  })
  const { calls, tron } = fakeTron(sunpumpWorld())
  const result = await captureSunpumpStages(db, ctxFor, new Date(NOW.getTime() + 60_000), 'basic', deps(tron))
  eq(result.skipped, undefined)
  assert(calls.length > 0)

  // Its OWN row in the same hour still stops it.
  const mine = fakeDb({ intel_meme_stage_snapshots: [{ chain: 'tron', contract_address: TOKEN_CREATED, captured_at: CAPTURED, source: SUNPUMP_SOURCE }] })
  const second = fakeTron(sunpumpWorld())
  const skipped = await captureSunpumpStages(mine, ctxFor, new Date(NOW.getTime() + 60_000), 'basic', deps(second.tron))
  eq(skipped.skipped, 'within_cadence')
  eq(second.calls.length, 0)
})

Deno.test('a name lookup is a call: it counts against the budget and is paced like every other', async () => {
  // THE DEFECT THIS PINS. On the first production run (2026-09-17, keyless) the
  // lane spent its six budgeted calls on the feeds and the transactions and then
  // fired FOUR MORE, unbudgeted and unpaced, at wallet/triggerconstantcontract.
  // The anonymous host answered 429 to the last four of them. A keyless run has
  // to make six calls in total, names included.
  __resetSunpumpNameCacheForTests()
  const at = NOW.getTime() - 60_000
  const { calls, tron } = fakeTron((path: string) => {
    if (path.includes('event_name=TokenCreate')) return eventPage([{ event: 'TokenCreate', tx: 'tx-create', at }])
    if (path.includes('event_name=')) return eventPage([])
    if (path.includes('value=tx-create')) return { blockTimeStamp: at, log: CREATE_LOGS }
    return null
  })
  let paced = 0
  const named: string[] = []
  const result = await captureSunpumpStages(fakeDb({ market_assets: [TRX_ROW] }), ctxFor, NOW, 'basic', deps(tron, {
    keyed: false,
    sleep: () => { paced += 1; return Promise.resolve() },
    constantCall: (token: string, selector: string) => { named.push(`${token}:${selector}`); return Promise.resolve(selector === 'name()' ? 'Name' : 'SYM') },
  }))
  // 3 event feeds + 1 transaction + 2 name calls = the whole keyless budget.
  eq(calls.length, 4, 'four TronGrid GETs')
  eq(named, [`${TOKEN_CREATED}:name()`, `${TOKEN_CREATED}:symbol()`])
  eq(result.nameCalls, 2)
  eq(result.calls, KEYLESS_MAX_CALLS, 'names are inside the budget, not beside it')
  eq(paced, 5, 'every live call after the first is paced, the name calls included')
})

Deno.test('a name lookup that would overrun the budget is not started', async () => {
  __resetSunpumpNameCacheForTests()
  const at = NOW.getTime() - 60_000
  // Two transactions keyless: 3 feeds + 2 transactions = 5 of 6, so a PAIR of
  // name calls does not fit and neither is started. A half-named token would
  // cost a call and buy nothing.
  const { tron } = fakeTron((path: string) => {
    if (path.includes('event_name=TokenCreate')) return eventPage([{ event: 'TokenCreate', tx: 'tx-a', at }, { event: 'TokenCreate', tx: 'tx-b', at: at - 1 }])
    if (path.includes('event_name=')) return eventPage([])
    if (path.includes('value=tx-a')) return { blockTimeStamp: at, log: CREATE_LOGS }
    if (path.includes('value=tx-b')) return { blockTimeStamp: at - 1, log: PENDING_LOGS }
    return null
  })
  let namedCalls = 0
  const result = await captureSunpumpStages(fakeDb({ market_assets: [TRX_ROW] }), ctxFor, NOW, 'basic', deps(tron, {
    keyed: false, constantCall: () => { namedCalls += 1; return Promise.resolve('X') },
  }))
  eq(namedCalls, 0)
  eq(result.nameCalls, 0)
  assert(Number(result.calls) <= KEYLESS_MAX_CALLS)
  eq(result.callBudgetExhausted, true)
  // The rows are still written; only the names are missing, which is the honest
  // degradation: a NULL name, never a skipped contract.
  eq(result.contracts, 2)
})
