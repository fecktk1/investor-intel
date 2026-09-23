// Investor Intel: the dividend-reinvestment multiplier of a total-return wrapper.
//
// THE PROBLEM. Some tokenised-stock wrappers reinvest the share's dividends
// inside the token: one token starts as one share and slowly becomes 1.009
// shares. Its price therefore climbs away from the share and from every wrapper
// that pays its dividends out, and the gap is not a premium. On 2026-09-23 SPYon
// sat +73 bp above the SPY Chainlink price and +101 bp above its sibling median,
// and its own on-chain multiplier was 1.00947: almost all of that gap was
// reinvested S&P 500 dividends, net of withholding.
//
// THE RULE. Before such a wrapper is compared with anything, its price is divided
// by the multiplier its issuer publishes for THAT token, in effect at the instant
// the wrapper prices were observed. Where no sourced multiplier exists, nothing is
// guessed: the wrapper keeps the existing 'accrues_in_price' state, its gap is an
// accrual gap labelled "includes reinvested dividends, not adjusted", and it
// never anchors or routes. A failed read is a stated reason, never 1.0.
//
// ─── Per-issuer findings, checked 2026-09-23 (read-only research) ────────────
//
// Ondo Global Markets (issuer "Ondo Assets", CoinMarketCap issuer id
//   688ca4ccabae9b5b9fb3167a, symbols ending "on"): REINVESTS INTO THE PRICE.
//   Ondo's docs (docs.ondo.finance, "Token & Quote Pricing") call the tokens
//   total-return trackers: dividends are reinvested net of withholding, so the
//   token price does not match the share price, and "the shares per token
//   multiplier ... is published on-chain". Chainlink's Ondo GM feed page states
//   token price = equity price x sValue. The factor is published in two places:
//     * SyntheticSharesOracle (Ondo, source verified on Sourcify):
//       `getSValue(address) -> (uint128 sValue, bool paused)` and
//       `assetData(address)`, 18 decimals, on Ethereum
//       0x9BC39DB6fbB44B91a48b8D5A6C208B82B1741bE6 and BNB Chain
//       0xF4Fd8a1B412633e10527454137A29Db7Aa35F15e. The Ethereum oracle holds
//       only SPYon, QQQon, SGOVon and TSLAon (every other token reverts
//       AssetNotFound). The BNB Chain oracle holds more tokens but LAGS: SPYon
//       1.00772 as of 2026-06-18 against 1.00947 on Ethereum as of 2026-09-18,
//       and no BNB entry was written after 2026-07-10. Not used.
//     * Each token's Solana mint (Token-2022, "scaled UI amount" extension):
//       `multiplier`, `newMultiplier`, `newMultiplierEffectiveTimestamp`, under
//       Ondo's authority 9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD. It equals
//       the Ethereum sValue to 15 significant digits (SPYon 1.0094730727840426,
//       QQQon 1.0040824301802083) and is current for every token, including
//       NVDAon (1.0017152487959897, effective 2026-09-10) which no EVM oracle
//       carries current. THIS is the source read here: one keyless public RPC
//       request per run, zero provider credits.
//   Live on 2026-09-23 (the 20:00 capture, prices observed 20:45 UTC, recomputed
//   by the one-off `rwa_wrapper_accrual` op):
//     SPYon 775.69 / 1.009473 = 768.41; vs SPY Chainlink 770.04: +73.4 bp raw,
//       -21.1 bp adjusted (inside the feed's 50 bp band); vs its sibling median
//       +100.6 bp raw, +5.8 bp adjusted.
//     NVDAon 225.69 / 1.001715 = 225.31; vs NVDA Chainlink 225.57: +5.4 bp raw,
//       -11.7 bp adjusted (both inside the 50 bp band; NVDA pays a tiny dividend).
//     AAPLon 337.98 / 1.003376 = 336.84; vs AAPL 336.905: +31.9 bp raw, -1.9 adjusted.
//     GMEon +163.4 bp raw, -7.9 adjusted (multiplier 1.01714).
//   Tokens whose multiplier is 1 (no dividend since launch: TSLAon, MSTRon,
//   COINon and others) are adjusted by x1, which is a sourced statement, not a
//   default.
//
// xStocks (issuer "Backed Assets", symbols ending "x"): REINVEST INTO THE
//   BALANCE, NOT THE PRICE. docs.xstocks.fi ("Dividends and Stock Splits",
//   "Multipliers"): dividends are reinvested net of withholding and reach holders
//   through a rebasing multiplier; on EVM `balanceOf()` returns the adjusted
//   balance (`getCurrentMultiplier()`), on Solana and TON the display amount is
//   raw x multiplier, and prices "should be quoted per displayed unit", i.e. per
//   share. So an xStock's price is NOT adjusted here. Open observation, recorded
//   rather than acted on: on 2026-09-23 SPYX sat +35 bp over the per-share
//   wrappers of SPY, near its pre-June multiplier (1.0039), which suggests some
//   venues quote per raw unit. Which unit a provider quote is in cannot be read
//   from the quote, so dividing would be a guess.
//
// Wrapped xStocks (issuer "Backed Assets", names "Wrapped ... (xStock)"):
//   REINVEST INTO THE PRICE. docs.xstocks.fi ("Wrapped xStocks"): a non-rebasing
//   ERC-4626 vault over the rebasing xStock, valued as `convertToAssets` x the
//   share price, so reinvested dividends accrue inside the wrapped token's
//   price. Their vault addresses are not in our catalogue, so no factor is read
//   and each one is LABELLED, not adjusted (`no_multiplier_source`).
//
// bStocks (issuer "bStocks"): reinvest into the balance through a multiplier,
//   like xStocks, so the price is per share. Not adjusted. Source: bstocks.finance
//   as indexed by search (the site refused a direct read on 2026-09-23). The
//   board agrees: SPYB, NVDAB and QQQB sit with the per-share wrappers.
// Robinhood stock tokens: cash dividends paid to the account in euros
//   (robinhood.com/eu, "Corporate actions for Stock Tokens"). Pays out.
// Dinari dShares (issuer "Dinari Assets"): dividends paid out in USDC to the
//   holding wallet (docs.dinari.com, "Dividends"). Pays out.
// Reality rTokens (issuer "Reality"): eligible dividends distributed in
//   stablecoins, per the 2026-09-16 Bitget Wallet release announcing Reality and
//   Bitget's rToken FAQ; Reality's own terms were not read. Pays out.
//
// Pure except `readScaledUiMultipliers`, which reaches the network only through
// the injected `rpcCall` seam shared with the Chainlink readers
// (`chainlink-nav.ts`), so every rule here tests without a network.

