import React, { useMemo, useState, useCallback } from 'react'
import { Helmet } from 'react-helmet-async'
import { useTranslation } from 'react-i18next'
import { Gauge, Check, MessageSquare } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { CHAINS } from '../lib/chains'
import { saveIntelProfile, completeIntelOnboarding } from '../lib/intel-api'
import IntelDisclaimer from '../components/IntelDisclaimer'

const EXPERIENCE = ['new', 'intermediate', 'advanced']
const STYLE = ['short', 'standard', 'deep']
const RISK = ['conservative', 'balanced', 'aggressive']
const TOPICS = ['btc', 'eth', 'sol', 'memecoins', 'defi', 'ai', 'gaming', 'rwa', 'airdrops', 'whales', 'new_launches', 'long_term', 'trading', 'education']
const BRIEFS = ['daily', 'watchlist', 'narrative', 'risk_only']

function toggle(arr, v) {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]
}

// Lightweight, single-screen onboarding that seeds the per-workspace risk
// profile (chains/topics/experience/style/briefs + disclaimer ack). Seeding the
// actual watchlist happens once the watchlist tables land (P2).
export default function IntelOnboardingPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org, profile } = useProfile()
  const { supabase, user } = useSupabase()

  const [experience, setExperience] = useState('intermediate')
  const [style, setStyle] = useState('standard')
  const [risk, setRisk] = useState('balanced')
  const [topics, setTopics] = useState([])
  const [chains, setChains] = useState(['solana', 'ethereum'])
  const [briefs, setBriefs] = useState(['daily'])
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const beginnerProtection = experience === 'new'
  const userId = user?.id || profile?.id || null

  const tlabel = useCallback((scope, key) => t(`onboarding.${scope}.${key}`, { defaultValue: key.replace(/_/g, ' ') }), [t])

  const finish = useCallback(async () => {
    if (!ack || !org?.id) return
    setBusy(true); setError(null)
    try {
      await saveIntelProfile(supabase, org.id, userId, {
        experience_level: experience,
        explanation_style: style,
        risk_tolerance: risk,
        topics_of_interest: topics,
        chains_of_interest: chains,
        brief_types: briefs,
        beginner_protection: beginnerProtection,
        disclaimer_ack_at: new Date().toISOString(),
      })
      await completeIntelOnboarding(supabase)
      // Hard reload so the profile re-fetches with onboarding_completed = true.
      window.location.assign('/intel')
    } catch (e) {
      setBusy(false)
      setError(e?.message || t('onboarding.error', { defaultValue: 'Could not save. Please try again.' }))
    }
  }, [ack, org?.id, supabase, userId, experience, style, risk, topics, chains, briefs, beginnerProtection, t])

  const Single = ({ value, set, options, scope }) => (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button key={o} type="button" onClick={() => set(o)}
          className={value === o ? 'chip chip--accent' : 'chip'}>{tlabel(scope, o)}</button>
      ))}
    </div>
  )
  const Multi = ({ values, set, options, scope }) => (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button key={o} type="button" onClick={() => set((s) => toggle(s, o))}
          className={values.includes(o) ? 'chip chip--accent' : 'chip'}>{tlabel(scope, o)}</button>
      ))}
    </div>
  )

  const sections = useMemo(() => ([
    { key: 'experience', title: t('onboarding.q_experience', { defaultValue: 'How experienced are you?' }), node: <Single value={experience} set={setExperience} options={EXPERIENCE} scope="experience" /> },
    { key: 'style', title: t('onboarding.q_style', { defaultValue: 'How much detail do you want?' }), node: <Single value={style} set={setStyle} options={STYLE} scope="style" /> },
    { key: 'risk', title: t('onboarding.q_risk', { defaultValue: 'What is your risk posture?' }), node: <Single value={risk} set={setRisk} options={RISK} scope="risk" /> },
    { key: 'topics', title: t('onboarding.q_topics', { defaultValue: 'What do you care about?' }), node: <Multi values={topics} set={setTopics} options={TOPICS} scope="topics" /> },
    { key: 'chains', title: t('onboarding.q_chains', { defaultValue: 'Which chains?' }), node: (
      <div className="flex flex-wrap gap-2">
        {CHAINS.map((c) => (
          <button key={c.id} type="button" onClick={() => setChains((s) => toggle(s, c.id))}
            className={chains.includes(c.id) ? 'chip chip--accent' : 'chip'}>{c.label}</button>
        ))}
      </div>
    ) },
    { key: 'briefs', title: t('onboarding.q_briefs', { defaultValue: 'Which briefs would you like?' }), node: <Multi values={briefs} set={setBriefs} options={BRIEFS} scope="briefs" /> },
  ]), [experience, style, risk, topics, chains, briefs, t])

  return (
    <div className="min-h-screen bg-black overflow-y-auto">
      <Helmet><title>{`${t('onboarding.title', { defaultValue: 'Set up Investor Intel' })} · TheContentForge`}</title></Helmet>
      <div className="max-w-2xl mx-auto p-6 space-y-5">
        <div className="flex items-center gap-3 pt-2">
          <div className="h-10 w-10 rounded-xl grid place-items-center" style={{ background: 'var(--accent-tint)' }}>
            <Gauge className="h-6 w-6" style={{ color: 'var(--accent)' }} />
          </div>
          <div>
            <div className="eyebrow">{t('brand.name', { defaultValue: 'Investor Intel' })}</div>
            <h1 className="page-title">{t('onboarding.title', { defaultValue: 'Set up your workspace' })}</h1>
          </div>
        </div>
        <p className="page-sub">{t('onboarding.sub', { defaultValue: 'This personalizes your briefs, explanations and risk framing. You can change it any time in Settings.' })}</p>

        {sections.map((s) => (
          <div key={s.key} className="card p-4 space-y-3">
            <div className="text-sm font-medium text-[var(--fg-1)]">{s.title}</div>
            {s.node}
          </div>
        ))}

        {beginnerProtection && (
          <div className="card--flat p-3 text-[12px] text-[var(--fg-3)] flex items-center gap-2">
            <Check className="h-4 w-4 text-[var(--accent)]" />
            {t('onboarding.beginner_on', { defaultValue: 'Beginner Protection is on — stronger risk warnings and simpler explanations.' })}
          </div>
        )}

        <label className="card p-4 flex items-start gap-3 cursor-pointer">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
          <span className="text-[13px] text-[var(--fg-2)]">
            {t('onboarding.ack', { defaultValue: 'I understand Investor Intel is research, education and risk context — not financial advice.' })}
          </span>
        </label>

        {error && <div className="card--flat p-3 text-[13px] text-red-400">{error}</div>}

        <div className="flex justify-end pb-8">
          <button onClick={finish} disabled={!ack || busy} className="btn btn--primary btn--lg disabled:opacity-50">
            {busy ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : t('onboarding.finish', { defaultValue: 'Start exploring' })}
          </button>
        </div>

        <div className="card--flat p-3 text-[12px] text-[var(--fg-3)] flex items-start gap-2">
          <MessageSquare className="h-4 w-4 text-[var(--accent)] flex-shrink-0 mt-0.5" />
          <span>{t('onboarding.feedback', { defaultValue: 'Feedback welcome — TheContentForge is always improving. During your free trial, use Report Issue in the sidebar to send bug reports, feature requests, or ideas that would make the platform better.' })}</span>
        </div>

        <IntelDisclaimer variant="block" />
      </div>
    </div>
  )
}
