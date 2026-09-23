// Investor Intel: Chainlink NAV feed reader (RWA Yield Provenance Engine).
//
// A tokenised real-world asset publishes its net asset value on chain through a
// Chainlink NAVLink feed. This module turns that feed into a dated NAV series
// the realized-yield math can use, and REFUSES any feed it cannot prove.
//
// THE DIRECTORY IS AN UNOFFICIAL MIRROR AND IS TREATED AS ONE.
// Probed 2026-09-16: `reference-data-directory.vercel.app/feeds-mainnet.json`
// answers 200 with 290 rows, while `reference-data-directory.chain.link` and
// `cdn.chain.link` do not resolve and `data.chain.link/api/feeds` is bot-gated.
// The mirror is therefore a CONVENIENCE INDEX ONLY: it suggests an address, and
// every address is proved against the chain with `description()` before a single
// figure is stored or displayed. A feed whose on-chain description disagrees
// with the mirror is refused, never rendered. On 2026-09-16 that rejected
// exactly one row: the mirror says "USCC NAV per Share", the chain says
// "USCC NAV". The mirror's own counts and labels are never trusted either:
// they are re-derived here and re-proved on chain.
//
// PRODUCT TYPE IS INCONSISTENTLY CASED IN THE MIRROR. The same probe found 21
// rows spelled "NAVLink" and 2 spelled "NAVLINK" (alongside "Price",
// "Proof of Reserve", "SmartData", "Macroeconomics"). A case-SENSITIVE filter
// silently drops those 2 feeds, so the match below is case-insensitive.
//
// KEYLESS, like the other chain adapters in `rpc-adapters/`. The network is
// reached only through the injected `rpcCall` seam, so this module tests without
// a network. Probed 2026-09-16: `https://ethereum-rpc.publicnode.com` answered
// 30 of 30 calls; `llamarpc` returned 525 and `cloudflare-eth` refuses eth_call,
// so neither is the default.

/** The single network seam, identical to `rpc-adapters/types.ts` RpcCall. */
export type NavRpc = (url: string, body: unknown, timeoutMs: number) => Promise<unknown>

export const NAV_DIRECTORY_URL = 'https://reference-data-directory.vercel.app/feeds-mainnet.json'
/** Keyless Ethereum mainnet RPC. Overridable for an operator who has a better
 * endpoint; the keyless default is the shipped behaviour. */
export const NAV_RPC_URL = 'https://ethereum-rpc.publicnode.com'
export const NAV_RPC_TIMEOUT_MS = 8000

/** The live `NavRpc`: one JSON-RPC POST (a single call or a batch), aborted at
 * `timeoutMs`. A non-2xx answer throws `rpc_http_<status>`, which every caller
 * turns into a stated refusal rather than a figure. Shared by the NAV lane and
 * the equity reference reader (`underlying-reference.ts`) so neither forks it. */
export const liveNavRpcCall: NavRpc = async (url, body, timeoutMs) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    })
    if (!res.ok) throw new Error(`rpc_http_${res.status}`)
    return await res.json()
  } finally { clearTimeout(timer) }
}

/** AggregatorV3Interface selectors. Each was exercised live on 2026-09-16
 * against the 23 NAV proxies the mirror lists. */
const SELECTOR = {
  description: '0x7284e416',
  decimals: '0x313ce567',
  latestRoundData: '0xfeaf968c',
  getRoundData: '0x9a6fc8f5',
} as const

/** The mirror's `docs.productType` for a NAV feed, compared case-insensitively.
 * Both "NAVLink" and "NAVLINK" appear in the same file. */
export function isNavProductType(value: unknown): boolean {
  return String(value ?? '').trim().toLowerCase() === 'navlink'
}

/** A checksummed or lower-case EVM address, normalised to lower case. Anything
 * else is not an address and is dropped rather than queried. */
export function navAddress(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  return /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : null
}

const int = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) && Number.isInteger(n) ? n : null
}
const text = (v: unknown, max = 200): string | null => {
  const s = v == null ? '' : String(v).trim()
  return s ? s.slice(0, max) : null
}

/** One NAV feed as the MIRROR describes it. Nothing here is believed yet. */
export interface NavFeedCandidate {
  /** The mirror's feed name. Proved against `description()` before use. */
  mirrorName: string
  address: string
  /** Mirror-reported answer decimals. Proved against `decimals()`. */
  decimals: number | null
  /** Mirror-reported heartbeat in SECONDS; the staleness monitor's own bound. */
  heartbeatSeconds: number | null
  /** The mirror's named reserve auditor, kept verbatim as provenance. */
  porAuditor: string | null
}

/** Every NAV feed the mirror lists, with an address we could parse. The mirror's
 * own counts are ignored: the list is re-derived from the rows themselves. */