import { liveNavRpcCall, type NavRpc } from './chainlink-nav.ts'
import type { AccrualVerdict } from './rwa-wrapper-spread.ts'

export const ACCRUAL_VERIFIED_AT = '2026-09-23'

export const ACCRUAL_SOURCES = ['ondo_solana_scaled_ui'] as const
export type AccrualSourceId = typeof ACCRUAL_SOURCES[number]

/** Where a multiplier is read. The label is the network's own name and is shown
 * untranslated. publicnode answered every call of the 2026-09-23 verification;
 * it refuses `getMultipleAccounts` above about ten accounts, so the read is a
 * JSON-RPC BATCH of `getAccountInfo` calls in one HTTP request instead. */
export const ACCRUAL_NETWORKS = {
  solana: { label: 'Solana', rpcUrl: 'https://solana-rpc.publicnode.com' },
} as const
export type AccrualNetwork = keyof typeof ACCRUAL_NETWORKS

/** The SPL Token-2022 program, which owns every Ondo GM mint. */
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
/** Ondo's multiplier (and mint) authority on every Ondo GM mint, 2026-09-23. A
 * mint whose multiplier authority is anything else is refused, so a repointed or
 * look-alike mint can never supply a factor. */
export const ONDO_GM_MULTIPLIER_AUTHORITY = '9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD'

