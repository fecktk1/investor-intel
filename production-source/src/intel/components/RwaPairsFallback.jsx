import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { Link } from 'react-router'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { captureReasonText, captureUnavailable, readCaptureView } from '../lib/capture-api'
import { readingText, usdLabel } from '../lib/rwa-depth-format'
import { formatDataTime } from '../lib/as-of'

// "Markets for this asset", when the market-pairs read is refused by plan.
//
// CoinMarketCap serves RWA market pairs from its Growth plan up, and ours is
// lower, so for every visitor and every member that read answers with a
// refusal. The drawer used to show that refusal beside a loading line and stop
// there. The refusal is final (it is a plan fact, not a slow read), so this
// block ends the section with what we DO hold about where the asset trades:
//
//   * the stored on-chain depth of each token representation of this asset,
//     from the daily pool lane (the rwa_depth capture view: a database read of
//     rows the lane already wrote, no provider call, free on every plan);
//   * the full DEX pool board on Market structure;
//   * the profile at the top of the drawer, which does not need market pairs.
//
// House visual language: an eyebrow, a hairline table and text links. No pills,
// no cards, no tiles.

const rule = 'border-b border-[var(--border-default)]'
const cell = `${rule} py-2 pr-3 align-top`
const head = `${rule} text-left font-normal py-2 pr-3`

/** The plan refusals of the market-pairs read. Anything else (a failed or slow
 * read) keeps the usual status line and its retry. */
const PLAN_REFUSALS = new Set(['insufficient_entitlement', 'unsupported_capability'])
export function pairsRefusedByPlan(result) {
  return !!result && ['unsupported', 'unavailable'].includes(result.state) && PLAN_REFUSALS.has(result.reason)
}

/** The rows of the depth board that belong to this real-world asset. */
export function depthRowsFor(payload, rwaId) {
  const id = String(rwaId ?? '')
  if (!id) return []
  return (Array.isArray(payload?.rows) ? payload.rows : []).filter(row => String(row?.rwaId ?? '') === id)
}

export default function RwaPairsFallback({ rwaId }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const client = useRef(supabase)
  client.current = supabase
  const orgId = org?.id || null
  const [read, setRead] = useState({ status: 'loading', rows: [], asOf: null, reason: null })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', rows: [], asOf: null, reason: null })
    readCaptureView('rwa_depth', {}, { orgId, signal: controller.signal, supabase: client.current })
      .then(payload => { if (alive) setRead({ status: 'ready', rows: depthRowsFor(payload, rwaId), asOf: payload?.asOf || null, reason: payload?.reason || null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', rows: [], asOf: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [rwaId, orgId])

  return (
    <div className="space-y-2 pt-1" data-testid="rwa-pairs-fallback" data-state={read.status}>
      <div className="eyebrow">{t('research.pairs_instead_eyebrow', { defaultValue: 'What we have instead' })}</div>
      {read.status === 'loading' && <p role="status" className="text-[12px]">{t('research.pairs_instead_loading', { defaultValue: 'Reading the stored pool depth of this asset\'s tokens…' })}</p>}
      {read.status === 'unavailable' && <p role="status" className="text-[12px]">{t('research.pairs_instead_failed', { why: captureReasonText(t, read.reason), defaultValue: 'The stored pool depth could not be read just now: {{why}}' })}</p>}
      {read.status === 'ready' && !read.rows.length && <p role="status" className="text-[12px] max-w-[75ch]">{t('research.pairs_instead_none', { defaultValue: 'The daily pool lane has not recorded on-chain pools for this asset\'s tokens, so there is no stored depth to show here.' })}</p>}
      {read.status === 'ready' && read.rows.length > 0 && (
        <>
          <p className="text-[12px] max-w-[75ch]">{t('research.pairs_instead_depth', { defaultValue: 'Stored on-chain depth of each token representation, from the daily pool lane. No provider call is made for this.' })}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr>
                  {/* The same column names as the pool board on Market structure. */}
                  <th scope="col" className={head}>{t('rwa_depth.col_token', { defaultValue: 'Token' })}</th>
                  <th scope="col" className={head}>{t('rwa_depth.col_deepest', { defaultValue: 'Deepest counted pool' })}</th>
                  <th scope="col" className={`${head} text-right`}>{t('rwa_depth.col_liquidity', { defaultValue: 'Sellable liquidity' })}</th>
                  <th scope="col" className={head}>{t('rwa_depth.col_reading', { defaultValue: 'Reading' })}</th>
                </tr>
              </thead>
              <tbody>
                {read.rows.map(row => {
                  const pool = row.deepestPool
                  const absent = t('rwa_lookup.not_reported', { defaultValue: 'not reported' })
                  const href = row.cryptoId ? `/intel/markets/${encodeURIComponent(row.symbol || row.cryptoId)}?provider=coinmarketcap&id=${row.cryptoId}` : null
                  return (
                    <tr key={row.tokenKey || row.cryptoId || row.symbol}>
                      <td className={cell}>{href ? <Link className="intel-text-link" to={href}>{row.symbol || row.tokenName}</Link> : (row.symbol || row.tokenName || absent)}{row.issuerName ? <span className="block text-[var(--fg-4)]">{row.issuerName}</span> : null}</td>
                      <td className={cell}>{pool ? [pool.dex, pool.chain, pool.pair].filter(Boolean).join(' · ') || absent : absent}</td>
                      <td className={`${cell} text-right intel-number`}>{row.countedLiquidityUsd == null ? absent : usdLabel(row.countedLiquidityUsd)}</td>
                      <td className={cell}>{readingText(row, t)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {read.asOf && <p className="text-[11px] text-[var(--fg-4)]">{t('research.pairs_instead_as_of', { time: formatDataTime(read.asOf, { language: i18next.language }), defaultValue: 'Captured {{time}}.' })}</p>}
        </>
      )}
      <p className="text-[12px]">
        <Link className="intel-text-link" to="/intel/structure#intel-rwa-depth">{t('research.pairs_instead_board', { defaultValue: 'Every tokenised asset\'s DEX pools on Market structure' })}</Link>
      </p>
      <p className="text-[12px] text-[var(--fg-4)] max-w-[75ch]">{t('research.pairs_instead_profile', { defaultValue: 'The asset profile at the top of this drawer and the token prices above come from stored captures and do not depend on market pairs.' })}</p>
    </div>
  )
}
