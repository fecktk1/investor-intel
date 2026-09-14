import React, { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { TrendingUp, TrendingDown, ArrowUp, ArrowDown } from 'lucide-react'
import { useSupabase } from '../../lib/useSupabase'
import { loadRankMovers } from '../lib/markets-api'
import { marketPanelHref } from '../lib/market-links'

function MoverRow({ m, climb }) {
  const location = useLocation()
  return (
    <Link to={marketPanelHref(m)} state={{from:location.pathname+location.search}} className="flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-[var(--bg-2)] transition-colors">
      <span className="flex items-center gap-1.5 min-w-0">
        <span className={`inline-flex items-center text-[11px] font-semibold ${climb ? 'text-emerald-400' : 'text-red-400'}`}>
          {climb ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}{Math.abs(m.delta)}
        </span>
        <span className="text-[12px] font-medium text-[var(--fg-1)] truncate">{m.symbol}</span>
        {m.name && <span className="text-[11px] text-[var(--fg-5)] truncate hidden sm:inline">{m.name}</span>}
      </span>
      <span className="text-[11px] text-[var(--fg-4)] whitespace-nowrap">#{m.prevRank}→#{m.rank}</span>
    </Link>
  )
}

// Leaderboard climbers/fallers — who moved up/down the market-cap rankings since
// ~a week ago, from market_ranking_snapshots (rank history that previously fed
// nothing on the client). Self-contained; renders nothing without enough history.
export default function RankMovers({ days = 7 }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { supabase } = useSupabase()
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true); setError(false); setData(null)
    loadRankMovers(supabase, { days }).then((d) => { if (alive) setData(d) }).catch(() => { if (alive) setError(true) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [supabase, days, retry])

  if (error) return <section role="alert" className="py-3 text-sm"><p>{t('markets.rank_history_failed',{defaultValue:'Ranking history could not be loaded.'})}</p><button className="btn btn--quiet mt-2" onClick={()=>setRetry(n=>n+1)}>{t('common.retry',{defaultValue:'Retry'})}</button></section>
  if (loading) return <p role="status" className="py-3 text-sm text-[var(--fg-4)]">{t('markets.rank_history_loading',{defaultValue:'Loading ranking history…'})}</p>
  if (!data || (!data.climbers.length && !data.fallers.length)) return null
  return (
    <div className="space-y-2">
    <p className="text-xs text-[var(--fg-4)]">{data.sourceProvider==='coinmarketcap'?'CoinMarketCap':'CoinGecko'} · {t('markets.rank_capture_comparison',{defaultValue:'Rank snapshots collected'})}: <time dateTime={data.priorAsOf}>{new Date(data.priorAsOf).toLocaleString(undefined,{timeZoneName:'short'})}</time> → <time dateTime={data.asOf}>{new Date(data.asOf).toLocaleString(undefined,{timeZoneName:'short'})}</time></p>
    <section className="grid gap-3 sm:grid-cols-2">
      <div className="card p-3 space-y-1">
        <div className="eyebrow flex items-center gap-1.5"><TrendingUp className="h-3.5 w-3.5 text-emerald-400" /> {t('markets.climbers', { defaultValue: 'Climbing the ranks' })}<span className="text-[10px] text-[var(--fg-5)] normal-case">· {data.days}d</span></div>
        {data.climbers.length ? data.climbers.map((m) => <MoverRow key={m.providerId} m={m} climb />) : <div className="text-[12px] text-[var(--fg-5)] px-2 py-1">{t('markets.no_rank_moves', { defaultValue: 'No notable moves' })}</div>}
      </div>
      <div className="card p-3 space-y-1">
        <div className="eyebrow flex items-center gap-1.5"><TrendingDown className="h-3.5 w-3.5 text-red-400" /> {t('markets.fallers', { defaultValue: 'Falling the ranks' })}<span className="text-[10px] text-[var(--fg-5)] normal-case">· {data.days}d</span></div>
        {data.fallers.length ? data.fallers.map((m) => <MoverRow key={m.providerId} m={m} climb={false} />) : <div className="text-[12px] text-[var(--fg-5)] px-2 py-1">{t('markets.no_rank_moves', { defaultValue: 'No notable moves' })}</div>}
      </div>
    </section>
    </div>
  )
}
