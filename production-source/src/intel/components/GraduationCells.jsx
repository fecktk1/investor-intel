import React from 'react'
import { Link } from 'react-router'
import { toneColor } from '../charts'
import CopyAddress from './CopyAddress'
import { getChain, chainIdFor } from '../lib/chains'
import { CHAIN_LABELS, PAD_LABELS } from '../lib/launchpads'
import { contractRoute } from '../lib/workspace-search'
import { formatUsd } from '../lib/market-format'

// Shared cells for the /intel/graduation tables.
//
// They live here rather than in GraduationFunnel.jsx because the stage lists,
// the recent-sightings table and the launchpad board all print the same facts
// and must print them the same way: a launchpad's NAME and never its dex id, a
// chain named the way every other Intel board names it, a bonding curve drawn
// as the small inline mark the chart kit uses for a value inside a table row,
// and a contract address that is shortened on screen but never truncated in
// what a reader can copy or open.

/** The app-facing chain ids this page's control offers, in the order it shows
 *  them. The first four are the networks the CoinGecko launchpad lane reads,
 *  `tron` is the chain-log lane's (SunPump, read off TRON directly), and the
 *  last two are the CoinMarketCap lane's platforms, kept because that lane still
 *  writes these tables and a window of its rows must stay filterable. */
export const MEME_CHAINS = ['all', 'solana', 'bnb', 'base', 'robinhood', 'tron', 'ethereum', 'arbitrum']

/** Chains the app-wide registry does not carry. Robinhood Chain is read by the
 *  launchpad lane and is not an Alchemy/Helius chain, so it has no entry in
 *  src/intel/lib/chains.js and its CAIP reference is stated here instead of
 *  being derived from a registry that does not know it. */
const EXTRA_CAIP = { robinhood: 'eip155:4663' }

const CAIP_SHAPE = /^[a-z0-9-]+:[A-Za-z0-9-]+$/

export const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** The CAIP chain the read is asked for, or null for "all".
 *
 *  A chain the control names is resolved through the chain registry wherever the
 *  registry carries it, so a CAIP reference that moves there cannot silently
 *  point this page at the wrong network. A chain the page was handed by the READ
 *  and does not name itself (a network the capture lane grew after this file was
 *  written) is passed straight back as the CAIP it already is. */
export function chainCaip(id) {
  if (!id || id === 'all') return null
  const chain = getChain(id)
  if (chain) return chain.namespace === 'eip155' ? `eip155:${chain.caip2Ref}` : chain.id
  if (EXTRA_CAIP[id]) return EXTRA_CAIP[id]
  return CAIP_SHAPE.test(id) ? id : null
}

/** A stored CAIP chain, named the way the CAPTURE registry names it, then the
 *  way the app-wide registry does, and otherwise shown verbatim rather than
 *  folded onto a network we did not read.
 *
 *  The capture's own name comes FIRST, and that order is the point. The two
 *  registries agree on every chain they both carry except one: the capture
 *  registry and TRON's own foundation call `tron` TRON, while chains.js spells
 *  it Tron for the portfolio side. The chain control is built from what the read
 *  named, so a Chain column that resolved through chains.js instead would print
 *  a second name for the network the filter above it just named. */
export function chainLabel(caip) {
  const raw = String(caip ?? '').trim()
  if (!raw) return '—'
  if (CHAIN_LABELS[raw]) return CHAIN_LABELS[raw]
  const [namespace, reference] = raw.includes(':') ? [raw.slice(0, raw.indexOf(':')), raw.slice(raw.indexOf(':') + 1)] : [raw, 'mainnet']
  return getChain(chainIdFor(namespace, reference) || '')?.label || raw
}

/** The pad's human name. The page never prints a dex id at a reader: the read
 *  carries `launchpadLabel`, the registry mirror is the fallback, and only a pad
 *  neither of them knows is shown as the id it is. */
export const padLabel = row => row?.launchpadLabel || PAD_LABELS[row?.launchpad] || row?.launchpad || null

export const shortAddress = value => {
  const raw = String(value ?? '').trim()
  if (!raw) return '—'
  return raw.length <= 16 ? raw : `${raw.slice(0, 8)}…${raw.slice(-6)}`
}

export const stamp = value => {
  const at = Date.parse(value)
  return Number.isFinite(at)
    ? new Date(at).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
    : '—'
}