/** CoinMarketCap's issuer ids, as the RWA quotes report them on each token. */
export const ONDO_GM_ISSUER = { id: '688ca4ccabae9b5b9fb3167a', name: 'Ondo Assets' } as const
export const BACKED_ISSUER = { id: '6878977dcbbf471de3366e85', name: 'Backed Assets' } as const

export const ACCRUAL_RPC_TIMEOUT_MS = 6000
/** Mints read per run, at most. The capture holds 42 Ondo wrappers today. */
export const ACCRUAL_MAX_READS = 80
/** A multiplier outside this band is not a dividend or split factor anyone has
 * published for a share wrapper; it is refused rather than divided by. The top
 * leaves room for a 10:1 split, which Ondo applies through the same factor. */
export const MULTIPLIER_MIN = 0.01
export const MULTIPLIER_MAX = 100

/** What the board says the adjustment is and is not, stated once. */
export const ACCRUAL_SCOPE =
  'Some wrappers reinvest the share\'s dividends inside the token, so one token is worth more than one share and its price drifts above the stock for reasons that are not a premium. Where the issuer publishes that token\'s multiplier on chain, the wrapper\'s price is divided by the multiplier in effect when the prices were observed before it is compared with its siblings or the stock, and the row names the multiplier, its source and its date. Where no multiplier could be read, nothing is guessed: the gap is shown as including reinvested dividends, not adjusted, and the wrapper is kept out of the anchor and the cheapest route.'

// ─── The register: which wrappers reinvest into their price ───────────────────

export const REINVESTING_CLASSES = ['ondo_gm', 'wrapped_xstock'] as const
export type ReinvestingClass = typeof REINVESTING_CLASSES[number]

/** Every Ondo GM token in the wrapper capture on 2026-09-23, keyed on the
 * CoinMarketCap crypto id (never a ticker), with its Solana mint.
 *
 * Twelve mints came from our own catalogue (`intel_rwa_token_deployments`,
 * source catalogue_facts); the other thirty were suggested by Jupiter's public
 * token search. None is believed because of where it came from: each was proved
 * on chain that day (owner Token-2022, metadata symbol exactly this symbol, mint
 * and multiplier authority Ondo's), and the lane re-proves every one on every
 * read. A token missing here is labelled `no_multiplier_address`, not guessed. */
