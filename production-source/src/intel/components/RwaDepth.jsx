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
import { assetHref, depthPoints, exitLiquidityText, pctLabel, readingText, unrecognisedText, usdLabel } from '../lib/rwa-depth-format'
import { rowExitScenarios } from '../lib/rwa-exit-capacity'
import { depthCsvColumns } from '../lib/rwa-depth-csv'
import { downloadTableCsv } from '../lib/table-csv'
import RwaExitInputs, { daysText, exitInputs, initialExitForm } from './RwaExitInputs'
import DemoNotInSnapshot, { isDemoMissReason } from '../demo/DemoNotInSnapshot'

// Where tokenised assets can actually be sold.
//
// The question this board answers is the one the RWA track structurally cannot:
// a tokenised treasury fund or tokenised share can carry a large tokenised
// market value and still have almost nothing behind it on chain. The endpoint
// built for that answer, /v5/real-world-assets/market-pairs/list, is Growth tier
// and is refused on this plan, so every other entry falls back to 24-hour
// volume, which is turnover and not depth. This board reads the pools instead.
//
// Five rules this file may never soften:
//   0. A POOL AGAINST A TOKEN WE CANNOT VALUE IS NOT DEPTH. CoinMarketCap's
//      `liqUsd` values BOTH legs, so a pool against a worthless or self-priced
//      token reports a large figure nobody could exit into. On 2026-09-20 that
//      made XAUt's "deepest pool" a `XAUt / GOLDGR` pool at $16.5M on $812 of
//      daily volume, and SLVon's a `u / SLVon` pool at $10.4M with no volume at
//      all against a $25.5M token. Every figure on this board is built only from
//      pools whose other leg is a recognised quote asset on that chain or another
//      tokenised asset we captured, matched BY CONTRACT ADDRESS. The rest are
//      listed in their own group with the sentence saying why.
//   1. "NO POOL" NEVER APPEARS WITHOUT ITS CHAINS. Every state that means "we
//      looked and found nothing" prints the chains that were read, and a token
//      deployed only on chains CoinMarketCap publishes no DEX data for is a
//      COVERAGE row, never a liquidity finding. A token whose only pools are ones
//      we cannot value gets its OWN sentence and is never called "no pool".
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
  // The exit simulator's inputs. Our calculation over the stored volumes; the
  // read is never repeated when they change.
  const [exitForm, setExitForm] = useState(initialExitForm)
  const inputs = useMemo(() => exitInputs(exitForm), [exitForm])

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
  // The licence switch travels on every capture read. Anything but an explicit
  // true blanks the CoinMarketCap columns in the file.
  const exportAllowed = payload.sourcePolicy?.exportAllowed === true
  const downloadCsv = () => downloadTableCsv({
    view: 'rwa_depth', asOf: payload.asOf || null, columns: depthCsvColumns(inputs), rows, exportAllowed,
  })

  return (
    <section id="intel-rwa-depth" className="intel-rwa-depth space-y-6" aria-label={t('rwa_depth.title', { defaultValue: 'Where tokenised assets can actually be sold' })}>
      <div>
        <div className="eyebrow">{t('rwa_depth.eyebrow', { defaultValue: 'On-chain depth' })}</div>
        <h3 className="text-lg font-medium mt-1">{t('rwa_depth.title', { defaultValue: 'Where tokenised assets can actually be sold' })}</h3>
        <Scope>{t('rwa_depth.intro', { chains: readChains, defaultValue: 'A tokenised asset can carry a large tokenised value and still have almost nothing behind it on chain. This board resolves each token\'s deployments across chains, then reads the pools of every deployment on {{chains}}, which are the chains CoinMarketCap publishes DEX pool data for on this plan. A token with no pool on those chains says so and names them; it is not evidence that the token cannot be sold elsewhere.' })}</Scope>
        {/* The single most important thing to say about these numbers, and the
            reason they are smaller than the provider's. */}
        <Scope>{t('rwa_depth.intro_counter_leg', { defaultValue: 'A pool is only counted here when the other side of it is something a seller could take out: a major quote asset on that chain, or another tokenised asset we have captured, matched by contract address rather than by the symbol a token gives itself. CoinMarketCap values both legs of a pool, so a pool against a worthless token still reports a large figure. Those pools are listed per token instead, with what they report.' })}</Scope>
      </div>

      {read.status === 'loading' && <p role="status">{t('rwa_depth.loading', { defaultValue: 'Reading the captured pools…' })}</p>}

      {read.status === 'unavailable' && (
        isDemoMissReason(read.reason) ? <p role="status"><DemoNotInSnapshot /></p> : <p role="alert">{t('rwa_depth.unavailable', { reason: read.reason || 'unknown', defaultValue: 'The depth board could not be read ({{reason}}). Nothing is asserted about any token\'s liquidity.' })}</p>
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
              {/* One definition ROW on a pair of hairlines, not five bordered
                  cells: a border under each entry reads as five tiles, which is
                  the card language this workspace does not use. The figures
                  themselves are unchanged. */}
              <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-8 gap-y-3 border-y border-[var(--border-default)] py-3 text-[12px] [font-variant-numeric:tabular-nums]">
                <div>
                  <dt className="text-[var(--fg-4)]">{t('rwa_depth.cohort_count', { defaultValue: 'Tokens read' })}</dt>
                  <dd className="mt-0.5">{formatCompact(cohort.count)}</dd>
                </div>
                <div>
                  <dt className="text-[var(--fg-4)]">{t('rwa_depth.cohort_with_pools', { defaultValue: 'With a pool' })}</dt>
                  <dd className="mt-0.5">{formatCompact(cohort.withPools)}</dd>
                </div>
                <div>
                  <dt className="text-[var(--fg-4)]">{t('rwa_depth.cohort_without_pools', { defaultValue: 'No pool on the chains read' })}</dt>
                  <dd className="mt-0.5">{formatCompact(cohort.withoutPools)}</dd>
                </div>
                <div>
                  <dt className="text-[var(--fg-4)]">{t('rwa_depth.cohort_permissioned', { defaultValue: 'Issuer redemption only' })}</dt>
                  <dd className="mt-0.5">{formatCompact(cohort.permissioned)}</dd>
                </div>
                <div>
                  <dt className="text-[var(--fg-4)]">{t('rwa_depth.cohort_liquidity', { defaultValue: 'Sellable pool liquidity' })}</dt>
                  <dd className="mt-0.5">{usdLabel(cohort.countedLiquidityUsd)}</dd>
                </div>
              </dl>
              {/* What CoinMarketCap's own total holds that this board's does not.
                  The two are printed apart and never added together. */}
              {cohort.unrecognisedLiquidityUsd > 0 && (
                <p className="text-[12px]">
                  {t('rwa_depth.cohort_unrecognised', {
                    excluded: usdLabel(cohort.unrecognisedLiquidityUsd), reported: usdLabel(cohort.totalLiquidityUsd),
                    defaultValue: 'CoinMarketCap reports {{reported}} across the same pools. The difference, {{excluded}}, sits in pools whose other side is a token we cannot value, so it is listed per token and is in none of the figures above.',
                  })}
                </p>
              )}
              {(cohort.notCovered > 0 || cohort.pending > 0) && (
                <p className="text-[12px]">
                  {t('rwa_depth.cohort_rest', {
                    notCovered: formatCompact(cohort.notCovered), pending: formatCompact(cohort.pending),
                    defaultValue: '{{notCovered}} more are deployed only on chains this plan cannot read pools for, and {{pending}} have not been reached by the daily read yet. Neither is counted as thin.',
                  })}
                </p>
              )}
              {cohort.onlyUnrecognised > 0 && (
                <p className="text-[12px]">
                  {t('rwa_depth.cohort_only_unrecognised', {
                    count: formatCompact(cohort.onlyUnrecognised),
                    defaultValue: '{{count}} have pools, and the other side of every one of them is a token we cannot value. They are not counted as having no pool, and they are not counted as having liquidity either.',
                  })}
                </p>
              )}
              {cohort.unclassified > 0 && (
                <p className="text-[12px]">
                  {t('rwa_depth.cohort_unclassified', {
                    count: formatCompact(cohort.unclassified), time: captureTime,
                    defaultValue: '{{count}} were captured before the lane recorded what is on the other side of each pool, so their liquidity is CoinMarketCap\'s figure over every pool found. The daily run at {{time}} UTC separates them.',
                  })}
                </p>
              )}

              {/* Liquidity against the token's own market cap. The point of the
                  figure is the bottom right: a large wrapper with a thin pool. */}
              <Scatter
                wide
                title={t('rwa_depth.chart_title', { defaultValue: 'Sellable pool liquidity against token market cap' })}
                description={t('rwa_depth.chart_sub', { plotted: points.length, excluded: Math.max(0, rows.length - points.length), defaultValue: 'Both axes are logarithmic. {{plotted}} tokens are plotted; {{excluded}} are left out because they have no market cap to place them by, no pool whose other side we can value, or a capture taken before those sides were recorded. Drawing any of those at zero would read as a measurement of zero.' })}
                points={points}
                xLabel={t('rwa_depth.chart_x', { defaultValue: 'Token market cap (USD)' })}
                yLabel={t('rwa_depth.chart_y', { defaultValue: 'Sellable pool liquidity (USD)' })}
                formatX={usdLabel}
                formatY={usdLabel}
                state={points.length ? 'ready' : 'empty'}
              />

              {/* The exit simulator. Days are OUR turnover calculation over two
                  stored volumes; the formula under the table is its whole method. */}
              <div className="space-y-2">
                <div className="eyebrow">{t('rwa_exit.eyebrow', { defaultValue: 'Exit capacity' })}</div>
                <RwaExitInputs form={exitForm} onChange={setExitForm} idPrefix="rwa-depth-exit" />
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <caption className="text-left pb-2">
                    <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <span className="text-[var(--fg-4)]">{t('rwa_depth_csv.caption', { count: rows.length, defaultValue: '{{count}} tokens, deepest sellable liquidity first' })}</span>
                      <span className="flex flex-wrap items-baseline gap-x-3">
                        <button type="button" className="intel-text-link" onClick={downloadCsv}>{t('rwa_depth_csv.download', { defaultValue: 'Download CSV' })}</button>
                        {!exportAllowed && <span className="text-[var(--fg-4)]">{t('rwa_depth_csv.blanked', { defaultValue: 'CoinMarketCap figures are left blank in the file under the current data licence; our own figures are kept.' })}</span>}
                      </span>
                    </span>
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col" className={head}>{t('rwa_depth.col_token', { defaultValue: 'Token' })}</th>
                      <th scope="col" className={head}>{t('rwa_depth.col_underlying', { defaultValue: 'Underlying' })}</th>
                      <th scope="col" className={head}>{t('rwa_depth.col_issuer', { defaultValue: 'Issuer' })}</th>
                      <th scope="col" className={head}>{t('rwa_depth.col_chains', { defaultValue: 'Chains and contracts' })}</th>
                      <th scope="col" className={`${rule} intel-number font-normal py-2 pr-3`}>{t('rwa_depth.col_pools', { defaultValue: 'Pools counted' })}</th>
                      <th scope="col" className={`${rule} intel-number font-normal py-2 pr-3`}>{t('rwa_depth.col_liquidity', { defaultValue: 'Sellable liquidity' })}</th>
                      <th scope="col" className={head}>{t('rwa_depth.col_deepest', { defaultValue: 'Deepest counted pool' })}</th>
                      <th scope="col" className={`${rule} intel-number font-normal py-2 pr-3`}>{t('rwa_depth.col_concentration', { defaultValue: 'In the deepest' })}</th>
                      <th scope="col" className={`${rule} intel-number font-normal py-2 pr-3`}>{t('rwa_exit.col_days', { defaultValue: 'Days to exit' })}</th>
                      <th scope="col" className={head}>{t('rwa_depth.col_reading', { defaultValue: 'Reading' })}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => {
                      const href = assetHref(row)
                      const name = row.symbol || row.tokenName || row.tokenKey
                      const exit = rowExitScenarios(row, inputs)
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
                            {/* The COUNTED pools lead, because they are what every
                                figure to the right is built from. The pools left
                                out are named on the same line, never hidden. */}
                            {row.poolCount == null ? '—'
                              : formatCompact(row.classification === 'unclassified' ? row.poolCount : row.countedPools)}
                            {row.classification !== 'unclassified' && row.unrecognisedPoolCount > 0 && (
                              <span className="block text-[var(--fg-4)]">{t('rwa_depth.unrecognised_pools', { count: formatCompact(row.unrecognisedPoolCount), defaultValue: '{{count}} not counted' })}</span>
                            )}
                            {row.countedLiquidityPools != null && row.countedPools != null && row.countedLiquidityPools < row.countedPools && (
                              <span className="block text-[var(--fg-4)]">{t('rwa_depth.priced_pools', { priced: formatCompact(row.countedLiquidityPools), total: formatCompact(row.countedPools), defaultValue: '{{priced}} of {{total}} reported a size' })}</span>
                            )}
                          </td>
                          <td className={`${cell} intel-number`}>
                            {usdLabel(row.classification === 'unclassified' ? row.totalLiquidityUsd : row.countedLiquidityUsd)}
                          </td>
                          <td className={cell}>
                            {row.deepestPool ? (
                              <>
                                <span>{[row.deepestPool.dex, row.deepestPool.pair].filter(Boolean).join(' · ') || row.deepestPool.chain}</span>
                                <span className="block text-[var(--fg-4)] intel-number">{t('rwa_depth.deepest_detail', { liquidity: usdLabel(row.deepestPool.liquidityUsd), volume: usdLabel(row.deepestPool.volume24h), defaultValue: '{{liquidity}} liquidity · {{volume}} traded in 24h' })}</span>
                              </>
                            ) : '—'}
                          </td>
                          <td className={`${cell} intel-number`}>{pctLabel(row.concentrationPct)}</td>
                          <td className={`${cell} intel-number`}>
                            {/* Recognised on-chain pools first, because that is
                                what this board is about; CoinMarketCap's
                                all-venue volume beneath it as the second scenario. */}
                            <span className="block">{t('rwa_exit.scenario_pools_short', { value: daysText(exit.recognised_pools, t), defaultValue: '{{value}} · recognised pools' })}</span>
                            <span className="block text-[var(--fg-4)]">{t('rwa_exit.scenario_venues_short', { value: daysText(exit.all_venues, t, exit.all_venues.volumeReason), defaultValue: '{{value}} · all venues' })}</span>
                            {exit.recognised_pools.positionPctOfPool != null && (
                              <span className="block text-[var(--fg-4)]">{t('rwa_exit.pool_relative_short', { pct: pctLabel(exit.recognised_pools.positionPctOfPool), defaultValue: '{{pct}} of recognised pools\' size' })}</span>
                            )}
                          </td>
                          <td className={cell}>
                            {readingText(row, t)}
                            {unrecognisedText(row, t) && (
                              <span className="block text-[var(--fg-4)]">
                                {unrecognisedText(row, t)}
                                {/* The largest one is NAMED. It is usually the
                                    pool that would otherwise have been the
                                    headline, and a reader comparing this board
                                    with CoinMarketCap has to be able to see it. */}
                                {row.unrecognisedPools?.[0]?.pair && (
                                  <> {t('rwa_depth.unrecognised_largest', {
                                    pair: row.unrecognisedPools[0].pair,
                                    venue: row.unrecognisedPools[0].dex || row.unrecognisedPools[0].chain,
                                    value: usdLabel(row.unrecognisedPools[0].liquidityUsd),
                                    defaultValue: 'The largest is {{pair}} on {{venue}} at {{value}}.',
                                  })}</>
                                )}
                              </span>
                            )}
                            {exitLiquidityText(row, t) && (
                              <span className="block text-[var(--fg-4)]">{exitLiquidityText(row, t)}</span>
                            )}
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

              {/* The simulator's whole method, with the inputs on screen. */}
              <Scope>
                {t('rwa_exit.formula', {
                  position: usdLabel(inputs.positionUsd),
                  participation: pctLabel(inputs.participationPct),
                  haircut: pctLabel(inputs.haircutPct),
                  defaultValue: 'Days to exit is our calculation: position ÷ (share of daily volume × 24-hour volume × (1 − stress haircut)), here {{position}}, {{participation}} and {{haircut}}. "Recognised pools" uses the 24-hour volume of the pools counted on this board; "all venues" uses CoinMarketCap\'s 24-hour volume for the token across every venue it tracks, centralised exchanges included, from the tokenised-asset quotes capture. It assumes a seller never trades more than that share of a day\'s volume, and it models no price impact.',
                })}
              </Scope>
              <Scope>{t('rwa_exit.pool_method', { defaultValue: 'Size relative to recognised pools is the position ÷ the quote-side liquidity CoinMarketCap reported for the counted pools, or their counted liquidity where it reported none, after the same haircut. It compares a size with a pool; it is not a slippage estimate and not a quote.' })}</Scope>
              {payload.providerVolume?.reason && (
                <Scope>{t('rwa_exit.volume_join_failed', { reason: payload.providerVolume.reason, defaultValue: 'The all-venue volume could not be read ({{reason}}), so that scenario is unavailable on every row. The depth figures are unaffected.' })}</Scope>
              )}

              {/* Provenance: the endpoints, the capture clock and the method
                  behind the figures we computed ourselves. */}
              <div className="pt-2">
                {/* `scope` already carries the counted and excluded sentences on
                    every classified row: the capture stores them and the read
                    view prepends them to a row it classified itself. */}
                <Scope>{payload.exitLiquidityScope}</Scope>
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
