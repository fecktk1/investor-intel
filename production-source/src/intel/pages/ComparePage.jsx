import React, { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Scale } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { CHAINS } from '../lib/chains'
import { resolveEntity } from '../lib/watchlist-api'
import { loadTokenChart } from '../lib/chart-api'
import { useArtifact } from '../lib/useArtifact'
import ArtifactView from '../components/ArtifactView'
import MultiTokenChart from '../components/MultiTokenChart'
import IntelDisclaimer from '../components/IntelDisclaimer'

const summ = (e) => ({ ref: e.canonical_ref_key, symbol: e.display_symbol, chain: e.chain_namespace, asset_id: e.asset_id })

function AssetInput({ label, val, set, t }) {
  return (
    <div className="card p-3 space-y-2">
      <div className="text-[12px] font-medium text-[var(--fg-2)]">{label}</div>
      <select className="select w-full" value={val.chain} onChange={(e) => set({ ...val, chain: e.target.value })}>
        {CHAINS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
      <input className="input w-full" placeholder={t('compare.ph', { defaultValue: 'Token mint / contract address' })} value={val.value} onChange={(e) => set({ ...val, value: e.target.value })} />
    </div>
  )
}

// P12 — Compare two assets. Explains tradeoffs; never declares a winner.
export default function ComparePage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [a, setA] = useState({ chain: 'solana', value: '' })
  const [b, setB] = useState({ chain: 'ethereum', value: '' })
  const [resolving, setResolving] = useState(false)
  const [err, setErr] = useState(null)
  const [series, setSeries] = useState([])
  const cmp = useArtifact()

  const compare = useCallback(async () => {
    if (!a.value.trim() || !b.value.trim() || !org?.id) return
    setResolving(true); setErr(null)
    try {
      const ea = await resolveEntity(supabase, org.id, { kind: 'asset', chain: a.chain, value: a.value.trim() })
      const eb = await resolveEntity(supabase, org.id, { kind: 'asset', chain: b.chain, value: b.value.trim() })
      const [ca, cb] = await Promise.all([
        loadTokenChart(supabase, org.id, { entityId: ea.id, timeframe: '1D' }).catch(() => null),
        loadTokenChart(supabase, org.id, { entityId: eb.id, timeframe: '1D' }).catch(() => null),
      ])
      setSeries([{ label: ea.display_symbol || 'A', candles: ca?.candles || [] }, { label: eb.display_symbol || 'B', candles: cb?.candles || [] }])
      await cmp.generate({
        artifactType: 'token_comparison', entityId: ea.id,
        context: { assets: [summ(ea), summ(eb)] },
        extra: { title: `${ea.display_symbol || 'A'} vs ${eb.display_symbol || 'B'}` },
      })
    } catch (e) { setErr(e.message) } finally { setResolving(false) }
  }, [a, b, org?.id, supabase, cmp])

  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow flex items-center gap-1.5"><Scale className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
        <h1 className="page-title">{t('nav.compare', { defaultValue: 'Compare' })}</h1>
        <p className="page-sub">{t('pages.compare_sub', { defaultValue: 'Compare assets across market, risk, narrative and execution.' })}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <AssetInput label={t('compare.a', { defaultValue: 'Asset A' })} val={a} set={setA} t={t} />
        <AssetInput label={t('compare.b', { defaultValue: 'Asset B' })} val={b} set={setB} t={t} />
      </div>
      <div className="flex justify-end">
        <button onClick={compare} disabled={resolving || cmp.loading || !a.value.trim() || !b.value.trim()} className="btn btn--primary disabled:opacity-50">
          {(resolving || cmp.loading) ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : <><Scale className="h-4 w-4" /> {t('compare.run', { defaultValue: 'Compare' })}</>}
        </button>
      </div>

      {err && <div className="card--flat p-3 text-[13px] text-red-400">{err}</div>}
      {series.length > 0 && <MultiTokenChart series={series} />}
      <ArtifactView result={cmp.result} loading={cmp.loading} />
      <IntelDisclaimer variant="block" />
    </div>
  )
}
