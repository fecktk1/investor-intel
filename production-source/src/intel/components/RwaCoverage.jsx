import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { formatUsd } from '../lib/market-format'

// RWA universe coverage: how many tokenised assets have a token that actually
// trades, and whether the tokenised funds a reader expects to find are here.
//
// Reads the `rwa_coverage` capture view (the daily rwa_coverage lane). Until the
// view is registered it renders the unavailable reason and nothing else.
//
// Rules this file keeps:
//   * A headline built on an incomplete read says "at least", never a total.
//   * A ticker seen under a DIFFERENT name is shown as exactly that and is never
//     counted as present. A ticker is not an identity.
//   * No pills, no cards: a sentence, a hairline table, plain text.

// Provider ids in catalogue matches, named as the product names them elsewhere.
const PROVIDER_NAMES = { coinmarketcap: 'CoinMarketCap', coingecko: 'CoinGecko' }

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const rule = 'border-b border-[var(--border-default)]'
const cell = `${rule} py-2 pr-3 align-top`

export const TICKER_STATE_LABELS = {
  absent: 'Not found anywhere we read',
  present_but_empty: 'Present, no market value reported',
  present_with_value: 'Present with a market value',
  symbol_seen_name_differs: 'Ticker seen under a different name, not counted',
}

export default function RwaCoverage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('rwa_coverage', {}, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, supabase])

  const payload = read.payload || {}
  const headline = payload.headline && typeof payload.headline === 'object' ? payload.headline : null
  const tickers = Array.isArray(payload.expected?.tickers) ? payload.expected.tickers : []
  const captureTime = payload.schedule?.rwa_coverage?.utc || '03:19'
  const stateLabel = state => t(`rwa_coverage.state_${state}`, { defaultValue: TICKER_STATE_LABELS[state] || state })

  const headlineText = () => {
    const withTokens = num(headline?.withTokens) ?? 0
    const noTradeable = num(headline?.noTradeable) ?? 0
    const key = headline?.truncated ? 'rwa_coverage.headline_floor' : 'rwa_coverage.headline'
    return t(key, {
      withTokens, noTradeable, date: payload.asOf,
      defaultValue: headline?.truncated
        ? 'On {{date}}, at least {{withTokens}} tokenised assets had tokens reported, and {{noTradeable}} of them had no token with any reported trading. Part of the universe was not read, so these are floors.'
        : 'On {{date}}, {{withTokens}} tokenised assets had tokens reported, and {{noTradeable}} of them had no token with any reported trading.',
    })
  }

  return (
    <section className="intel-rwa-coverage space-y-4" aria-label={t('rwa_coverage.title', { defaultValue: 'RWA universe coverage' })}>
      <div>
        <div className="eyebrow">{t('rwa_coverage.eyebrow', { defaultValue: 'Recorded daily' })}</div>
        <h3 className="text-lg font-medium mt-1">{t('rwa_coverage.title', { defaultValue: 'RWA universe coverage' })}</h3>
      </div>

      {read.status === 'loading' && <p role="status">{t('rwa_coverage.loading', { defaultValue: 'Reading the recorded coverage…' })}</p>}

      {read.status === 'unavailable' && (
        <p role="alert">
          {t('rwa_coverage.unavailable', {
            reason: captureReasonText(t, read.reason),
            defaultValue: 'Coverage could not be read. {{reason}}',
          })}
        </p>
      )}

      {read.status === 'ready' && (
        <>
          {payload.reason && (
            <p role="status" className="text-[12px]">
              {t('rwa_coverage.partial', { reason: payload.reason, defaultValue: 'Part of this read did not answer ({{reason}}). What did load is shown.' })}
            </p>
          )}

          {!payload.asOf && (
            <p role="status" className="text-[12px]">
              {t('rwa_coverage.not_captured', { time: captureTime, defaultValue: 'No coverage snapshot has been stored yet. It is recorded once a day at {{time}} UTC.' })}
            </p>
          )}

          {payload.asOf && headline && <p className="text-[13px]">{headlineText()}</p>}

          {tickers.length > 0 && (
            <div>
              <h4 className="text-[13px] font-medium">{t('rwa_coverage.watch_title', { defaultValue: 'Tokenised funds we expect to see' })}</h4>
              <table className="w-full text-[12px] mt-2">
                <caption className="sr-only">{t('rwa_coverage.watch_title', { defaultValue: 'Tokenised funds we expect to see' })}</caption>
                <thead>
                  <tr className="text-left text-[var(--fg-4)]">
                    <th scope="col" className={cell}>{t('rwa_coverage.col_ticker', { defaultValue: 'Ticker' })}</th>
                    <th scope="col" className={cell}>{t('rwa_coverage.col_expected_name', { defaultValue: 'Expected fund' })}</th>
                    <th scope="col" className={cell}>{t('rwa_coverage.col_state', { defaultValue: 'What we found' })}</th>
                    <th scope="col" className={cell}>{t('rwa_coverage.col_in_universe', { defaultValue: 'In the RWA universe today' })}</th>
                    <th scope="col" className={`${cell} text-right`}>{t('rwa_coverage.col_value', { defaultValue: 'Largest reported market cap' })}</th>
                  </tr>
                </thead>
                <tbody>
                  {tickers.map(ticker => {
                    const matched = Array.isArray(ticker.matched) ? ticker.matched : []
                    const caps = matched.map(m => num(m?.marketCap)).filter(v => v != null && v > 0)
                    const others = Array.isArray(ticker.otherNames) ? ticker.otherNames : []
                    return (
                      <tr key={ticker.symbol}>
                        <th scope="row" className={`${cell} font-medium`}>{ticker.symbol}</th>
                        <td className={cell}>{ticker.expectedName}</td>
                        <td className={cell}>
                          {stateLabel(ticker.state)}
                          {matched.length > 0 && (
                            <div className="text-[11px] text-[var(--fg-4)]">
                              {t('rwa_coverage.found_via', { providers: [...new Set(matched.map(m => PROVIDER_NAMES[m?.sourceProvider] || m?.sourceProvider || m?.source).filter(Boolean))].join(', '), defaultValue: 'Found via: {{providers}}' })}
                            </div>
                          )}
                          {others.length > 0 && (
                            <div className="text-[11px] text-[var(--fg-4)]">
                              {t('rwa_coverage.seen_as', { names: others.join(', '), defaultValue: 'Seen as: {{names}}' })}
                            </div>
                          )}
                        </td>
                        <td className={cell}>
                          {ticker.inRwaUniverse
                            ? t('rwa_coverage.yes', { defaultValue: 'Yes' })
                            : t('rwa_coverage.no', { defaultValue: 'No' })}
                        </td>
                        <td className={`${cell} text-right intel-number`}>
                          {caps.length ? formatUsd(Math.max(...caps)) : t('rwa_coverage.not_reported', { defaultValue: 'Not reported' })}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="text-[11px] text-[var(--fg-4)] mt-2 max-w-[80ch]">
                {t('rwa_coverage.watch_note', { defaultValue: 'A ticker counts as present only when the name beside it matches the fund. The same ticker under another name is listed as seen, not as present. Sources: the market catalogue and the day\'s CoinMarketCap RWA tokens.' })}
              </p>
            </div>
          )}
        </>
      )}
    </section>
  )
}
