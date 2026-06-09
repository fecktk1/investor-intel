import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings, Check } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { CHAINS } from '../lib/chains'
import { getIntelProfile, saveIntelProfile } from '../lib/intel-api'
import IntelDisclaimer from '../components/IntelDisclaimer'

const EXPERIENCE = ['new', 'intermediate', 'advanced']
const STYLE = ['short', 'standard', 'deep']
const RISK = ['conservative', 'balanced', 'aggressive']
const TOPICS = ['btc', 'eth', 'sol', 'memecoins', 'defi', 'ai', 'gaming', 'rwa', 'airdrops', 'whales', 'new_launches', 'long_term', 'trading', 'education']
const toggle = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])

export default function IntelSettingsPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const [p, setP] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      if (!org?.id) return
      try { const row = await getIntelProfile(supabase, org.id); if (alive) setP(row || { experience_level: 'intermediate', explanation_style: 'standard', risk_tolerance: 'balanced', beginner_protection: true, topics_of_interest: [], chains_of_interest: [] }) }
      catch (e) { setErr(e.message) } finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [org?.id, supabase])

  const save = useCallback(async () => {
    if (!org?.id || !p) return
    setSaving(true); setErr(null); setSaved(false)
    try {
      await saveIntelProfile(supabase, org.id, user?.id, {
        experience_level: p.experience_level, explanation_style: p.explanation_style, risk_tolerance: p.risk_tolerance,
        beginner_protection: !!p.beginner_protection, topics_of_interest: p.topics_of_interest || [], chains_of_interest: p.chains_of_interest || [],
      })
      setSaved(true)
    } catch (e) { setErr(e.message) } finally { setSaving(false) }
  }, [org?.id, p, supabase, user?.id])

  if (loading || !p) return <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>

  const Single = ({ k, options, scope }) => (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => <button key={o} type="button" onClick={() => setP((s) => ({ ...s, [k]: o }))} className={p[k] === o ? 'chip chip--accent' : 'chip'}>{t(`onboarding.${scope}.${o}`, { defaultValue: o })}</button>)}
    </div>
  )

  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow flex items-center gap-1.5"><Settings className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
        <h1 className="page-title">{t('nav.settings', { defaultValue: 'Settings' })}</h1>
        <p className="page-sub">{t('pages.settings_sub', { defaultValue: 'Risk profile, chains, topics, explanation style and Beginner Protection.' })}</p>
      </div>

      <div className="card p-4 space-y-2"><div className="text-sm font-medium text-[var(--fg-1)]">{t('onboarding.q_experience', { defaultValue: 'Experience' })}</div><Single k="experience_level" options={EXPERIENCE} scope="experience" /></div>
      <div className="card p-4 space-y-2"><div className="text-sm font-medium text-[var(--fg-1)]">{t('onboarding.q_style', { defaultValue: 'Detail level' })}</div><Single k="explanation_style" options={STYLE} scope="style" /></div>
      <div className="card p-4 space-y-2"><div className="text-sm font-medium text-[var(--fg-1)]">{t('onboarding.q_risk', { defaultValue: 'Risk posture' })}</div><Single k="risk_tolerance" options={RISK} scope="risk" /></div>
      <div className="card p-4 space-y-2"><div className="text-sm font-medium text-[var(--fg-1)]">{t('onboarding.q_topics', { defaultValue: 'Topics' })}</div>
        <div className="flex flex-wrap gap-2">{TOPICS.map((o) => <button key={o} type="button" onClick={() => setP((s) => ({ ...s, topics_of_interest: toggle(s.topics_of_interest || [], o) }))} className={(p.topics_of_interest || []).includes(o) ? 'chip chip--accent' : 'chip'}>{t(`onboarding.topics.${o}`, { defaultValue: o })}</button>)}</div>
      </div>
      <div className="card p-4 space-y-2"><div className="text-sm font-medium text-[var(--fg-1)]">{t('onboarding.q_chains', { defaultValue: 'Chains' })}</div>
        <div className="flex flex-wrap gap-2">{CHAINS.map((c) => <button key={c.id} type="button" onClick={() => setP((s) => ({ ...s, chains_of_interest: toggle(s.chains_of_interest || [], c.id) }))} className={(p.chains_of_interest || []).includes(c.id) ? 'chip chip--accent' : 'chip'}>{c.label}</button>)}</div>
      </div>
      <label className="card p-4 flex items-center gap-3 cursor-pointer">
        <input type="checkbox" checked={!!p.beginner_protection} onChange={(e) => setP((s) => ({ ...s, beginner_protection: e.target.checked }))} />
        <span className="text-[13px] text-[var(--fg-2)]">{t('settings.beginner', { defaultValue: 'Beginner Protection — stronger risk warnings and simpler explanations.' })}</span>
      </label>

      {err && <div className="card--flat p-3 text-[13px] text-red-400">{err}</div>}
      <div className="flex items-center gap-3 justify-end">
        {saved && <span className="text-[12px] text-[var(--ok)] flex items-center gap-1"><Check className="h-4 w-4" /> {t('settings.saved', { defaultValue: 'Saved' })}</span>}
        <button onClick={save} disabled={saving} className="btn btn--primary disabled:opacity-50">{saving ? '…' : t('settings.save', { defaultValue: 'Save changes' })}</button>
      </div>

      <IntelDisclaimer variant="block" />
    </div>
  )
}