export const ONDO_GM_SOLANA_MINTS: Readonly<Record<string, { symbol: string; mint: string }>> = Object.freeze({
  '38037': { symbol: 'AAPLon', mint: '123mYEnRLM2LLYsJW3K6oyYh8uP1fngj732iG638ondo' },
  '38027': { symbol: 'AMDon', mint: '14diAn5z8kjrKwSC8WLqvBqqe5YmihJhjxRxd8Z6ondo' },
  '38083': { symbol: 'AMZNon', mint: '14Tqdo8V1FhzKsE3W2pFsZCzYPQxxupXRcqw9jv6ondo' },
  '38059': { symbol: 'ARMon', mint: '15SsCZqCsM9fZGhTmP4rdJTPT9WGZKazDSsgeQ8ondo' },
  '38050': { symbol: 'ASMLon', mint: '1eLZPRsn8bAKmoxsqDMH9Q2m2k7GMNp6RLSQGm8ondo' },
  '38062': { symbol: 'AVGOon', mint: '1FWZtdWN7y38BSXGzbs8D6Shk88oL9atDNgbVz9ondo' },
  '38076': { symbol: 'BABAon', mint: '1zvb9ELBFShBCWKEk5jRTJAaPAwtVt7quEXx1X4ondo' },
  '39224': { symbol: 'BMNRon', mint: 'MYXqkDYbzr7vjXAz2BapR4AiYRXzoikGirrLoRzondo' },
  '39751': { symbol: 'COHRon', mint: 'BXMkru8ded26p71gJ3AMMwJmwZaYYfQjRo8vbZzondo' },
  '38046': { symbol: 'COINon', mint: '5u6KDiNJXxX4rGMfYT4BApZQC5CuDNrG6MHkwp1ondo' },
  '38056': { symbol: 'CRCLon', mint: '6xHEyem9hmkGtVq6XGCiQUGpPsHBaoYuYdFNZa5ondo' },
  '39781': { symbol: 'EWYon', mint: 'C8pSaSgjkiTWixS3GM6Hxd6HKnKrgAbY9WDgfVeondo' },
  '39276': { symbol: 'GLDon', mint: 'hWfiw4mcxT8rnNFkk6fsCQSxoxgZ9yVhB6tyeVcondo' },
  '37997': { symbol: 'GMEon', mint: 'aznKt8v32CwYMEcTcB4bGTv8DXWStCpHrcCtyy7ondo' },
  '38001': { symbol: 'GOOGLon', mint: 'bbahNA5vT9WJeYft8tALrH1LXWffjwqVoUbqYa1ondo' },
  '42272': { symbol: 'GOOGon', mint: 'jcA9zXHWuTuDFDDDDYJTNhersed1B5etkuB6X9Eondo' },
  '38034': { symbol: 'HIMSon', mint: 'bdh3njeo19d2TBLAKTGvCWdSoArfVw8uZBAJHY4ondo' },
  '38004': { symbol: 'HOODon', mint: 'BVdXGvmgi6A9oAiwWvBvP76fyTqcCNRJMM7zMN6ondo' },
  '38035': { symbol: 'INTCon', mint: 'cJpUMp5R7rZ6fGeLHbHhrRuJzK9mkyKDjZqNpT3ondo' },
  '39254': { symbol: 'IRENon', mint: '13QHuepdhtJ3urNsV9i1hdL8nQoca2G7ZaLzb5FYondo' },
  '38043': { symbol: 'LLYon', mint: 'eGGxZwNSfuNKRqQLKaz2hc4QkA2mau7skyxPdj7ondo' },
  '38065': { symbol: 'METAon', mint: 'fDxs5y12E7x7jBwCKBXGqt71uJmCWsAQ3Srkte6ondo' },
  '38089': { symbol: 'MRVLon', mint: 'FovBwhoV5KQjZCdhoM6jgXYwXLX3F8vgAfvmLH7ondo' },
  '38086': { symbol: 'MSFTon', mint: 'FRmH6iRkMr33DLG6zVLR7EM4LojBFAuq6NtFzG6ondo' },
  '38092': { symbol: 'MSTRon', mint: 'FSz4ouiqXpHuGPcpacZfTzbMjScoj5FfzHkiyu2ondo' },
  '38014': { symbol: 'MUon', mint: 'Fz9edBpaURPPzpKVRR1A8PENYDEgHqwx5D5th28ondo' },
  '38093': { symbol: 'NVDAon', mint: 'gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo' },
  '38009': { symbol: 'ORCLon', mint: 'GmDADFpfwjfzZq9MfCafMDTS69MgVjtzD7Fd9a4ondo' },
  '38073': { symbol: 'PLTRon', mint: 'HfsnTS5qtdStwec9DfBrunRqnAMYMMz1kjv9Hu9ondo' },
  '38048': { symbol: 'QCOMon', mint: 'hrmX7MV5hifoaBVjnrdpz698yABxrbBNAcWtWo9ondo' },
  '38094': { symbol: 'QQQon', mint: 'HrYNm6jTQ71LoFphjVKBTdAE4uja7WsmLG8VxB8ondo' },
  '39306': { symbol: 'SGOVon', mint: 'HjrN6ChZK2QRL6hMXayjGPLFvxhgjwKEy135VRjondo' },
  '40823': { symbol: 'SKHYon', mint: 'Huyb2fyDDjSuDKCRWsN9ci2rmcgPo6NFiLbx9ZDondo' },
  '38057': { symbol: 'SLVon', mint: 'iy11ytbSGcUnrjE6Lfv78TFqxKyUESfku1FugS9ondo' },
  '39788': { symbol: 'SNDKon', mint: 'EJmUVvDqAdfH5zEohkdS4234bi3c6iunqEMobjmondo' },
  '39283': { symbol: 'SOFIon', mint: 'mqL8yXQpeSvc7NgrAtLLPtRvUiWyLoG5RWLv16iondo' },
  '40232': { symbol: 'SPCXon', mint: 'wzAyQTorWyoVXuJKj2x8EqKEGJpS13z6EWE9z5Aondo' },
  '38067': { symbol: 'SPYon', mint: 'k18WJUULWheRkSpSquYGdNNmtuE2Vbw1hpuUi92ondo' },
  '39284': { symbol: 'TQQQon', mint: '14W1itEkV7k1W819mLSknFTaMmkCtPokbF2tRkPUondo' },
  '38029': { symbol: 'TSLAon', mint: 'KeGv7bsfR4MheC1CkmnAVceoApjrkvBhHYjWb67ondo' },
  '38075': { symbol: 'TSMon', mint: 'keybg184d4vyXeQdFqs4o99YsMg7xBthxTJ6Ky3ondo' },
  '39250': { symbol: 'USOon', mint: 'rpydAzWdCy85HEmoQkH5PVxYtDYQWjmLxgHHadxondo' },
})

