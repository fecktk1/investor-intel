// Investor Intel — meme graduation lifecycle, THIRD source: SunPump on TRON,
// read off the chain through TronGrid.
//
// WHY THIS EXISTS. `/intel/graduation` has two lanes today. The CoinMarketCap
// `meme_stages` lane answers 200, one credit and three EMPTY arrays every hour
// on this account. The CoinGecko `launchpad_stages` lane fills the tables from
// GeckoTerminal's dex registry — which covers Solana, BNB Chain, Base and
// Robinhood Chain and does NOT cover SunPump, because SunPump's bonding curve
// lives in one TRON contract and has no GeckoTerminal dex id at all. So this
// lane does not ask a discovery API what happened. It reads the launchpad
// contract's own event log.
//
// That difference matters for one number in particular. A graduated token LEAVES
// a discovery feed, which is why the CoinGecko lane has to re-poll every cohort
// member it still tracks in order to observe a single graduation. A chain log
// never forgets: `TokenLaunched` is emitted once, stays in the log forever, and
// is read by asking for it by name. This lane therefore observes graduations
// directly and cheaply, and it does so with ZERO per-token polling.
//
// ── THE CONTRACT ─────────────────────────────────────────────────────────────
// SunPump is a proxy. Verified 2026-09-17 through `wallet/getcontract` and
// re-verified here against live logs:
//
//   proxy           TTfvyrAz86hbZk5iDpKD78pqLGgi8C7AAw  "LaunchPadProxy"
//                   hex 41c22dd1b7bc7574e94563c8282f64b065bc07b2fa
//   implementation  TKYQmYdssV2UVjr7UmNNt4jti1mmm7ZWnX  "LaunchPad"
//                   hex 416900ae70c3b47bc314762deb2b73cc175e4bc64e
//
// The events are declared on the IMPLEMENTATION's ABI but EMITTED by the PROXY
// (a delegatecall keeps the caller's address), so every read below is addressed
// to the PROXY. The implementation's own `/events` feed holds exactly one entry,
// its deploy-time `TokenCreate` from 2024-10-02, and is useless for capture.
//
// ── ONE CORRECTION TO THE BRIEF THIS LANE WAS BUILT FROM ─────────────────────
// The brief said `GET /v1/contracts/{proxy}/events` returns empty because the
// proxy carries no ABI. Probed live on 2026-09-17 it does NOT return empty: it
// returns rows with `event_name` filled in (TronGrid resolves topic0 against its
// own signature index) but `result: {}` and `result_type: {}` — the ARGUMENTS
// are missing, because decoding them needs the ABI the proxy does not have. So:
//
//   * the events feed IS usable, and it accepts `event_name=`, which turns
//     "find the 8 graduations in the last 30 days" into ONE call instead of a
//     scan. That is the single reason this lane fits inside six calls keyless.
//   * but every argument — which token, how much reserve is left — has to come
//     from the RAW log, which is `wallet/gettransactioninfobyid`. `event_name`
//     is used only to decide WHICH transactions are worth opening; the topic0 of
//     the raw log is then matched against hashes computed HERE, so a wrong or
//     changed signature index at the provider cannot misfile a row.
//
// ── TOPIC0, DERIVED NOT TRUSTED ──────────────────────────────────────────────
// Every hash in `TOPICS` below is keccak256 of the signature text, and every one
// was then confirmed against a real log read on 2026-09-17 (transaction ids are
// named on each constant). The two prefixes the brief supplied, 1ff0a01c and
// 63abb625, both match, which is what proves the ARGUMENT TYPES are right —
// keccak of the wrong type list would not collide on four bytes.
//
// ── THE BONDING CURVE, AND THE ONE PLACE THE BRIEF'S MATHS WAS WRONG ─────────
// The brief gave progress as (TOKEN_SUPPLY - tokenReserve) / TOTAL_SALE. Applied
// to a real `TokenPurchased` log that yields NEGATIVE EIGHT PER CENT at the
// moment of creation, because `tokenReserve` in the event INCLUDES the virtual
// reserve. Verified numbers, all from logs read on 2026-09-17:
//
//   at creation (tx 43a80fba…)   tokenReserve 1,069,939,472  = 1.07e9 minus a dev buy
//   at LaunchPending (tx c85af1…) tokenReserve   271,376,812
//   tokens moved into the LP at TokenLaunched (tx 058eb5…)   201,376,812
//
// The third number is the second minus exactly 70,000,000, i.e.
// VIRTUAL_TOKEN_RESERVE_AMOUNT. So the real remaining supply is
// `tokenReserve - VIRTUAL_TOKEN_RESERVE`, it starts at 1,000,000,000 and the pad
// graduates at about 200,000,000, and progress is:
//
//   progress% = (TOKEN_SUPPLY - (tokenReserve - VIRTUAL_TOKEN_RESERVE)) / TOTAL_SALE * 100
//
// which gives 0.0076% at that creation and 99.83% at that LaunchPending. The
// curve is a constant product and the same three numbers confirm it: with
// k = 35,000 TRX * 1,070,000,000 tokens, the TRX side at the LaunchPending
// reserve is k / 271,376,812 = 138,001 TRX, which is LAUNCH_TRX_RESERVE to five
// figures. That invariant is what FDV is computed from below.
//
// ── HONESTY RULES, the same ones both other lanes keep ───────────────────────
//   * `captured_at` is OUR capture hour. The chain publishes a block time per
//     EVENT, not a clock for a discovery list, so the hour is ours.
//   * `completed_at` IS the source's own clock: the block timestamp of the
//     `TokenLaunched` log. It is never our capture hour.
//   * `first_seen_at` carries forward from whichever lane saw the contract first,
//     through the SHARED `priorSnapshots` helper.
//   * `graduation_pct` is published only when a trade log for that contract was
//     actually read this run. A contract whose progress we did not read keeps
//     NULL — never 0, and never a guess from its stage.
//   * `migration_pool` is null unless the graduation transaction's own logs carry
//     the pair. They usually do: the SunSwap V2 pair emits the canonical
//     `Mint(address,uint256,uint256)` in the same transaction. Cross-checked
//     against DexScreener on 2026-09-17: the pair derived from the log for
//     TEDJZjYojq5WCM5RpW7N89Zw3PpKQtgjam is TCWhkRw7Bfgt53RzR49KQtztK8omMCpTUe,
//     which is the `pairAddress` DexScreener publishes for it.
//   * A row another lane already wrote for THIS hour is MERGED, not overwritten:
//     only still-NULL fields are filled, exactly as `capture-launchpads.ts` does.
//   * An empty window is a result. Nothing is written and one
//     `intel_sunpump_capture` line still says what was asked and what answered.
//
// ── KEYS ─────────────────────────────────────────────────────────────────────
// `TRONGRID_API_KEY` is OPTIONAL and free (trongrid.io, 15 requests a second,
// 500,000 a day). Without it the lane still runs, against the anonymous host
// which is heavily throttled: it drops its ceiling to six paced calls and records
// `keyless: true` on the run line, so a thin keyless hour is never mistaken for a
// quiet chain. Nothing in this module reads or logs the key; it travels in a
// `TRON-PRO-API-KEY` header set inside `tronGridHeaders()` and handed to
// `marketAssetsGet`, which writes the `provider_call_logs` receipt.
//
// ── LICENSING ────────────────────────────────────────────────────────────────
// TRON chain data is public; TronGrid is infrastructure over it, and its terms
// govern the SERVICE, not the facts, so nothing here is redistributed data.
// DexScreener is used only to enrich a token that has already graduated (price,
// market cap, fdv, name, symbol); its terms permit commercial use and forbid
// reselling the feed, and this lane exposes no raw feed. Neither requires a
// displayed attribution, which is why the read payload's `attribution` object is
// unchanged.

import { hourBucket } from './capture-jobs.ts'
import type { CaptureDeps, JobResult, SchedulePolicyRow } from './capture-jobs.ts'
import { dedupe, hoursBetween, priorSnapshots, upsert, MEME_STAGES } from './capture-meme.ts'
import type { MemeStage } from './capture-meme.ts'
import { marketAssetsGet } from '../market-assets/http.ts'
import { logProviderCall } from '../provider-budget.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import { GRADUATION_NEAR_PCT } from './launchpad-registry.ts'

