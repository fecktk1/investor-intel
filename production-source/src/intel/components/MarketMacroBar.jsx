import React from 'react'
import { useTranslation } from 'react-i18next'
import { fmtPct, fmtVol } from '../lib/market-format'
const percentage = value => value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
export default function MarketMacroBar({ macro, loading, error, onRetry }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const fields = [ ['total_market_cap_usd', 'Total market cap', fmtVol], ['total_volume_24h_usd', '24h volume', fmtVol],
    ['market_cap_change_24h_pct', 'Market cap change · 24h', fmtPct], ['btc_dominance_pct', 'BTC dominance', percentage], ['eth_dominance_pct', 'ETH dominance', percentage], ['stablecoin_market_cap_usd', 'Stablecoin cap', fmtVol] ]
  return <section className="intel-macro-observations"><h2>{t('markets.macro_title', { defaultValue: 'Crypto market — global' })}</h2>
    {loading && <p role="status">{t('markets.macro_loading', { defaultValue: 'Loading global observations…' })}</p>}
    {error && <p role="alert">{t('markets.macro_failed', { defaultValue: 'Global observations could not be read.' })} <button onClick={onRetry}>{t('common.retry', { defaultValue: 'Retry' })}</button></p>}
    {!loading && !error && !macro && <p>{t('markets.macro_empty', { defaultValue: 'No global observations are retained yet.' })}</p>}
    {macro && <dl>{fields.map(([key, label, format]) => <div key={key}><dt>{t(`markets.macro_${key}`, { defaultValue: label })}</dt><dd>{format(macro[key])}</dd><small>{macro.fieldObservations?.[key]?.asOf ? <time dateTime={macro.fieldObservations[key].asOf}>{new Date(macro.fieldObservations[key].asOf).toLocaleString(undefined, { timeZoneName: 'short' })}</time> : t('markets.unknown_time', { defaultValue: 'Observation time unknown' })}</small></div>)}</dl>}
  </section>
}
