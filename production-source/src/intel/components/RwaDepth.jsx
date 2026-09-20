import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { Scatter } from '../charts'
import TokenAvatar from './TokenAvatar'
import CopyAddress from './CopyAddress'
import { readCaptureView, captureUnavailable } from '../lib/capture-api'
import { formatCompact } from '../lib/market-format'
import { assetHref, depthPoints, pctLabel, readingText, usdLabel } from '../lib/rwa-depth-format'

// Where tokenised assets can actually be sold.
//
// The question this board answers is the one the RWA track structurally cannot:
// a tokenised treasury fund or tokenised share can carry a large tokenised
// market value and still have almost nothing behind it on chain. The endpoint
// built for that answer, /v5/real-world-assets/market-pairs/list, is Growth tier
// and is refused on this plan, so every other entry falls back to 24-hour
// volume, which is turnover and not depth. This board reads the pools instead.
//
// Four rules this file may never soften:
//   1. "NO POOL" NEVER APPEARS WITHOUT ITS CHAINS. Every state that means "we
//      looked and found nothing" prints the chains that were read, and a token
//      deployed only on chains CoinMarketCap publishes no DEX data for is a
//      COVERAGE row, never a liquidity finding.
//   2. OUR FIGURES ARE LABELLED AS OURS. Concentration and the "size relative to
//      the deepest pool" reading are computed by us from the provider's stored
//      liquidity, and the method sentence is on the page, not in a tooltip.
//   3. PENDING IS NOT THIN. A token the daily budget did not reach reads as
//      pending and sorts into its own group.
//   4. AN EMPTY BOARD SAYS WHY AND WHEN IT FILLS.
//
// House visual language: no pills, no chips, no cards. Eyebrow, hairlines,
// plain table, matching RwaUniverse.jsx and RwaIssuerLegitimacy.jsx.

const rule = 'border-b border-[var(--border-default)]'
const cell = `${rule} py-2 pr-3 align-top`
const head = `${rule} text-left font-normal py-2 pr-3`

function Scope({ children }) {
  return <p className="text-[11px] leading-relaxed text-[var(--fg-4)] mt-1 max-w-[80ch]">{children}</p>
}