export const hoursText = value => (num(value) == null ? '—' : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })}h`)

/** Where a captured contract opens. The Markets asset page resolves
 *  `provider=contract` with a `<chain>:<address>` identity, verified live for a
 *  launchpad token on a free membership, so every captured row that names a
 *  chain and an address opens — nothing is gated on the catalogue having heard
 *  of the token first. The route is minted by the shared helper so this page and
 *  the workspace search can never disagree about its shape.
 *
 *  The path segment is the SYMBOL, and where the source published none it is the
 *  ADDRESS: an identifier either way. A display name is not one — it carries
 *  spaces, punctuation and whatever a deployer typed — and the asset page reads
 *  the segment as a lookup input whenever the query has no identity on it. The
 *  identity is on `provider=contract&id=<chain>:<address>` regardless. */
export function contractHref(row) {
  const chain = String(row?.chain ?? '').trim()
  const address = String(row?.contractAddress ?? '').trim()
  if (!chain || !address) return null
  return contractRoute(row?.symbol || address, chain, address)
}

/** Bonding-curve progress as the chart kit draws an inline value: a small mark
 *  inside the row, no figure, no caption, no pill, colour from a workspace token.
 *
 *  The percentage is printed AS PUBLISHED. Pump.fun publishes small negative
 *  percentages at the very start of a curve, so the band is -100..100 and the
 *  number is never floored to zero to make the bar look tidy; only the drawn
 *  width is clamped, because a negative bar is not a shape. A pad with no
 *  bonding curve publishes no percentage at all, and that says "not published"
 *  rather than "0%". */
export function BondingProgress({ pct, near = 80, t }) {
  const value = num(pct)
  if (value == null) {
    return <span className="text-[var(--fg-4)]">{t('graduation.progress_unpublished', { defaultValue: 'no curve published' })}</span>
  }
  const width = Math.max(0, Math.min(100, value))
  const text = `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
  const color = toneColor(value >= near ? 'green' : 'accent')
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <svg className="intel-sparkline" viewBox="0 0 64 8" width="64" height="8" role="img"
        aria-label={t('graduation.progress_label', { pct: text, defaultValue: 'Bonding curve {{pct}}' })}>
        <rect x="0" y="3" width="64" height="2" fill="var(--border-default)" />
        {width > 0 ? <rect x="0" y="2" width={((width / 100) * 64).toFixed(2)} height="4" fill={color} /> : null}
      </svg>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{text}</span>
    </span>
  )
}

/** Market cap when the source published one, and the fully diluted valuation
 *  when it did not — LABELLED as the FDV it is.
 *
 *  Before graduation CoinGecko publishes `fdv` and leaves `market_cap` null, so
 *  a cell that read `marketCap` alone would show every pre-graduation token on
 *  this page as valueless. Presenting an FDV as a market cap would be worse, so
 *  the cell names which of the two it is showing. */
export function ValueCell({ row, t }) {
  const cap = num(row?.marketCap)
  if (cap != null) return <>{formatUsd(cap)}</>
  const fdv = num(row?.fdv)
  if (fdv == null) return <>—</>
  return <>{`${formatUsd(fdv)} ${t('graduation.fdv_suffix', { defaultValue: 'FDV' })}`}</>
}

/**
 * The captured contract: shortened on screen, whole in the title attribute,
 * whole on the clipboard, and never a dead end.
 *
 * The address opens the Markets asset page through the contract route, which
 * resolves a launchpad token for any member.
 *
 * The copy control is the SHARED one. Every Intel surface that prints an address
 * prints it through CopyAddress, so the rule that the button writes the full
 * address and never the shortened label, the "Copied" status and the fallback a
 * browser with no clipboard API gets are one implementation and not three that
 * drift apart. It is asked not to print the address itself, because here the
 * address is a link and only this cell knows where it goes.
 */
export function ContractCell({ row, t }) {
  const address = String(row?.contractAddress ?? '').trim()
  if (!address) return <>—</>
  const href = contractHref(row)
  const shown = <code title={address} className="font-mono text-[var(--fg-2)]">{shortAddress(address)}</code>

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {href
        ? <Link to={href} title={t('graduation.open_asset', { address, defaultValue: 'Open the asset page for {{address}}' })}>{shown}</Link>
        : shown}
      <CopyAddress value={address} showAddress={false} />
    </span>
  )
}

/** The row's name on the asset page, linked there.
 *
 *  EVERY captured row links. A source that published no symbol still published a
 *  contract, so the link text falls back to the SHORTENED ADDRESS rather than to
 *  a dash: a dash is not a name, and a row a reader cannot open from the column
 *  they are reading is a dead end on the one page whose job is to name new
 *  contracts. Only a row carrying neither a chain nor an address has nowhere to
 *  go, and that is plain text rather than a link to nowhere. */
export function AssetName({ row, text, t }) {
  const address = String(row?.contractAddress ?? '').trim()
  const label = text || row?.symbol || (address ? shortAddress(address) : null) || row?.name || '—'
  const href = contractHref(row)
  if (!href) return <>{label}</>
  return <Link to={href} title={t('graduation.open_asset', { address: address || label, defaultValue: 'Open the asset page for {{address}}' })}>{label}</Link>
}
