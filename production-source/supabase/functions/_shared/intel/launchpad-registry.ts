// Investor Intel — the launchpad registry: which networks and which launchpads
// the `launchpad_stages` capture lane covers, and what to CALL each of them.
//
// This is a separate module from `capture-launchpads.ts` on purpose. The read
// half (`capture-meme-read.ts`) needs the human labels so the page never prints
// a dex id at a reader, and it must not drag the capture lane's transport — and
// with it the HTTP client, the provider budget and the CoinGecko key handling —
// into its module graph just to look up a name.
//
// EVERY id here was read out of `GET /networks/{network}/dexes` on the public
// GeckoTerminal host on 2026-09-17 and is listed, together with the ids that
// were REJECTED and why, in docs/investor-intel/launchpads.md. The lane
// nevertheless re-reads the registry at run time before it writes a row: this
// file is a claim, the live registry is the evidence, and a pad the registry
// does not name is skipped and reported rather than trusted from here.

/** `network` is the source's own network id; `chain` is the CAIP-2 identity the
 * capture tables store. Both are stated rather than derived: a wrong mapping
 * would file a BNB Chain token under Ethereum and no later read could tell. */
export interface LaunchpadNetwork {
  network: string
  chain: string
  label: string
  /** Address shape, matching the CHECK on `contract_address`. */
  address: 'evm' | 'solana'
}

export const LAUNCHPAD_NETWORKS: readonly LaunchpadNetwork[] = [
  { network: 'solana', chain: 'solana', label: 'Solana', address: 'solana' },
  { network: 'bsc', chain: 'eip155:56', label: 'BNB Chain', address: 'evm' },
  { network: 'base', chain: 'eip155:8453', label: 'Base', address: 'evm' },
  { network: 'robinhood', chain: 'eip155:4663', label: 'Robinhood Chain', address: 'evm' },
] as const

/**
 * `role: 'pad'` is where a token is CREATED and runs a bonding curve.
 * `role: 'destination'` is the AMM a graduated token migrates INTO. A
 * destination pool is only ever kept when its base token is one we already
 * track, so a destination can confirm a graduation but never invents a cohort
 * member out of an AMM listing.
 */
export interface LaunchpadPad {
  network: string
  dex: string
  /** Human name for the page. The page must never print a dex id at a reader. */
  label: string
  role: 'pad' | 'destination'
}

export const LAUNCHPAD_PADS: readonly LaunchpadPad[] = [
  // Solana
  { network: 'solana', dex: 'pump-fun', label: 'Pump.fun', role: 'pad' },
  { network: 'solana', dex: 'raydium-launchlab', label: 'LetsBonk on Raydium LaunchLab', role: 'pad' },
  { network: 'solana', dex: 'meteora-dbc', label: 'Meteora DBC', role: 'pad' },
  { network: 'solana', dex: 'boop-fun', label: 'Boop', role: 'pad' },
  { network: 'solana', dex: 'bags-fm', label: 'Bags', role: 'pad' },
  { network: 'solana', dex: 'moonit', label: 'Moonit', role: 'pad' },
  { network: 'solana', dex: 'pumpswap', label: 'PumpSwap', role: 'destination' },
  { network: 'solana', dex: 'meteora-damm-v2', label: 'Meteora DAMM v2', role: 'destination' },
  // BNB Chain
  { network: 'bsc', dex: 'four-meme', label: 'Four.meme', role: 'pad' },
  { network: 'bsc', dex: 'tiktokfun', label: 'TikTok.fun', role: 'pad' },
  { network: 'bsc', dex: 'pancakeswap_v2', label: 'PancakeSwap v2', role: 'destination' },
  { network: 'bsc', dex: 'pancakeswap-infinity-clmm', label: 'PancakeSwap Infinity CLMM', role: 'destination' },
  // Base
  { network: 'base', dex: 'virtuals-base', label: 'Virtuals', role: 'pad' },
  { network: 'base', dex: 'virtuals-unicorn-base', label: 'Virtuals Unicorn', role: 'pad' },
  { network: 'base', dex: 'bankr', label: 'Bankr', role: 'pad' },
  { network: 'base', dex: 'o1-launchpad', label: 'o1 Launchpad', role: 'pad' },
  // Robinhood Chain
  { network: 'robinhood', dex: 'pons-v2', label: 'Pons', role: 'pad' },
  { network: 'robinhood', dex: 'pons-dot-family', label: 'Pons Family', role: 'pad' },
  { network: 'robinhood', dex: 'clanker-robinhood', label: 'Clanker', role: 'pad' },
  { network: 'robinhood', dex: 'bankr-robinhood', label: 'Bankr', role: 'pad' },
  { network: 'robinhood', dex: 'virtuals-robinhood', label: 'Virtuals', role: 'pad' },
  { network: 'robinhood', dex: 'o1-launchpad-robinhood', label: 'o1 Launchpad', role: 'pad' },
  { network: 'robinhood', dex: 'pons-v2-dex', label: 'Pons v2 AMM', role: 'destination' },
] as const

