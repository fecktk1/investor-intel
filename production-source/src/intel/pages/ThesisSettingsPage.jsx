import React from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Settings, ShieldCheck } from 'lucide-react'

// Journal info + behavior. Per-thesis settings (cadence, benchmark, visibility)
// are set on each thesis; this page explains how the Journal works.
export default function ThesisSettingsPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const items = [
    t('journal.about.1', { defaultValue: 'Every thesis captures an immutable baseline (price, benchmark, fundamentals, selected evidence) at creation, so the Journal can always show what changed since your call.' }),
    t('journal.about.2', { defaultValue: 'The engine SUGGESTS status changes (strengthening, weakening, needs review) from your own evidence and rules. It never changes your conclusion. You confirm.' }),
    t('journal.about.3', { defaultValue: 'Confirmation and invalidation rules can become alerts. Partnerships are treated skeptically: announced is not measurable adoption.' }),
    t('journal.about.4', { defaultValue: 'Your theses and trades are private to you. Trade Journal is for planning and review only. Investor Intel never executes trades.' }),
  ]
  return (
    <div className="space-y-4">
      <div>
        <div className="eyebrow flex items-center gap-1.5"><Settings className="h-3.5 w-3.5" /> {t('journal.brand', { defaultValue: 'Thesis Journal' })}</div>
        <h1 className="page-title">{t('journal.nav.settings', { defaultValue: 'Settings' })}</h1>
      </div>
      <div className="card p-4 space-y-2">
        <div className="flex items-center gap-1.5 text-[var(--ok)]"><ShieldCheck className="h-4 w-4" /><span className="text-[13px] font-medium">{t('journal.how_it_works', { defaultValue: 'How the Thesis Journal works' })}</span></div>
        <ul className="space-y-2 mt-1">
          {items.map((x, i) => <li key={i} className="text-[12px] text-[var(--fg-3)] flex gap-2"><span className="text-[var(--accent)]">•</span> {x}</li>)}
        </ul>
      </div>
      <div className="flex gap-2">
        <Link to="/intel/theses/new" className="btn btn--primary btn--sm">{t('journal.new_thesis', { defaultValue: 'New thesis' })}</Link>
        <Link to="/intel/theses/list" className="btn btn--quiet btn--sm">{t('journal.nav.theses', { defaultValue: 'Theses' })}</Link>
      </div>
    </div>
  )
}