export const SUNPUMP_JOB = 'sunpump_stages'
/** `provider_schedule_policy.provider` for this lane's row. */
export const SUNPUMP_POLICY_PROVIDER = 'trongrid'
/** The value written into `source` on every row this lane owns. */
export const SUNPUMP_SOURCE = 'trongrid'
/** `chain` and `launchpad` as stored. The label lives in `launchpad-registry.ts`
 * so the read half can print "SunPump" on "TRON" without importing this module. */
export const SUNPUMP_CHAIN = 'tron'
export const SUNPUMP_LAUNCHPAD = 'sunpump'

export { MEME_STAGES, GRADUATION_NEAR_PCT }

// ─── Addresses ───────────────────────────────────────────────────────────────

/** The proxy, which is what every event is emitted BY and every read addressed
 * TO. `logAddress` is the form a raw log entry uses: 20 bytes, no 0x41 prefix. */
export const SUNPUMP_PROXY = 'TTfvyrAz86hbZk5iDpKD78pqLGgi8C7AAw'
export const SUNPUMP_PROXY_HEX = '41c22dd1b7bc7574e94563c8282f64b065bc07b2fa'
export const SUNPUMP_PROXY_LOG_ADDRESS = 'c22dd1b7bc7574e94563c8282f64b065bc07b2fa'
/** The implementation, kept only so the next reader does not go looking for it.
 * It is NEVER read: its own events feed holds one deploy-time row. */
export const SUNPUMP_IMPLEMENTATION = 'TKYQmYdssV2UVjr7UmNNt4jti1mmm7ZWnX'
export const SUNPUMP_IMPLEMENTATION_HEX = '416900ae70c3b47bc314762deb2b73cc175e4bc64e'

// ─── Curve constants (verified, see the header) ──────────────────────────────

/** Whole tokens, not sun. Every reserve below is converted out of 18 decimals
 * before it meets these. */
export const TOKEN_SUPPLY = 1_000_000_000
export const TOTAL_SALE = 800_000_000
export const VIRTUAL_TOKEN_RESERVE = 70_000_000
export const VIRTUAL_TRX_RESERVE = 35_000
export const LAUNCH_TRX_RESERVE = 138_000
export const TOKEN_DECIMALS = 18
/** The constant product the curve holds: the TRX side times the token side,
 * both at creation. k / tokenReserve is the TRX side at any point, so
 * k / tokenReserve^2 is the price in TRX. */
export const CURVE_K = VIRTUAL_TRX_RESERVE * (TOKEN_SUPPLY + VIRTUAL_TOKEN_RESERVE)

// ─── Bounds ──────────────────────────────────────────────────────────────────

/** Per-run call ceiling with a key, and the value the migration seeds into
 * `provider_schedule_policy.max_credits`. TronGrid is rate limited, not metered. */
export const SUNPUMP_MAX_CALLS = 40
/** Keyless the anonymous host is heavily throttled and shared with every other
 * anonymous caller on this egress, so the run is tiny and paced. */
export const KEYLESS_MAX_CALLS = 6
export const KEYLESS_SPACING_MS = 2500
/** Event pages per event name. One page of 200 covers a month of TokenCreate
 * (594 in 30 days, measured 2026-09-17), so an hour never needs a second. */
export const EVENT_PAGES = 2
export const EVENTS_PER_PAGE = 200
/** Transactions opened for their raw logs in one run. Every decision-carrying
 * argument comes out of these, so this is the number that actually bounds the
 * run once the three event lists are read. */
export const TX_INFO_CAP = 24
/** Constant calls (`name()`/`symbol()`) per run, across all tokens. Two per
 * token, so ten tokens are named in a full run.
 *
 * This is a SECOND ceiling under the run's own call budget, not beside it. The
 * first production run (2026-09-17, keyless) spent its six budgeted calls on the
 * feeds and the transactions and then fired four unbudgeted, unpaced constant
 * calls; the anonymous host answered 429 to the last four of them. Every constant
 * call now goes through the same counter and the same pacing as everything else,
 * so a keyless run really does make six calls. */
export const NAME_CALL_CAP = 20
/** Addresses per DexScreener request. Their documented ceiling. */
export const DEX_BATCH = 30
/** DexScreener requests per run. */
export const DEX_CALL_CAP = 2
/** How far back a run reads when there is no previous capture to resume from. */
export const COLD_START_HOURS = 24
/** and the ceiling on the window even when the last capture is older than that,
 * so a lane that has been paused for a month does not try to read a month. */
export const MAX_WINDOW_HOURS = 72
/** A TRX price older than this is not a price. FDV then stays NULL rather than
 * being computed against a stale quote. */
export const TRX_PRICE_MAX_AGE_MS = 24 * 3600_000
/** Stop STARTING calls this far into the invocation. */
export const RUN_BUDGET_MS = 80_000
/** Bound on the same-hour merge read. */
const SAME_HOUR_CAP = 2000

const CADENCE_GRACE = 0.9
const LANE_CADENCE_SECONDS = 3600

// ─── sha256, so base58check needs no import ──────────────────────────────────
//
// Addresses are converted in tight loops and the conversion has to be
// synchronous; `crypto.subtle.digest` is not. Thirty lines of SHA-256 is a
// smaller liability than a wasm import in an Edge Function, and the vector at
// the bottom of the tests pins it.

const SHA_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0

export function sha256(message: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const length = message.length
  const padded = new Uint8Array((((length + 9) + 63) >> 6) << 6)
  padded.set(message)
  padded[length] = 0x80
  const view = new DataView(padded.buffer)
  const bits = length * 8
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000))
  view.setUint32(padded.length - 4, bits >>> 0)
  const w = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const a15 = w[i - 15], a2 = w[i - 2]
      const s0 = rotr(a15, 7) ^ rotr(a15, 18) ^ (a15 >>> 3)
      const s1 = rotr(a2, 17) ^ rotr(a2, 19) ^ (a2 >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + s1 + ch + SHA_K[i] + w[i]) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) >>> 0
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0
  }
  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i])
  return out
}

// ─── base58check ─────────────────────────────────────────────────────────────

/** Bitcoin's alphabet, which TRON uses. No 0, O, I or l. */
export const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
/** The shape the table CHECK accepts, restated here so an address this module
 * would emit but the database would reject is dropped rather than written. */
export const TRON_ADDRESS_SHAPE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const HEX_SHAPE = /^[0-9a-f]+$/

export function hexToBytes(hex: string): Uint8Array | null {
  const clean = String(hex ?? '').trim().replace(/^0x/i, '').toLowerCase()
  if (!clean || clean.length % 2 !== 0 || !HEX_SHAPE.test(clean)) return null
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8
      digits[i] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0 }
  }
  let prefix = ''
  for (const byte of bytes) { if (byte !== 0) break; prefix += '1' }
  let body = ''
  for (let i = digits.length - 1; i >= 0; i--) body += BASE58_ALPHABET[digits[i]]
  return prefix + body
}

export function base58Decode(value: string): Uint8Array | null {
  const text = String(value ?? '').trim()
  if (!text) return null
  const bytes: number[] = [0]
  for (const character of text) {
    const index = BASE58_ALPHABET.indexOf(character)
    if (index < 0) return null
    let carry = index
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58
      bytes[i] = carry & 0xff
      carry = carry >> 8
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry = carry >> 8 }
  }
  for (const character of text) { if (character !== '1') break; bytes.push(0) }
  return new Uint8Array(bytes.reverse())
}

/**
 * TRON's 21-byte hex address (0x41 + 20 bytes) to base58check.
 *
 * The checksum is the FIRST FOUR BYTES of sha256(sha256(payload)), which is the
 * same rule Bitcoin uses and the reason a typo in an address cannot be stored:
 * the result would not match `TRON_ADDRESS_SHAPE` or would fail a round trip.
 * Returns null rather than a repaired string for anything that is not a 21-byte
 * 0x41-prefixed payload.
 */