export interface ReinvestingToken {
  cryptoId: string | null
  symbol: string | null
  name: string | null
  issuerId: string | null
  issuerName: string | null
}

const clean = (v: unknown): string => String(v ?? '').trim()

/** The registry entry for a token, only while the provider's symbol still
 * matches it exactly. A repurposed crypto id is not given another token's mint. */
export function ondoMintFor(token: Pick<ReinvestingToken, 'cryptoId' | 'symbol'>): { symbol: string; mint: string } | null {
  const id = clean(token.cryptoId)
  if (!id || !Object.hasOwn(ONDO_GM_SOLANA_MINTS, id)) return null
  const entry = ONDO_GM_SOLANA_MINTS[id]
  return clean(token.symbol) === entry.symbol ? entry : null
}

/** Does this wrapper reinvest dividends into its own price, and under which
 * issuer's rules? Null for every wrapper that pays dividends out or reinvests
 * into the holder's balance (see the findings above). */
export function reinvestingClass(token: ReinvestingToken): ReinvestingClass | null {
  if (ondoMintFor(token)) return 'ondo_gm'
  const issuerId = clean(token.issuerId)
  const issuerName = clean(token.issuerName)
  const name = clean(token.name)
  // An Ondo GM token the registry has not met yet: still total return, so it is
  // labelled rather than silently reported as a premium.
  if (issuerId === ONDO_GM_ISSUER.id && issuerName === ONDO_GM_ISSUER.name && /\(Ondo\)$/.test(name)) return 'ondo_gm'
  if (issuerId === BACKED_ISSUER.id && issuerName === BACKED_ISSUER.name && /^wrapped\s/i.test(name) && /\(xstock\)$/i.test(name)) return 'wrapped_xstock'
  return null
}

// ─── Reading the multiplier on chain ──────────────────────────────────────────

export interface MultiplierReading {
  mint: string
  state: 'read' | 'refused' | 'unavailable'
  /** Fixed vocabulary; null only when read. */
  reason: string | null
  /** The transport or chain message, kept for the operator. */
  detail: string | null
  /** What the mint's own metadata calls itself. */
  onChainSymbol: string | null
  /** The extension's `multiplier`: in effect until `effectiveAt`. */
  multiplier: number | null
  /** The extension's `newMultiplier`: in effect from `effectiveAt`. */
  newMultiplier: number | null
  /** Seconds since the epoch; 0 means the multiplier was never updated. */
  effectiveAt: number | null
  readAt: string
}

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

