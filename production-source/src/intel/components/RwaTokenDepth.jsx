import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import CopyAddress from './CopyAddress'
import { readCaptureView } from '../lib/capture-api'
import { formatCompact } from '../lib/market-format'
import { exitLiquidityText, pctLabel, readingText, unrecognisedText, usdLabel } from '../lib/rwa-depth-format'

// The "Tokenised asset" block on the asset page.
//
// It renders for a token the depth lane has captured and NOTHING AT ALL for
// anything else, which is nearly every asset: this lane covers tokenised
// real-world assets, and an empty block on a Bitcoin page saying a figure is
// missing would be noise on a page that already has plenty. `captured: false`
// from the read view is the normal answer and is not an error.
//
// A FAILED read is also silent here, deliberately. The structure board is where
// this figure is presented and where an unavailable read is reported with its
// reason; the asset page carries it as context, and a red line on someone's
// Bitcoin page about an RWA capture they never asked for would be worse than
// nothing. The board keeps the honesty contract; this block keeps the summary.

const rule = 'border-b border-[var(--border-default)]'

export default function RwaTokenDepth({ sourceProvider, providerId }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const cryptoId = sourceProvider === 'coinmarketcap' && /^[1-9][0-9]{0,11}$/.test(String(providerId ?? '')) ? String(providerId) : null
  const [token, setToken] = useState(null)
  const [payload, setPayload] = useState(null)

  useEffect(() => {
    if (!cryptoId) { setToken(null); setPayload(null); return undefined }
    const controller = new AbortController()
    let alive = true
    setToken(null); setPayload(null)
    readCaptureView('rwa_token_depth', { cryptoId }, { orgId, signal: controller.signal, supabase })
      .then(result => { if (alive && result?.captured && result.token) { setToken(result.token); setPayload(result) } })
      .catch(() => { /* see the header: this block is context, the board is the claim */ })
    return () => { alive = false; controller.abort() }
  }, [cryptoId, orgId, supabase])

  if (!token) return null
  const asOf = token.capturedAt && Number.isFinite(Date.parse(token.capturedAt)) ? new Date(token.capturedAt).toLocaleString() : null

  return (
    <section className="intel-rwa-token-depth space-y-2" aria-label={t('rwa_depth.token_title', { defaultValue: 'Tokenised asset' })}>
      <div className="eyebrow">{t('rwa_depth.token_eyebrow', { defaultValue: 'Tokenised asset' })}</div>
      <h3 className="text-[13px] font-medium">{t('rwa_depth.token_title', { defaultValue: 'Tokenised asset' })}</h3>

      <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-4 text-[12px]">
        <div className={`${rule} py-2`}>
          <dt className="text-[var(--fg-4)]">{t('rwa_depth.token_underlying', { defaultValue: 'Underlying' })}</dt>
          <dd>{token.rwaName || t('rwa_depth.token_underlying_unreported', { defaultValue: 'Not reported' })}</dd>
        </div>
        <div className={`${rule} py-2`}>
          <dt className="text-[var(--fg-4)]">{t('rwa_depth.token_issuer', { defaultValue: 'Issuer' })}</dt>
          <dd>{token.issuerName || t('rwa_depth.token_issuer_unreported', { defaultValue: 'Not reported' })}</dd>
        </div>
        <div className={`${rule} py-2`}>
          {/* Only pools whose other side can be valued, except on a capture taken
              before those sides were recorded, where the provider's own total is
              shown and the reading sentence says so. */}
          <dt className="text-[var(--fg-4)]">
            {token.classification === 'unclassified'
              ? t('rwa_depth.token_liquidity_reported', { defaultValue: 'Pool liquidity reported' })
              : t('rwa_depth.token_liquidity', { defaultValue: 'Sellable pool liquidity' })}
          </dt>
          <dd className="intel-number">
            {usdLabel(token.classification === 'unclassified' ? token.totalLiquidityUsd : token.countedLiquidityUsd)}
          </dd>
        </div>
        <div className={`${rule} py-2`}>
          <dt className="text-[var(--fg-4)]">{t('rwa_depth.token_concentration', { defaultValue: 'In the deepest pool' })}</dt>
          <dd className="intel-number">{pctLabel(token.concentrationPct)}</dd>
        </div>
      </dl>

      {/* The deployments, each contract copyable. This is the cross-chain answer:
          a reader who wants to sell has to know which of these they hold. */}
      {(token.contracts || []).length > 0 && (
        <ul className="text-[12px]">
          {token.contracts.map(contract => (
            <li key={`${contract.chainKey}:${contract.address}`} className={`${rule} py-2 flex flex-wrap items-baseline gap-2`}>
              <span>{contract.chain}</span>
              <CopyAddress value={contract.address} />
              {!contract.readable && <span className="text-[var(--fg-4)]">{t('rwa_depth.chain_unread', { defaultValue: 'pools not published for this chain' })}</span>}
            </li>
          ))}
        </ul>
      )}
      {token.chainsOmitted > 0 && (
        <p className="text-[11px] text-[var(--fg-4)]">{t('rwa_depth.chains_omitted', { count: token.chainsOmitted, defaultValue: '{{count}} more deployments are not listed here.' })}</p>
      )}

      <p className="text-[12px]">
        {readingText(token, t)}
        {token.deepestPool && (
          <> {t('rwa_depth.token_deepest', {
            venue: [token.deepestPool.dex, token.deepestPool.pair].filter(Boolean).join(' · ') || token.deepestPool.chain,
            chain: token.deepestPool.chain, liquidity: usdLabel(token.deepestPool.liquidityUsd),
            defaultValue: 'Deepest counted pool: {{venue}} on {{chain}}, {{liquidity}}.',
          })}</>
        )}
        {token.holderCount != null && (
          <> {t('rwa_depth.holders', { count: formatCompact(token.holderCount), chain: token.holderChain, defaultValue: '{{count}} holder accounts on {{chain}}' })}.</>
        )}
        {exitLiquidityText(token, t) && <> {exitLiquidityText(token, t)}</>}
      </p>

      {/* THE POOLS THAT ARE NOT IN THE FIGURES ABOVE, listed in full and headed
          by the sentence saying why they are apart. Hiding them would leave a
          reader unable to reconcile this block with CoinMarketCap's own number;
          counting them would be the defect this group exists to fix. */}
      {(token.unrecognisedPools || []).length > 0 && (
        <div className="space-y-1">
          <div className="eyebrow">{t('rwa_depth.unrecognised_eyebrow', { defaultValue: 'Not counted as depth' })}</div>
          <p className="text-[12px]">{unrecognisedText(token, t)}</p>
          <ul className="text-[12px]">
            {token.unrecognisedPools.map(entry => (
              <li key={`${entry.chain}:${entry.address}`} className={`${rule} py-2 flex flex-wrap items-baseline gap-2`}>
                <span>{entry.pair || t('rwa_depth.unrecognised_no_pair', { defaultValue: 'Pair not reported' })}</span>
                <span className="text-[var(--fg-4)]">{[entry.dex, entry.chain].filter(Boolean).join(' · ')}</span>
                <span className="intel-number text-[var(--fg-4)]">
                  {t('rwa_depth.deepest_detail', { liquidity: usdLabel(entry.liquidityUsd), volume: usdLabel(entry.volume24h), defaultValue: '{{liquidity}} liquidity · {{volume}} traded in 24h' })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-[var(--fg-4)] max-w-[80ch]">
        {exitLiquidityText(token, t) && payload?.exitLiquidityScope ? <>{payload.exitLiquidityScope}{' '}</> : null}
        {payload?.exitabilityMethod ? <>{payload.exitabilityMethod}{' '}</> : null}
        {token.scope}
        {' '}
        {t('rwa_depth.token_provenance', {
          asOf: asOf || t('rwa_depth.no_capture_time', { defaultValue: 'not reported' }),
          defaultValue: 'Captured {{asOf}}, which is when we asked.',
        })}
        {' '}
        <Link className="intel-text-link" to="/intel/structure#intel-rwa-depth">{t('rwa_depth.token_open_board', { defaultValue: 'Compare it with every other tokenised asset' })}</Link>
        {' · '}
        {t('rwa_depth.source', { defaultValue: 'Data: CoinMarketCap' })}
      </p>
    </section>
  )
}
