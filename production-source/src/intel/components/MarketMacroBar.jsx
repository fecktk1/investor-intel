import React from 'react'
import { useTranslation } from 'react-i18next'
import { fmtPct, fmtVol } from '../lib/market-format'
import FigureSourceLine from './FigureSourceLine'
const percentage = value => value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
/** The newest clock across the fields on screen. Each field retains its own
 *  observation time, so there is no single stored stamp to quote; the source
 *  line carries the newest of them and every field still shows its own. */
export function newestObservation(macro) {
  const stamps = Object.values(macro?.fieldObservations || {})
    .map(entry => Date.parse(String(entry?.asOf ?? ''))).filter(Number.isFinite)
  return stamps.length ? new Date(Math.max(...stamps)).toISOString() : null
}

export default function MarketMacroBar({ macro, loading, error, onRetry }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const fields = [ ['total_market_cap_usd', 'Total market cap', fmtVol], ['total_volume_24h_usd', '24h volume', fmtVol],
    ['market_cap_change_24h_pct', 'Market cap change · 24h', fmtPct], ['btc_dominance_pct', 'BTC dominance', percentage], ['eth_dominance_pct', 'ETH dominance', percentage], ['stablecoin_market_cap_usd', 'Stablecoin cap', fmtVol] ]
  return <section className="intel-macro-observations"><h2>{t('markets.macro_title', { defaultValue: 'Global crypto market' })}</h2>
    {loading && <p role="status">{t('markets.macro_loading', { defaultValue: 'Loading global observations…' })}</p>}
    {error && <p role="alert">{t('markets.macro_failed', { defaultValue: 'Global observations could not be read.' })} <button onClick={onRetry}>{t('common.retry', { defaultValue: 'Retry' })}</button></p>}
    {!loading && !error && !macro && <p>{t('markets.macro_empty', { defaultValue: 'No global observations are retained yet.' })}</p>}
    {/* Every field above is one provider's published global reading, read back
        from our stored snapshot. The provider is the one the stored row names,
        never a guess, and the clock is the newest field observation because the
        fields are retained with their own separate times (see the <small> on
        each). */}
    {macro && <FigureSourceLine source={macro.provider} observedAt={newestObservation(macro)}/>}
    {macro && <dl>{fields.map(([key, label, format]) => <div key={key}><dt>{t(`markets.macro_${key}`, { defaultValue: label })}</dt><dd>{format(macro[key])}</dd><small>{macro.fieldObservations?.[key]?.asOf ? <time dateTime={macro.fieldObservations[key].asOf}>{new Date(macro.fieldObservations[key].asOf).toLocaleString(undefined, { timeZoneName: 'short' })}</time> : t('markets.unknown_time', { defaultValue: 'Observation time unknown' })}</small></div>)}</dl>}
  </section>
}
