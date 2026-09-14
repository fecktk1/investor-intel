import React from 'react'
import { useTranslation } from 'react-i18next'
import { TrendingUp } from 'lucide-react'

// "Since you created this thesis" — price AND evidence change, not just price.
const pct = (v) => v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`
const cls = (v) => v == null ? 'text-[var(--fg-4)]' : v >= 0 ? 'text-[var(--ok)]' : 'text-red-400'

export default function ThesisDeltaCard({ delta, loading, error }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (loading) return <section className="intel-thesis-delta" aria-busy="true" role="status">Loading changes since this thesis was created…</section>
  if (error || !delta) return <section className="intel-thesis-delta" role="alert">Changes since creation could not be loaded. Reload to retry.</section>
  if (!delta.has_baseline) {
    return <section className="intel-thesis-delta text-[12px] text-[var(--fg-4)]">{t('journal.no_baseline', { defaultValue: 'No baseline was captured for this legacy thesis.' })}</section>
  }
  const ec = delta.evidence_change || {}
  const metrics = [
    ['price', t('journal.delta.price', { defaultValue: 'Price' }), delta.price_pct],
    ['benchmark', t('journal.delta.vs_benchmark', { defaultValue: 'vs benchmark' }), delta.vs_benchmark_pct],
    ['tvl', t('journal.delta.tvl', { defaultValue: 'TVL' }), delta.tvl_pct],
    ['volume', t('journal.delta.volume', { defaultValue: 'Volume' }), delta.volume_pct],
  ]
  return (
    <section className="intel-thesis-delta space-y-3" aria-label="Changes since thesis creation">
      <div className="flex items-center gap-1.5"><TrendingUp className="h-3.5 w-3.5 text-[var(--accent)]" /><div className="eyebrow">{t('journal.since_creation', { defaultValue: 'Since you created this thesis' })}</div></div>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {metrics.map(([k, label, v]) => (
          <div key={k}><dt className="text-[11px] text-[var(--fg-4)]">{label}</dt><dd className={`text-sm font-semibold ${cls(v)}`}>{pct(v)}</dd></div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2 text-[11px] pt-1 border-t border-[var(--border-default)]">
        <span>{ec.new_supporting_evidence_count ?? '—'} {t('journal.delta.support', { defaultValue: 'support' })}</span>
        <span>{ec.new_weakening_evidence_count ?? '—'} {t('journal.delta.weaken', { defaultValue: 'weaken' })}</span>
        {ec.new_invalidations_count > 0 && <span>{ec.new_invalidations_count} {t('journal.delta.invalidations', { defaultValue: 'invalidations' })}</span>}
        {ec.new_confirmations_count > 0 && <span>{ec.new_confirmations_count} {t('journal.delta.confirmations', { defaultValue: 'confirmations' })}</span>}
        {ec.unreviewed_evidence_count > 0 && <span>{ec.unreviewed_evidence_count} {t('journal.delta.unreviewed', { defaultValue: 'unreviewed' })}</span>}
      </div>
    </section>
  )
}