export function hexToBase58Check(hex: string): string | null {
  const bytes = hexToBytes(hex)
  if (!bytes || bytes.length !== 21 || bytes[0] !== 0x41) return null
  const checksum = sha256(sha256(bytes)).subarray(0, 4)
  const full = new Uint8Array(25)
  full.set(bytes)
  full.set(checksum, 21)
  const encoded = base58Encode(full)
  return TRON_ADDRESS_SHAPE.test(encoded) ? encoded : null
}

/** base58check back to 21-byte hex, checksum VERIFIED. Used by the round-trip
 * test and by nothing in the run path, which only ever converts one way. */
export function base58CheckToHex(address: string): string | null {
  const decoded = base58Decode(address)
  if (!decoded || decoded.length !== 25 || decoded[0] !== 0x41) return null
  const payload = decoded.subarray(0, 21)
  const checksum = sha256(sha256(payload)).subarray(0, 4)
  for (let i = 0; i < 4; i++) if (checksum[i] !== decoded[21 + i]) return null
  return [...payload].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A 32-byte ABI word (a topic, or one slot of `data`) holding an address. The
 * address is the LOW 20 bytes; TRON's 0x41 prefix is added here because an EVM
 * word never carries it. */
export function addressFromWord(word: unknown): string | null {
  const clean = String(word ?? '').trim().replace(/^0x/i, '').toLowerCase()
  if (clean.length !== 64 || !HEX_SHAPE.test(clean)) return null
  return hexToBase58Check(`41${clean.slice(24)}`)
}

/** The `address` field of a raw log entry: 20 bytes, no prefix. */
export function addressFromLog(value: unknown): string | null {
  const clean = String(value ?? '').trim().replace(/^0x/i, '').toLowerCase()
  if (clean.length !== 40 || !HEX_SHAPE.test(clean)) return null
  return hexToBase58Check(`41${clean}`)
}

// ─── Event signatures and their topic0 ───────────────────────────────────────
//
// Each hash is keccak256 of the signature text. Each was CONFIRMED against a
// live log on 2026-09-17; the transaction is named so the next reader can check
// it without asking anybody.

export const EVENT_SIGNATURES = {
  TokenCreate: 'TokenCreate(address,uint256,address)',
  TokenPurchased: 'TokenPurchased(address,address,uint256,uint256,uint256,uint256)',
  TokenSold: 'TokenSold(address,address,uint256,uint256,uint256,uint256)',
  LaunchPending: 'LaunchPending(address)',
  TokenLaunched: 'TokenLaunched(address)',
  /** Not a SunPump event: the canonical Uniswap V2 pair mint, which the SunSwap
   * V2 pair emits in the SAME transaction as a graduation. It is how the
   * migration pool is recovered from a log that does not name it. */
  PairMint: 'Mint(address,uint256,uint256)',
} as const

export const TOPICS = {
  // tx 43a80fba683d31d3d416a297b49735d643be7d07e38e046d028417307ea340fb
  // No indexed arguments: tokenAddress, tokenIndex and creator are all in `data`.
  TokenCreate: '1ff0a01c8968e3551472812164f233abb579247de887db8cbb18281c149bee7a',
  // tx 52146529de9626fe9f0bc6e753076c21fcf781be017592df5ff5cd7a64286c98
  // token and buyer are INDEXED; trxAmount, fee, tokenAmount, tokenReserve are in `data`.
  TokenPurchased: '63abb62535c21a5d221cf9c15994097b8880cc986d82faf80f57382b998dbae5',
  // Same shape as TokenPurchased. Its hash is keccak of the signature above; the
  // events feed names TokenSold on the proxy (tx 8f260928…), which is how the
  // signature was chosen, and the layout mirrors TokenPurchased.
  TokenSold: 'e5dc7b09acc7972566f52bd93340cbe3fa08404d98dff6d9ff26f9ce65cb3e6f',
  // tx c85af11695b4bc73fe3c1e69dabba4fde0460a421e36812f3cdb94abe6e8c0d9
  // token is NOT indexed: it is the single word of `data`.
  LaunchPending: 'ff274cd97aba8af276149429fbc7ea387e14da22dcd51779c691af908f4feb64',
  // tx 058eb53a1effb0f5ae18c66f6b6a6d28fae6df0db06ad7843466c5a24a6ca30c
  // token IS indexed and there is no `data` at all — the key is absent, not empty.
  TokenLaunched: '2ab676eef3f76f1bd4e765a352c6cd81e62702f7ad3d363291c8b60582a45250',
  PairMint: '4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f',
} as const

/** The lifecycle events this lane asks the events feed for BY NAME, newest
 * first. Trades are deliberately absent: there are thousands an hour, they carry
 * no lifecycle meaning on their own, and the ones that matter (a dev buy in a
 * creation, the buy that tipped a curve into LaunchPending) are already in the
 * transactions these three feeds point at. */
export const LIFECYCLE_EVENTS = ['TokenLaunched', 'LaunchPending', 'TokenCreate'] as const
export type LifecycleEvent = typeof LIFECYCLE_EVENTS[number]

// ─── Small pure helpers ──────────────────────────────────────────────────────

const text = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }

export function chunk<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = []
  const step = Math.max(1, Math.trunc(size))
  for (let i = 0; i < rows.length; i += step) out.push(rows.slice(i, i + step))
  return out
}

/** One 32-byte word of an ABI `data` blob as a NUMBER OF WHOLE TOKENS.
 *
 * `Number` loses precision above 2^53 and a raw reserve is around 1e27, so the
 * value is divided by 10^18 in TWO steps through BigInt — integer part exactly,
 * fractional part to nine places — and only then becomes a float. Doing it the
 * naive way (`Number(BigInt(hex)) / 1e18`) is accurate enough for a percentage
 * but not for the reserve comparisons this lane's constants are pinned on. */
export function tokensFromWord(word: unknown): number | null {
  const clean = String(word ?? '').trim().replace(/^0x/i, '').toLowerCase()
  if (clean.length !== 64 || !HEX_SHAPE.test(clean)) return null
  let raw: bigint
  try { raw = BigInt(`0x${clean}`) } catch { return null }
  const scale = 10n ** BigInt(TOKEN_DECIMALS)
  const whole = raw / scale
  const fraction = raw % scale
  // A reserve over a trillion tokens is not a SunPump reserve; refusing it keeps
  // a corrupt word out of the maths instead of letting it make a wild percentage.
  if (whole > 1_000_000_000_000n) return null
  return Number(whole) + Number(fraction * 1_000_000_000n / scale) / 1e9
}

/** `data` split into 32-byte words. A log with no `data` key at all (which is
 * what TronGrid returns for `TokenLaunched`) yields an empty list, not a throw. */
export function dataWords(data: unknown): string[] {
  const clean = String(data ?? '').trim().replace(/^0x/i, '').toLowerCase()
  if (!clean || clean.length % 64 !== 0 || !HEX_SHAPE.test(clean)) return []
  const out: string[] = []
  for (let i = 0; i < clean.length; i += 64) out.push(clean.slice(i, i + 64))
  return out
}

const normalizeTopic = (value: unknown): string => String(value ?? '').trim().replace(/^0x/i, '').toLowerCase()

/**
 * Bonding-curve progress as a percentage, from the `tokenReserve` an event
 * published. See the header for why the virtual reserve is subtracted: without
 * it a freshly created token reads as MINUS eight per cent.
 *
 * Returns null for an unreadable reserve. The band is NOT clamped — a value
 * outside -100..100 is the caller's problem to report, exactly as the CoinGecko
 * lane treats an out-of-band published percentage.
 */
export function bondingProgressPct(tokenReserveTokens: number | null): number | null {
  if (tokenReserveTokens == null || !Number.isFinite(tokenReserveTokens)) return null
  const real = tokenReserveTokens - VIRTUAL_TOKEN_RESERVE
  const sold = TOKEN_SUPPLY - real
  const pct = (sold / TOTAL_SALE) * 100
  return Number.isFinite(pct) ? Math.round(pct * 1e6) / 1e6 : null
}