/** Ids that were CONSIDERED and are deliberately absent, with the reason. Kept
 * in code so the next reader does not re-add one and then wonder why it writes
 * nothing. Asserted against LAUNCHPAD_PADS by test. */
export const LAUNCHPAD_REJECTED: readonly { network: string; dex: string; reason: string }[] = [
  // Verified absent from `GET /networks/solana/dexes` on 2026-09-17: the registry
  // names raydium, raydium-clmm and raydium-launchlab, and no raydium-cpmm.
  { network: 'solana', dex: 'raydium-cpmm', reason: 'absent_from_registry' },
  // Base has no Clanker or Zora dex id, and neither runs a bonding curve there,
  // so there is nothing to place in a graduation funnel.
  { network: 'base', dex: 'clanker', reason: 'absent_from_registry' },
  { network: 'base', dex: 'zora', reason: 'absent_from_registry' },
  // Flap is not on GeckoTerminal at all; covering it would mean reading raw
  // chain logs, which is a different lane.
  { network: 'bsc', dex: 'flap', reason: 'not_published_by_source' },
] as const

/**
 * Launchpads a CHAIN-LOG lane covers, which have no CoinGecko dex id at all.
 *
 * These are deliberately NOT in `LAUNCHPAD_PADS`. That list is the set of ids the
 * CoinGecko lane verifies against `GET /networks/{network}/dexes` before it
 * writes a row, and an id that registry has never heard of would be rejected
 * every hour and reported as missing forever. SunPump is read straight off the
 * TRON chain through TronGrid by `capture-sunpump.ts`, so its evidence is a
 * contract log, not a dex registry.
 *
 * They still belong in this file, because the READ half needs the same two
 * things for every launchpad whatever lane wrote it: a human name for the page
 * and the chain it lives on.
 */
export interface ChainLogPad {
  /** `launchpad` as stored on the row. */
  launchpad: string
  /** CAIP-2 chain as stored on the row. */
  chain: string
  label: string
  chainLabel: string
}

export const CHAIN_LOG_PADS: readonly ChainLogPad[] = [
  { launchpad: 'sunpump', chain: 'tron', label: 'SunPump', chainLabel: 'TRON' },
] as const

/** launchpad id → human name, for the read payload and the page. Covers both the
 * dex-registry pads and the chain-log pads, so the page never prints a raw id at
 * a reader whichever lane wrote the row. */
export const PAD_LABELS: Record<string, string> = {
  ...Object.fromEntries(LAUNCHPAD_PADS.map((pad) => [pad.dex, pad.label])),
  ...Object.fromEntries(CHAIN_LOG_PADS.map((pad) => [pad.launchpad, pad.label])),
}
/** CAIP-2 chain → human name. 'tron' is named TRON, which is what TRON's own
 * foundation, TronScan and our own `market_assets` row for TRX all call it. */
export const CHAIN_LABELS: Record<string, string> = {
  ...Object.fromEntries(LAUNCHPAD_NETWORKS.map((n) => [n.chain, n.label])),
  ...Object.fromEntries(CHAIN_LOG_PADS.map((pad) => [pad.chain, pad.chainLabel])),
}
/** launchpad id → the CAIP-2 chain it lives on. */
export const PAD_CHAINS: Record<string, string> = {
  ...Object.fromEntries(LAUNCHPAD_PADS.map((pad) => [pad.dex, LAUNCHPAD_NETWORKS.find((n) => n.network === pad.network)?.chain ?? pad.network])),
  ...Object.fromEntries(CHAIN_LOG_PADS.map((pad) => [pad.launchpad, pad.chain])),
}

/** Stage boundary: a bonding curve at or above this is `aboutGraduates`. */
export const GRADUATION_NEAR_PCT = 80

/** The CoinGecko attribution the paid terms REQUIRE wherever this data is
 * shown (visible, font size at least 10). It travels on the read payload so the
 * page cannot render the data without being handed the notice it must print. */
export const COINGECKO_ATTRIBUTION = {
  provider: 'coingecko',
  text: 'Powered by CoinGecko',
  url: 'https://www.coingecko.com',
} as const
