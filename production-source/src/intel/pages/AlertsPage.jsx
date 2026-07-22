import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Bell, Plus, Trash2, Info } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { CHAINS } from '../lib/chains'
import { resolveEntity } from '../lib/watchlist-api'
import { listAlertRules, createAlertRule, deleteAlertRule, updateAlertRule, listAlertEvents } from '../lib/intel-data'
import { useArtifact } from '../lib/useArtifact'
import ArtifactView from '../components/ArtifactView'
import IntelDisclaimer from '../components/IntelDisclaimer'
import IntelErrorNotice from '../components/IntelErrorNotice'
import RelevantSignals from '../components/RelevantSignals'
import { markSurfaceSeen } from '../lib/changes-api'
import { emitTutorialSignal } from '../../help/signals'

const TRIGGERS = ['price_move', 'liquidity_drop', 'volume_spike', 'wallet_activity', 'narrative_heat', 'holder_shift']

// P10 — Smart Alerts. Rules are created here; evaluation + the AI "why it
// matters" artifact run server-side (cron + intel-generate) in production.
export default function AlertsPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const [rules, setRules] = useState([])
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ chain: 'solana', value: '', trigger: 'price_move', threshold: '10' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const why = useArtifact()
  const [whyId, setWhyId] = useState(null)

  const load = useCallback(async () => {
    if (!org?.id) return
    setLoading(true)
    try { const [r, e] = await Promise.all([listAlertRules(supabase, org.id), listAlertEvents(supabase, org.id)]); setRules(r); setEvents(e) }
    catch (ex) { setErr(ex.message) } finally { setLoading(false) }
  }, [org?.id, supabase])
  useEffect(() => { load() }, [load])
  useEffect(() => () => { if (org?.id) markSurfaceSeen(supabase, 'alerts') }, [org?.id, supabase])

  const add = useCallback(async (e) => {
    e.preventDefault()
    if (!form.value.trim() || !org?.id) return
    setBusy(true); setErr(null)
    try {
      const ent = await resolveEntity(supabase, org.id, { kind: 'asset', chain: form.chain, value: form.value.trim() })
      const rule = await createAlertRule(supabase, org.id, user?.id, { entity_id: ent.id, trigger_type: form.trigger, config: { threshold_pct: Number(form.threshold) || null } })
      // Tutorial receipt: every create is a fresh row, so its id + created_at
      // uniquely identify this run's operation.
      emitTutorialSignal('alerts.rule-created', rule ? { rule_id: rule.id } : {})
      setForm((f) => ({ ...f, value: '' })); await load()
    } catch (ex) {
      // Raw message — IntelErrorNotice maps intel_limit_reached:* to friendly
      // copy + the /intel/upgrade link.
      setErr(ex.message || '')
    } finally { setBusy(false) }
  }, [form, org?.id, supabase, user?.id, load])

  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow flex items-center gap-1.5"><Bell className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
        <h1 className="page-title">{t('nav.alerts', { defaultValue: 'Alerts' })}</h1>
        <p className="page-sub">{t('pages.alerts_sub', { defaultValue: 'Smart alerts with an AI explanation of why each one matters.' })}</p>
      </div>

      <form onSubmit={add} className="card p-4 flex flex-wrap items-end gap-3">
        <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('watchlist.chain', { defaultValue: 'Chain' })}</span>
          <select className="select" value={form.chain} onChange={(e) => setForm((f) => ({ ...f, chain: e.target.value }))}>{CHAINS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
        </label>
        <label className="block flex-1 min-w-[160px]"><span className="text-[11px] text-[var(--fg-4)]">{t('watchlist.value', { defaultValue: 'Identifier' })}</span>
          <input className="input w-full" data-tutorial="intel-alerts.identifier-input" placeholder={t('watchlist.ph.token', { defaultValue: 'Token mint / contract' })} value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} />
        </label>
        <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('alerts.trigger', { defaultValue: 'Trigger' })}</span>
          <select className="select" data-tutorial="intel-alerts.trigger-select" value={form.trigger} onChange={(e) => setForm((f) => ({ ...f, trigger: e.target.value }))}>{TRIGGERS.map((tr) => <option key={tr} value={tr}>{t(`alerts.triggers.${tr}`, { defaultValue: tr.replace(/_/g, ' ') })}</option>)}</select>
        </label>
        <label className="block w-20"><span className="text-[11px] text-[var(--fg-4)]">%</span>
          <input className="input w-full" type="number" value={form.threshold} onChange={(e) => setForm((f) => ({ ...f, threshold: e.target.value }))} />
        </label>
        <button type="submit" disabled={busy || !form.value.trim()} data-tutorial="intel-alerts.add-button" className="btn btn--primary disabled:opacity-50"><Plus className="h-4 w-4" /> {t('alerts.add', { defaultValue: 'Add rule' })}</button>
      </form>

      <IntelErrorNotice error={err} />

      <div className="card--flat p-3 flex items-start gap-2 text-[12px] text-[var(--fg-4)]">
        <Info className="h-3.5 w-3.5 mt-0.5" /> {t('alerts.note', { defaultValue: 'Alert evaluation and the AI "why it matters" explanation run on a schedule server-side.' })}
      </div>

      <RelevantSignals title={t('alerts.relevant_signals', { defaultValue: 'Signals affecting your watchlist & holdings' })} seeAllHref="/intel" />

      {loading ? (
        <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
      ) : (
        <>
          <div className="space-y-2">
            <div className="eyebrow">{t('alerts.rules', { defaultValue: 'Rules' })}</div>
            {rules.length === 0 ? <p className="text-[13px] text-[var(--fg-3)]">{t('alerts.no_rules', { defaultValue: 'No alert rules yet.' })}</p> : rules.map((r) => (
              <div key={r.id} className="card p-3 space-y-1.5">
                <div className="flex items-center gap-3">
                  <span className="chip chip--accent text-[10px] uppercase">{t(`alerts.triggers.${r.trigger_type}`, { defaultValue: r.trigger_type })}</span>
                  <span className="flex-1 text-[13px] text-[var(--fg-2)] truncate">{r.entity?.display_symbol || r.entity?.canonical_ref_key}</span>
                  {r.quality_score != null && (
                    <span className={`chip text-[10px] ${r.noisy ? 'chip--err' : r.quality_score >= 70 ? 'chip--ok' : ''}`} title={t('alerts.quality_tip', { defaultValue: 'Deterministic quality score: fewer repeats + opened alerts score higher.' })}>
                      {r.noisy ? t('alerts.noisy', { defaultValue: 'Noisy' }) : `Q ${Math.round(r.quality_score)}`}
                    </span>
                  )}
                  <select className="select text-[11px] py-0.5" value={r.cooldown_minutes ?? 720} title={t('alerts.cooldown', { defaultValue: 'Cooldown between fires' })}
                    onChange={(e) => updateAlertRule(supabase, r.id, { cooldown_minutes: Number(e.target.value) }).then(load).catch(() => {})}>
                    <option value={360}>6h</option><option value={720}>12h</option><option value={1440}>24h</option><option value={2880}>48h</option>
                  </select>
                  <span className="text-[11px] text-[var(--fg-4)]">{r.config?.threshold_pct != null ? `${r.config.threshold_pct}%` : ''}</span>
                  <button onClick={() => deleteAlertRule(supabase, r.id).then(load)} className="p-1.5 rounded-lg text-[var(--fg-4)] hover:text-red-400"><Trash2 className="h-4 w-4" /></button>
                </div>
                {r.noisy && r.suggested_config?.threshold_pct != null && (
                  <div className="flex items-center gap-2 text-[12px] text-[var(--fg-3)]">
                    <span>{t('alerts.suggest', { defaultValue: 'Suggested threshold' })}: <b>{r.suggested_config.threshold_pct}%</b> — {r.suggested_config.reason}</span>
                    <button className="btn btn--quiet btn--sm" onClick={() => updateAlertRule(supabase, r.id, { config: { ...(r.config || {}), threshold_pct: r.suggested_config.threshold_pct }, noisy: false, suggested_config: {} }).then(load).catch(() => {})}>
                      {t('alerts.apply', { defaultValue: 'Apply suggestion' })}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {events.length > 0 && (
            <div className="space-y-2">
              <div className="eyebrow">{t('alerts.recent', { defaultValue: 'Recent alerts' })}</div>
              {(() => {
                // Collapse same-group events into one digest card (related alerts
                // that fired in the same evaluation run).
                const seenGroups = new Set()
                return events.map((ev) => {
                  const groupMates = ev.group_id ? events.filter((e) => e.group_id === ev.group_id) : [ev]
                  if (ev.group_id) { if (seenGroups.has(ev.group_id)) return null; seenGroups.add(ev.group_id) }
                  const isDigest = groupMates.length > 1
                  return (
                    <div key={ev.id} className="card p-3 space-y-2">
                      {isDigest && <div className="chip chip--info text-[10px]">{t('alerts.digest', { defaultValue: '{{n}} related alerts fired together', n: groupMates.length })}</div>}
                      {groupMates.map((g) => (
                        <div key={g.id} className="space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <div className="text-[11px] text-[var(--fg-4)]">{new Date(g.fired_at).toLocaleString()}</div>
                              <div className="text-[13px] text-[var(--fg-2)]">
                                {g.payload?.symbol ? <span className="font-medium">{g.payload.symbol} </span> : null}
                                {t(`alerts.triggers.${g.payload?.trigger_type}`, { defaultValue: g.payload?.trigger_type || 'alert' })}
                                {g.payload?.value != null ? ` — ${Number(g.payload.value).toFixed(1)}% (≥ ${g.payload.threshold_pct}%)` : ''}
                                {g.payload?.signal_direction ? <span className={`chip text-[9px] ml-1.5 ${g.payload.signal_direction === 'bullish' ? 'chip--ok' : g.payload.signal_direction === 'bearish' ? 'chip--err' : 'chip--info'}`}>{g.payload.signal_direction}</span> : null}
                              </div>
                            </div>
                            <button onClick={() => { setWhyId(g.id); why.generate({ artifactType: 'alert_explanation', extra: { alert: g.payload, title: 'Alert' } }) }} disabled={why.loading && whyId === g.id} className="btn btn--quiet btn--sm">
                              {why.loading && whyId === g.id ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : t('alerts.why', { defaultValue: 'Why it matters' })}
                            </button>
                          </div>
                          {/* Deterministic why-now + confirm/weaken from the linked stored signal — no AI */}
                          {g.payload?.why_now && <p className="text-[12px] text-[var(--fg-2)] leading-snug"><span className="text-[var(--fg-5)]">{t('alerts.why_now', { defaultValue: 'Why this fired now' })}: </span>{g.payload.why_now}</p>}
                          {g.payload?.confirm_or_weaken && <p className="text-[12px] text-[var(--fg-3)] leading-snug"><span className="text-[var(--fg-5)]">{t('alerts.confirm_weaken', { defaultValue: 'What would confirm or weaken this' })}: </span>{g.payload.confirm_or_weaken}</p>}
                          {whyId === g.id && why.result && <ArtifactView result={why.result} loading={why.loading} onRefresh={() => why.refresh({ artifactType: 'alert_explanation', extra: { alert: g.payload, title: 'Alert' } })} />}
                        </div>
                      ))}
                    </div>
                  )
                })
              })()}
            </div>
          )}
        </>
      )}

      <IntelDisclaimer variant="block" />
    </div>
  )
}
