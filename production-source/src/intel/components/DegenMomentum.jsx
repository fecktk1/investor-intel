import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity } from 'lucide-react'
import { useSupabase } from '../../lib/useSupabase'
import { loadDegenMomentum } from '../lib/markets-api'

function Spark({ values, climb }) {
  const nums = (values || []).filter((v) => Number.isFinite(v))
  if (nums.length < 2) return null
  const min = Math.min(...nums), max = Math.max(...nums), range = max - min || 1
  const w = 88, h = 24
  const pts = nums.map((v, i) => `${(i / (nums.length - 1)) * w},${(h - ((v - min) / range) * h).toFixed(1)}`).join(' ')
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="flex-shrink-0"><polyline points={pts} fill="none" stroke={climb ? 'var(--ok)' : '#f87171'} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /></svg>
}

// Degen momentum trajectory — the memecoin's price / momentum-score / volume trend
// over the last day, drawn from memecoin_token_snapshots (history that previously
// reached the client). Self-contained; renders nothing with < 2 snapshots.
export default function DegenMomentum({ chain, address }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { supabase } = useSupabase()
  const [data, setData] = useState(null)

  useEffect(() => {
    let alive = true
    loadDegenMomentum(supabase, chain, address).then((d) => { if (alive) setData(d) }).catch(() => { if (alive) setData(null) })
    return () => { alive = false }
  }, [supabase, chain, address])

  if (!data) return null
  const up = (data.priceChangePct ?? 0) >= 0
  return (
    <section className="card p-4 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="eyebrow flex items-center gap-1.5"><Activity className="h-3.5 w-3.5" /> {t('degen.momentum', { defaultValue: 'Momentum' })}<span className="text-[10px] text-[var(--fg-5)] normal-case">· {data.hours}h · {data.points} pts</span></div>
        <Spark values={data.priceSeries} climb={up} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
        {data.priceChangePct != null && <span><span className="text-[var(--fg-5)]">{t('degen.priceTrend', { defaultValue: 'Price' })} </span><span className={`font-semibold ${up ? 'text-emerald-400' : 'text-red-400'}`}>{up ? '+' : ''}{data.priceChangePct.toFixed(1)}%</span></span>}
        {data.latestMomentum != null && (
          <span><span className="text-[var(--fg-5)]">{t('degen.momentumScore', { defaultValue: 'Momentum score' })} </span><span className="font-semibold text-[var(--fg-1)]">{data.latestMomentum.toFixed(2)}</span>
            {data.momoDelta != null && data.momoDelta !== 0 && <span className={`ml-0.5 ${data.momoDelta > 0 ? 'text-emerald-400' : 'text-red-400'}`}>{data.momoDelta > 0 ? '↑' : '↓'}</span>}
          </span>
        )}
        {data.volChangePct != null && <span><span className="text-[var(--fg-5)]">{t('degen.volTrend', { defaultValue: 'Volume' })} </span><span className={`font-semibold ${data.volChangePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{data.volChangePct >= 0 ? '+' : ''}{data.volChangePct.toFixed(0)}%</span></span>}
      </div>
    </section>
  )
}