const multiplierValue = (v: unknown): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Decode one `getAccountInfo` (jsonParsed) answer and prove it is the mint we
 * asked for. Exported for tests. */
export function parseScaledUiAccount(
  // deno-lint-ignore no-explicit-any
  value: any,
  expect: { mint: string; symbol: string; authority?: string },
  readAt: string,
): MultiplierReading {
  const base: MultiplierReading = {
    mint: expect.mint, state: 'refused', reason: null, detail: null,
    onChainSymbol: null, multiplier: null, newMultiplier: null, effectiveAt: null, readAt,
  }
  if (!value || typeof value !== 'object') return { ...base, reason: 'account_not_found' }
  if (value.owner !== TOKEN_2022_PROGRAM_ID) return { ...base, reason: 'not_token_2022', detail: clean(value.owner).slice(0, 60) || null }
  const info = value?.data?.parsed?.info
  const extensions = Array.isArray(info?.extensions) ? info.extensions : []
  // deno-lint-ignore no-explicit-any
  const find = (name: string) => extensions.find((e: any) => e?.extension === name)?.state ?? null
  const metadata = find('tokenMetadata')
  const scaled = find('scaledUiAmountConfig')
  const onChainSymbol = metadata ? clean(metadata.symbol).slice(0, 50) || null : null
  const seen = { ...base, onChainSymbol }
  // EXACT, as the Chainlink description check is: a look-alike mint whose
  // metadata differs by one character is exactly what this gate exists for.
  if (!metadata || onChainSymbol !== expect.symbol || clean(metadata.mint) !== expect.mint) return { ...seen, reason: 'mint_identity_not_proved' }
  if (!scaled) return { ...seen, reason: 'no_published_multiplier' }
  if (clean(scaled.authority) !== (expect.authority ?? ONDO_GM_MULTIPLIER_AUTHORITY)) return { ...seen, reason: 'multiplier_authority_changed', detail: clean(scaled.authority).slice(0, 60) || null }
  const multiplier = multiplierValue(scaled.multiplier)
  const newMultiplier = multiplierValue(scaled.newMultiplier)
  const effectiveAt = multiplierValue(scaled.newMultiplierEffectiveTimestamp)
  const inBand = (m: number | null) => m != null && m >= MULTIPLIER_MIN && m <= MULTIPLIER_MAX
  if (!inBand(multiplier) || !inBand(newMultiplier)) return { ...seen, reason: 'multiplier_out_of_range', detail: `${scaled.multiplier}/${scaled.newMultiplier}`.slice(0, 60) }
  if (effectiveAt == null || effectiveAt < 0 || !Number.isInteger(effectiveAt)) return { ...seen, reason: 'multiplier_time_unreadable' }
  return { ...seen, state: 'read', multiplier, newMultiplier, effectiveAt }
}

/** Read the scaled-UI multiplier of each requested mint in ONE HTTP request (a
 * JSON-RPC batch of `getAccountInfo`). Never throws: a transport failure marks
 * every requested mint `unavailable` with its reason. */