/**
 * Fully diluted valuation in USD from the curve alone, for a token that has NOT
 * graduated and therefore has no market anywhere to quote.
 *
 * The curve is a constant product (see the header): the TRX side is
 * `CURVE_K / tokenReserve`, so the price of one token in TRX is
 * `CURVE_K / tokenReserve^2`, and FDV is that price across the whole supply.
 * `tokenReserve` here is the RAW event value, virtual reserve included, because
 * the invariant is stated on the raw reserves.
 */
export function curveFdvUsd(tokenReserveTokens: number | null, trxUsd: number | null): number | null {
  if (tokenReserveTokens == null || trxUsd == null) return null
  if (!(tokenReserveTokens > 0) || !(trxUsd > 0)) return null
  const priceTrx = CURVE_K / (tokenReserveTokens * tokenReserveTokens)
  const fdv = priceTrx * TOKEN_SUPPLY * trxUsd
  return Number.isFinite(fdv) && fdv >= 0 ? fdv : null
}

/**
 * The stage rules, and nothing else:
 *
 *   graduates       a `TokenLaunched` log was read for this contract. The token
 *                   has migrated to SunSwap V2; the log is permanent evidence and
 *                   needs no second witness.
 *   aboutGraduates  a `LaunchPending` log was read, OR the progress computed from
 *                   a trade log is >= 80. `LaunchPending` is the contract's own
 *                   statement that it is about to migrate, so it outranks any
 *                   percentage.
 *   newCreations    everything else, INCLUDING a null percentage. "We did not
 *                   read a trade for it" is a new creation, never a near-graduate.
 */
export function classifyStage(seen: { launched: boolean; pending: boolean }, progressPct: number | null): MemeStage {
  if (seen.launched) return 'graduates'
  if (seen.pending) return 'aboutGraduates'
  if (progressPct != null && progressPct >= GRADUATION_NEAR_PCT) return 'aboutGraduates'
  return 'newCreations'
}

// ─── Log decoding ────────────────────────────────────────────────────────────

export interface RawLog { address?: unknown; topics?: unknown; data?: unknown }

export interface DecodedLifecycle {
  kind: 'TokenCreate' | 'LaunchPending' | 'TokenLaunched'
  token: string
  /** TokenCreate only. */
  tokenIndex: number | null
  creator: string | null
}
export interface DecodedTrade {
  kind: 'TokenPurchased' | 'TokenSold'
  token: string
  tokenReserveTokens: number | null
}
export interface DecodedTx {
  lifecycle: DecodedLifecycle[]
  trades: DecodedTrade[]
  /** The SunSwap V2 pair that emitted `Mint` in this transaction, if any. */
  pair: string | null
  /** Logs from the proxy whose topic0 is none of ours. Counted, never guessed at. */
  unknownProxyLogs: number
}

/**
 * Every SunPump log of one transaction, matched on topic0 computed HERE.
 *
 * A log from any address OTHER than the proxy is ignored for lifecycle and trade
 * purposes — a transaction touches TRC-20 transfers, the TRX wrapper and the AMM,
 * and a `Transfer` on a token contract says nothing about a bonding curve. The
 * one exception is the pair `Mint`, which is by definition emitted by the pair
 * and not by the proxy, and which is only read at all so `migration_pool` can be
 * filled from the source rather than left blank.
 */
export function decodeTransaction(logs: unknown): DecodedTx {
  const rows: RawLog[] = Array.isArray(logs) ? logs as RawLog[] : []
  const out: DecodedTx = { lifecycle: [], trades: [], pair: null, unknownProxyLogs: 0 }
  for (const log of rows) {
    const address = String(log?.address ?? '').trim().replace(/^0x/i, '').toLowerCase()
    const topics = (Array.isArray(log?.topics) ? log.topics : []).map(normalizeTopic)
    const topic0 = topics[0] ?? ''
    if (address !== SUNPUMP_PROXY_LOG_ADDRESS) {
      if (topic0 === TOPICS.PairMint && !out.pair) out.pair = addressFromLog(address)
      continue
    }
    const words = dataWords(log?.data)
    if (topic0 === TOPICS.TokenCreate) {
      // No indexed arguments: token, index, creator are data words 0, 1, 2.
      const token = addressFromWord(words[0])
      if (!token) { out.unknownProxyLogs += 1; continue }
      const indexRaw = words[1] ? Number.parseInt(words[1], 16) : Number.NaN
      out.lifecycle.push({ kind: 'TokenCreate', token, tokenIndex: Number.isFinite(indexRaw) ? indexRaw : null, creator: addressFromWord(words[2]) })
    } else if (topic0 === TOPICS.LaunchPending) {
      const token = addressFromWord(words[0])
      if (!token) { out.unknownProxyLogs += 1; continue }
      out.lifecycle.push({ kind: 'LaunchPending', token, tokenIndex: null, creator: null })
    } else if (topic0 === TOPICS.TokenLaunched) {
      // Indexed, and there is NO data key on this log at all.
      const token = addressFromWord(topics[1])
      if (!token) { out.unknownProxyLogs += 1; continue }
      out.lifecycle.push({ kind: 'TokenLaunched', token, tokenIndex: null, creator: null })
    } else if (topic0 === TOPICS.TokenPurchased || topic0 === TOPICS.TokenSold) {
      // token and buyer/seller are indexed; the four data words are
      // trxAmount, fee, tokenAmount, tokenReserve — the reserve is the LAST.
      const token = addressFromWord(topics[1])
      if (!token) { out.unknownProxyLogs += 1; continue }
      out.trades.push({
        kind: topic0 === TOPICS.TokenPurchased ? 'TokenPurchased' : 'TokenSold',
        token,
        tokenReserveTokens: tokensFromWord(words[3]),
      })
    } else {
      out.unknownProxyLogs += 1
    }
  }
  return out
}

export interface EventRef { eventName: string; transactionId: string; blockTimestampMs: number }

/** One page of `GET /v1/contracts/{proxy}/events` reduced to what this lane
 * uses: which transaction to open, and the block clock of the event. The
 * ARGUMENTS on that page are empty (see the header) and are deliberately not
 * read even when a future provider change starts filling them in — the raw log
 * is the evidence. */
// deno-lint-ignore no-explicit-any
export function eventRefsFrom(payload: any): { refs: EventRef[]; fingerprint: string | null } {
  const rows = Array.isArray(payload?.data) ? payload.data : []
  const refs: EventRef[] = []
  for (const row of rows) {
    const eventName = text(row?.event_name, 60)
    const transactionId = text(row?.transaction_id, 80)
    const stamp = Number(row?.block_timestamp)
    if (!eventName || !transactionId || !Number.isFinite(stamp)) continue
    refs.push({ eventName, transactionId, blockTimestampMs: stamp })
  }
  return { refs, fingerprint: text(payload?.meta?.fingerprint, 600) }
}

/** One DexScreener `/tokens/v1/tron/{addresses}` answer, best pair per base
 * token by liquidity. A token with no pair is simply absent, which is exactly
 * what a pre-graduation SunPump token is (verified 2026-09-17: the newly created
 * TUPFixViRqQHNEtJkozmuxqYVE7BAPmfsV returns nothing, the graduated
 * TEDJZjYojq5WCM5RpW7N89Zw3PpKQtgjam returns one sunswap pair). */
export interface DexQuote { name: string | null; symbol: string | null; priceUsd: number | null; marketCap: number | null; fdv: number | null; pair: string | null }
// deno-lint-ignore no-explicit-any
export function dexQuotesFrom(payload: any): Map<string, DexQuote> {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.pairs) ? payload.pairs : []
  const best = new Map<string, { liquidity: number; quote: DexQuote }>()
  for (const row of rows) {
    const address = text(row?.baseToken?.address, 60)
    if (!address || !TRON_ADDRESS_SHAPE.test(address)) continue
    const liquidity = num(row?.liquidity?.usd) ?? 0
    const existing = best.get(address)
    if (existing && existing.liquidity >= liquidity) continue
    best.set(address, {
      liquidity,
      quote: {
        name: text(row?.baseToken?.name, 200), symbol: text(row?.baseToken?.symbol, 50),
        priceUsd: num(row?.priceUsd), marketCap: num(row?.marketCap), fdv: num(row?.fdv),
        pair: text(row?.pairAddress, 60),
      },
    })
  }
  return new Map([...best].map(([address, entry]) => [address, entry.quote]))
}

