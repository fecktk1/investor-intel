import React from 'react'
import { useTranslation } from 'react-i18next'
import { Layers } from 'lucide-react'
import ContextCard from './ContextCard'

// The right rail: the asset's evidence grouped into the 10 first-class sections,
// each card labelled and actionable. This is what turns thesis creation into a
// research workflow instead of a blank note.
const SECTIONS = [
  ['what_changed', 'What changed recently'],
  ['news', 'Major news'],
  ['developments', 'Developments'],
  ['partnerships', 'Partnerships & integrations'],
  ['tokenomics_unlocks', 'Tokenomics & unlocks'],
  ['usage_fundamentals', 'Usage & fundamentals'],
  ['price_liquidity', 'Price & liquidity'],
  ['risks', 'Risks'],
  ['competitors', 'Competitors'],
  ['catalysts', 'Upcoming catalysts'],
]
export const cardKey = (c) => `${c.source_table}|${c.source_ref}`

export default function AssetContextPack({ cards = [], selections = {}, onSelect, loading, coverage, emptyHint }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const bySection = {}
  for (const c of cards) (bySection[c.section] ||= []).push(c)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <Layers className="h-3.5 w-3.5 text-[var(--accent)]" />
        <div className="eyebrow">{t('journal.context_pack', { defaultValue: 'Asset Context Pack' })}</div>
      </div>

      {loading ? (
        <div className="card p-6 grid place-items-center"><div className="animate-spin rounded-full h-5 w-5 border-b-2 border-[var(--accent)]" /></div>
      ) : !cards.length ? (
        <div className="card--flat p-4 text-[12px] text-[var(--fg-4)]">{emptyHint || t('journal.context_empty', { defaultValue: 'Pick an asset to pull its recent news, developments, partnerships, unlocks, metrics and risks.' })}</div>
      ) : (
        <div className="space-y-4">
          {coverage?.material_gaps?.length > 0 && (
            <div className="card--flat p-2 text-[11px] text-amber-300 border-l-2 border-amber-400">
              {t('journal.coverage_gap', { defaultValue: 'Limited data coverage for this asset:' })} {coverage.material_gaps[0]}
            </div>
          )}
          {SECTIONS.map(([key, label]) => {
            const items = bySection[key] || []
            if (!items.length) return null
            return (
              <div key={key} className="space-y-2">
                <div className="text-[11px] font-medium text-[var(--fg-3)] uppercase tracking-wide">{t(`journal.section.${key}`, { defaultValue: label })}</div>
                {items.map((c) => (
                  <ContextCard key={cardKey(c)} card={c} selection={selections[cardKey(c)]} onChange={(sel) => onSelect && onSelect(c, sel)} />
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
