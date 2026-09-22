import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { formatUsd } from '../lib/market-format'

// How concentrated the tokenised market is by ISSUER, and where its tokens live
// by chain. Our calculation over the newest daily token snapshot, weighted by
// the market cap CoinMarketCap reports per token.
//
// Reads the `rwa_concentration` capture view. Rules this file keeps:
//   * Tokens with no reported market cap, or with no issuer at all, are excluded
//     and COUNTED on the page. They are never weighted as zero.
//   * Chain value is shown only for tokens on exactly one chain. A multi-chain
//     token's value is one figure with no per-chain split, so it is shown as
//     "not attributable" rather than divided up.
//   * One formula line says how every figure is computed.
//   * No pills, no cards: hairline tables and text.

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const rule = 'border-b border-[var(--border-default)]'
const cell = `${rule} py-2 pr-3 align-top`
const numCell = `${cell} text-right intel-number`

export const hhiLabel = value => {
  const n = num(value)
  return n == null ? null : Math.round(n).toLocaleString()
}
export const shareLabel = value => {
  const n = num(value)
  return n == null ? null : `${(n * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
}
export const effectiveLabel = value => {
  const n = num(value)
  return n == null ? null : n.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

export default function RwaConcentration() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('rwa_concentration', {}, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, supabase])

  const payload = read.payload || {}
  const overall = payload.overall && typeof payload.overall === 'object' ? payload.overall : null
  const byType = Array.isArray(payload.byType) ? payload.byType : []
  const chains = payload.chains && typeof payload.chains === 'object' ? payload.chains : null
  const groups = Array.isArray(overall?.groups) ? overall.groups : []
  const dash = t('rwa_concentration.not_available', { defaultValue: 'Not available' })
  const captureTime = payload.schedule?.rwa_coverage?.utc || '03:19'

  const summaryRow = (key, label, figures) => (
    <tr key={key}>
      <th scope="row" className={`${cell} font-medium text-left`}>{label}</th>
      <td className={numCell}>{figures.available ? hhiLabel(figures.hhi) : dash}</td>
      <td className={numCell}>{figures.available ? effectiveLabel(figures.effectiveIssuers) : dash}</td>
      <td className={numCell}>{figures.available ? shareLabel(figures.top5Share) : dash}</td>
      <td className={numCell}>{num(figures.includedTokens) ?? 0}</td>
      <td className={numCell}>{num(figures.excludedNoWeight) ?? 0}</td>
      <td className={numCell}>{num(figures.excludedNoIssuer) ?? 0}</td>
    </tr>
  )

  return (
    <section className="intel-rwa-concentration space-y-4" aria-label={t('rwa_concentration.title', { defaultValue: 'Issuer concentration' })}>
      <div>
        <div className="eyebrow">{t('rwa_concentration.eyebrow', { defaultValue: 'Our calculation' })}</div>
        <h3 className="text-lg font-medium mt-1">{t('rwa_concentration.title', { defaultValue: 'Issuer concentration' })}</h3>
      </div>

      {read.status === 'loading' && <p role="status">{t('rwa_concentration.loading', { defaultValue: 'Reading the recorded tokens…' })}</p>}

      {read.status === 'unavailable' && (
        <p role="alert">
          {t('rwa_concentration.unavailable', { reason: captureReasonText(t, read.reason), defaultValue: 'Concentration could not be read. {{reason}}' })}
        </p>
      )}

      {read.status === 'ready' && payload.reason && (
        <p role="status" className="text-[12px]">
          {t('rwa_concentration.partial', { reason: payload.reason, defaultValue: 'Part of this read did not answer ({{reason}}). What did load is shown.' })}
        </p>
      )}

      {read.status === 'ready' && !payload.asOf && (
        <p role="status" className="text-[12px]">
          {t('rwa_concentration.not_captured', { time: captureTime, defaultValue: 'No token snapshot has been stored yet. It is recorded once a day at {{time}} UTC.' })}
        </p>
      )}

      {read.status === 'ready' && payload.asOf && overall && (
        <>
          <table className="w-full text-[12px]">
            <caption className="text-left text-[13px] font-medium pb-1">
              {t('rwa_concentration.summary_caption', { date: payload.asOf, defaultValue: 'By issuer, weighted by reported market cap, {{date}}' })}
            </caption>
            <thead>
              <tr className="text-[var(--fg-4)]">
                <th scope="col" className={`${cell} text-left`}>{t('rwa_concentration.col_scope', { defaultValue: 'Scope' })}</th>
                <th scope="col" className={`${cell} text-right`}>{t('rwa_concentration.col_hhi', { defaultValue: 'HHI' })}</th>
                <th scope="col" className={`${cell} text-right`}>{t('rwa_concentration.col_effective', { defaultValue: 'Effective issuers' })}</th>
                <th scope="col" className={`${cell} text-right`}>{t('rwa_concentration.col_top5', { defaultValue: 'Top 5 share' })}</th>
                <th scope="col" className={`${cell} text-right`}>{t('rwa_concentration.col_included', { defaultValue: 'Tokens counted' })}</th>
                <th scope="col" className={`${cell} text-right`}>{t('rwa_concentration.col_no_weight', { defaultValue: 'Excluded: no market cap' })}</th>
                <th scope="col" className={`${cell} text-right`}>{t('rwa_concentration.col_no_issuer', { defaultValue: 'Excluded: no issuer' })}</th>
              </tr>
            </thead>
            <tbody>
              {summaryRow('all', t('rwa_concentration.scope_all', { defaultValue: 'All tokenised assets' }), overall)}
              {byType.map(type => summaryRow(type.assetType, type.assetType, type))}
            </tbody>
          </table>

          {groups.length > 0 && (
            <table className="w-full text-[12px]">
              <caption className="text-left text-[13px] font-medium pb-1">{t('rwa_concentration.issuers_caption', { defaultValue: 'Largest issuers' })}</caption>
              <thead>
                <tr className="text-[var(--fg-4)]">
                  <th scope="col" className={`${cell} text-left`}>{t('rwa_concentration.col_issuer', { defaultValue: 'Issuer' })}</th>
                  <th scope="col" className={`${cell} text-right`}>{t('rwa_concentration.col_tokens', { defaultValue: 'Tokens' })}</th>
                  <th scope="col" className={`${cell} text-right`}>{t('rwa_concentration.col_value', { defaultValue: 'Reported market cap' })}</th>
                  <th scope="col" className={`${cell} text-right`}>{t('rwa_concentration.col_share', { defaultValue: 'Share' })}</th>
                </tr>
              </thead>
              <tbody>
                {groups.map(group => (
                  <tr key={group.key}>
                    <th scope="row" className={`${cell} font-normal text-left`}>{group.label || group.key}</th>
                    <td className={numCell}>{num(group.tokens) ?? 0}</td>
                    <td className={numCell}>{formatUsd(num(group.weight))}</td>
                    <td className={numCell}>{shareLabel(group.share)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {chains && (
            <table className="w-full text-[12px]">
              <caption className="text-left text-[13px] font-medium pb-1">{t('rwa_concentration.chains_caption', { defaultValue: 'Where the tokens are deployed' })}</caption>
              <thead>
                <tr className="text-[var(--fg-4)]">
                  <th scope="col" className={`${cell} text-left`}>{t('rwa_concentration.col_chain', { defaultValue: 'Chain' })}</th>
                  <th scope="col" className={`${cell} text-right`}>{t('rwa_concentration.col_deployments', { defaultValue: 'Tokens deployed' })}</th>
                  <th scope="col" className={`${cell} text-right`}>{t('rwa_concentration.col_single_chain', { defaultValue: 'Only on this chain' })}</th>
                  <th scope="col" className={`${cell} text-right`}>{t('rwa_concentration.col_single_value', { defaultValue: 'Market cap, single-chain tokens' })}</th>
                </tr>
              </thead>
              <tbody>
                {(Array.isArray(chains.chains) ? chains.chains : []).map(chain => (
                  <tr key={chain.chain}>
                    <th scope="row" className={`${cell} font-normal text-left`}>{chain.label || chain.chain}</th>
                    <td className={numCell}>{num(chain.deployments) ?? 0}</td>
                    <td className={numCell}>{num(chain.singleChainTokens) ?? 0}</td>
                    <td className={numCell}>{num(chain.singleChainValue) == null ? t('rwa_concentration.not_reported', { defaultValue: 'Not reported' }) : formatUsd(num(chain.singleChainValue))}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row" className={`${cell} font-normal text-left`}>{t('rwa_concentration.multi_chain', { defaultValue: 'On two or more chains' })}</th>
                  <td className={numCell}>{num(chains.multiChainTokens) ?? 0}</td>
                  <td className={numCell}></td>
                  <td className={numCell}>{t('rwa_concentration.not_attributable', { defaultValue: 'Not attributable to one chain' })}</td>
                </tr>
                <tr>
                  <th scope="row" className={`${cell} font-normal text-left`}>{t('rwa_concentration.no_deployment', { defaultValue: 'No deployment on record' })}</th>
                  <td className={numCell}>{num(chains.noDeploymentTokens) ?? 0}</td>
                  <td className={numCell}></td>
                  <td className={numCell}></td>
                </tr>
              </tbody>
            </table>
          )}

          <p className="text-[11px] text-[var(--fg-4)] max-w-[80ch]">
            {t('rwa_concentration.formula', { defaultValue: 'HHI = sum over issuers of (issuer market cap / total market cap)² × 10,000; effective issuers = 1 / sum of squared shares; top 5 share = sum of the five largest shares. Issuers are grouped by CoinMarketCap issuer id, or by normalised issuer name where no id is reported.' })}
          </p>
        </>
      )}
    </section>
  )
}
