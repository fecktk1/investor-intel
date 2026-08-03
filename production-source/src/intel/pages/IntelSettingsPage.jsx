import React, { useEffect, useState, useCallback, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Bot, Check, Copy, Plus, Settings, Trash2, Coins } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useAuth } from '../../lib/auth-context'
import { useSupabase } from '../../lib/useSupabase'
import SparqHolderBadge from '../../components/SparqHolderBadge'
import WorkspaceRenameCard from '../../components/WorkspaceRenameCard'

const SparqAccessCard = lazy(() => import('../../components/sparq/SparqAccessCard'))
import { CHAINS } from '../lib/chains'
import { getIntelProfile, getNotificationPrefs, saveIntelProfile, saveNotificationPrefs } from '../lib/intel-api'
import IntelDisclaimer from '../components/IntelDisclaimer'

const EXPERIENCE = ['new', 'intermediate', 'advanced']
const STYLE = ['short', 'standard', 'deep']
const RISK = ['conservative', 'balanced', 'aggressive']
const TOPICS = ['btc', 'eth', 'sol', 'memecoins', 'defi', 'ai', 'gaming', 'rwa', 'airdrops', 'whales', 'new_launches', 'long_term', 'trading', 'education']
const TG_CHAT_PERMISSIONS = [
  ['briefs', 'Briefs'],
  ['alerts', 'Alerts'],
  ['charts', 'Charts'],
  ['token_lookup', 'Token lookup'],
  ['ask', 'Ask'],
]
const toggle = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])

function defaultIntelProfile() {
  return {
    experience_level: 'intermediate',
    explanation_style: 'standard',
    risk_tolerance: 'balanced',
    beginner_protection: true,
    topics_of_interest: [],
    chains_of_interest: [],
  }
}

function defaultPrefs(userId) {
  return {
    user_id: userId,
    channels: { in_app: true, email: false, telegram: false },
    brief_schedule: 'daily',
    quiet_hours: {},
  }
}

function displayTelegramUser(row) {
  if (!row) return 'Not linked'
  const handle = row.telegram_username ? `@${row.telegram_username}` : null
  const name = [row.telegram_first_name, row.telegram_last_name].filter(Boolean).join(' ')
  return handle || name || row.telegram_user_id
}

