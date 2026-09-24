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
// xStocks (issuer "Backed Assets", CoinMarketCap issuer id
//   6878977dcbbf471de3366e85, symbols ending "x"): THE MULTIPLIER IS PUBLISHED,
//   BUT THE QUOTE'S UNIT IS MIXED, SO THE PRICE IS LABELLED, NOT DIVIDED.
//   Checked 2026-09-23. The mechanism, from the issuer's docs
//   (https://docs.xstocks.fi/developers/multipliers): every xStock launches at a
//   multiplier of 1.0; dividends (net of withholding) and splits raise it; on
//   Solana each mint is Token-2022 with the "scaled UI amount" extension, so the
//   on-chain RAW amount never changes and the displayed amount is raw x
//   multiplier (on EVM `balanceOf()` is already scaled, `getCurrentMultiplier()`),
//   and the docs ask venues to quote per displayed unit, i.e. per share. One RAW
//   unit is therefore worth `multiplier` shares, and a price per raw unit
//   includes the multiplier. Jupiter's public price API shows both on the same
//   mint (SPYx 768.02 per displayed unit, 772.40 "prescaled" per raw unit).
//   The multiplier is read here from each xStock's Solana mint (authority
//   S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS on every one); mint addresses
//   from the issuer's public assets API (api.xstocks.fi/api/v2/public/assets),
//   ten of them also in our own catalogue and identical, and every one proved on
//   chain that day as the Ondo mints are. Equal on EVM: the Ethereum xStock's
//   `getCurrentMultiplier()` matched the Solana value to all digits for all 42.
//   The numbers, against the median of the liquid per-share siblings (Robinhood,
//   bStocks, Reality, Backpack), averaged over the nine distinct quote clocks
//   2026-09-20..23: the deep Solana pools look per RAW unit, the thin
//   ones per SHARE. MSFTX (multiplier 1.00590) +56.4 bp raw, -2.7 divided;
//   SPYX (1.00571) +49.9, -7.2; GMEX (1.00531) +72.4, +19.2; QQQX (1.00346)
//   +27.5, -7.0; AAPLX (1.00327) +23.6, -9.1; GOOGLX, METAX and NVDAX likewise.
//   But ORCLX (1.00932) +2.0 raw, -90.3 divided; AVGOX (1.00616) +6.9, -54.4;
//   QCOMx, ASMLx, LLYX and MRVLX lean the same way; and TQQQX, whose multiplier
//   is 2.0117 after a split, sits +6.9 bp raw and would be -5,020 bp divided, so
//   its quote is plainly per share. CoinMarketCap's price is a volume-weighted
//   blend of venues, and how much of it is per raw unit differs by token and by
//   hour (roughly with the depth of the Solana pools: Jupiter liquidity SPYx $6.3m,
//   ORCLx $4k). Which part of one quote is which cannot be read from the quote,
//   so dividing would be a guess either way. DECISION: an xStock whose multiplier
//   in effect is exactly 1 is per share on every venue and is compared as it
//   stands (recorded as 'adjusted' by x1, a sourced statement, as for Ondo); one
//   whose multiplier is above 1 is NOT divided and is labelled
//   `quote_unit_mixed`: its gap is an accrual gap ("may include reinvested
//   dividends"), and it never anchors or routes.
//
// Wrapped xStocks (issuer "Backed Assets", names "Wrapped ... (xStock)"):
//   REINVEST INTO THE PRICE, BY EXACTLY THE MULTIPLIER. ADJUSTED. docs.xstocks.fi
//   (https://docs.xstocks.fi/developers/wrapped-xstocks): an ERC-4626 vault over
//   the rebasing xStock that uses "the live current multiplier" for its rate,
//   valued as `convertToAssets(shares)` x the xStock's price. On 2026-09-23 the
//   Ethereum vault of every one of the 42 (the API's `wrapperAddressV2`)
//   answered `convertToAssets(1e18)` equal to its xStock's Solana multiplier to
//   all digits, so one wrapped token is `multiplier` shares. The numbers agree,
//   including the largest factor: WORCLX +94.9 bp raw, +1.7 divided; WAVGOX
//   +65.5, +3.9; WMSFTX +57.6, -1.4; wSPYx +53.4, -3.7; wTSMx +59.0, -2.9
//   (2026-09-23 20:45 quotes; the nine-clock averages match). A wrapped token has
//   no second unit to be quoted in, so there is no blend. Its price is divided
//   by its xStock's Solana multiplier in effect at the quote's observed time.
//
// bStocks (issuer "bStocks", BNB Chain): the same shape of mechanism, NOT READ
//   and NOT ADJUSTED. The token contract (beacon proxy) exposes `uiMultiplier()`,
//   `newUIMultiplier()`, `effectiveAt()`, `balanceOfUI()` and `toUIAmount()`, so
//   `balanceOf()` is the raw unit, and Binance's bStocks guide says dividends
//   become a multiplier by which one token redeems for more shares. On
//   2026-09-23 every bStock read (13 of them) was within 8 bp of 1 (NVDAB
//   1.00078, QQQB 1.00072, GOOGLB 1.00048), far below what the prices can
//   resolve, so the numbers can neither confirm nor refute a unit, and our
//   catalogue holds only 13 of their addresses. They stay per-share wrappers.
//   To revisit when a bStock's multiplier becomes material.
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

