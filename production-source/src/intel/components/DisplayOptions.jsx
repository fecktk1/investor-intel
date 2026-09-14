import React from 'react'
import { useTranslation } from 'react-i18next'
export function orderedKeys(items, order) {
  const allowed = new Set(items.map(item => item[0]))
  return [...new Set([...(Array.isArray(order) ? order : []).filter(key => allowed.has(key)), ...allowed])]
}
export default function DisplayOptions({ label = 'Display options', items, order, visible, onChange, disabled = false }) {
  const { t } = useTranslation('intel', { useSuspense: false }), keys = orderedKeys(items, order), selected = new Set(visible || keys)
  const move = (index, offset) => { const next = [...keys]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; onChange(next, next.filter(key => selected.has(key))) }
  return <details className="intel-display-options"><summary>{label}</summary><div className="py-3 space-y-2"><p className="text-xs text-[var(--fg-4)]">{t('workspace.display_hint', { defaultValue: 'Choose what appears and its order. Hidden information remains available through these controls.' })}</p><ol>{keys.map((key, index) => <li key={key} className="flex items-center gap-3 py-1"><label className="flex-1 flex items-center gap-2"><input type="checkbox" checked={selected.has(key)} disabled={disabled} onChange={() => { const next = new Set(selected); next.has(key) ? next.delete(key) : next.add(key); onChange(keys, keys.filter(key => next.has(key))) }}/>{items.find(item => item[0] === key)[1]}</label><button type="button" className="btn btn--quiet btn--sm" disabled={disabled || !index} aria-label={`Move ${items.find(item => item[0] === key)[1]} up`} onClick={() => move(index, -1)}>↑</button><button type="button" className="btn btn--quiet btn--sm" disabled={disabled || index === keys.length - 1} aria-label={`Move ${items.find(item => item[0] === key)[1]} down`} onClick={() => move(index, 1)}>↓</button></li>)}</ol><button className="btn btn--quiet btn--sm" disabled={disabled} onClick={() => onChange(items.map(item => item[0]), items.map(item => item[0]))}>{t('workspace.reset_display', { defaultValue: 'Reset display' })}</button></div></details>
}
