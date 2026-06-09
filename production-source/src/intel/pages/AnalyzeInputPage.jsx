import React, { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { CHAINS } from '../lib/chains'
import { resolveEntity } from '../lib/watchlist-api'
import { useArtifact } from '../lib/useArtifact'
import ArtifactView from '../components/ArtifactView'
import IntelDisclaimer from '../components/IntelDisclaimer'

// Generic "enter an identifier → analyze" page. Powers DeFi (P7), Execution
// (P8) and Wallet (P6) by varying artifactType + kind.
export default function AnalyzeInputPage({ artifactType, titleKey, defaultTitle, subKey, defaultSub, kind = 'asset', defaultPh = 'Address or identifier' }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [form, setForm] = useState({ chain: 'solana', value: '' })
  const [resolving, setResolving] = useState(false)
  const [err, setErr] = useState(null)
  const art = useArtifact()
  const needsChain = kind !== 'narrative'

  const run = useCallback(async () => {
    if (!form.value.trim() || !org?.id) return
    setResolving(true); setErr(null)
    try {
      const e = await resolveEntity(supabase, org.id, { kind, chain: form.chain, value: form.value.trim() })
      await art.generate({ artifactType, entityId: e.id })
    } catch (ex) { setErr(ex.message) } finally { setResolving(false) }
  }, [form, org?.id, kind, artifactType, supabase, art])

  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow">{t('brand.name', { defaultValue: 'Investor Intel' })}</div>
        <h1 className="page-title">{t(titleKey, { defaultValue: defaultTitle })}</h1>
        {(subKey || defaultSub) && <p className="page-sub">{t(subKey, { defaultValue: defaultSub })}</p>}
      </div>

      <div className="card p-4 flex flex-wrap items-end gap-3">
        {needsChain && (
          <label className="block">
            <span className="text-[11px] text-[var(--fg-4)]">{t('watchlist.chain', { defaultValue: 'Chain' })}</span>
            <select className="select" value={form.chain} onChange={(e) => setForm((f) => ({ ...f, chain: e.target.value }))}>
              {CHAINS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
        )}
        <label className="block flex-1 min-w-[200px]">
          <span className="text-[11px] text-[var(--fg-4)]">{t('watchlist.value', { defaultValue: 'Identifier' })}</span>
          <input className="input w-full" placeholder={defaultPh} value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') run() }} />
        </label>
        <button onClick={run} disabled={resolving || art.loading || !form.value.trim()} className="btn btn--primary disabled:opacity-50">
          {(resolving || art.loading) ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : <><Search className="h-4 w-4" /> {t('analyze.run', { defaultValue: 'Analyze' })}</>}
        </button>
      </div>

      {err && <div className="card--flat p-3 text-[13px] text-red-400">{err}</div>}
      {!art.result && !art.loading && <div className="card p-8 text-center text-[var(--fg-3)] text-sm">{t('analyze.empty', { defaultValue: 'Enter an identifier above to generate analysis.' })}</div>}
      <ArtifactView result={art.result} loading={art.loading} />
      <IntelDisclaimer variant="block" />
    </div>
  )
}