export const ACCRUAL_SOURCES = ['ondo_solana_scaled_ui', 'xstocks_solana_scaled_ui'] as const
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
/** The scaled-UI multiplier authority on every xStocks Solana mint, 2026-09-23
 * (their metadata authority is 5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq and
 * their mint authority 7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj). The same
 * refusal applies: a mint whose multiplier authority is anything else supplies
 * no factor. */
export const XSTOCKS_MULTIPLIER_AUTHORITY = 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS'

/** CoinMarketCap's issuer ids, as the RWA quotes report them on each token. */
export const ONDO_GM_ISSUER = { id: '688ca4ccabae9b5b9fb3167a', name: 'Ondo Assets' } as const
export const BACKED_ISSUER = { id: '6878977dcbbf471de3366e85', name: 'Backed Assets' } as const

export const ACCRUAL_RPC_TIMEOUT_MS = 6000
/** Mints read per run, at most. The capture holds 42 Ondo mints and 42 xStocks
 * mints today (a wrapped xStock reads its xStock's mint); publicnode answered
 * all 84 in one batch on 2026-09-23. */
export const ACCRUAL_MAX_READS = 120
/** A multiplier outside this band is not a dividend or split factor anyone has
 * published for a share wrapper; it is refused rather than divided by. The top
 * leaves room for a 10:1 split, which Ondo applies through the same factor. */
export const MULTIPLIER_MIN = 0.01
export const MULTIPLIER_MAX = 100

/** What the board says the adjustment is and is not, stated once. */
export const ACCRUAL_SCOPE =
  'Some wrappers reinvest the share\'s dividends inside the token, so one token is worth more than one share and its price drifts above the stock for reasons that are not a premium. Where the issuer publishes that token\'s multiplier on chain, the wrapper\'s price is divided by the multiplier in effect when the prices were observed before it is compared with its siblings or the stock, and the row names the multiplier, its source and its date. Where no multiplier could be read, nothing is guessed: the gap is shown as including reinvested dividends, not adjusted, and the wrapper is kept out of the anchor and the cheapest route. An xStock whose multiplier is above one is labelled the same way rather than divided, because its quote blends venues that price one share with on-chain pools that price one raw token, which includes the multiplier.'

// ─── The register: which wrappers reinvest into their price ───────────────────

/** 'xstock' is in the register although its price is never divided: its quote
 * may include its multiplier (see the findings above), so it is read, and
 * labelled unless the multiplier is exactly 1. */
export const REINVESTING_CLASSES = ['ondo_gm', 'wrapped_xstock', 'xstock'] as const
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

