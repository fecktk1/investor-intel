// Investor Intel — frontend mirror of the launchpad registry.
//
// The authority is supabase/functions/_shared/intel/launchpad-registry.ts, and
// the live GeckoTerminal dex registry is the authority over THAT. This copy
// exists for one reason only: the page has to offer a chain and a launchpad
// control before it has read anything, and a control built purely out of the
// answer would collapse to a single option the moment a reader picked one (a
// filtered read names only the group it was filtered to, so the reader could
// never get back out).
//
// Nothing here is ever printed as a fact about captured data. A pad listed here
// with no rows in the window renders the page's honest empty state; a pad the
// answer names that this list does not know is added to the control from the
// answer, with the answer's own label, rather than being dropped.

/** CAIP-2 chain → the name the capture registry gives it. Chain names are
 *  proper nouns and are not translated: 'Solana' is 'Solana' in every locale,
 *  exactly as the Chain column on every other Intel board prints it. */
export const LAUNCHPAD_CHAINS = [
  { chain: 'solana', label: 'Solana' },
  { chain: 'eip155:56', label: 'BNB Chain' },
  { chain: 'eip155:8453', label: 'Base' },
  { chain: 'eip155:4663', label: 'Robinhood Chain' },
]

/** The CoinMarketCap lane's own platforms, kept because that lane still writes
 *  these two tables and a window of its rows must stay filterable. Removing
 *  them would remove a filter that works. */
export const LEGACY_CHAINS = [
  { chain: 'eip155:1', label: 'Ethereum' },
  { chain: 'eip155:42161', label: 'Arbitrum' },
]

/** Chains a CHAIN-LOG lane reads, mirroring CHAIN_LOG_PADS in the capture
 *  registry. SunPump has no GeckoTerminal dex id at all, so `capture-sunpump.ts`
 *  reads its launch log off TRON directly and writes the same two tables.
 *
 *  The name is the CAPTURE's: `tron` is TRON, which is what the capture
 *  registry, TRON's own foundation and TronScan call it. The app-wide registry
 *  in src/intel/lib/chains.js spells the same chain `Tron` for the portfolio
 *  side, and a page that took one name for its filter and the other for its
 *  Chain column would print two names for one network. */
export const CHAIN_LOG_CHAINS = [
  { chain: 'tron', label: 'TRON' },
]

/** `role: 'pad'` entries only. A graduation destination is an AMM, never a
 *  launchpad, and it never appears in this control. */
export const LAUNCHPADS = [
  { key: 'pump-fun', label: 'Pump.fun', chain: 'solana' },
  { key: 'raydium-launchlab', label: 'LetsBonk on Raydium LaunchLab', chain: 'solana' },
  { key: 'meteora-dbc', label: 'Meteora DBC', chain: 'solana' },
  { key: 'boop-fun', label: 'Boop', chain: 'solana' },
  { key: 'bags-fm', label: 'Bags', chain: 'solana' },
  { key: 'moonit', label: 'Moonit', chain: 'solana' },
  { key: 'four-meme', label: 'Four.meme', chain: 'eip155:56' },
  { key: 'tiktokfun', label: 'TikTok.fun', chain: 'eip155:56' },
  { key: 'virtuals-base', label: 'Virtuals', chain: 'eip155:8453' },
  { key: 'virtuals-unicorn-base', label: 'Virtuals Unicorn', chain: 'eip155:8453' },
  { key: 'bankr', label: 'Bankr', chain: 'eip155:8453' },
  { key: 'o1-launchpad', label: 'o1 Launchpad', chain: 'eip155:8453' },
  { key: 'pons-v2', label: 'Pons', chain: 'eip155:4663' },
  { key: 'pons-dot-family', label: 'Pons Family', chain: 'eip155:4663' },
  { key: 'clanker-robinhood', label: 'Clanker', chain: 'eip155:4663' },
  { key: 'bankr-robinhood', label: 'Bankr', chain: 'eip155:4663' },
  { key: 'virtuals-robinhood', label: 'Virtuals', chain: 'eip155:4663' },
  { key: 'o1-launchpad-robinhood', label: 'o1 Launchpad', chain: 'eip155:4663' },
  // A chain-log pad: no dex id, read straight off TRON by the SunPump lane. It
  // is a launchpad like any other to a reader, so it is on the same control.
  { key: 'sunpump', label: 'SunPump', chain: 'tron' },
]

export const CHAIN_LABELS = Object.fromEntries([...LAUNCHPAD_CHAINS, ...CHAIN_LOG_CHAINS, ...LEGACY_CHAINS].map(row => [row.chain, row.label]))
export const PAD_LABELS = Object.fromEntries(LAUNCHPADS.map(pad => [pad.key, pad.label]))
export const PAD_CHAINS = Object.fromEntries(LAUNCHPADS.map(pad => [pad.key, pad.chain]))

/** Stage boundary: a bonding curve at or above this is `aboutGraduates`. It
 *  mirrors GRADUATION_NEAR_PCT in the capture registry, and the page uses it
 *  only to colour the inline curve mark — never to re-derive a stage, which is
 *  the capture's to decide. */
export const GRADUATION_NEAR_PCT = 80

/**
 * How many capture hours a cohort needs before an absent graduation is read as
 * a measurement rather than as "we have only looked once".
 *
 * The lane runs hourly and a graduation is a MOVEMENT between two captures, so
 * a window holding a single capture cannot contain one by construction. Three
 * is the smallest number that is not trivially one: two captures can hold one
 * transition, three can hold a distribution worth quoting a rate over. Above
 * this line a cohort with no graduates is a real zero and is printed as one.
 */
export const HISTORY_CAPTURES = 3

/** Two pads can share a label on different chains — Bankr and Virtuals each run
 *  on Base and on Robinhood Chain — so an option list that shows the label
 *  alone would offer the same word twice. A label that is not unique inside the
 *  list it is shown in carries its chain; one that is unique stays plain. */
export function padOptionLabel(pad, pads = []) {
  const label = pad?.label || pad?.key || ''
  const clashes = pads.filter(other => (other?.label || other?.key) === label).length > 1
  if (!clashes) return label
  const chain = CHAIN_LABELS[pad?.chain] || pad?.chain
  return chain ? `${label} · ${chain}` : label
}