export function navDirectoryRows(payload: unknown): NavFeedCandidate[] {
  const rows = Array.isArray(payload) ? payload : []
  const out: NavFeedCandidate[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const record = row as Record<string, unknown>
    const docs = record.docs && typeof record.docs === 'object' ? record.docs as Record<string, unknown> : {}
    if (!isNavProductType(docs.productType)) continue
    const address = navAddress(record.proxyAddress)
    const mirrorName = text(record.name, 120)
    // A row with no usable address or name cannot be proved on chain, so it is
    // not a candidate. Dropping it here is not a silent loss: it never had an
    // identity to lose.
    if (!address || !mirrorName) continue
    const heartbeat = int(record.heartbeat)
    out.push({
      mirrorName,
      address,
      decimals: int(record.decimals),
      heartbeatSeconds: heartbeat != null && heartbeat > 0 ? heartbeat : null,
      porAuditor: text(docs.porAuditor, 120),
    })
  }
  return out
}

// ─── ABI decoding ─────────────────────────────────────────────────────────────

/** A 32-byte word as a SIGNED 256-bit integer. `latestRoundData` returns int256
 * and a NAV can in principle be reported negative; reading it unsigned would
 * turn a negative into an astronomically large positive. */
export function decodeInt256(word: string): bigint | null {
  if (!/^[0-9a-fA-F]{64}$/.test(word)) return null
  const raw = BigInt('0x' + word)
  return raw >= (1n << 255n) ? raw - (1n << 256n) : raw
}

/** A dynamic ABI string. Kept local rather than imported from `evm-abi.ts` so
 * this module has no dependency on the resolver ladder. */
export function decodeAbiText(result: unknown): string | null {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) return null
  const hex = result.slice(2)
  if (hex.length < 128) return null
  const offset = Number(BigInt('0x' + hex.slice(0, 64)))
  if (!Number.isFinite(offset) || offset * 2 + 64 > hex.length) return null
  const length = Number(BigInt('0x' + hex.slice(offset * 2, offset * 2 + 64)))
  if (!Number.isFinite(length) || length > 1024) return null
  const body = hex.slice(offset * 2 + 64, offset * 2 + 64 + length * 2)
  let out = ''
  for (let i = 0; i + 1 < body.length; i += 2) out += String.fromCharCode(parseInt(body.slice(i, i + 2), 16))
  // Control bytes and the replacement character are provider noise, not a name.
  const clean = [...out].filter((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 65533).join('').trim()
  return clean ? clean.slice(0, 200) : null
}

/** One NAV round exactly as the aggregator reported it. */
export interface NavRound {
  /** Phase-encoded and therefore far beyond Number.MAX_SAFE_INTEGER, so it is
   * carried as a decimal STRING and never as a JS number. */
  roundId: string
  /** The answer scaled by the feed's own decimals. */
  nav: number
  /** Seconds since the epoch, as the aggregator reported it. */
  updatedAt: number
}

/** Decode a `latestRoundData()` / `getRoundData()` return.
 *
 * A round the aggregator never wrote answers with `updatedAt = 0`; that is "no
 * round here", not a 1970 observation, and it is dropped rather than dated. */
export function decodeRoundData(result: unknown, decimals: number): NavRound | null {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(result)) return null
  const hex = result.slice(2)
  if (hex.length < 64 * 5) return null
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null
  const answer = decodeInt256(hex.slice(64, 128))
  const roundWord = hex.slice(0, 64)
  if (answer == null || !/^[0-9a-fA-F]{64}$/.test(roundWord)) return null
  const updatedAt = Number(BigInt('0x' + hex.slice(192, 256)))
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null
  const nav = Number(answer) / Math.pow(10, decimals)
  if (!Number.isFinite(nav)) return null
  return { roundId: BigInt('0x' + roundWord).toString(), nav, updatedAt }
}

// ─── On-chain proof ───────────────────────────────────────────────────────────

export interface NavFeedValidation {
  candidate: NavFeedCandidate
  state: 'validated' | 'refused'
  /** Machine reason, always present on a refusal and never on a pass. */
  reason?: string
  /** What the CHAIN said its description is. Kept even on a refusal so the
   * disagreement itself is reviewable rather than just asserted. */
  onChainDescription?: string | null
  onChainDecimals?: number | null
  latest?: NavRound | null
}

// deno-lint-ignore no-explicit-any
const resultAt = (rows: any, id: number): unknown => (Array.isArray(rows) ? rows : [rows]).find((r: any) => Number(r?.id) === id)?.result

/** Prove one mirror row against the chain.
 *
 * Three things must agree before a figure from this feed may be stored:
 *   1. `description()` equals the mirror's name EXACTLY. This is the check that
 *      stops a mirror typo, a stale entry or a swapped address from being
 *      presented as a named fund's NAV.
 *   2. `decimals()` equals the mirror's decimals, because the answer is scaled
 *      by it and a wrong scale is a wrong NAV by orders of magnitude.
 *   3. A latest round exists and its NAV is strictly positive. A zero or
 *      negative NAV is not a fund valuation we can reason about.
 *
 * A transport failure is a refusal with its own reason, never a throw and never
 * a silent drop: the monitor lists the feed with the reason it could not read. */