export default function IntelSettingsPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org, sparqHolder } = useProfile()
  const { session } = useAuth()
  const { supabase, user } = useSupabase()
  const [p, setP] = useState(null)
  const [prefs, setPrefs] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState(null)
  const [tgLinks, setTgLinks] = useState([])
  const [tgChats, setTgChats] = useState([])
  const [tgCode, setTgCode] = useState(null)
  const [tgMsg, setTgMsg] = useState(null)
  const [tgLoading, setTgLoading] = useState(false)
  const [newChat, setNewChat] = useState({ chat_id: '', chat_title: '' })

  useEffect(() => {
    let alive = true
    ;(async () => {
      if (!org?.id) return
      try {
        const [row, prefRow] = await Promise.all([
          getIntelProfile(supabase, org.id),
          getNotificationPrefs(supabase, org.id),
        ])
        if (!alive) return
        setP(row || defaultIntelProfile())
        setPrefs(prefRow || defaultPrefs(user?.id))
      } catch (e) {
        setErr(e.message)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [org?.id, supabase, user?.id])

  const loadTelegramSettings = useCallback(async () => {
    if (!org?.id) return
    setTgLoading(true)
    setTgMsg(null)
    try {
      const [linksRes, chatsRes] = await Promise.all([
        supabase
          .from('intel_telegram_links')
          .select('id, telegram_user_id, telegram_username, telegram_first_name, telegram_last_name, status, allows_private_alerts, linked_at')
          .eq('org_id', org.id)
          .order('linked_at', { ascending: false }),
        supabase
          .from('intel_telegram_chats')
          .select('id, chat_id, chat_title, chat_type, enabled, permissions, min_alert_severity, default_timeframe, created_at')
          .eq('org_id', org.id)
          .order('created_at', { ascending: false }),
      ])
      if (linksRes.error) throw linksRes.error
      if (chatsRes.error) throw chatsRes.error
      setTgLinks(linksRes.data || [])
      setTgChats(chatsRes.data || [])
    } catch (e) {
      setTgMsg(e.message || 'Telegram settings failed to load')
    } finally {
      setTgLoading(false)
    }
  }, [org?.id, supabase])

  useEffect(() => {
    loadTelegramSettings()
  }, [loadTelegramSettings])

  const save = useCallback(async () => {
    if (!org?.id || !p) return
    setSaving(true)
    setErr(null)
    setSaved(false)
    try {
      await saveIntelProfile(supabase, org.id, user?.id, {
        experience_level: p.experience_level,
        explanation_style: p.explanation_style,
        risk_tolerance: p.risk_tolerance,
        beginner_protection: !!p.beginner_protection,
        topics_of_interest: p.topics_of_interest || [],
        chains_of_interest: p.chains_of_interest || [],
      })
      if (prefs) {
        await saveNotificationPrefs(supabase, org.id, user?.id, {
          channels: prefs.channels || defaultPrefs(user?.id).channels,
          brief_schedule: prefs.brief_schedule || 'daily',
          quiet_hours: prefs.quiet_hours || {},
        })
      }
      setSaved(true)
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }, [org?.id, p, prefs, supabase, user?.id])

  const generateTelegramCode = useCallback(async () => {
    setTgLoading(true)
    setTgMsg(null)
    setTgCode(null)
    try {
      const { data, error } = await supabase.rpc('create_intel_telegram_link_code')
      if (error) throw error
      setTgCode(data)
      setTgMsg('Code generated. Send the link command to the Investor Intel Telegram bot within 15 minutes.')
    } catch (e) {
      setTgMsg(e.message || 'Could not generate Telegram code')
    } finally {
      setTgLoading(false)
    }
  }, [supabase])

  const copyLinkCommand = useCallback(async () => {
    if (!tgCode) return
    try {
      await navigator.clipboard.writeText(`/link ${tgCode}`)
      setTgMsg('Link command copied.')
    } catch {
      setTgMsg('Copy failed. You can select the command manually.')
    }
  }, [tgCode])

  const addTelegramChat = useCallback(async () => {
    if (!org?.id || !newChat.chat_id.trim()) return
    setTgLoading(true)
    setTgMsg(null)
    try {
      const { error } = await supabase.from('intel_telegram_chats').insert({
        org_id: org.id,
        added_by: user?.id,
        chat_id: newChat.chat_id.trim(),
        chat_title: newChat.chat_title.trim() || null,
        chat_type: 'group',
      })
      if (error) throw error
      setNewChat({ chat_id: '', chat_title: '' })
      setTgMsg('Group chat added.')
      await loadTelegramSettings()
    } catch (e) {
      setTgMsg(e.message || 'Could not add Telegram chat')
    } finally {
      setTgLoading(false)
    }
  }, [loadTelegramSettings, newChat.chat_id, newChat.chat_title, org?.id, supabase, user?.id])

  const updateTelegramChat = useCallback(async (id, patch) => {
    setTgMsg(null)
    const current = tgChats.find((c) => c.id === id)
    setTgChats((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
    const { error } = await supabase.from('intel_telegram_chats').update(patch).eq('id', id)
    if (error) {
      setTgMsg(error.message)
      if (current) setTgChats((rows) => rows.map((row) => (row.id === id ? current : row)))
    }
  }, [supabase, tgChats])

  const toggleChatPermission = useCallback((chat, key) => {
    const permissions = { ...(chat.permissions || {}), [key]: !(chat.permissions || {})[key] }
    if (key === 'charts' && permissions.charts) permissions.token_lookup = true
    updateTelegramChat(chat.id, { permissions })
  }, [updateTelegramChat])

  const revokeTelegramLink = useCallback(async (id) => {
    setTgLoading(true)
    setTgMsg(null)
    try {
      const { error } = await supabase
        .from('intel_telegram_links')
        .update({ status: 'revoked', revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      setTgMsg('Telegram account revoked.')
      await loadTelegramSettings()
    } catch (e) {
      setTgMsg(e.message || 'Could not revoke Telegram account')
    } finally {
      setTgLoading(false)
    }
  }, [loadTelegramSettings, supabase])

  const deleteTelegramChat = useCallback(async (id) => {
    setTgLoading(true)
    setTgMsg(null)
    try {
      const { error } = await supabase.from('intel_telegram_chats').delete().eq('id', id)
      if (error) throw error
      setTgMsg('Group chat removed.')
      await loadTelegramSettings()
    } catch (e) {
      setTgMsg(e.message || 'Could not remove Telegram chat')
    } finally {
      setTgLoading(false)
    }
  }, [loadTelegramSettings, supabase])

  const togglePrivateAlerts = useCallback(async (link) => {
    const next = !link.allows_private_alerts
    setTgLinks((rows) => rows.map((row) => (row.id === link.id ? { ...row, allows_private_alerts: next } : row)))
    const { error } = await supabase
      .from('intel_telegram_links')
      .update({ allows_private_alerts: next, updated_at: new Date().toISOString() })
      .eq('id', link.id)
    if (error) {
      setTgMsg(error.message)
      setTgLinks((rows) => rows.map((row) => (row.id === link.id ? link : row)))
    }
  }, [supabase])

  if (loading || !p) {
    return <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
  }

  const Single = ({ k, options, scope }) => (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button key={o} type="button" onClick={() => setP((s) => ({ ...s, [k]: o }))} className={p[k] === o ? 'chip chip--accent' : 'chip'}>
          {t(`onboarding.${scope}.${o}`, { defaultValue: o })}
        </button>
      ))}
    </div>
  )

  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow flex items-center gap-1.5"><Settings className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
        <h1 className="page-title">{t('nav.settings', { defaultValue: 'Settings' })}</h1>
        <p className="page-sub">{t('pages.settings_sub', { defaultValue: 'Risk profile, chains, topics, explanation style and Beginner Protection.' })}</p>
      </div>

      <WorkspaceRenameCard />

      <div className="card p-4 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-medium text-[var(--fg-1)]">{t('settings.plan_heading', { defaultValue: 'Plan' })}</div>
          {sparqHolder ? (
            <div className="mt-1"><SparqHolderBadge holder={sparqHolder} /></div>
          ) : (
            <p className="text-[13px] text-[var(--fg-3)] capitalize">
              {t('settings.plan_current', {
                defaultValue: 'Current tier: {{tier}}',
                tier: org?.plan_overrides?.intel_tier || 'trial',
              })}
            </p>
          )}
        </div>
        {!sparqHolder && (
          <Link to="/intel/upgrade" className="btn btn--quiet btn--sm">
            {t('settings.plan_manage', { defaultValue: 'Upgrade / manage plan' })}
          </Link>
        )}
      </div>

      <div className="card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Coins className="h-4 w-4 text-[var(--accent)]" />
          <div className="text-sm font-medium text-[var(--fg-1)]">{t('settings.sparq_heading', { defaultValue: 'FORGE Holder Access' })}</div>
        </div>
        <Suspense fallback={<div className="text-[13px] text-[var(--fg-3)]">{t('settings.sparq_loading', { defaultValue: 'Loading holder access…' })}</div>}>
          <SparqAccessCard session={session} scope="user" />
        </Suspense>
      </div>

      <div className="card p-4 space-y-2">
        <div className="text-sm font-medium text-[var(--fg-1)]">{t('onboarding.q_experience', { defaultValue: 'Experience' })}</div>
        <Single k="experience_level" options={EXPERIENCE} scope="experience" />
      </div>
      <div className="card p-4 space-y-2">
        <div className="text-sm font-medium text-[var(--fg-1)]">{t('onboarding.q_style', { defaultValue: 'Detail level' })}</div>
        <Single k="explanation_style" options={STYLE} scope="style" />
      </div>
      <div className="card p-4 space-y-2">
        <div className="text-sm font-medium text-[var(--fg-1)]">{t('onboarding.q_risk', { defaultValue: 'Risk posture' })}</div>
        <Single k="risk_tolerance" options={RISK} scope="risk" />
      </div>
      <div className="card p-4 space-y-2">
        <div className="text-sm font-medium text-[var(--fg-1)]">{t('onboarding.q_topics', { defaultValue: 'Topics' })}</div>
        <div className="flex flex-wrap gap-2">
          {TOPICS.map((o) => (
            <button key={o} type="button" onClick={() => setP((s) => ({ ...s, topics_of_interest: toggle(s.topics_of_interest || [], o) }))} className={(p.topics_of_interest || []).includes(o) ? 'chip chip--accent' : 'chip'}>
              {t(`onboarding.topics.${o}`, { defaultValue: o })}
            </button>
          ))}
        </div>
      </div>
      <div className="card p-4 space-y-2">
        <div className="text-sm font-medium text-[var(--fg-1)]">{t('onboarding.q_chains', { defaultValue: 'Chains' })}</div>
        <div className="flex flex-wrap gap-2">
          {CHAINS.map((c) => (
            <button key={c.id} type="button" onClick={() => setP((s) => ({ ...s, chains_of_interest: toggle(s.chains_of_interest || [], c.id) }))} className={(p.chains_of_interest || []).includes(c.id) ? 'chip chip--accent' : 'chip'}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <label className="card p-4 flex items-center gap-3 cursor-pointer">
        <input type="checkbox" checked={!!p.beginner_protection} onChange={(e) => setP((s) => ({ ...s, beginner_protection: e.target.checked }))} />
        <span className="text-[13px] text-[var(--fg-2)]">{t('settings.beginner', { defaultValue: 'Beginner Protection - stronger risk warnings and simpler explanations.' })}</span>
      </label>

      <div className="card p-4 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-sm font-medium text-[var(--fg-1)] flex items-center gap-2"><Bot className="h-4 w-4" /> Telegram bot</div>
            <p className="text-[13px] text-[var(--fg-3)]">Link a private DM or add a group chat for briefs, alerts, token overviews, and live chart commands.</p>
          </div>
          <button type="button" onClick={loadTelegramSettings} disabled={tgLoading} className="btn btn--quiet btn--sm disabled:opacity-50">Refresh</button>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <section className="rounded-md border border-[var(--border)] p-3 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[13px] font-medium text-[var(--fg-1)]">Private DM</div>
                <p className="text-[12px] text-[var(--fg-3)]">Private chats can receive user-specific alerts, briefs, portfolio summaries, and chart requests.</p>
              </div>
              <button type="button" onClick={generateTelegramCode} disabled={tgLoading} className="btn btn--primary btn--sm disabled:opacity-50">Generate code</button>
            </div>

            {tgCode && (
              <div className="rounded-md border border-[var(--border)] bg-[var(--bg-2)] p-3 space-y-2">
                <div className="text-[12px] uppercase tracking-wide text-[var(--fg-3)]">Send this to the bot</div>
                <div className="flex items-center justify-between gap-2">
                  <code className="text-[13px] text-[var(--fg-1)] break-all">/link {tgCode}</code>
                  <button type="button" onClick={copyLinkCommand} className="btn btn--quiet btn--sm" aria-label="Copy link command"><Copy className="h-4 w-4" /></button>
                </div>
              </div>
            )}

            <label className="flex items-center gap-2 text-[13px] text-[var(--fg-2)]">
              <input
                type="checkbox"
                checked={!!prefs?.channels?.telegram}
                onChange={(e) => setPrefs((s) => ({ ...(s || defaultPrefs(user?.id)), channels: { ...((s || {}).channels || defaultPrefs(user?.id).channels), telegram: e.target.checked } }))}
              />
              Use Telegram for Investor Intel notifications when a link or group exists.
            </label>

            <div className="space-y-2">
              {(tgLinks || []).length ? tgLinks.map((link) => (
                <div key={link.id} className="rounded-md border border-[var(--border)] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-[13px] font-medium text-[var(--fg-1)]">{displayTelegramUser(link)}</div>
                      <div className="text-[12px] text-[var(--fg-3)]">Status: {link.status}</div>
                    </div>
                    <button type="button" onClick={() => revokeTelegramLink(link.id)} disabled={tgLoading || link.status === 'revoked'} className="btn btn--quiet btn--sm disabled:opacity-50" aria-label="Revoke Telegram link"><Trash2 className="h-4 w-4" /></button>
                  </div>
                  <label className="mt-2 flex items-center gap-2 text-[12px] text-[var(--fg-2)]">
                    <input type="checkbox" checked={!!link.allows_private_alerts} onChange={() => togglePrivateAlerts(link)} disabled={link.status !== 'active'} />
                    Allow private alerts and briefs in DM
                  </label>
                </div>
              )) : (
                <div className="rounded-md border border-dashed border-[var(--border)] p-3 text-[13px] text-[var(--fg-3)]">No private Telegram account linked.</div>
              )}
            </div>
          </section>

          <section className="rounded-md border border-[var(--border)] p-3 space-y-3">
            <div>
              <div className="text-[13px] font-medium text-[var(--fg-1)]">Group chats</div>
              <p className="text-[12px] text-[var(--fg-3)]">Groups can use shared org intel. Portfolio commands stay private-only.</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2">
              <input className="input text-[13px]" placeholder="Chat ID" value={newChat.chat_id} onChange={(e) => setNewChat((s) => ({ ...s, chat_id: e.target.value }))} />
              <input className="input text-[13px]" placeholder="Group name" value={newChat.chat_title} onChange={(e) => setNewChat((s) => ({ ...s, chat_title: e.target.value }))} />
              <button type="button" onClick={addTelegramChat} disabled={tgLoading || !newChat.chat_id.trim()} className="btn btn--primary btn--sm disabled:opacity-50"><Plus className="h-4 w-4" /> Add</button>
            </div>

            <div className="space-y-2">
              {(tgChats || []).length ? tgChats.map((chat) => (
                <div key={chat.id} className="rounded-md border border-[var(--border)] p-3 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-[13px] font-medium text-[var(--fg-1)]">{chat.chat_title || chat.chat_id}</div>
                      <div className="text-[12px] text-[var(--fg-3)]">{chat.chat_id} - {chat.enabled ? 'Enabled' : 'Paused'}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => updateTelegramChat(chat.id, { enabled: !chat.enabled })} className="btn btn--quiet btn--sm">{chat.enabled ? 'Pause' : 'Enable'}</button>
                      <button type="button" onClick={() => deleteTelegramChat(chat.id)} disabled={tgLoading} className="btn btn--quiet btn--sm disabled:opacity-50" aria-label="Remove chat"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {TG_CHAT_PERMISSIONS.map(([key, label]) => {
                      const active = (chat.permissions || {})[key] !== false
                      return <button key={key} type="button" onClick={() => toggleChatPermission(chat, key)} className={active ? 'chip chip--accent' : 'chip'}>{label}</button>
                    })}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <label className="text-[12px] text-[var(--fg-3)]">
                      Alert floor
                      <select className="input mt-1 text-[13px]" value={chat.min_alert_severity || 'low'} onChange={(e) => updateTelegramChat(chat.id, { min_alert_severity: e.target.value })}>
                        {['low', 'medium', 'high', 'critical'].map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </label>
                    <label className="text-[12px] text-[var(--fg-3)]">
                      Default chart timeframe
                      <select className="input mt-1 text-[13px]" value={chat.default_timeframe || '1D'} onChange={(e) => updateTelegramChat(chat.id, { default_timeframe: e.target.value })}>
                        {['1H', '4H', '1D', '1W'].map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </label>
                  </div>
                </div>
              )) : (
                <div className="rounded-md border border-dashed border-[var(--border)] p-3 text-[13px] text-[var(--fg-3)]">No group chats added. Add the bot to a group, send /id, then paste the chat ID here.</div>
              )}
            </div>
          </section>
        </div>

        {tgMsg && <div className="rounded-md border border-[var(--border)] p-3 text-[13px] text-[var(--fg-2)]">{tgMsg}</div>}
      </div>

      {err && <div className="card--flat p-3 text-[13px] text-red-400">{err}</div>}
      <div className="flex items-center gap-3 justify-end">
        {saved && <span className="text-[12px] text-[var(--ok)] flex items-center gap-1"><Check className="h-4 w-4" /> {t('settings.saved', { defaultValue: 'Saved' })}</span>}
        <button onClick={save} disabled={saving} className="btn btn--primary disabled:opacity-50">{saving ? '...' : t('settings.save', { defaultValue: 'Save changes' })}</button>
      </div>

      <IntelDisclaimer variant="block" />
    </div>
  )
}