export async function readScaledUiMultipliers(
  requests: { mint: string; symbol: string }[],
  deps: { rpcCall?: NavRpc; rpcUrl?: string; timeoutMs?: number; readAt?: string } = {},
): Promise<Map<string, MultiplierReading>> {
  const out = new Map<string, MultiplierReading>()
  const readAt = deps.readAt || new Date().toISOString()
  const unique = new Map<string, { mint: string; symbol: string }>()
  for (const request of requests) {
    if (unique.size >= ACCRUAL_MAX_READS) break
    if (SOLANA_ADDRESS.test(request.mint) && !unique.has(request.mint)) unique.set(request.mint, request)
  }
  const list = [...unique.values()]
  if (!list.length) return out
  const fail = (reason: string, detail: string | null) => {
    for (const request of list) {
      out.set(request.mint, {
        mint: request.mint, state: 'unavailable', reason, detail,
        onChainSymbol: null, multiplier: null, newMultiplier: null, effectiveAt: null, readAt,
      })
    }
    return out
  }
  let rows: unknown
  try {
    rows = await (deps.rpcCall || liveNavRpcCall)(
      deps.rpcUrl || ACCRUAL_NETWORKS.solana.rpcUrl,
      list.map((request, i) => ({
        jsonrpc: '2.0', id: i + 1, method: 'getAccountInfo',
        params: [request.mint, { encoding: 'jsonParsed', commitment: 'finalized' }],
      })),
      deps.timeoutMs ?? ACCRUAL_RPC_TIMEOUT_MS,
    )
  } catch (e) {
    return fail('multiplier_read_failed', ((e as Error)?.message || 'rpc_unavailable').slice(0, 120))
  }
  // deno-lint-ignore no-explicit-any
  const answers: any[] = Array.isArray(rows) ? rows : [rows]
  list.forEach((request, i) => {
    const answer = answers.find((row) => Number(row?.id) === i + 1)
    if (!answer || answer.error || !answer.result || typeof answer.result !== 'object') {
      out.set(request.mint, {
        mint: request.mint, state: 'unavailable', reason: 'multiplier_read_failed',
        detail: answer?.error ? clean(answer.error.message || answer.error.code).slice(0, 120) || null : 'no_answer',
        onChainSymbol: null, multiplier: null, newMultiplier: null, effectiveAt: null, readAt,
      })
      return
    }
    out.set(request.mint, parseScaledUiAccount(answer.result.value, request, readAt))
  })
  return out
}

/** The multiplier in effect at the instant the wrapper prices were observed.
 *
 * Token-2022 keeps only the value in effect before `effectiveAt` and the value
 * from it on. When an update took effect AFTER the observation, the value that
 * applied at the observation may be neither (Ondo writes both fields at once), so
 * the row is refused rather than adjusted with a factor the price never saw.
 * `effectiveAt` 0 means the multiplier has never been updated since the mint was
 * created, so it applied at every observation. */
export function multiplierAt(
  reading: MultiplierReading | null | undefined,
  observedAtMs: number,
): { multiplier: number; asOf: string | null; reason: null } | { multiplier: null; asOf: null; reason: string } {
  if (!reading) return { multiplier: null, asOf: null, reason: 'multiplier_read_failed' }
  if (reading.state !== 'read' || reading.newMultiplier == null || reading.effectiveAt == null) {
    return { multiplier: null, asOf: null, reason: reading.reason || 'multiplier_read_failed' }
  }
  if (!Number.isFinite(observedAtMs)) return { multiplier: null, asOf: null, reason: 'wrapper_observation_time_unknown' }
  if (reading.effectiveAt === 0) return { multiplier: reading.newMultiplier, asOf: null, reason: null }
  if (observedAtMs >= reading.effectiveAt * 1000) {
    return { multiplier: reading.newMultiplier, asOf: new Date(reading.effectiveAt * 1000).toISOString(), reason: null }
  }
  return { multiplier: null, asOf: null, reason: 'multiplier_changed_after_observation' }
}

// ─── The source, and resolving a capture ─────────────────────────────────────

/** A multiplier provider. The Ondo Solana reader is the only one. */
export interface AccrualMultiplierSource {
  readonly id: AccrualSourceId
  readonly network: AccrualNetwork
  read(requests: { mint: string; symbol: string }[], readAt: string): Promise<Map<string, MultiplierReading>>
}

export function ondoSolanaMultiplierSource(deps: { rpcCall?: NavRpc; rpcUrl?: string; timeoutMs?: number } = {}): AccrualMultiplierSource {
  return {
    id: 'ondo_solana_scaled_ui',
    network: 'solana',
    read: (requests, readAt) => readScaledUiMultipliers(requests, { ...deps, readAt }),
  }
}

export interface AccrualAssetInput {
  rwaId: string
  /** The provider's clock for the wrapper prices. */
  observedAt: string | null
  tokens: ReinvestingToken[]
}