export default function RwaDepth() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  // Service-role capture tables: the read travels on the reader's own
  // authenticated client, never the anonymous one.
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('rwa_depth', {}, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, supabase])

  const payload = read.payload || {}
  const rows = useMemo(() => (Array.isArray(payload.rows) ? payload.rows : []), [payload])
  const cohort = payload.cohort || {}
  const points = useMemo(() => depthPoints(rows), [rows])
  const readChains = (payload.readChains || []).join(', ')
  const captureTime = payload.schedule?.rwa_depth?.utc || '03:34'
  const asOf = payload.asOf && Number.isFinite(Date.parse(payload.asOf)) ? new Date(payload.asOf).toLocaleString() : null

  return (
    <section id="intel-rwa-depth" className="intel-rwa-depth space-y-6" aria-label={t('rwa_depth.title', { defaultValue: 'Where tokenised assets can actually be sold' })}>
      <div>
        <div className="eyebrow">{t('rwa_depth.eyebrow', { defaultValue: 'On-chain depth' })}</div>
        <h3 className="text-lg font-medium mt-1">{t('rwa_depth.title', { defaultValue: 'Where tokenised assets can actually be sold' })}</h3>
        <Scope>{t('rwa_depth.intro', { chains: readChains, defaultValue: 'A tokenised asset can carry a large tokenised value and still have almost nothing behind it on chain. This board resolves each token\'s deployments across chains, then reads the pools of every deployment on {{chains}}, which are the chains CoinMarketCap publishes DEX pool data for on this plan. A token with no pool on those chains says so and names them; it is not evidence that the token cannot be sold elsewhere.' })}</Scope>
      </div>

      {read.status === 'loading' && <p role="status">{t('rwa_depth.loading', { defaultValue: 'Reading the captured pools…' })}</p>}

      {read.status === 'unavailable' && (
        <p role="alert">{t('rwa_depth.unavailable', { reason: read.reason || 'unknown', defaultValue: 'The depth board could not be read ({{reason}}). Nothing is asserted about any token\'s liquidity.' })}</p>
      )}

      {read.status === 'ready' && (
        <>
          {payload.reason && (
            <p role="status" className="text-[12px]">
              {t('rwa_depth.partial', { reason: payload.reason, defaultValue: 'Part of this read did not answer ({{reason}}). What did load is shown; nothing was replaced with a zero.' })}
            </p>
          )}

          {rows.length === 0 ? (
            <p role="status" className="text-[12px]">
              {t('rwa_depth.not_captured', { time: captureTime, defaultValue: 'No tokenised-asset pools have been captured yet. The deployments and pools are read once a day at {{time}} UTC, and the board fills from the first run.' })}
            </p>
          ) : (
            <>
              <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-5 text-[12px]">
                <div className={`${rule} py-2`}>
                  <dt className="text-[var(--fg-4)]">{t('rwa_depth.cohort_count', { defaultValue: 'Tokens read' })}</dt>
                  <dd className="intel-number">{formatCompact(cohort.count)}</dd>
                </div>
                <div className={`${rule} py-2`}>
                  <dt className="text-[var(--fg-4)]">{t('rwa_depth.cohort_with_pools', { defaultValue: 'With a pool' })}</dt>
                  <dd className="intel-number">{formatCompact(cohort.withPools)}</dd>
                </div>
                <div className={`${rule} py-2`}>
                  <dt className="text-[var(--fg-4)]">{t('rwa_depth.cohort_without_pools', { defaultValue: 'No pool on the chains read' })}</dt>
                  <dd className="intel-number">{formatCompact(cohort.withoutPools)}</dd>
                </div>
                <div className={`${rule} py-2`}>
                  <dt className="text-[var(--fg-4)]">{t('rwa_depth.cohort_permissioned', { defaultValue: 'Issuer redemption only' })}</dt>
                  <dd className="intel-number">{formatCompact(cohort.permissioned)}</dd>
                </div>
                <div className={`${rule} py-2`}>
                  <dt className="text-[var(--fg-4)]">{t('rwa_depth.cohort_liquidity', { defaultValue: 'Pool liquidity found' })}</dt>
                  <dd className="intel-number">{usdLabel(cohort.totalLiquidityUsd)}</dd>
                </div>
              </dl>
              {(cohort.notCovered > 0 || cohort.pending > 0) && (
                <p className="text-[12px]">
                  {t('rwa_depth.cohort_rest', {
                    notCovered: formatCompact(cohort.notCovered), pending: formatCompact(cohort.pending),
                    defaultValue: '{{notCovered}} more are deployed only on chains this plan cannot read pools for, and {{pending}} have not been reached by the daily read yet. Neither is counted as thin.',
                  })}
                </p>
              )}

              {/* Liquidity against the token's own market cap. The point of the
                  figure is the bottom right: a large wrapper with a thin pool. */}
              <Scatter
                title={t('rwa_depth.chart_title', { defaultValue: 'Pool liquidity against token market cap' })}
                description={t('rwa_depth.chart_sub', { plotted: points.length, excluded: Math.max(0, rows.length - points.length), defaultValue: 'Both axes are logarithmic. {{plotted}} tokens are plotted; {{excluded}} are left out because they have no pool liquidity or no market cap to place them by, and drawing those at zero would read as a measurement of zero.' })}
                points={points}
                xLabel={t('rwa_depth.chart_x', { defaultValue: 'Token market cap (USD)' })}
                yLabel={t('rwa_depth.chart_y', { defaultValue: 'Pool liquidity found (USD)' })}
                formatX={usdLabel}
                formatY={usdLabel}
                state={points.length ? 'ready' : 'empty'}
              />

              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr>
                      <th scope="col" className={head}>{t('rwa_depth.col_token', { defaultValue: 'Token' })}</th>
                      <th scope="col" className={head}>{t('rwa_depth.col_underlying', { defaultValue: 'Underlying' })}</th>
                      <th scope="col" className={head}>{t('rwa_depth.col_issuer', { defaultValue: 'Issuer' })}</th>
                      <th scope="col" className={head}>{t('rwa_depth.col_chains', { defaultValue: 'Chains and contracts' })}</th>
                      <th scope="col" className={head}>{t('rwa_depth.col_pools', { defaultValue: 'Pools' })}</th>
                      <th scope="col" className={head}>{t('rwa_depth.col_liquidity', { defaultValue: 'Liquidity' })}</th>
                      <th scope="col" className={head}>{t('rwa_depth.col_deepest', { defaultValue: 'Deepest pool' })}</th>
                      <th scope="col" className={head}>{t('rwa_depth.col_concentration', { defaultValue: 'In the deepest' })}</th>
                      <th scope="col" className={head}>{t('rwa_depth.col_reading', { defaultValue: 'Reading' })}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => {
                      const href = assetHref(row)
                      const name = row.symbol || row.tokenName || row.tokenKey
                      return (
                        <tr key={row.tokenKey}>
                          <th scope="row" className={`${cell} text-left font-normal`}>
                            <span className="flex items-center gap-2">
                              <TokenAvatar symbol={row.symbol} name={row.tokenName} size="sm" />
                              {href ? <Link className="intel-text-link" to={href}>{name}</Link> : <span>{name}</span>}
                            </span>
                            {row.tokenName && row.symbol && <span className="block text-[var(--fg-4)]">{row.tokenName}</span>}
                          </th>
                          <td className={cell}>
                            {row.rwaName || '—'}
                            {row.underlyingValueUsd != null && (
                              <span className="block text-[var(--fg-4)] intel-number">{t('rwa_depth.underlying_value', { value: usdLabel(row.underlyingValueUsd), defaultValue: '{{value}} tokenised' })}</span>
                            )}
                          </td>
                          <td className={cell}>{row.issuerName || '—'}</td>
                          <td className={cell}>
                            {(row.contracts || []).length === 0 ? '—' : (
                              <ul>
                                {row.contracts.map(contract => (
                                  <li key={`${contract.chainKey}:${contract.address}`} className="flex flex-wrap items-baseline gap-2">
                                    <span>{contract.chain}</span>
                                    <CopyAddress value={contract.address} />
                                    {!contract.readable && <span className="text-[var(--fg-4)]">{t('rwa_depth.chain_unread', { defaultValue: 'pools not published for this chain' })}</span>}
                                  </li>
                                ))}
                              </ul>
                            )}
                            {row.chainsOmitted > 0 && (
                              <span className="block text-[var(--fg-4)]">{t('rwa_depth.chains_omitted', { count: row.chainsOmitted, defaultValue: '{{count}} more deployments are not listed here.' })}</span>
                            )}
                          </td>
                          <td className={`${cell} intel-number`}>
                            {row.poolCount == null ? '—' : formatCompact(row.poolCount)}
                            {row.liquidityPools != null && row.poolCount != null && row.liquidityPools < row.poolCount && (
                              <span className="block text-[var(--fg-4)]">{t('rwa_depth.priced_pools', { priced: formatCompact(row.liquidityPools), total: formatCompact(row.poolCount), defaultValue: '{{priced}} of {{total}} reported a size' })}</span>
                            )}
                          </td>
                          <td className={`${cell} intel-number`}>{usdLabel(row.totalLiquidityUsd)}</td>
                          <td className={cell}>
                            {row.deepestPool ? (
                              <>
                                <span>{[row.deepestPool.dex, row.deepestPool.pair].filter(Boolean).join(' · ') || row.deepestPool.chain}</span>
                                <span className="block text-[var(--fg-4)] intel-number">{t('rwa_depth.deepest_detail', { liquidity: usdLabel(row.deepestPool.liquidityUsd), volume: usdLabel(row.deepestPool.volume24h), defaultValue: '{{liquidity}} liquidity · {{volume}} traded in 24h' })}</span>
                              </>
                            ) : '—'}
                          </td>
                          <td className={`${cell} intel-number`}>{pctLabel(row.concentrationPct)}</td>
                          <td className={cell}>
                            {readingText(row, t)}
                            {row.holderCount != null && (
                              <span className="block text-[var(--fg-4)] intel-number">{t('rwa_depth.holders', { count: formatCompact(row.holderCount), chain: row.holderChain, defaultValue: '{{count}} holder accounts on {{chain}}' })}</span>
                            )}
                            {row.restriction?.sourceUrl && (
                              <a className="intel-text-link block" href={row.restriction.sourceUrl} target="_blank" rel="noreferrer">{t('rwa_depth.open_source', { defaultValue: 'Open the verified contract source' })}</a>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Provenance: the endpoints, the capture clock and the method
                  behind the figures we computed ourselves. */}
              <div className="pt-2">
                <Scope>{payload.exitabilityMethod}</Scope>
                <Scope>{payload.scope}</Scope>
                <Scope>
                  {t('rwa_depth.provenance', {
                    endpoints: (payload.attribution?.endpoints || []).join(', '),
                    asOf: asOf || t('rwa_depth.no_capture_time', { defaultValue: 'not reported' }),
                    defaultValue: 'Read from {{endpoints}}. Newest capture {{asOf}}, which is when we asked: CoinMarketCap publishes no observation time for a pool liquidity figure, so none is shown.',
                  })}
                </Scope>
                <Scope>{t('rwa_depth.source', { defaultValue: 'Data: CoinMarketCap' })}</Scope>
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}
