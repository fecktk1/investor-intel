import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toneColor } from '../charts'
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
 *  them. The first four are the networks the launchpad lane reads; the last two
 *  are the CoinMarketCap lane's platforms, kept because that lane still writes
 *  these tables and a window of its rows must stay filterable. */
export const MEME_CHAINS = ['all', 'solana', 'bnb', 'base', 'robinhood', 'ethereum', 'arbitrum']

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
  if (MEME_CHAINS.includes(id)) {
    const chain = getChain(id)
    if (chain) return chain.namespace === 'eip155' ? `eip155:${chain.caip2Ref}` : chain.id
    return EXTRA_CAIP[id] ?? null
  }
  return CAIP_SHAPE.test(id) ? id : null
}

/** A stored CAIP chain, named the way chains.js names it, then the way the
 *  launchpad registry names it, and otherwise shown verbatim rather than folded
 *  onto a network we did not read. */
export function chainLabel(caip) {
  const raw = String(caip ?? '').trim()
  if (!raw) return '—'
  const [namespace, reference] = raw.includes(':') ? [raw.slice(0, raw.indexOf(':')), raw.slice(raw.indexOf(':') + 1)] : [raw, 'mainnet']
  return getChain(chainIdFor(namespace, reference) || '')?.label || CHAIN_LABELS[raw] || raw
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
 *  the workspace search can never disagree about its shape. */
export function contractHref(row) {
  const chain = String(row?.chain ?? '').trim()
  const address = String(row?.contractAddress ?? '').trim()
  if (!chain || !address) return null
  return contractRoute(row?.symbol || row?.name || address, chain, address)
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

const selectNode = node => {
  try {
    const selection = window.getSelection?.()
    if (!selection || !node) return
    const range = document.createRange()
    range.selectNodeContents(node)
    selection.removeAllRanges()
    selection.addRange(range)
  } catch { /* a browser that refuses the selection still shows the full text */ }
}

/**
 * The captured contract: shortened on screen, whole in the title attribute,
 * whole on the clipboard, and never a dead end.
 *
 * The address opens the Markets asset page through the contract route, which
 * resolves a launchpad token for any member. When the clipboard API is missing
 * or refuses, the control does not fail silently: it swaps the shortened text
 * for the FULL address in a focusable element and selects it, so the address is
 * still reachable and copyable from the keyboard.
 */
export function ContractCell({ row, t }) {
  const address = String(row?.contractAddress ?? '').trim()
  const [state, setState] = useState('idle')
  const full = useRef(null)
  const timer = useRef(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const copy = useCallback(() => {
    const manual = () => {
      setState('manual')
      // The node only exists once the manual branch has rendered it.
      setTimeout(() => selectNode(full.current), 0)
    }
    let written = null
    try { written = navigator.clipboard?.writeText?.(address) } catch { written = null }
    if (!written) { manual(); return }
    Promise.resolve(written)
      .then(() => {
        setState('copied')
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setState('idle'), 1600)
      })
      .catch(manual)
  }, [address])

  if (!address) return <>—</>
  const href = contractHref(row)
  const shown = state === 'manual'
    ? <code ref={full} tabIndex={0} className="font-mono text-[var(--fg-2)] break-all">{address}</code>
    : <code title={address} className="font-mono text-[var(--fg-2)]">{shortAddress(address)}</code>

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {href
        ? <Link to={href} title={t('graduation.open_asset', { address, defaultValue: 'Open the asset page for {{address}}' })}>{shown}</Link>
        : shown}
      <button
        type="button"
        className="intel-text-link text-[11px]"
        aria-label={t('graduation.copy_address', { defaultValue: 'Copy contract address' })}
        title={t('graduation.copy_address', { defaultValue: 'Copy contract address' })}
        onClick={copy}
      >
        {t('graduation.copy_address', { defaultValue: 'Copy contract address' })}
      </button>
      {state === 'copied'
        ? <span role="status" className="text-[11px] text-[var(--fg-4)]">{t('graduation.copied', { defaultValue: 'Copied' })}</span>
        : null}
      {state === 'manual'
        ? <span role="status" className="text-[11px] text-[var(--fg-4)]">{t('graduation.copy_unavailable', { defaultValue: 'The clipboard is unavailable here. The full address is selected, so copy it with your keyboard.' })}</span>
        : null}
    </span>
  )
}

/** Symbol or name, linked to the asset page. Every captured row that names a
 *  chain and an address opens; a row that names neither is plain text rather
 *  than a link to nowhere. */
export function AssetName({ row, text, t }) {
  const label = text || row?.symbol || row?.name || '—'
  const href = contractHref(row)
  if (!href) return <>{label}</>
  return <Link to={href} title={t('graduation.open_asset', { address: row?.contractAddress || label, defaultValue: 'Open the asset page for {{address}}' })}>{label}</Link>
}
