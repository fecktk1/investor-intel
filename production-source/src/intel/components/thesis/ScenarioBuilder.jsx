import React from 'react'
import { useTranslation } from 'react-i18next'

// Structured bull / base / bear scenarios — narrative, probability, target,
// assumptions, risks, review trigger. NOT three generic text boxes.
const KINDS = [
  { kind: 'bull', label: 'Bull case', accent: 'var(--ok)' },
  { kind: 'base', label: 'Base case', accent: 'var(--fg-2)' },
  { kind: 'bear', label: 'Bear case', accent: '#f87171' },
]
const toLines = (v) => Array.isArray(v) ? v.join('\n') : (v || '')
const fromLines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean)

export default function ScenarioBuilder({ value = {}, onChange }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const patch = (kind, p) => onChange && onChange(kind, p)

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      {KINDS.map(({ kind, label, accent }) => {
        const s = value[kind] || {}
        return (
          <div key={kind} className="card p-3 space-y-2">
            <div className="text-[13px] font-semibold" style={{ color: accent }}>{t(`journal.scenario.${kind}`, { defaultValue: label })}</div>
            <textarea className="textarea w-full" rows={3} placeholder={t('journal.scenario.narrative', { defaultValue: 'What happens in this scenario?' })}
              value={s.narrative || ''} onChange={(e) => patch(kind, { narrative: e.target.value })} />
            <div className="flex gap-2">
              <label className="block flex-1">
                <span className="text-[10px] text-[var(--fg-4)]">{t('journal.scenario.prob', { defaultValue: 'Probability %' })}</span>
                <input type="number" min="0" max="100" className="input w-full" value={s.probabilityPct ?? ''}
                  onChange={(e) => patch(kind, { probabilityPct: e.target.value === '' ? null : Number(e.target.value) })} />
              </label>
              <label className="block flex-1">
                <span className="text-[10px] text-[var(--fg-4)]">{t('journal.scenario.target', { defaultValue: 'Price target' })}</span>
                <input type="number" className="input w-full" value={s.price_target ?? ''}
                  onChange={(e) => patch(kind, { price_target: e.target.value === '' ? null : Number(e.target.value) })} />
              </label>
            </div>
            <label className="block">
              <span className="text-[10px] text-[var(--fg-4)]">{t('journal.scenario.assumptions', { defaultValue: 'Key assumptions (one per line)' })}</span>
              <textarea className="textarea w-full" rows={2} value={toLines(s.assumptions)} onChange={(e) => patch(kind, { assumptions: fromLines(e.target.value) })} />
            </label>
            <label className="block">
              <span className="text-[10px] text-[var(--fg-4)]">{t('journal.scenario.risks', { defaultValue: 'Main risks (one per line)' })}</span>
              <textarea className="textarea w-full" rows={2} value={toLines(s.risks)} onChange={(e) => patch(kind, { risks: fromLines(e.target.value) })} />
            </label>
            <label className="block">
              <span className="text-[10px] text-[var(--fg-4)]">{t('journal.scenario.trigger', { defaultValue: 'Review trigger' })}</span>
              <input className="input w-full" value={s.trigger_text || ''} onChange={(e) => patch(kind, { trigger_text: e.target.value })} />
            </label>
          </div>
        )
      })}
    </div>
  )
}