/** Every xStock and wrapped xStock in the wrapper capture on 2026-09-23, keyed
 * on the CoinMarketCap crypto id, with CoinMarketCap's symbol (matched exactly,
 * as for Ondo), the xStock's own on-chain symbol, and the Solana mint of the
 * xStock. A wrapped xStock carries its xStock's mint: its vault's
 * `convertToAssets` rate IS that multiplier (all 42 checked on Ethereum that day).
 *
 * Addresses from the issuer's public assets API (api.xstocks.fi/api/v2/public/
 * assets, `deployments[].address` on network Solana), ten also in our catalogue
 * (`intel_rwa_token_deployments`) and identical there. Each mint was proved on
 * chain that day (owner Token-2022, metadata symbol exactly `xstock`, metadata
 * mint the mint, multiplier authority xStocks'), and the lane re-proves every
 * one on every read. A token missing here is labelled `no_multiplier_address`. */
export const XSTOCKS_SOLANA_MINTS: Readonly<Record<string, { symbol: string; xstock: string; mint: string; wrapped?: true }>> = Object.freeze({
  '36994': { symbol: 'AAPLX', xstock: 'AAPLx', mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp' },
  '37269': { symbol: 'WAAPLX', xstock: 'AAPLx', mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', wrapped: true },
  '41115': { symbol: 'wAMDx', xstock: 'AMDx', mint: 'XsXcJ6GZ9kVnjqGsjBnktRcuwMBmvKWh8S93RefZ1rF', wrapped: true },
  '37014': { symbol: 'AMZNX', xstock: 'AMZNx', mint: 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg' },
  '37112': { symbol: 'WAMZNX', xstock: 'AMZNx', mint: 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg', wrapped: true },
  '41183': { symbol: 'wARMx', xstock: 'ARMx', mint: 'XswUFSYE5CWsZM3X3yo6e2pZvxcAzx912DonGvgUFka', wrapped: true },
  '40184': { symbol: 'ASMLx', xstock: 'ASMLx', mint: 'XshuHQ6o6SVpUNawvnnTMxsZ4tacZsNgVCLorv7TkFq' },
  '41170': { symbol: 'wASMLx', xstock: 'ASMLx', mint: 'XshuHQ6o6SVpUNawvnnTMxsZ4tacZsNgVCLorv7TkFq', wrapped: true },
  '37021': { symbol: 'AVGOX', xstock: 'AVGOx', mint: 'XsgSaSvNSqLTtFuyWPBhK9196Xb9Bbdyjj4fH3cPJGo' },
  '37129': { symbol: 'WAVGOX', xstock: 'AVGOx', mint: 'XsgSaSvNSqLTtFuyWPBhK9196Xb9Bbdyjj4fH3cPJGo', wrapped: true },
  '41124': { symbol: 'wBMNRx', xstock: 'BMNRx', mint: 'XsrBCwaH8c46xiqXBChzobgufRKxQxAWUWbndgBNzFn', wrapped: true },
  '41149': { symbol: 'wCOHRx', xstock: 'COHRx', mint: 'XsipFyePxrgwZJrX4s26RJ25cqwpkfn6ec8JLy26w5b', wrapped: true },
  '36989': { symbol: 'COINX', xstock: 'COINx', mint: 'Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu' },
  '37193': { symbol: 'WCOINX', xstock: 'COINx', mint: 'Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu', wrapped: true },
  '37005': { symbol: 'CRCLX', xstock: 'CRCLx', mint: 'XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1' },
  '41268': { symbol: 'wCRCLx', xstock: 'CRCLx', mint: 'XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1', wrapped: true },
  '40159': { symbol: 'EWYx', xstock: 'EWYx', mint: 'XswenHXJtDWYMh89uRYx2tZcABxwXSn7j3jidDPS1Yo' },
  '41388': { symbol: 'wEWYx', xstock: 'EWYx', mint: 'XswenHXJtDWYMh89uRYx2tZcABxwXSn7j3jidDPS1Yo', wrapped: true },
  '37024': { symbol: 'GLDX', xstock: 'GLDx', mint: 'Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re' },
  '41367': { symbol: 'wGLDx', xstock: 'GLDx', mint: 'Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re', wrapped: true },
  '37023': { symbol: 'GMEX', xstock: 'GMEx', mint: 'Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc' },
  '37120': { symbol: 'WGMEX', xstock: 'GMEx', mint: 'Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc', wrapped: true },
  '37013': { symbol: 'GOOGLX', xstock: 'GOOGLx', mint: 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN' },
  '37121': { symbol: 'WGOOGLX', xstock: 'GOOGLx', mint: 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN', wrapped: true },
  '40148': { symbol: 'HIMSx', xstock: 'HIMSx', mint: 'XsprHSJzwz3qmHcEf7j7WcUk6hMUL4sPLuAdWaSY1oh' },
  '41430': { symbol: 'wHIMSx', xstock: 'HIMSx', mint: 'XsprHSJzwz3qmHcEf7j7WcUk6hMUL4sPLuAdWaSY1oh', wrapped: true },
  '37041': { symbol: 'HOODX', xstock: 'HOODx', mint: 'XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg' },
  '37200': { symbol: 'WHOODX', xstock: 'HOODx', mint: 'XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg', wrapped: true },
  '37028': { symbol: 'INTCX', xstock: 'INTCx', mint: 'XshPgPdXFRWB8tP1j82rebb2Q9rPgGX37RuqzohmArM' },
  '37202': { symbol: 'WINTCX', xstock: 'INTCx', mint: 'XshPgPdXFRWB8tP1j82rebb2Q9rPgGX37RuqzohmArM', wrapped: true },
  '40162': { symbol: 'IRENx', xstock: 'IRENx', mint: 'Xshh1dRsnxatP45yBfrzU9MrvrFCvxHQGTrWjgdA81E' },
  '41291': { symbol: 'wIRENx', xstock: 'IRENx', mint: 'Xshh1dRsnxatP45yBfrzU9MrvrFCvxHQGTrWjgdA81E', wrapped: true },
  '40178': { symbol: 'LITEx', xstock: 'LITEx', mint: 'XsexQ9qqNbDkLE6XwCN9ceVhLo8Lxc7UheVR6eBkKyo' },
  '41452': { symbol: 'wLITEx', xstock: 'LITEx', mint: 'XsexQ9qqNbDkLE6XwCN9ceVhLo8Lxc7UheVR6eBkKyo', wrapped: true },
  '37038': { symbol: 'LLYX', xstock: 'LLYx', mint: 'Xsnuv4omNoHozR6EEW5mXkw8Nrny5rB3jVfLqi6gKMH' },
  '37207': { symbol: 'WLLYX', xstock: 'LLYx', mint: 'Xsnuv4omNoHozR6EEW5mXkw8Nrny5rB3jVfLqi6gKMH', wrapped: true },
  '37055': { symbol: 'METAX', xstock: 'METAx', mint: 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu' },
  '37211': { symbol: 'WMETAX', xstock: 'METAx', mint: 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu', wrapped: true },
  '37050': { symbol: 'MRVLX', xstock: 'MRVLx', mint: 'XsuxRGDzbLjnJ72v74b7p9VY6N66uYgTCyfwwRjVCJA' },
  '37213': { symbol: 'WMRVLX', xstock: 'MRVLx', mint: 'XsuxRGDzbLjnJ72v74b7p9VY6N66uYgTCyfwwRjVCJA', wrapped: true },
  '37056': { symbol: 'MSFTX', xstock: 'MSFTx', mint: 'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX' },
  '37214': { symbol: 'WMSFTX', xstock: 'MSFTx', mint: 'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX', wrapped: true },
  '37003': { symbol: 'MSTRX', xstock: 'MSTRx', mint: 'XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ' },
  '37215': { symbol: 'WMSTRX', xstock: 'MSTRx', mint: 'XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ', wrapped: true },
  '40175': { symbol: 'MUx', xstock: 'MUx', mint: 'XsQLZycSZ7QnBBdBXQaTbQdiUcbRqjNJgyBGAMzhHav' },
  '41636': { symbol: 'wMUx', xstock: 'MUx', mint: 'XsQLZycSZ7QnBBdBXQaTbQdiUcbRqjNJgyBGAMzhHav', wrapped: true },
  '41481': { symbol: 'wNBISx', xstock: 'NBISx', mint: 'Xsii5eERa2sKFyTHQqdYxpxL5xoUSLVurzHeqBEMBho', wrapped: true },
  '36992': { symbol: 'NVDAX', xstock: 'NVDAx', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh' },
  '37270': { symbol: 'WNVDAX', xstock: 'NVDAx', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', wrapped: true },
  '37059': { symbol: 'ORCLX', xstock: 'ORCLx', mint: 'XsjFwUPiLofddX5cWFHW35GCbXcSu1BCUGfxoQAQjeL' },
  '37218': { symbol: 'WORCLX', xstock: 'ORCLx', mint: 'XsjFwUPiLofddX5cWFHW35GCbXcSu1BCUGfxoQAQjeL', wrapped: true },
  '37062': { symbol: 'PLTRX', xstock: 'PLTRx', mint: 'XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4' },
  '37220': { symbol: 'WPLTRX', xstock: 'PLTRx', mint: 'XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4', wrapped: true },
  '41907': { symbol: 'QCOMx', xstock: 'QCOMx', mint: 'XsUUG8bjFN2KvzLTpzavvEKdAjMAeLTZiTeAQJ9uhvB' },
  '41622': { symbol: 'wQCOMx', xstock: 'QCOMx', mint: 'XsUUG8bjFN2KvzLTpzavvEKdAjMAeLTZiTeAQJ9uhvB', wrapped: true },
  '37057': { symbol: 'QQQX', xstock: 'QQQx', mint: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ' },
  '41519': { symbol: 'wQQQx', xstock: 'QQQx', mint: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ', wrapped: true },
  '41665': { symbol: 'wSGOVx', xstock: 'SGOVx', mint: 'XsYD72ntjj7ZwoFDZCDmN2gamTcLpnywqvG7PQN5vCN', wrapped: true },
  '40786': { symbol: 'SKHYx', xstock: 'SKHYx', mint: 'XsnhgGRQwhExfS2bmWzR6EYddKGPRGDEjeJsatkmKqU' },
  '41523': { symbol: 'wSKHYx', xstock: 'SKHYx', mint: 'XsnhgGRQwhExfS2bmWzR6EYddKGPRGDEjeJsatkmKqU', wrapped: true },
  '41644': { symbol: 'wSLVx', xstock: 'SLVx', mint: 'XsxAd6okt8y1RRK6gNg7iJaqiWNiq5Md5EDf3ZrF2dm', wrapped: true },
  '40037': { symbol: 'SNDKX', xstock: 'SNDKx', mint: 'Xswbpc8UqU6e1j9QZEWCjBMjyvz4twqD7PCy6j2e7jj' },
  '41493': { symbol: 'wSNDKx', xstock: 'SNDKx', mint: 'Xswbpc8UqU6e1j9QZEWCjBMjyvz4twqD7PCy6j2e7jj', wrapped: true },
  '41634': { symbol: 'wSOFIx', xstock: 'SOFIx', mint: 'Xsipo31rLh5EqPMR2cArn6kVPAD83C6rxbmCrT9Wu5u', wrapped: true },
  '40147': { symbol: 'SOXLx', xstock: 'SOXLx', mint: 'XsdZDkoMdUb6iKDAKKappuM7C1Q2HmTqC8jNujbfmCu' },
  '41586': { symbol: 'wSOXLx', xstock: 'SOXLx', mint: 'XsdZDkoMdUb6iKDAKKappuM7C1Q2HmTqC8jNujbfmCu', wrapped: true },
  '40218': { symbol: 'SPCXx', xstock: 'SPCXx', mint: 'Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8' },
  '41610': { symbol: 'wSPCXx', xstock: 'SPCXx', mint: 'Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8', wrapped: true },
  '37006': { symbol: 'SPYX', xstock: 'SPYx', mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W' },
  '41525': { symbol: 'wSPYx', xstock: 'SPYx', mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', wrapped: true },
  '37044': { symbol: 'TQQQX', xstock: 'TQQQx', mint: 'XsjQP3iMAaQ3kQScQKthQpx9ALRbjKAjQtHg6TFomoc' },
  '41573': { symbol: 'wTQQQx', xstock: 'TQQQx', mint: 'XsjQP3iMAaQ3kQScQKthQpx9ALRbjKAjQtHg6TFomoc', wrapped: true },
  '37004': { symbol: 'TSLAX', xstock: 'TSLAx', mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB' },
  '37227': { symbol: 'WTSLAX', xstock: 'TSLAx', mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', wrapped: true },
  '41688': { symbol: 'wTSMx', xstock: 'TSMx', mint: 'XsafvsGtzFqqHgTnA3aPC83EAMkacU5mcGtcSayhpVV', wrapped: true },
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

/** The xStocks registry entry for a token, on the same exact-symbol gate. */
export function xstockMintFor(token: Pick<ReinvestingToken, 'cryptoId' | 'symbol'>): { symbol: string; xstock: string; mint: string; wrapped?: true } | null {
  const id = clean(token.cryptoId)
  if (!id || !Object.hasOwn(XSTOCKS_SOLANA_MINTS, id)) return null
  const entry = XSTOCKS_SOLANA_MINTS[id]
  return clean(token.symbol) === entry.symbol ? entry : null
}

/** Does this wrapper's price carry a dividend multiplier, and under which
 * issuer's rules? Null for every wrapper that pays dividends out or whose
 * multiplier is not read (bStocks; see the findings above). */
export function reinvestingClass(token: ReinvestingToken): ReinvestingClass | null {
  if (ondoMintFor(token)) return 'ondo_gm'
  const xstock = xstockMintFor(token)
  if (xstock) return xstock.wrapped ? 'wrapped_xstock' : 'xstock'
  const issuerId = clean(token.issuerId)
  const issuerName = clean(token.issuerName)
  const name = clean(token.name)
  // An Ondo GM token the registry has not met yet: still total return, so it is
  // labelled rather than silently reported as a premium.
  if (issuerId === ONDO_GM_ISSUER.id && issuerName === ONDO_GM_ISSUER.name && /\(Ondo\)$/.test(name)) return 'ondo_gm'
  // Likewise an xStock or wrapped xStock the registry has not met: its multiplier
  // cannot be read without a mint, so it is labelled, never assumed to be 1.
  if (issuerId === BACKED_ISSUER.id && issuerName === BACKED_ISSUER.name && /\(xstock\)$/i.test(name)) {
    return /^wrapped\s/i.test(name) ? 'wrapped_xstock' : 'xstock'
  }
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

/** One mint to read: its address, the symbol its own metadata must carry, and
 * the multiplier authority it must name (Ondo's when omitted). */
export interface MultiplierRequest {
  mint: string
  symbol: string
  authority?: string
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
  requests: MultiplierRequest[],
  deps: { rpcCall?: NavRpc; rpcUrl?: string; timeoutMs?: number; readAt?: string } = {},
): Promise<Map<string, MultiplierReading>> {
  const out = new Map<string, MultiplierReading>()
  const readAt = deps.readAt || new Date().toISOString()
  const unique = new Map<string, MultiplierRequest>()
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
 * the row is refused rather than adjusted with a factor the price never saw. The
 * same holds while an update is still PENDING at the read (`effectiveAt` later
 * than `readAt`; xStocks writes the next value ahead of its activation): the
 * current `multiplier` is in effect now, but when it took effect is not on chain,
 * so it is not proved to have applied at the observation either. Both are stated
 * reasons. `effectiveAt` 0 means the multiplier has never been updated since the
 * mint was created, so it applied at every observation. */
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
  const effectiveMs = reading.effectiveAt * 1000
  if (observedAtMs >= effectiveMs) {
    return { multiplier: reading.newMultiplier, asOf: new Date(effectiveMs).toISOString(), reason: null }
  }
  const readAtMs = Date.parse(reading.readAt)
  if (Number.isFinite(readAtMs) && readAtMs < effectiveMs) return { multiplier: null, asOf: null, reason: 'multiplier_update_pending' }
  return { multiplier: null, asOf: null, reason: 'multiplier_changed_after_observation' }
}

// ─── The source, and resolving a capture ─────────────────────────────────────

/** A multiplier reader. The Solana scaled-UI reader is the only one: it reads
 * every mint the register asks for, Ondo's and xStocks', in one request. `id`
 * names the reader; which ISSUER a factor is attributed to (`AccrualSourceId`)
 * follows from the register, not from the reader. */
export interface AccrualMultiplierSource {
  readonly id: string
  readonly network: AccrualNetwork
  read(requests: MultiplierRequest[], readAt: string): Promise<Map<string, MultiplierReading>>
}

export function solanaScaledUiMultiplierSource(deps: { rpcCall?: NavRpc; rpcUrl?: string; timeoutMs?: number } = {}): AccrualMultiplierSource {
  return {
    id: 'solana_scaled_ui',
    network: 'solana',
    read: (requests, readAt) => readScaledUiMultipliers(requests, { ...deps, readAt }),
  }
}

/** The name the reader had while it read only Ondo's mints; the same reader. */
export const ondoSolanaMultiplierSource = solanaScaledUiMultiplierSource

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

/** Where a registered wrapper's multiplier is read, what the mint must prove,
 * and which issuer the factor is attributed to. Null when no mint is recorded. */
export function multiplierTarget(
  token: Pick<ReinvestingToken, 'cryptoId' | 'symbol'>,
  cls: ReinvestingClass,
): { request: MultiplierRequest; source: AccrualSourceId } | null {
  if (cls === 'ondo_gm') {
    const entry = ondoMintFor(token)
    return entry ? { request: { mint: entry.mint, symbol: entry.symbol }, source: 'ondo_solana_scaled_ui' } : null
  }
  const entry = xstockMintFor(token)
  // The register only ever hands an xStock entry to its own class.
  if (!entry || (cls === 'wrapped_xstock') !== (entry.wrapped === true)) return null
  return { request: { mint: entry.mint, symbol: entry.xstock, authority: XSTOCKS_MULTIPLIER_AUTHORITY }, source: 'xstocks_solana_scaled_ui' }
}

/** Classify every wrapper, read each registered mint once, and decide per
 * wrapper whether its price is divided or labelled:
 *   Ondo GM and wrapped xStock: divided by the multiplier in effect when the
 *     prices were observed;
 *   xStock: compared as it stands when that multiplier is exactly 1 (recorded as
 *     adjusted by x1), otherwise labelled `quote_unit_mixed` and never divided;
 *   any of them without a proved multiplier: labelled with the reason.
 * `source: false` switches the read off: the wrappers are still found and
 * LABELLED, never reported as premiums. */
export async function resolveAccrual(
  assets: AccrualAssetInput[],
  source: AccrualMultiplierSource | false,
  readAt: string,
): Promise<AccrualStepResult> {
  const classes = new Map<string, Map<string, ReinvestingClass>>()
  const wanted = new Map<string, MultiplierRequest>()
  for (const asset of assets) {
    const inAsset = new Map<string, ReinvestingClass>()
    for (const token of asset.tokens) {
      const cls = reinvestingClass(token)
      if (!cls || !token.cryptoId) continue
      inAsset.set(token.cryptoId, cls)
      const target = multiplierTarget(token, cls)
      if (target && !wanted.has(target.request.mint)) wanted.set(target.request.mint, target.request)
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
      const target = multiplierTarget(token, cls)
      let verdict: AccrualVerdict
      if (!target) verdict = { ...none, reason: 'no_multiplier_address' }
      else if (!readings) {
        verdict = { ...none, reason: error === 'multiplier_step_off' ? 'multiplier_not_read' : 'multiplier_read_failed', network: 'solana', address: target.request.mint }
      } else {
        const reading = readings.get(target.request.mint)
        const at = multiplierAt(reading, observedAtMs)
        const located = { network: 'solana', address: target.request.mint, readAt: reading?.readAt ?? readAt }
        if (at.reason != null) verdict = { ...none, ...located, reason: at.reason }
        // A proved multiplier above 1 on an xStock: its quote may or may not
        // include it (see the findings above), so it is labelled, not divided.
        else if (cls === 'xstock' && at.multiplier !== 1) verdict = { ...none, ...located, reason: 'quote_unit_mixed' }
        else verdict = { ...none, ...located, treatment: 'adjusted', multiplier: at.multiplier, source: target.source, asOf: at.asOf }
      }
      if (verdict.treatment === 'adjusted') adjusted += 1
      else notAdjusted += 1
      out.set(token.cryptoId, verdict)
    }
    verdicts.set(asset.rwaId, out)
  }
  return { verdicts, reinvesting, adjusted, notAdjusted, reads: readings ? wanted.size : 0, error }
}
