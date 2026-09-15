import React, { useEffect, useState, useCallback, useRef } from 'react'
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
import { appendHistoryPage } from '../lib/history-page'
import ChartAlertRow,{ChartAlertEvent} from '../components/ChartAlertRow'
import AlertDelivery from '../components/AlertDelivery'
import AlertRehearsal from '../components/AlertRehearsal'
import MarketAlertControls,{MarketAlertFields,MARKET_TRIGGERS,marketAlertConfig,marketAlertForm} from '../components/MarketAlertControls'
import AlertSourceReceipt,{alertValueLabel} from '../components/AlertSourceReceipt'
import AlertRuleHistory from '../components/AlertRuleHistory'
import {requestChartWorkspace} from '../lib/chart-workspace-api'

const TRIGGERS = ['price_move', 'liquidity_drop', 'volume_spike', 'wallet_activity', 'narrative_heat', 'holder_shift', 'unlock', 'supply_shock', 'metadata_migration', 'metadata_notice', 'liquidation_cascade', 'attention_entry']

// Triggers whose English name is not simply their key with the underscores
// taken out.
const TRIGGER_LABELS = { metadata_notice: 'Listing notice', liquidation_cascade: 'Liquidation cascade', attention_entry: 'Attention entry' }

// A listing notice is present or it is not, so its rule carries no reader
// threshold and no comparator choice: threshold_pct is fixed at 1, the
// evaluation is a level match at the daily metadata clock, and the rule
// re-arms after its cooldown. Built here — not in marketAlertConfig — because
// it is not a market trigger and must never pick up the market fields.
export const METADATA_NOTICE_CONFIG = { threshold_pct: 1, condition: 'legacy_level', repeat: 'rearm', direction: 'either' }

// CMC plan proposals 13 and 23. Both are capture-clock rules evaluated by
// intel-alerts-eval against a recorded series, so both fix the same three
// fields the listing notice fixes — a level match, re-arming after cooldown, no
// direction to choose — and let the reader set only what the rule actually
// compares. Neither is a market trigger, so neither may pick up the market
// fields (reset margin, sustain window).
const CAPTURE_RULE_FIXED = { condition: 'legacy_level', repeat: 'rearm', direction: 'either' }
export const CASCADE_WINDOWS = ['1h', '4h']
export const ATTENTION_LISTS = ['trending', 'most_visited', 'gainers', 'losers']
export const LIQUIDATION_CASCADE_DEFAULTS = { multiple: 3, window: '1h', ...CAPTURE_RULE_FIXED }
export const ATTENTION_ENTRY_DEFAULTS = { hours: 1, list: 'trending', ...CAPTURE_RULE_FIXED }

// The evaluator reads `threshold_pct` for every rule it stores, so the reader's
// multiple (and, for attention, the hour count) is written into BOTH fields from
// the one input. They can never drift apart, and no percentage is implied: the
// number is a ratio against this asset's own seven-day average for the window.
export function liquidationCascadeConfig(form) {
  const multiple = Number(form?.multiple)
  if (form?.multiple === '' || !Number.isFinite(multiple) || multiple < 1.5 || multiple > 20) {
    throw new Error('Choose a cascade multiple between 1.5 and 20 times the seven-day average for that window.')
  }
  const windowKey = String(form?.cascadeWindow || LIQUIDATION_CASCADE_DEFAULTS.window)
  if (!CASCADE_WINDOWS.includes(windowKey)) throw new Error('Choose the one-hour or the four-hour liquidation window.')
  return { threshold_pct: multiple, multiple, window: windowKey, ...CAPTURE_RULE_FIXED }
}

export function attentionEntryConfig(form) {
  const hours = Number(form?.attentionHours)
  if (form?.attentionHours === '' || !Number.isInteger(hours) || hours < 1 || hours > 24) {
    throw new Error('Choose a whole number of consecutive hourly captures from 1 to 24.')
  }
  const list = String(form?.attentionList || ATTENTION_ENTRY_DEFAULTS.list)
  if (!ATTENTION_LISTS.includes(list)) throw new Error('Choose one of the captured attention lists.')
  return { threshold_pct: hours, hours, list, ...CAPTURE_RULE_FIXED }
}