/** `wallet/triggerconstantcontract` answers a string return as one ABI blob:
 * offset, length, bytes. Anything else — an empty result, a revert, a numeric
 * return — yields null rather than a mangled name. */
export function decodeAbiString(hex: unknown): string | null {
  const clean = String(hex ?? '').trim().replace(/^0x/i, '').toLowerCase()
  if (clean.length < 128 || clean.length % 64 !== 0 || !HEX_SHAPE.test(clean)) return null
  const offset = Number.parseInt(clean.slice(0, 64), 16)
  if (!Number.isFinite(offset) || offset !== 32) return null
  const length = Number.parseInt(clean.slice(64, 128), 16)
  if (!Number.isFinite(length) || length <= 0 || length > 256) return null
  const body = clean.slice(128, 128 + length * 2)
  if (body.length < length * 2) return null
  const bytes = hexToBytes(body)
  if (!bytes) return null
  try {
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/[\u0000]/g, '').trim()
    return decoded ? decoded.slice(0, 200) : null
  } catch { return null }
}

// ─── Transport ───────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
const _glob = globalThis as any
function env(name: string): string | undefined {
  try { const v = _glob?.Deno?.env?.get?.(name); if (v != null) return v } catch { /* permission-gated */ }
  const fromProcess = _glob?.process?.env?.[name]
  return fromProcess != null ? String(fromProcess) : undefined
}

export const TRONGRID_BASE = 'https://api.trongrid.io'
export const DEXSCREENER_BASE = 'https://api.dexscreener.com'

/** True when a TronGrid key is configured. The key itself never leaves this
 * function's scope and is never logged. */
export function tronGridKeyed(): boolean {
  return !!(env('TRONGRID_API_KEY') || '').trim()
}
function tronGridHeaders(): Record<string, string> {
  const key = (env('TRONGRID_API_KEY') || '').trim()
  return key ? { 'TRON-PRO-API-KEY': key } : {}
}
function tronGridBase(): string {
  return (env('TRONGRID_API_BASE') || TRONGRID_BASE).replace(/\/+$/, '')
}
function dexScreenerBase(): string {
  return (env('DEXSCREENER_API_BASE') || DEXSCREENER_BASE).replace(/\/+$/, '')
}

export interface TronRequestOpts { endpoint: string; cacheKey: string; ttlMs?: number; ctx?: MarketAssetsContext }
// deno-lint-ignore no-explicit-any
export type TronRequest = (path: string, opts: TronRequestOpts) => Promise<any>

/** One cached TronGrid GET. Everything goes through `marketAssetsGet`, so every
 * call lands in `provider_call_logs`, is single-flighted, is cached in memory and
 * in `market_data_response_cache`, and is negative-cached on a 4xx. Returns null
 * on any refusal or failure — the caller treats null as "unavailable", never as
 * "the chain is quiet". */
// deno-lint-ignore no-explicit-any
export function fetchTronGrid(path: string, opts: TronRequestOpts): Promise<any> {
  const clean = String(path || '').replace(/^\/+/, '')
  if (!clean) return Promise.resolve(null)
  return marketAssetsGet({
    provider: 'trongrid',
    url: `${tronGridBase()}/${clean}`,
    endpoint: opts.endpoint,
    // The tier is part of the key: an anonymous answer (which is throttled and
    // can be a 403) must not be served to a deployment that has since been given
    // a key, and the other way round.
    cacheKey: `trongrid:${tronGridKeyed() ? 'keyed' : 'anon'}:${opts.cacheKey}`,
    headers: tronGridHeaders(),
    ttlMs: opts.ttlMs,
    ctx: opts.ctx,
  })
}

/** One cached DexScreener GET, for graduated tokens only. */
// deno-lint-ignore no-explicit-any
export function fetchDexScreener(addresses: string[], ctx?: MarketAssetsContext): Promise<any> {
  const clean = addresses.filter((a) => TRON_ADDRESS_SHAPE.test(a))
  if (!clean.length) return Promise.resolve(null)
  return marketAssetsGet({
    provider: 'dexscreener',
    url: `${dexScreenerBase()}/tokens/v1/tron/${clean.map(encodeURIComponent).join(',')}`,
    endpoint: '/tokens/v1/tron/{addresses}',
    cacheKey: `dexscreener:tron:${clean.join(',')}`,
    ttlMs: 5 * 60_000,
    symbolCount: clean.length,
    ctx,
  })
}

/**
 * One TRC-20 constant call, for a name or a symbol.
 *
 * `wallet/triggerconstantcontract` is a POST. It is a read, it changes nothing
 * and it broadcasts nothing, but the node's HTTP API only accepts it as a POST,
 * so this is the one call in the lane that `marketAssetsGet` (GET only) cannot
 * carry. It is therefore written out here, kept to a hard per-run cap, made
 * injectable so tests never reach the network, and it writes its OWN
 * `provider_call_logs` receipt so the lane's call accounting has no hole in it.
 *
 * THIS IS THE ONE PATH THAT COULD NOT BE PROBED LIVE while the lane was written,
 * because the sandbox it was built in permits only GET probes and this endpoint
 * answers an empty body to one. Its failure mode is a NULL name and symbol on an
 * otherwise complete row, never a failed run.
 */