export async function validateNavFeed(
  candidate: NavFeedCandidate,
  deps: { rpcCall: NavRpc; rpcUrl?: string; timeoutMs?: number },
): Promise<NavFeedValidation> {
  const url = deps.rpcUrl || NAV_RPC_URL
  const timeout = deps.timeoutMs ?? NAV_RPC_TIMEOUT_MS
  const refuse = (reason: string, extra: Partial<NavFeedValidation> = {}): NavFeedValidation =>
    ({ candidate, state: 'refused', reason, ...extra })
  if (candidate.decimals == null) return refuse('mirror_decimals_missing')
  let rows: unknown
  try {
    rows = await deps.rpcCall(url, [
      { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: candidate.address, data: SELECTOR.description }, 'latest'] },
      { jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: candidate.address, data: SELECTOR.decimals }, 'latest'] },
      { jsonrpc: '2.0', id: 3, method: 'eth_call', params: [{ to: candidate.address, data: SELECTOR.latestRoundData }, 'latest'] },
    ], timeout)
  } catch (e) {
    return refuse(((e as Error)?.message || 'rpc_unavailable').slice(0, 120))
  }
  const onChainDescription = decodeAbiText(resultAt(rows, 1))
  const decimalsWord = resultAt(rows, 2)
  const onChainDecimals = typeof decimalsWord === 'string' && /^0x[0-9a-fA-F]+$/.test(decimalsWord) ? Number(BigInt(decimalsWord)) : null
  const seen = { onChainDescription, onChainDecimals }
  if (!onChainDescription) return refuse('no_on_chain_description', seen)
  // EXACT match. Not a prefix, not case-folded: two different funds can differ
  // by one word ("USCC NAV" against "USCC NAV per Share") and that difference is
  // exactly what this gate exists to catch.
  if (onChainDescription !== candidate.mirrorName) return refuse('description_mismatch', seen)
  if (onChainDecimals == null || onChainDecimals !== candidate.decimals) return refuse('decimals_mismatch', seen)
  const latest = decodeRoundData(resultAt(rows, 3), onChainDecimals)
  if (!latest) return refuse('no_latest_round', seen)
  if (!(latest.nav > 0)) return refuse('non_positive_nav', { ...seen, latest })
  return { candidate, state: 'validated', ...seen, latest }
}

/** Walk a validated feed's history backwards from its latest round.
 *
 * Round ids are PHASE-ENCODED (`phaseId << 64 | aggregatorRoundId`), so walking
 * back is a decrement inside the current phase. Crossing below the phase's first
 * round returns rounds the aggregator never wrote, which decode as `updatedAt`
 * zero and are dropped by `decodeRoundData`, so the walk degrades to a shorter
 * history instead of inventing one. The rounds are returned OLDEST FIRST, which
 * is the order the realized-yield math reads them in.
 *
 * `count` is a hard ceiling on the extra calls this makes: one batch, never a
 * cursor followed to exhaustion. */
export async function readNavRounds(
  validation: NavFeedValidation,
  deps: { rpcCall: NavRpc; rpcUrl?: string; timeoutMs?: number },
  count = 10,
): Promise<NavRound[]> {
  if (validation.state !== 'validated' || !validation.latest) return []
  const decimals = validation.onChainDecimals
  if (decimals == null) return []
  const wanted = Math.max(0, Math.min(60, Math.trunc(count)))
  const rounds: NavRound[] = [validation.latest]
  if (wanted < 2) return rounds
  let latestId: bigint
  try { latestId = BigInt(validation.latest.roundId) } catch { return rounds }
  const ids: bigint[] = []
  for (let back = 1n; back <= BigInt(wanted - 1) && latestId - back > 0n; back++) ids.push(latestId - back)
  if (!ids.length) return rounds
  let rows: unknown
  try {
    rows = await deps.rpcCall(deps.rpcUrl || NAV_RPC_URL, ids.map((id, i) => ({
      jsonrpc: '2.0', id: i + 1, method: 'eth_call',
      params: [{ to: validation.candidate.address, data: SELECTOR.getRoundData + id.toString(16).padStart(64, '0') }, 'latest'],
    })), deps.timeoutMs ?? NAV_RPC_TIMEOUT_MS)
  } catch {
    // The latest round still stands on its own; a failed history read shortens
    // the series and the caller reports insufficient history rather than a gap
    // filled with guesses.
    return rounds
  }
  for (let i = 0; i < ids.length; i++) {
    const round = decodeRoundData(resultAt(rows, i + 1), decimals)
    if (round) rounds.push(round)
  }
  // Oldest first, and a round the aggregator repeated at one instant collapses
  // to a single point: two identical stamps are not two observations.
  const byStamp = new Map<number, NavRound>()
  for (const round of rounds.sort((a, b) => a.updatedAt - b.updatedAt)) byStamp.set(round.updatedAt, round)
  return [...byStamp.values()].sort((a, b) => a.updatedAt - b.updatedAt)
}