// P10 — Smart Alerts. Rules are created here; evaluation + the AI "why it
// matters" artifact run server-side (cron + intel-generate) in production.
export default function AlertsPage() {
  const {org}=useProfile(),{user}=useSupabase()
  return <ScopedAlertsPage key={`${org?.id}:${user?.id}`}/>
}
function ScopedAlertsPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const [rules, setRules] = useState([])
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({
    ...marketAlertForm(), chain: 'solana', value: '', trigger: 'price_move', threshold: '10', active:false,
    multiple: String(LIQUIDATION_CASCADE_DEFAULTS.multiple), cascadeWindow: LIQUIDATION_CASCADE_DEFAULTS.window,
    attentionHours: String(ATTENTION_ENTRY_DEFAULTS.hours), attentionList: ATTENTION_ENTRY_DEFAULTS.list,
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const why = useArtifact()
  const [whyId, setWhyId] = useState(null)
  const [cursors, setCursors] = useState({ rules: null, events: null })
  const [loadingMore, setLoadingMore] = useState(null)
  const scope = `${org?.id || ''}:${user?.id || ''}`
  const active = useRef(scope); active.current = scope
  const sequence = useRef(0)
  const createOperation=useRef(null)
  const [loadedScope, setLoadedScope] = useState(null)

  const load = useCallback(async () => {
    if (!org?.id || !user?.id) return
    const seq = ++sequence.current
    setLoading(true)
    setErr(null)
    try {
      const [r, e] = await Promise.all([listAlertRules(supabase, org.id, { paged: true }), listAlertEvents(supabase, org.id, { paged: true })])
      if (active.current !== scope || sequence.current !== seq) return
      setRules(r.rows); setEvents(e.rows); setCursors({ rules: r.nextCursor, events: e.nextCursor }); setLoadedScope(scope)
    } catch (ex) { if (active.current === scope && sequence.current === seq) setErr(ex.message) }
    finally { if (active.current === scope && sequence.current === seq) setLoading(false) }
  }, [org?.id, user?.id, supabase, scope])
  useEffect(() => { setRules([]); setEvents([]); setBusy(false); setCursors({ rules: null, events: null }); setWhyId(null); setLoadingMore(null); load(); return () => { sequence.current++ } }, [load])
  const loadMore = async kind => {
    if (!cursors[kind] || loadingMore) return
    const seq = sequence.current
    setLoadingMore(kind); setErr(null)
    try {
      const page = await (kind === 'rules' ? listAlertRules : listAlertEvents)(supabase, org.id, { cursor: cursors[kind], paged: true })
      if (active.current !== scope || sequence.current !== seq) return
      ;(kind === 'rules' ? setRules : setEvents)(previous => appendHistoryPage(previous, page.rows))
      setCursors(previous => ({ ...previous, [kind]: page.nextCursor }))
    } catch (e) { if (active.current === scope) setErr(e.message) }
    finally { if (active.current === scope) setLoadingMore(null) }
  }
  const mutate = async action => {
    setErr(null)
    try { await action(); if (active.current === scope) await load() }
    catch (e) { if (active.current === scope) setErr(e.message) }
  }
  useEffect(() => () => { if (org?.id) markSurfaceSeen(supabase, 'alerts', '', { orgId: org.id, userId: user?.id }) }, [org?.id, user?.id, supabase])

  const add = useCallback(async (e) => {
    e.preventDefault()
    if (!form.value.trim() || !org?.id) return
    setBusy(true); setErr(null)
    try {
      const threshold = Number(form.threshold)
      if (form.threshold==='' || !Number.isFinite(threshold) || threshold < 0) throw new Error('Enter a threshold of zero or greater')
      let entityId = null, config
      if (form.trigger === 'narrative_heat') {
        const { data: narrative, error } = await supabase.from('narrative_taxonomy').select('slug').eq('slug', form.value.trim().toLowerCase()).maybeSingle()
        if (error) throw error
        if (!narrative) throw new Error('Enter an existing narrative slug')
        config = { slug: narrative.slug, momentum_delta: threshold }
      } else {
        const ent = await resolveEntity(supabase, org.id, { kind: form.trigger === 'wallet_activity' ? 'wallet' : 'asset', chain: form.chain, value: form.value.trim() })
        entityId = ent.id
        config = form.trigger === 'liquidity_drop' ? { min_liquidity_usd: threshold } : form.trigger === 'wallet_activity' ? { min_usd: threshold } : form.trigger === 'unlock' ? {window_days:threshold} : form.trigger === 'metadata_migration' ? {} : form.trigger === 'metadata_notice' ? { ...METADATA_NOTICE_CONFIG } : form.trigger === 'liquidation_cascade' ? liquidationCascadeConfig(form) : form.trigger === 'attention_entry' ? attentionEntryConfig(form) : { threshold_pct: threshold }
      }
      config={...config,title:form.title,note:form.note,visibility:'private',...(MARKET_TRIGGERS.includes(form.trigger)?marketAlertConfig(form):{})}
      if(form.trigger==='unlock'&&threshold>90)throw Error('Choose an unlock window from zero to 90 days.')
      if (active.current !== scope) return
      const body={operation:'alert_general_save',entityId,trigger:form.trigger,config,active:form.active,revision:0,cooldownMinutes:720},signature=JSON.stringify([scope,body])
      if(createOperation.current?.signature!==signature)createOperation.current={signature,id:crypto.randomUUID()}
      const {rule}=await requestChartWorkspace({supabase,orgId:org.id,userId:user.id},{...body,operationId:createOperation.current.id})
      // Tutorial receipt: every create is a fresh row, so its id + created_at
      // uniquely identify this run's operation.
      emitTutorialSignal('alerts.rule-created', rule ? { rule_id: rule.id } : {})
      if (active.current === scope) { createOperation.current=null;setForm((f) => ({ ...f, value: '' })); await load() }
    } catch (ex) {
      // Raw message — IntelErrorNotice maps intel_limit_reached:* to friendly
      // copy + the /intel/upgrade link.
      if (active.current === scope) setErr(ex.message || '')
    } finally { if (active.current === scope) setBusy(false) }
  }, [form, org?.id, supabase, user?.id, load, scope])

  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow flex items-center gap-1.5"><Bell className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
        <h1 className="page-title">{t('nav.alerts', { defaultValue: 'Alerts' })}</h1>
        <p className="page-sub">{t('pages.alerts_sub', { defaultValue: 'Conditions, source evidence, and a record of what happened.' })}</p>
      </div>

      <form onSubmit={add} className="intel-alert-create-form flex flex-wrap items-end gap-3">
        <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('watchlist.chain', { defaultValue: 'Chain' })}</span>
          <select className="select" value={form.chain} onChange={(e) => setForm((f) => ({ ...f, chain: e.target.value }))}>{CHAINS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
        </label>
        <label className="block flex-1 min-w-[160px]"><span className="text-[11px] text-[var(--fg-4)]">{t('watchlist.value', { defaultValue: 'Identifier' })}</span>
          <input className="input w-full" data-tutorial="intel-alerts.identifier-input" placeholder={form.trigger === 'narrative_heat' ? 'Narrative slug' : form.trigger === 'wallet_activity' ? 'Wallet address' : t('watchlist.ph.token', { defaultValue: 'Token mint / contract' })} value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} />
        </label>
        <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('alerts.trigger', { defaultValue: 'Trigger' })}</span>
          <select className="select" data-tutorial="intel-alerts.trigger-select" value={form.trigger} onChange={(e) => setForm((f) => ({ ...f, trigger: e.target.value }))}>{TRIGGERS.map((tr) => <option key={tr} value={tr}>{t(`alerts.triggers.${tr}`, { defaultValue: TRIGGER_LABELS[tr] || tr.replace(/_/g, ' ') })}</option>)}</select>
        </label>
        <label className="block w-28"><span className="text-[11px] text-[var(--fg-4)]">{form.trigger === 'liquidity_drop' ? 'Liquidity below $' : form.trigger === 'wallet_activity' ? 'Transfer above $' : form.trigger === 'narrative_heat' ? 'Momentum points' : form.trigger==='unlock' ? 'Days ahead' : form.trigger==='metadata_migration' ? 'All material changes' : form.trigger==='metadata_notice' ? t('alerts.notice_threshold_label', { defaultValue: 'Any notice present' }) : form.trigger==='liquidation_cascade' ? t('alerts.cascade_threshold_label', { defaultValue: 'Set by the multiple' }) : form.trigger==='attention_entry' ? t('alerts.attention_threshold_label', { defaultValue: 'Set by the hours' }) : '%'}</span>
          <input className="input w-full" type="number" min="0" step="any" required disabled={form.trigger==='metadata_migration'||form.trigger==='metadata_notice'||form.trigger==='liquidation_cascade'||form.trigger==='attention_entry'} value={form.threshold} onChange={(e) => setForm((f) => ({ ...f, threshold: e.target.value }))} />
        </label>
        {form.trigger==='liquidation_cascade'&&<>
          <label className="block w-32"><span className="text-[11px] text-[var(--fg-4)]">{t('alerts.cascade_multiple_label', { defaultValue: 'Times the 7-day average' })}</span>
            <input className="input w-full" data-testid="cascade-multiple" type="number" min="1.5" max="20" step="0.5" required value={form.multiple} onChange={(e) => setForm((f) => ({ ...f, multiple: e.target.value }))} />
          </label>
          <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('alerts.cascade_window_label', { defaultValue: 'Liquidation window' })}</span>
            <select className="select" data-testid="cascade-window" value={form.cascadeWindow} onChange={(e) => setForm((f) => ({ ...f, cascadeWindow: e.target.value }))}>
              <option value="1h">{t('alerts.cascade_window_1h', { defaultValue: 'Rolling 1 hour' })}</option>
              <option value="4h">{t('alerts.cascade_window_4h', { defaultValue: 'Rolling 4 hours' })}</option>
            </select>
          </label>
        </>}
        {form.trigger==='attention_entry'&&<>
          <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('alerts.attention_list_label', { defaultValue: 'Attention list' })}</span>
            <select className="select" data-testid="attention-list" value={form.attentionList} onChange={(e) => setForm((f) => ({ ...f, attentionList: e.target.value }))}>
              <option value="trending">{t('alerts.attention_list_trending', { defaultValue: 'Trending' })}</option>
              <option value="most_visited">{t('alerts.attention_list_most_visited', { defaultValue: 'Most visited' })}</option>
              <option value="gainers">{t('alerts.attention_list_gainers', { defaultValue: 'Top gainers' })}</option>
              <option value="losers">{t('alerts.attention_list_losers', { defaultValue: 'Top losers' })}</option>
            </select>
          </label>
          <label className="block w-32"><span className="text-[11px] text-[var(--fg-4)]">{t('alerts.attention_hours_label', { defaultValue: 'Consecutive hours' })}</span>
            <input className="input w-full" data-testid="attention-hours" type="number" min="1" max="24" step="1" required value={form.attentionHours} onChange={(e) => setForm((f) => ({ ...f, attentionHours: e.target.value }))} />
          </label>
        </>}
        {form.trigger==='metadata_notice'&&<p className="intel-analysis-caption w-full" data-testid="metadata-notice-explanation">{t('alerts.notice_explanation', { defaultValue: 'Fires when a CoinMarketCap listing notice is present for this asset. It is evaluated at the daily metadata clock, not on your schedule, and the wording of the notice is not interpreted: the rule reports only that a notice exists, so read the notice itself before acting. There is no threshold and no direction to choose — the rule re-arms after its cooldown.' })}</p>}
        {form.trigger==='liquidation_cascade'&&<p className="intel-analysis-caption w-full" data-testid="liquidation-cascade-explanation">{t('alerts.cascade_explanation', { defaultValue: 'Fires when the newest five-minute liquidation capture for this asset reports a total for the chosen window at or above your multiple of the same window’s seven-day average. The comparison is a ratio against this asset’s OWN recent average, not a percentage of anything and not a measure of positions at risk: the figures are provider-reported aggregates across the venues it covers, so a provider that adds or drops a venue moves the ratio on its own. There is no direction to choose — the rule matches a level at the capture clock and re-arms after its cooldown.' })}</p>}
        {form.trigger==='attention_entry'&&<p className="intel-analysis-caption w-full" data-testid="attention-entry-explanation">{t('alerts.attention_explanation', { defaultValue: 'Fires when this asset has been in the chosen attention list for that many consecutive hourly captures. It reads the provider’s own published list, so it says where readers are being pointed and nothing else: attention is not a valuation, not a flow, and not a forecast, and an asset can leave the list between captures without the rule ever seeing it. There is no direction to choose — the rule matches a level at the hourly capture clock and re-arms after its cooldown.' })}</p>}
        <details className="w-full"><summary>Condition, original note and activation</summary>
          <label>Alert name<input maxLength={120} value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))}/></label>
          {MARKET_TRIGGERS.includes(form.trigger)&&<MarketAlertFields form={form} setForm={setForm} trigger={form.trigger} disabled={busy}/>}
          <label>Your note<textarea maxLength={2000} rows={2} value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))}/></label>
          <label className="intel-workstation-check"><input type="checkbox" checked={form.active} onChange={e=>setForm(f=>({...f,active:e.target.checked}))}/>Activate in-app</label>
          <p className="intel-analysis-caption">Saved privately as a draft unless activated. External delivery requires separate channel consent. Holder-shift monitoring needs comparable population IDs and original source clocks, which the current source does not provide.</p>
        </details>
        <button type="submit" disabled={busy || !form.value.trim()} data-tutorial="intel-alerts.add-button" className="btn btn--primary disabled:opacity-50"><Plus className="h-4 w-4" /> {form.active?'Save active rule':'Save draft rule'}</button>
      </form>

      <IntelErrorNotice error={err} />
      {err && <button className="btn btn--quiet btn--sm" onClick={load}>Retry loading alerts</button>}
      {why.error && <IntelErrorNotice error={why.error} />}

      <div className="intel-open-section p-3 flex items-start gap-2 text-[12px] text-[var(--fg-4)]">
        <Info className="h-3.5 w-3.5 mt-0.5" /> Rules use shared retained data on a 15-minute schedule. Explanations are generated only when you request them. Source time, evaluation time and delivery status are recorded separately.
      </div>

      <details><summary>Signals affecting your watchlist & holdings</summary><RelevantSignals title={t('alerts.relevant_signals', { defaultValue: 'Signals affecting your watchlist & holdings' })} seeAllHref="/intel" /></details>

      {loading ? (
        <div className="intel-open-section p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
      ) : loadedScope !== scope ? null : (
        <>
          <div className="space-y-2">
            <div className="eyebrow">{t('alerts.rules', { defaultValue: 'Rules' })}</div>
            {rules.length === 0 ? <p className="text-[13px] text-[var(--fg-3)]">{t('alerts.no_rules', { defaultValue: 'No alert rules yet.' })}</p> : rules.map((r) => r.trigger_type==='chart_price'?<ChartAlertRow key={`${scope}:${r.id}:${r.chart_revision}`} rule={r} context={{supabase,userId:user?.id,orgId:org?.id,asset:r.config.asset}} onChanged={load} onDelete={()=>mutate(()=>deleteAlertRule(supabase,r.id))}/>: (
              <div key={`${scope}:${r.id}:${r.chart_revision}`} className="intel-chart-alert-row space-y-1.5">
                <div className="intel-alert-rule-heading">
                  <span className="text-[10px] uppercase">{t(`alerts.triggers.${r.trigger_type}`, { defaultValue: r.trigger_type==='thesis_condition'?'Thesis condition':r.trigger_type.replaceAll('_',' ') })}</span>
                  <span className="intel-alert-rule-title text-[13px] text-[var(--fg-2)]">{r.config?.title || r.entity?.display_symbol || r.entity?.canonical_ref_key || r.config?.slug || r.config?.asset}</span>
                  {r.quality_score != null && (
                    <span className={`text-[10px] ${r.noisy ? 'text-red-600' : r.quality_score >= 70 ? 'text-green-600' : ''}`} title={t('alerts.quality_tip', { defaultValue: 'Deterministic quality score: fewer repeats + opened alerts score higher.' })}>
                      {r.noisy ? t('alerts.noisy', { defaultValue: 'Noisy' }) : `Q ${Math.round(r.quality_score)}`}
                    </span>
                  )}
                  <select className="select text-[11px] py-0.5" value={r.cooldown_minutes ?? 720} title={t('alerts.cooldown', { defaultValue: 'Cooldown between fires' })}
                    onChange={(e) => mutate(() => updateAlertRule(supabase, r.id, { cooldown_minutes: Number(e.target.value) },r.chart_revision))}>
                    <option value={15}>15m</option><option value={60}>1h</option><option value={360}>6h</option><option value={720}>12h</option><option value={1440}>24h</option><option value={2880}>48h</option>
                  </select>
                  <span className="text-[11px] text-[var(--fg-4)]">{r.config?.min_liquidity_usd != null ? `Below $${r.config.min_liquidity_usd}` : r.config?.min_usd != null ? `Above $${r.config.min_usd}` : r.config?.threshold_pct != null ? `${r.config.threshold_pct}%` : r.config?.momentum_delta != null ? `${r.config.momentum_delta} points` : ''}</span>
                  <button aria-label="Delete alert rule" onClick={() => mutate(() => deleteAlertRule(supabase, r.id))} className="p-1.5 rounded-lg text-[var(--fg-4)] hover:text-red-400"><Trash2 className="h-4 w-4" /></button>
                </div>
                <p className="intel-analysis-caption">{r.is_active?'Active':'Paused'} · revision {r.chart_revision??1} · {r.evaluation_state?.status?.replaceAll('_',' ')||'Not evaluated yet'}{r.evaluation_state?.checkedAt?` · ${new Date(r.evaluation_state.checkedAt).toLocaleString()}`:''}</p>
                {r.evaluation_state?.reason&&<p role={r.evaluation_state.status==='evaluation_failed'?'alert':undefined}>{r.evaluation_state.reason}</p>}
                {r.trigger_type==='thesis_condition'&&<p>{r.config?.condition?.metric} {r.config?.condition?.comparator} {r.config?.condition?.threshold??'—'} {r.config?.condition?.threshold_unit} · {r.config?.condition?.time_window} · One-time thesis review condition</p>}
                {r.trigger_type!=='thesis_condition'&&<MarketAlertControls rule={r} context={{supabase,userId:user?.id,orgId:org?.id}} onChanged={load}/>}
                <details><summary>History preview and delivery</summary>{r.trigger_type!=='thesis_condition'&&<><AlertRehearsal rule={r} context={{supabase,userId:user?.id,orgId:org?.id}} operation="alert_market_rehearsal"/><AlertRuleHistory ruleId={r.id} context={{supabase,userId:user?.id,orgId:org?.id}}/></>}
                {r.evaluation_state?.observation&&r.trigger_type!=='thesis_condition'&&<AlertSourceReceipt payload={{checkpoint:r.evaluation_state,config:r.config}}/>}
                <AlertDelivery ruleId={r.id} context={{supabase,userId:user?.id,orgId:org?.id}}/></details>
                {r.noisy && r.suggested_config?.threshold_pct != null && (
                  <div className="flex items-center gap-2 text-[12px] text-[var(--fg-3)]">
                    <span>{t('alerts.suggest', { defaultValue: 'Suggested threshold' })}: <b>{r.suggested_config.threshold_pct}%</b> — {r.suggested_config.reason}</span>
                    <button className="btn btn--quiet btn--sm" onClick={() => mutate(() => updateAlertRule(supabase, r.id, { config: { ...(r.config || {}), threshold_pct: r.suggested_config.threshold_pct }, noisy: false, suggested_config: {} }))}>
                      {t('alerts.apply', { defaultValue: 'Apply suggestion' })}
                    </button>
                  </div>
                )}
              </div>
            ))}
            {cursors.rules && <button className="btn btn--quiet" disabled={!!loadingMore} onClick={() => loadMore('rules')}>{loadingMore === 'rules' ? 'Loading…' : 'Load more rules'}</button>}
          </div>
          {events.length > 0 && (
            <div className="space-y-2">
              <div className="eyebrow">{t('alerts.recent', { defaultValue: 'Recent alerts' })}</div>
              {(() => {
                // Collapse same-group events into one digest card (related alerts
                // that fired in the same evaluation run).
                const seenGroups = new Set(), groups = new Map()
                for (const event of events) { const key = event.group_id || event.id; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(event) }
                return events.map((ev) => {
                  if(ev.payload?.trigger_type==='chart_price')return <ChartAlertEvent key={scope+':'+ev.id} event={ev} context={{supabase,userId:user?.id,orgId:org?.id}} onRead={result=>{if(active.current===scope)setEvents(previous=>previous.map(row=>row.id===result.id?{...row,read_at:result.readAt}:row))}}/>
                  const groupMates = groups.get(ev.group_id || ev.id)
                  if (ev.group_id) { if (seenGroups.has(ev.group_id)) return null; seenGroups.add(ev.group_id) }
                  const isDigest = groupMates.length > 1
                  return (
                    <div key={ev.id} className="intel-open-section p-3 space-y-2">
                      {isDigest && <div className=" text-[10px]">{t('alerts.digest', { defaultValue: '{{n}} related alerts fired together', n: groupMates.length })}</div>}
                      {groupMates.map((g) => (
                        <div key={g.id} className="space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <div className="text-[11px] text-[var(--fg-4)]">{new Date(g.fired_at).toLocaleString()}</div>
                              <div className="text-[13px] text-[var(--fg-2)]">
                                {g.payload?.symbol ? <span className="font-medium">{g.payload.symbol} </span> : null}
                                {t(`alerts.triggers.${g.payload?.trigger_type}`, { defaultValue: g.payload?.trigger_type==='thesis_condition'?'Thesis condition':g.payload?.trigger_type?.replaceAll('_',' ') || 'alert' })}
                                {g.payload?.value != null ? ` — ${alertValueLabel(g.payload)}` : ''}
                                {g.payload?.signal_direction ? <span className={`text-[9px] ml-1.5 ${g.payload.signal_direction === 'bullish' ? 'text-green-600' : g.payload.signal_direction === 'bearish' ? 'text-red-600' : ''}`}>{g.payload.signal_direction}</span> : null}
                              </div>
                            </div>
                            <button onClick={() => { setWhyId(g.id); why.setResult(null); why.generate({ artifactType: 'alert_explanation', alertEventId:g.id }) }} disabled={why.loading} className="btn btn--quiet btn--sm">
                              {why.loading && whyId === g.id ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : t('alerts.why', { defaultValue: 'Why it matters' })}
                            </button>
                          </div>
                          {g.payload?.trigger_type!=='thesis_condition'&&<AlertSourceReceipt payload={g.payload}/>}
                          {/* Deterministic why-now + confirm/weaken from the linked stored signal — no AI */}
                          {g.payload?.why_now && <p className="text-[12px] text-[var(--fg-2)] leading-snug"><span className="text-[var(--fg-5)]">{t('alerts.why_now', { defaultValue: 'Why this fired now' })}: </span>{g.payload.why_now}</p>}
                          {g.payload?.trigger_type==='thesis_condition'&&<details><summary>Original thesis condition and evidence</summary><blockquote className="whitespace-pre-wrap">{g.payload.checkpoint?.condition?.description}</blockquote><p>{g.payload.checkpoint?.condition?.metric} {g.payload.checkpoint?.condition?.comparator} {g.payload.checkpoint?.condition?.threshold??'—'} {g.payload.checkpoint?.condition?.threshold_unit} · {g.payload.checkpoint?.condition?.time_window}</p><p className="break-all">Evidence version {g.payload.checkpoint?.evidence_version}</p><p>Source observed {g.payload.checkpoint?.observation?.observedAt} · Known {g.payload.checkpoint?.observation?.recordedAt}</p><p className="break-all">{g.payload.checkpoint?.observation?.sourceRef}</p>{/^(venue|depth|liquidation):/.test(g.payload.checkpoint?.condition?.source_metric||'')&&<p className="break-all">Matched source: {g.payload.checkpoint?.observation?.sourceMetric||'Not recorded in this receipt'}</p>}<a className="intel-text-link" href={`/intel/theses/${g.payload.thesis_id}?tab=alerts`}>Review thesis condition</a></details>}
                          {g.payload?.confirm_or_weaken && <p className="text-[12px] text-[var(--fg-3)] leading-snug"><span className="text-[var(--fg-5)]">{t('alerts.confirm_weaken', { defaultValue: 'What would confirm or weaken this' })}: </span>{g.payload.confirm_or_weaken}</p>}
                          {whyId===g.id&&why.error&&<p role="alert">{why.error}</p>}
                          {whyId === g.id && (why.result||why.loading) && <ArtifactView result={why.result} loading={why.loading} onRefresh={() => why.refresh({ artifactType: 'alert_explanation', alertEventId:g.id })} />}
                        </div>
                      ))}
                    </div>
                  )
                })
              })()}
              {cursors.events && <button className="btn btn--quiet" disabled={!!loadingMore} onClick={() => loadMore('events')}>{loadingMore === 'events' ? 'Loading…' : 'Load older alerts'}</button>}
            </div>
          )}
        </>
      )}

      <IntelDisclaimer variant="block" />
    </div>
  )
}