export interface AccrualStepResult {
  /** Verdicts per asset, then per wrapper crypto id. Only reinvesting wrappers. */
  verdicts: Map<string, Map<string, AccrualVerdict>>
  reinvesting: number
  adjusted: number
  notAdjusted: number
  /** Distinct mints read over RPC (never a provider credit). */
  reads: number
  error: string | null
}

/** Classify every wrapper, read each Ondo mint once, and decide per wrapper
 * whether its price is divided or labelled. `source: false` switches the read
 * off: the wrappers are still found and LABELLED, never reported as premiums. */
export async function resolveAccrual(
  assets: AccrualAssetInput[],
  source: AccrualMultiplierSource | false,
  readAt: string,
): Promise<AccrualStepResult> {
  const classes = new Map<string, Map<string, ReinvestingClass>>()
  const wanted = new Map<string, { mint: string; symbol: string }>()
  for (const asset of assets) {
    const inAsset = new Map<string, ReinvestingClass>()
    for (const token of asset.tokens) {
      const cls = reinvestingClass(token)
      if (!cls || !token.cryptoId) continue
      inAsset.set(token.cryptoId, cls)
      const entry = cls === 'ondo_gm' ? ondoMintFor(token) : null
      if (entry) wanted.set(entry.mint, entry)
    }
    if (inAsset.size) classes.set(asset.rwaId, inAsset)
  }

  let readings: Map<string, MultiplierReading> | null = null
  let error: string | null = null
  if (!source) error = 'multiplier_step_off'
  else if (wanted.size) {
    try {
      readings = await source.read([...wanted.values()], readAt)
    } catch (e) {
      // The reader never throws; a throw from a replacement source is still a reason.
      error = ((e as Error)?.message || 'multiplier_read_failed').slice(0, 120)
    }
  }

  const verdicts = new Map<string, Map<string, AccrualVerdict>>()
  let reinvesting = 0, adjusted = 0, notAdjusted = 0
  for (const asset of assets) {
    const inAsset = classes.get(asset.rwaId)
    if (!inAsset) continue
    const observedAtMs = Date.parse(String(asset.observedAt ?? ''))
    const out = new Map<string, AccrualVerdict>()
    for (const token of asset.tokens) {
      const cls = token.cryptoId ? inAsset.get(token.cryptoId) : undefined
      if (!cls || !token.cryptoId) continue
      reinvesting += 1
      const none: AccrualVerdict = {
        treatment: 'not_adjusted', reinvestingClass: cls, reason: null, multiplier: null,
        source: null, asOf: null, network: null, address: null, readAt: null,
      }
      let verdict: AccrualVerdict
      if (cls === 'wrapped_xstock') verdict = { ...none, reason: 'no_multiplier_source' }
      else {
        const entry = ondoMintFor(token)
        if (!entry) verdict = { ...none, reason: 'no_multiplier_address' }
        else if (!readings) {
          verdict = { ...none, reason: error === 'multiplier_step_off' ? 'multiplier_not_read' : 'multiplier_read_failed', network: 'solana', address: entry.mint }
        } else {
          const reading = readings.get(entry.mint)
          const at = multiplierAt(reading, observedAtMs)
          const located = { network: 'solana', address: entry.mint, readAt: reading?.readAt ?? readAt }
          verdict = at.reason == null
            ? { ...none, ...located, treatment: 'adjusted', multiplier: at.multiplier, source: 'ondo_solana_scaled_ui', asOf: at.asOf }
            : { ...none, ...located, reason: at.reason }
        }
      }
      if (verdict.treatment === 'adjusted') adjusted += 1
      else notAdjusted += 1
      out.set(token.cryptoId, verdict)
    }
    verdicts.set(asset.rwaId, out)
  }
  return { verdicts, reinvesting, adjusted, notAdjusted, reads: readings ? wanted.size : 0, error }
}