export async function tronConstantCall(token: string, selector: 'name()' | 'symbol()',
  ctx?: MarketAssetsContext, timeoutMs = 8000): Promise<string | null> {
  if (!TRON_ADDRESS_SHAPE.test(token)) return null
  const startedAt = Date.now()
  let status: number | null = null
  let failure: string | null = null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await _glob.fetch(`${tronGridBase()}/wallet/triggerconstantcontract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...tronGridHeaders() },
        body: JSON.stringify({ owner_address: SUNPUMP_PROXY, contract_address: token, function_selector: selector, visible: true }),
        signal: controller.signal,
      })
    } finally { clearTimeout(timer) }
    status = response.status
    if (!response.ok) { await response.body?.cancel(); return null }
    const payload = await response.json().catch(() => null)
    const result = Array.isArray(payload?.constant_result) ? payload.constant_result[0] : null
    return decodeAbiString(result)
  } catch (e) {
    failure = ((e as Error)?.message || 'constant_call_failed').slice(0, 200)
    return null
  } finally {
    // Best effort, and never allowed to fail the call: a missing receipt is a
    // reporting gap, a thrown logger would be a lost name.
    try {
      // deno-lint-ignore no-explicit-any
      await logProviderCall((ctx as any)?.supabase, {
        provider: 'trongrid', dataType: 'market_assets', endpoint: '/wallet/triggerconstantcontract',
        chain: SUNPUMP_CHAIN, subjectRef: `${selector}:${token}`, cacheStatus: 'miss', calls: 1,
        latencyMs: Date.now() - startedAt, statusCode: status,
        caller: ctx?.caller ?? ctx?.jobName ?? null, jobName: ctx?.jobName ?? null,
        errorMessage: failure,
      })
    } catch { /* a receipt must never fail a capture */ }
  }
}

// ─── Deps ────────────────────────────────────────────────────────────────────

export interface SunpumpDeps extends CaptureDeps {
  /** Defaults to `fetchTronGrid`. Injected in tests. */
  tron?: TronRequest
  /** Defaults to `fetchDexScreener`. */
  // deno-lint-ignore no-explicit-any
  dex?: (addresses: string[], ctx?: MarketAssetsContext) => Promise<any>
  /** Defaults to `tronConstantCall`. */
  constantCall?: (token: string, selector: 'name()' | 'symbol()', ctx?: MarketAssetsContext) => Promise<string | null>
  /** Defaults to `tronGridKeyed()`. */
  keyed?: boolean
  /** Injected so tests do not wait out the keyless pacing. */
  sleep?: (ms: number) => Promise<void>
  /** Injected so a test can pin the wall clock the run budget is measured on. */
  clock?: () => number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ─── Policy ──────────────────────────────────────────────────────────────────

/**
 * This lane's own `provider_schedule_policy` row.
 *
 * `loadSchedulePolicy` in capture-jobs.ts filters on provider 'coinmarketcap',
 * so a 'trongrid' row never reaches `deps.policy` and the lane would silently run
 * as if its row said `enabled = true`. It reads its own row instead, so DISABLING
 * IT IN THE DATABASE ACTUALLY DISABLES IT. An unreadable table is not a reason to
 * stop capturing: the documented defaults stand and the run says `policyUnavailable`.
 */
// deno-lint-ignore no-explicit-any
export async function loadSunpumpPolicy(db: any): Promise<{ rows: SchedulePolicyRow[]; reason: string | null }> {
  try {
    const { data, error } = await db.from('provider_schedule_policy')
      .select('provider,feature,cadence_seconds,enabled,min_plan,max_credits')
      .eq('provider', SUNPUMP_POLICY_PROVIDER).limit(50)
    if (error) return { rows: [], reason: String(error.message || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data as SchedulePolicyRow[] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'policy_read_failed').slice(0, 200) } }
}

export function sunpumpPolicy(rows: SchedulePolicyRow[] | undefined): { enabled: boolean; cadenceSeconds: number; maxCalls: number } {
  const row = (rows || []).find((r) => r?.feature === SUNPUMP_JOB && r.provider === SUNPUMP_POLICY_PROVIDER)
  if (!row) return { enabled: true, cadenceSeconds: LANE_CADENCE_SECONDS, maxCalls: SUNPUMP_MAX_CALLS }
  const cadence = Number(row.cadence_seconds)
  const ceiling = Number(row.max_credits)
  return {
    enabled: row.enabled !== false,
    cadenceSeconds: Number.isFinite(cadence) && cadence > 0 ? cadence : LANE_CADENCE_SECONDS,
    maxCalls: Number.isFinite(ceiling) && ceiling > 0 ? Math.trunc(ceiling) : SUNPUMP_MAX_CALLS,
  }
}

/** Newest TronGrid capture, or null. Filtered by source so the other two lanes
 * writing the same table can never make this one skip its own run. */
// deno-lint-ignore no-explicit-any
async function newestSunpumpCapture(db: any): Promise<number | null> {
  try {
    const { data, error } = await db.from('intel_meme_stage_snapshots')
      .select('captured_at').eq('source', SUNPUMP_SOURCE)
      .order('captured_at', { ascending: false }).limit(1)
    if (error) return null
    const row = Array.isArray(data) ? data[0] : data
    const parsed = Date.parse(String(row?.captured_at ?? ''))
    return Number.isFinite(parsed) ? parsed : null
  } catch { return null }
}

/**
 * TRX in USD, from OUR OWN `market_assets` table.
 *
 * Deliberately not a new provider call: the platform already stores a TRX quote
 * refreshed by the market-assets worker (verified 2026-09-17, both a
 * coinmarketcap and a coingecko row, minutes old), and adding a price provider to
 * a chain-log lane would put a second licence on a table that has one. A quote
 * older than `TRX_PRICE_MAX_AGE_MS` is treated as absent, and FDV then stays NULL
 * rather than being computed against a stale price.
 */
// deno-lint-ignore no-explicit-any
export async function trxUsdPrice(db: any, now: number): Promise<{ usd: number | null; asOf: string | null; reason: string | null }> {
  try {
    const { data, error } = await db.from('market_assets')
      .select('current_price,last_refreshed_at,normalized_symbol')
      .eq('normalized_symbol', 'TRX')
      .order('last_refreshed_at', { ascending: false }).limit(5)
    if (error) return { usd: null, asOf: null, reason: String(error.message || error).slice(0, 200) }
    for (const row of (Array.isArray(data) ? data : data ? [data] : [])) {
      const price = num(row?.current_price)
      const at = Date.parse(String(row?.last_refreshed_at ?? ''))
      if (price == null || !(price > 0) || !Number.isFinite(at)) continue
      if (now - at > TRX_PRICE_MAX_AGE_MS) return { usd: null, asOf: new Date(at).toISOString(), reason: 'trx_price_stale' }
      return { usd: price, asOf: new Date(at).toISOString(), reason: null }
    }
    return { usd: null, asOf: null, reason: 'trx_price_absent' }
  } catch (e) { return { usd: null, asOf: null, reason: ((e as Error)?.message || 'trx_price_failed').slice(0, 200) } }
}

// ─── Same-hour merge (identical rule to capture-launchpads.ts) ───────────────

const SNAPSHOT_WRITE_COLUMNS = 'platform_id,chain,contract_address,captured_at,stage,name,symbol,price,market_cap,first_seen_at,source,launchpad,graduation_pct,completed_at,migration_pool,fdv'

// deno-lint-ignore no-explicit-any
async function sameHourRows(db: any, addresses: string[], capturedAt: string): Promise<{ byAddress: Map<string, Record<string, unknown>>; reason: string | null }> {
  const byAddress = new Map<string, Record<string, unknown>>()
  if (!addresses.length) return { byAddress, reason: null }
  try {
    const { data, error } = await db.from('intel_meme_stage_snapshots')
      .select(SNAPSHOT_WRITE_COLUMNS)
      .eq('chain', SUNPUMP_CHAIN).eq('captured_at', capturedAt).in('contract_address', addresses)
      .limit(SAME_HOUR_CAP)
    if (error) return { byAddress, reason: String(error.message || error).slice(0, 200) }
    for (const row of (Array.isArray(data) ? data : data ? [data] : [])) {
      const address = text(row?.contract_address, 200)
      if (address) byAddress.set(address, row as Record<string, unknown>)
    }
    return { byAddress, reason: null }
  } catch (e) { return { byAddress, reason: ((e as Error)?.message || 'same_hour_read_failed').slice(0, 200) } }
}

/** Fills ONLY the fields that are still null and keeps everything else, `source`
 * and `stage` included. The same rule, and the same field list, as the CoinGecko
 * lane's `mergeExisting`: two lanes must not be able to corrupt each other's rows
 * in two different ways. */
export function mergeExisting(existing: Record<string, unknown>, mine: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing }
  for (const field of ['platform_id', 'launchpad', 'graduation_pct', 'completed_at', 'migration_pool', 'fdv', 'name', 'symbol', 'price', 'market_cap']) {
    if (merged[field] == null && mine[field] != null) merged[field] = mine[field]
  }
  return merged
}

// ─── Name and symbol cache ───────────────────────────────────────────────────
//
// A name does not change, so a warm isolate should not ask twice. The cache is
// module-scoped with a 24-hour entry lifetime and is also the per-run dedupe: two
// events for one token in one run cost one pair of calls, not two.

interface NameEntry { name: string | null; symbol: string | null; at: number }
const NAME_TTL_MS = 24 * 3600_000
const _names = new Map<string, NameEntry>()
export function __resetSunpumpNameCacheForTests(): void { _names.clear() }

// ─── Run lines ───────────────────────────────────────────────────────────────

export interface SunpumpEventLine { event: LifecycleEvent; state: 'read' | 'unavailable' | 'call_budget'; refs: number; reason: string | null }

function logCapture(entry: Record<string, unknown>): void {
  try { console.info(JSON.stringify({ intel_sunpump_capture: entry })) } catch { /* a log must never fail a capture */ }
}

// ─── The lane ────────────────────────────────────────────────────────────────

interface Candidate {
  token: string
  launched: boolean
  pending: boolean
  created: boolean
  /** Block clock of the `TokenLaunched` log. The SOURCE's own time. */
  completedAt: string | null
  migrationPool: string | null
  tokenReserveTokens: number | null
  /** Block clock of the trade the reserve came from, so the newest trade wins. */
  reserveAtMs: number
}

/**
 * Hourly SunPump stage capture.
 *
 * `plan` is accepted to match the lane-op signature and is DELIBERATELY unused:
 * the CoinMarketCap plan tier is not this lane's gate. This lane spends no CMC
 * credit, and gating it on a CMC plan is exactly the mistake that leaves a page
 * empty for a reason nobody can find.
 */
// deno-lint-ignore no-explicit-any
export async function captureSunpumpStages(db: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  now = new Date(), _plan = 'basic', deps: SunpumpDeps = { request: () => Promise.resolve(null) }): Promise<JobResult> {
  const job = SUNPUMP_JOB
  let calls = 0
  try {
    const loaded = await loadSunpumpPolicy(db)
    const policy = sunpumpPolicy(loaded.rows.length ? loaded.rows : deps.policy)
    if (!policy.enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }

    const newest = await newestSunpumpCapture(db)
    if (newest != null && now.getTime() - newest < policy.cadenceSeconds * 1000 * CADENCE_GRACE) {
      return { job, rows: 0, credits: 0, skipped: 'within_cadence', newestAt: new Date(newest).toISOString() }
    }

    const keyed = deps.keyed ?? tronGridKeyed()
    const keyless = !keyed
    const ceiling = Math.max(1, keyless ? Math.min(policy.maxCalls, KEYLESS_MAX_CALLS) : policy.maxCalls)
    const ctx = ctxFor('sunpump-stages', ceiling)
    const contextBudget = Number(ctx?.maxCalls)
    const budget = Math.max(0, Math.min(ceiling, Number.isFinite(contextBudget) && contextBudget >= 0 ? Math.trunc(contextBudget) : ceiling))
    if (budget < 1) return { job, rows: 0, credits: 0, skipped: 'call_budget' }

    const tron = deps.tron ?? fetchTronGrid
    const dex = deps.dex ?? fetchDexScreener
    const constantCall = deps.constantCall ?? tronConstantCall
    const sleep = deps.sleep ?? defaultSleep
    const clock = deps.clock ?? (() => Date.now())
    const startedAt = clock()
    const capturedAt = hourBucket(now)

    // The window resumes from the last capture so nothing between two runs is
    // lost, is bounded so a long pause cannot turn into a long read, and falls
    // back to a cold-start day when there is no previous capture at all.
    const sinceMs = Math.max(
      now.getTime() - MAX_WINDOW_HOURS * 3600_000,
      newest != null ? newest : now.getTime() - COLD_START_HOURS * 3600_000,
    )

    let budgetExhausted = false
    let live = 0
    // deno-lint-ignore no-explicit-any
    const ask = async (path: string, opts: Omit<TronRequestOpts, 'ctx'>): Promise<any | null> => {
      if (calls >= budget || clock() - startedAt > RUN_BUDGET_MS) { budgetExhausted = true; return null }
      if (keyless && live > 0) await sleep(KEYLESS_SPACING_MS)
      calls += 1
      live += 1
      return await tron(path, { ...opts, ctx }).catch(() => null)
    }

    let reason: string | null = loaded.reason
    const eventLines: SunpumpEventLine[] = []

    // ── 1. the three lifecycle feeds, by name, newest first ──
    const refs = new Map<string, EventRef>()   // transaction id → the event that named it
    for (const eventName of LIFECYCLE_EVENTS) {
      const line: SunpumpEventLine = { event: eventName, state: 'call_budget', refs: 0, reason: 'call_budget' }
      eventLines.push(line)
      let fingerprint: string | null = null
      for (let page = 0; page < EVENT_PAGES; page++) {
        const query = [
          `event_name=${encodeURIComponent(eventName)}`,
          `min_block_timestamp=${sinceMs}`,
          'order_by=block_timestamp,desc',
          `limit=${EVENTS_PER_PAGE}`,
          fingerprint ? `fingerprint=${encodeURIComponent(fingerprint)}` : null,
        ].filter(Boolean).join('&')
        const payload = await ask(`v1/contracts/${encodeURIComponent(SUNPUMP_PROXY)}/events?${query}`, {
          endpoint: '/v1/contracts/{address}/events',
          cacheKey: `events:${eventName}:${sinceMs}:${page}`,
        })
        if (!payload) break
        line.state = 'read'
        line.reason = null
        const read = eventRefsFrom(payload)
        for (const ref of read.refs) {
          // A transaction that already named an event keeps the FIRST naming:
          // the feeds are read graduation-first, and a transaction that both
          // pends and launches is a launch.
          if (!refs.has(ref.transactionId)) refs.set(ref.transactionId, ref)
          line.refs += 1
        }
        fingerprint = read.fingerprint
        if (!fingerprint || read.refs.length < EVENTS_PER_PAGE) break
      }
      if (line.state !== 'read') {
        line.state = budgetExhausted ? 'call_budget' : 'unavailable'
        line.reason = budgetExhausted ? 'call_budget' : 'events_unavailable'
        reason = reason || line.reason
      }
    }

    // ── 2. open the transactions and decode their raw logs ──
    // Newest first, so a run that runs out of budget keeps the freshest facts.
    const ordered = [...refs.values()].sort((a, b) => b.blockTimestampMs - a.blockTimestampMs).slice(0, TX_INFO_CAP)
    const candidates = new Map<string, Candidate>()
    const counts: Record<string, number> = { TokenCreate: 0, LaunchPending: 0, TokenLaunched: 0, trades: 0 }
    let txInfos = 0, unknownProxyLogs = 0
    for (const ref of ordered) {
      const payload = await ask(`wallet/gettransactioninfobyid?value=${encodeURIComponent(ref.transactionId)}`, {
        endpoint: '/wallet/gettransactioninfobyid',
        // A confirmed transaction never changes, so its receipt is cached for a day.
        cacheKey: `txinfo:${ref.transactionId}`,
        ttlMs: 24 * 3600_000,
      })
      if (!payload) continue
      txInfos += 1
      const blockMs = Number(payload?.blockTimeStamp)
      const at = Number.isFinite(blockMs) ? blockMs : ref.blockTimestampMs
      const decoded = decodeTransaction(payload?.log)
      unknownProxyLogs += decoded.unknownProxyLogs
      const touch = (token: string): Candidate => {
        const existing = candidates.get(token)
        if (existing) return existing
        const fresh: Candidate = { token, launched: false, pending: false, created: false, completedAt: null, migrationPool: null, tokenReserveTokens: null, reserveAtMs: -1 }
        candidates.set(token, fresh)
        return fresh
      }
      for (const event of decoded.lifecycle) {
        counts[event.kind] += 1
        const candidate = touch(event.token)
        if (event.kind === 'TokenLaunched') {
          candidate.launched = true
          // The SOURCE's clock, and only ever the source's clock.
          candidate.completedAt = new Date(at).toISOString()
          candidate.migrationPool = candidate.migrationPool ?? decoded.pair
        } else if (event.kind === 'LaunchPending') {
          candidate.pending = true
        } else {
          candidate.created = true
        }
      }
      for (const trade of decoded.trades) {
        counts.trades += 1
        // A trade for a token no lifecycle event named is not a cohort member:
        // this lane writes a row only for a contract whose own creation,
        // pending or launch it read. The trade only ever supplies progress.
        const candidate = candidates.get(trade.token)
        if (!candidate || trade.tokenReserveTokens == null) continue
        if (at >= candidate.reserveAtMs) { candidate.tokenReserveTokens = trade.tokenReserveTokens; candidate.reserveAtMs = at }
      }
    }

    const members = [...candidates.values()]
    if (!members.length) {
      const state = eventLines.every((l) => l.state === 'read') ? (budgetExhausted ? 'call_budget' : 'empty') : 'unavailable'
      logCapture({
        lane: SUNPUMP_JOB, source: SUNPUMP_SOURCE, launchpad: SUNPUMP_LAUNCHPAD, chain: SUNPUMP_CHAIN,
        keyless, capturedAt, sinceAt: new Date(sinceMs).toISOString(), calls, budget, state, reason: reason ?? null,
        events: counts, txInfos, unknownProxyLogs, contracts: 0, rows: 0, transitions: 0, merged: 0,
        nameCalls: 0, dexCalls: 0, trxPriceAt: null, graduationPctOutOfBand: 0, eventFeeds: eventLines,
      })
      return {
        job, rows: 0, credits: 0, capturedAt, calls, keyless, events: counts, eventFeeds: eventLines, txInfos,
        ...(state === 'unavailable' ? { error: 'sunpump_events_unavailable' } : { skipped: state === 'call_budget' ? 'call_budget' : 'no_sunpump_events' }),
      }
    }

    // ── 3. enrichment: our own TRX quote, then DexScreener for the graduates ──
    const trx = await trxUsdPrice(db, now.getTime())
    reason = reason || trx.reason

    const graduated = members.filter((m) => m.launched).map((m) => m.token)
    const quotes = new Map<string, DexQuote>()
    let dexCalls = 0
    for (const batch of chunk(graduated, DEX_BATCH).slice(0, DEX_CALL_CAP)) {
      if (calls >= budget || clock() - startedAt > RUN_BUDGET_MS) { budgetExhausted = true; break }
      calls += 1
      dexCalls += 1
      const payload = await dex(batch, ctx).catch(() => null)
      if (!payload) continue
      for (const [address, quote] of dexQuotesFrom(payload)) quotes.set(address, quote)
    }

    // ── 4. name and symbol, inside the run budget, hard-capped, cached a day ──
    // The pair is SEQUENTIAL and paced keyless, not fired together: the anonymous
    // host answered 429 to a burst on the first production run.
    let nameCalls = 0
    const nowMs = now.getTime()
    const askName = async (token: string, selector: 'name()' | 'symbol()'): Promise<string | null> => {
      if (calls >= budget || clock() - startedAt > RUN_BUDGET_MS) { budgetExhausted = true; return null }
      if (keyless && live > 0) await sleep(KEYLESS_SPACING_MS)
      calls += 1
      live += 1
      nameCalls += 1
      return await constantCall(token, selector, ctx).catch(() => null)
    }
    for (const member of members) {
      const cached = _names.get(member.token)
      if (cached && nowMs - cached.at < NAME_TTL_MS) continue
      const quote = quotes.get(member.token)
      if (quote?.name || quote?.symbol) { _names.set(member.token, { name: quote.name, symbol: quote.symbol, at: nowMs }); continue }
      if (nameCalls + 2 > NAME_CALL_CAP) break
      if (calls + 2 > budget) { budgetExhausted = true; break }
      const name = await askName(member.token, 'name()')
      const symbol = await askName(member.token, 'symbol()')
      if (name || symbol) _names.set(member.token, { name, symbol, at: nowMs })
    }

    // ── 5. classify, carry first_seen_at forward, merge, stage rows ──
    const addresses = members.map((m) => m.token)
    const prior = await priorSnapshots(db, SUNPUMP_CHAIN, addresses, capturedAt)
    reason = reason || prior.reason
    const current = await sameHourRows(db, addresses, capturedAt)
    reason = reason || current.reason

    const snapshots: Record<string, unknown>[] = []
    const transitions: Record<string, unknown>[] = []
    let merged = 0, graduationPctOutOfBand = 0
    const stageRows: Record<string, number> = { newCreations: 0, aboutGraduates: 0, graduates: 0 }

    for (const member of members) {
      const progress = bondingProgressPct(member.tokenReserveTokens)
      const outOfBand = progress != null && (progress < -100 || progress > 100)
      if (outOfBand) graduationPctOutOfBand += 1
      const graduationPct = outOfBand ? null : progress
      const stage = classifyStage(member, progress)
      const quote = quotes.get(member.token)
      const named = _names.get(member.token)
      const previous = prior.byAddress.get(member.token)
      const firstSeenAt = previous?.firstSeenAt || capturedAt
      const mine: Record<string, unknown> = {
        // CoinMarketCap's DEX platform id, which TRON has none of and which this
        // lane does not invent. The chain names the network instead.
        platform_id: null,
        chain: SUNPUMP_CHAIN,
        contract_address: member.token,
        captured_at: capturedAt,
        stage,
        name: quote?.name ?? named?.name ?? null,
        symbol: quote?.symbol ?? named?.symbol ?? null,
        // Pre-graduation there is no market to quote, and a curve price is not a
        // market price, so `price` stays NULL until the token trades on SunSwap.
        price: quote?.priceUsd ?? null,
        market_cap: quote?.marketCap ?? null,
        first_seen_at: firstSeenAt,
        source: SUNPUMP_SOURCE,
        launchpad: SUNPUMP_LAUNCHPAD,
        graduation_pct: graduationPct,
        completed_at: member.completedAt,
        migration_pool: member.migrationPool ?? quote?.pair ?? null,
        // Graduated: the market's own fdv. Before that: the curve's, which is a
        // DERIVED figure and is null whenever either input is missing.
        fdv: quote?.fdv ?? curveFdvUsd(member.tokenReserveTokens, trx.usd),
      }
      const existing = current.byAddress.get(member.token)
      if (existing) {
        // Another lane owns this hour's row. Fill its gaps, move nothing.
        snapshots.push(mergeExisting(existing, mine))
        merged += 1
        continue
      }
      snapshots.push(mine)
      stageRows[stage] += 1
      // No previous snapshot is not a transition: there is no stage to move from.
      if (previous?.stage && previous.stage !== stage) {
        transitions.push({
          chain: SUNPUMP_CHAIN, contract_address: member.token,
          from_stage: previous.stage, to_stage: stage, at: capturedAt,
          hours_since_first_seen: hoursBetween(firstSeenAt, capturedAt),
          source: SUNPUMP_SOURCE, launchpad: SUNPUMP_LAUNCHPAD,
          graduation_pct: graduationPct,
          completed_at: member.completedAt,
          migration_pool: member.migrationPool ?? quote?.pair ?? null,
          fdv: mine.fdv,
        })
      }
    }

    logCapture({
      lane: SUNPUMP_JOB, source: SUNPUMP_SOURCE, launchpad: SUNPUMP_LAUNCHPAD, chain: SUNPUMP_CHAIN,
      keyless, capturedAt, sinceAt: new Date(sinceMs).toISOString(), calls, budget,
      state: snapshots.length ? 'captured' : 'empty', reason: reason ?? null,
      events: counts, txInfos, unknownProxyLogs,
      contracts: snapshots.length, rows: snapshots.length - merged, merged, transitions: transitions.length,
      stages: stageRows, nameCalls, dexCalls, trxPriceAt: trx.asOf, graduationPctOutOfBand,
      eventFeeds: eventLines,
    })

    const wroteSnapshots = await upsert(db, 'intel_meme_stage_snapshots',
      dedupe(snapshots, (r) => `${r.chain}|${r.contract_address}`), 'chain,contract_address,captured_at')
    const wroteTransitions = transitions.length
      ? await upsert(db, 'intel_meme_stage_transitions', dedupe(transitions, (r) => `${r.chain}|${r.contract_address}`), 'chain,contract_address,at')
      : { rows: 0 }
    const error = wroteSnapshots.error || wroteTransitions.error || null
    return {
      job, rows: wroteSnapshots.rows, credits: 0, capturedAt, calls, keyless,
      events: counts, eventFeeds: eventLines, txInfos, stages: stageRows,
      contracts: snapshots.length, merged, transitions: wroteTransitions.rows,
      nameCalls, dexCalls, trxPriceAt: trx.asOf, graduationPctOutOfBand,
      ...(prior.truncated ? { priorTruncated: true } : {}),
      ...(budgetExhausted ? { callBudgetExhausted: true } : {}),
      ...(reason ? { partial: reason } : {}), ...(error ? { error } : {}),
    }
  } catch (e) {
    return { job, rows: 0, credits: 0, calls, error: ((e as Error)?.message || 'capture_failed').slice(0, 200) }
  }
}

/** Integration surface, wired into `LANE_OPS` in `intel-capture/index.ts`. */
export const SUNPUMP_CAPTURE_OPS: Record<string, (
  // deno-lint-ignore no-explicit-any
  admin: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext, now: Date, plan: string, deps: CaptureDeps
) => Promise<JobResult>> = {
  sunpump_stages: (admin, ctxFor, now, plan, deps) => captureSunpumpStages(admin, ctxFor, now, plan, deps as SunpumpDeps),
}
