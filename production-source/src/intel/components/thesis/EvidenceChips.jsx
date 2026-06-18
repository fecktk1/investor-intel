import React from 'react'
import { useTranslation } from 'react-i18next'

// The action chips on every evidence card. In the builder the user labels evidence
// into their thesis; standalone (market/news pages) they spin it into a thesis.
// selection = { label, confirmation, invalidation, track }
const LABELS = [
  { key: 'include', label: 'Support', cls: 'chip--ok' },
  { key: 'risk', label: 'Risk', cls: 'text-amber-300' },
  { key: 'contradiction', label: 'Contradicts', cls: 'chip--err' },
  { key: 'ignore', label: 'Noise', cls: 'text-[var(--fg-5)]' },
]

export default function EvidenceChips({ card, selection = {}, onChange, mode = 'builder', onAttach, onTurnInto }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const set = (patch) => onChange && onChange({ ...selection, ...patch })
  const toggleLabel = (k) => set({ label: selection.label === k ? null : k })

  if (mode === 'standalone') {
    return (
      <div className="flex flex-wrap gap-1.5">
        <button onClick={onTurnInto} className="chip text-[11px] chip--ok">{t('journal.ev.turn_into', { defaultValue: 'Turn into thesis' })}</button>
        <button onClick={onAttach} className="chip text-[11px]">{t('journal.ev.attach', { defaultValue: 'Add to thesis' })}</button>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {LABELS.map((l) => (
        <button key={l.key} onClick={() => toggleLabel(l.key)}
          className={`chip text-[11px] ${selection.label === l.key ? `${l.cls} ring-1 ring-[var(--accent)]` : 'text-[var(--fg-4)]'}`}>
          {t(`journal.ev.${l.key}`, { defaultValue: l.label })}
        </button>
      ))}
      <button onClick={() => set({ confirmation: !selection.confirmation })}
        className={`chip text-[11px] ${selection.confirmation ? 'chip--ok ring-1 ring-[var(--accent)]' : 'text-[var(--fg-4)]'}`}>
        {t('journal.ev.confirm', { defaultValue: 'Confirmation rule' })}
      </button>
      <button onClick={() => set({ invalidation: !selection.invalidation })}
        className={`chip text-[11px] ${selection.invalidation ? 'chip--err ring-1 ring-[var(--accent)]' : 'text-[var(--fg-4)]'}`}>
        {t('journal.ev.invalidate', { defaultValue: 'Invalidation rule' })}
      </button>
      {card?.watch_metric && (
        <button onClick={() => set({ track: !selection.track })}
          className={`chip text-[11px] ${selection.track ? 'chip--info ring-1 ring-[var(--accent)]' : 'text-[var(--fg-4)]'}`}>
          {t('journal.ev.track', { defaultValue: 'Track metric' })}
        </button>
      )}
    </div>
  )
}
