import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Sparkles, ArrowRight, ArrowLeft, Check, Wand2 } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { resolveEntity } from '../lib/watchlist-api'
import { CHAINS } from '../lib/chains'
import {
  getAssetContextPack, getThesisDraft, getThesisCritique, getThesisQuality, createThesis,
} from '../lib/thesis-api'
import AssetContextPack, { cardKey } from '../components/thesis/AssetContextPack'
import ScenarioBuilder from '../components/thesis/ScenarioBuilder'
import ThesisQualityScore from '../components/thesis/ThesisQualityScore'
import IntelErrorNotice from '../components/IntelErrorNotice'

const THESIS_TYPES = ['asset', 'chain', 'protocol', 'narrative', 'portfolio_holding', 'trade', 'bear_case', 'watchlist']
const STANCES = ['bullish', 'bearish', 'neutral', 'market_neutral']
const HORIZONS = ['intraday', 'swing', 'weeks', 'months', 'cycle', 'long_term']
const CADENCES = ['daily', 'weekly', 'biweekly', 'monthly', 'on_event']
const STEPS = ['Basics', 'Evidence', 'Draft', 'Scenarios', 'Rules', 'Review & save']

const cadenceDays = { daily: 1, weekly: 7, biweekly: 14, monthly: 30, on_event: 7 }
const defaultBenchmark = (sym) => String(sym || '').toUpperCase() === 'BTC' ? 'ETH' : 'BTC'
const metricForCard = (c) => c.event_type === 'unlock' ? 'unlock'
  : c.section === 'usage_fundamentals' ? 'usage_metric'
  : c.section === 'price_liquidity' ? 'price_move'
  : c.section === 'competitors' ? 'narrative_heat' : 'manual'

export default function ThesisBuilderPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const navigate = useNavigate()
  const { state } = useLocation()
  const prefill = state?.prefill || {}
  const idemKey = useRef(`tj_${Date.now()}_${Math.round(Math.random() * 1e9).toString(36)}`)

  const [step, setStep] = useState(0)
  const [basics, setBasics] = useState({
    thesis_type: prefill.thesisType || 'asset', title: '', chain: prefill.chain || 'solana', identifier: prefill.value || '',
    stance: prefill.stance || 'bullish', time_horizon: 'months', review_cadence: 'weekly', benchmark: '', conviction: 3,
  })
  const [entity, setEntity] = useState(null)
  const [pack, setPack] = useState({ cards: [], coverage: null, loading: false, err: null })
  const [selections, setSelections] = useState({})
  const [draft, setDraft] = useState({ statement: '', why_now: '', whats_missing: '', supports: '', weakens: '', proves_wrong: '', opposing: '' })
  const [scenarios, setScenarios] = useState({ bull: {}, base: {}, bear: {} })
  const [rules, setRules] = useState([])
  const [ai, setAi] = useState({ loading: false, draft: null, critique: null, err: null })
  const [quality, setQuality] = useState({ score: 0, missing: [], loading: false })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  const setB = (p) => setBasics((b) => ({ ...b, ...p }))
  const symbol = entity?.display_symbol || null

  // Resolve asset + load context pack
  const resolveAsset = useCallback(async () => {
    if (!org?.id || !basics.identifier.trim()) return
    setPack((p) => ({ ...p, loading: true, err: null }))
    try {
      const ent = await resolveEntity(supabase, org.id, { kind: 'asset', chain: basics.chain, value: basics.identifier.trim() })
      setEntity(ent)
      if (!basics.benchmark) setB({ benchmark: defaultBenchmark(ent?.display_symbol) })
      if (!basics.title) setB({ title: `${ent?.display_symbol || basics.identifier} thesis` })
      const res = await getAssetContextPack(supabase, org.id, {
        symbol: ent?.display_symbol, chain: basics.chain, canonicalKey: ent?.canonical_ref_key,
        tokenAddress: /^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(basics.identifier.trim()) ? basics.identifier.trim() : null,
      })
      setPack({ cards: res?.cards || [], coverage: res?.coverage || null, loading: false, err: res?.error || null })
    } catch (e) {
      setPack({ cards: [], coverage: null, loading: false, err: e.message })
    }
  }, [org?.id, supabase, basics.chain, basics.identifier]) // eslint-disable-line

  const selectedCards = useMemo(() => pack.cards.filter((c) => {
    const s = selections[cardKey(c)]; return s && (s.label || s.confirmation || s.invalidation || s.track)
  }), [pack.cards, selections])

  // Build the payload (also used for the quality preview)
  const buildPayload = useCallback(() => {
    const watched = new Set()
    const evidence = []
    const evRules = []
    for (const c of pack.cards) {
      const s = selections[cardKey(c)]
      if (!s) continue
      if (s.label) evidence.push({ source_table: c.source_table, source_ref: c.source_ref, event_type: c.event_type, event_at: c.date, event_snapshot: c, user_label: s.label, impact: c.suggested_thesis_impact, impact_source: 'user' })
      if (s.track && c.watch_metric) watched.add(c.watch_metric)
      if (s.confirmation) evRules.push({ rule_kind: 'confirmation', description: c.title, metric: metricForCard(c), source_metric: c.watch_metric || null, origin: 'user' })
      if (s.invalidation) evRules.push({ rule_kind: 'invalidation', description: c.title, metric: metricForCard(c), source_metric: c.watch_metric || null, origin: 'user' })
    }
    const allRules = [...rules, ...evRules]
    const scen = ['bull', 'base', 'bear'].map((kind, i) => {
      const s = scenarios[kind] || {}
      return { kind, narrative: s.narrative || null, probability: s.probabilityPct != null ? s.probabilityPct / 100 : null, price_target: s.price_target ?? null, target_basis: 'price', assumptions: s.assumptions || [], risks: s.risks || [], trigger_text: s.trigger_text || null, ordinal: i }
    }).filter((s) => s.narrative || s.price_target || (s.assumptions || []).length)
    const keyRisks = [...new Set(['bull', 'base', 'bear'].flatMap((k) => scenarios[k]?.risks || []))]
    return {
      idempotency_key: idemKey.current,
      thesis_type: basics.thesis_type,
      title: basics.title || `${symbol || 'Asset'} thesis`,
      stance: basics.stance,
      conviction: Math.max(0, Math.min(1, (Number(basics.conviction) || 3) / 5)),
      time_horizon: basics.time_horizon,
      review_cadence: basics.review_cadence,
      benchmark_key: `symbol:${(basics.benchmark || defaultBenchmark(symbol)).toUpperCase()}`,
      entity_id: entity?.id || null,
      subject_kind: basics.thesis_type === 'narrative' ? 'narrative' : 'token',
      subject_canonical_key: entity?.canonical_ref_key || null,
      visibility: 'private',
      status: 'active',
      next_review_at: new Date(Date.now() + (cadenceDays[basics.review_cadence] || 7) * 86400000).toISOString(),
      ai_summary: draft.statement || null,
      bull_thesis: scenarios.bull?.narrative || draft.statement || null,
      neutral_thesis: scenarios.base?.narrative || null,
      bear_thesis: scenarios.bear?.narrative || null,
      what_would_confirm: allRules.filter((r) => r.rule_kind === 'confirmation').map((r) => r.description).join('; ') || null,
      what_would_invalidate: allRules.filter((r) => r.rule_kind === 'invalidation').map((r) => r.description).join('; ') || null,
      watched_metrics: [...watched],
      key_risks: keyRisks,
      scenarios: scen,
      rules: allRules,
      evidence,
      symbol, chain: basics.chain,
    }
  }, [pack.cards, selections, rules, scenarios, basics, entity, symbol, draft.statement])

  // Recompute quality on step changes (server-side engine; no logic drift)
  const recheckQuality = useCallback(async () => {
    if (!org?.id) return
    setQuality((q) => ({ ...q, loading: true }))
    try {
      const p = buildPayload()
      const q = await getThesisQuality(supabase, org.id, { ...p, statement: draft.statement })
      setQuality({ ...q, loading: false })
    } catch { setQuality((q) => ({ ...q, loading: false })) }
  }, [org?.id, supabase, buildPayload, draft.statement])

  useEffect(() => { if (entity && step >= 2) recheckQuality() }, [step, entity]) // eslint-disable-line

  const runAiDraft = useCallback(async () => {
    if (!org?.id) return
    setAi((a) => ({ ...a, loading: true, err: null }))
    try {
      const res = await getThesisDraft(supabase, org.id, {
        basics: { symbol, chain: basics.chain, canonicalKey: entity?.canonical_ref_key, stance: basics.stance, time_horizon: basics.time_horizon, notes: draft.statement },
        cards: selectedCards.length ? selectedCards : pack.cards.slice(0, 10),
      })
      setAi((a) => ({ ...a, loading: false, draft: res?.draft || null, err: res?.error || null }))
    } catch (e) { setAi((a) => ({ ...a, loading: false, err: e.message })) }
  }, [org?.id, supabase, symbol, basics, entity, draft.statement, selectedCards, pack.cards])

  const applyAiDraft = useCallback(() => {
    const d = ai.draft; if (!d) return
    setDraft((prev) => ({ ...prev, statement: d.statement || prev.statement, why_now: d.why_now || prev.why_now, whats_missing: d.whats_missing || prev.whats_missing }))
    setScenarios((prev) => ({
      bull: { ...prev.bull, narrative: d.bull?.narrative || prev.bull.narrative, price_target: d.bull?.price_target ?? prev.bull.price_target, assumptions: d.bull?.assumptions || prev.bull.assumptions, risks: d.bull?.risks || prev.bull.risks },
      base: { ...prev.base, narrative: d.base?.narrative || prev.base.narrative, assumptions: d.base?.assumptions || prev.base.assumptions, risks: d.base?.risks || prev.base.risks },
      bear: { ...prev.bear, narrative: d.bear?.narrative || prev.bear.narrative, assumptions: d.bear?.assumptions || prev.bear.assumptions, risks: d.bear?.risks || prev.bear.risks },
    }))
    const aiRules = [...(d.confirmation_rules || []).map((r) => ({ ...r, rule_kind: 'confirmation', origin: 'ai_coach' })), ...(d.invalidation_rules || []).map((r) => ({ ...r, rule_kind: 'invalidation', origin: 'ai_coach' }))]
    if (aiRules.length) setRules((prev) => [...prev, ...aiRules])
  }, [ai.draft])

  const runCritique = useCallback(async () => {
    if (!org?.id) return
    setAi((a) => ({ ...a, loading: true, err: null }))
    try {
      const res = await getThesisCritique(supabase, org.id, { basics: { symbol, stance: basics.stance }, cards: selectedCards, draft: { ...draft, scenarios, rules } })
      setAi((a) => ({ ...a, loading: false, critique: res?.critique || null }))
    } catch (e) { setAi((a) => ({ ...a, loading: false, err: e.message })) }
  }, [org?.id, supabase, symbol, basics.stance, selectedCards, draft, scenarios, rules])

  const save = useCallback(async () => {
    if (!org?.id) return
    setSaving(true); setErr(null)
    try {
      const res = await createThesis(supabase, org.id, buildPayload())
      if (res?.thesis_id) navigate(`/intel/theses/${res.thesis_id}`)
      else setErr('Could not create thesis')
    } catch (e) { setErr(e.message) } finally { setSaving(false) }
  }, [org?.id, supabase, buildPayload, navigate])

  const canNext = step === 0 ? !!entity : true
  const onSelect = (c, sel) => setSelections((m) => ({ ...m, [cardKey(c)]: sel }))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" /> {t('journal.brand', { defaultValue: 'Thesis Journal' })}</div>
          <h1 className="page-title">{t('journal.new_thesis', { defaultValue: 'New thesis' })}</h1>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {STEPS.map((s, i) => (
            <button key={s} onClick={() => entity || i === 0 ? setStep(i) : null}
              className={`chip text-[11px] ${i === step ? 'bg-[var(--accent)] text-black' : i < step ? 'chip--ok' : 'text-[var(--fg-4)]'}`}>
              {i < step ? <Check className="h-3 w-3" /> : `${i + 1}.`} {t(`journal.step.${s}`, { defaultValue: s })}
            </button>
          ))}
        </div>
      </div>

      {err && <IntelErrorNotice error={err} />}

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        {/* LEFT — current step */}
        <div className="space-y-4 min-w-0">
          {step === 0 && (
            <div className="card p-4 space-y-3">
              <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('journal.f.type', { defaultValue: 'What is this thesis about?' })}</span>
                <select className="select w-full" value={basics.thesis_type} onChange={(e) => setB({ thesis_type: e.target.value })}>
                  {THESIS_TYPES.map((x) => <option key={x} value={x}>{t(`journal.type.${x}`, { defaultValue: x.replace(/_/g, ' ') })}</option>)}
                </select>
              </label>
              <div className="flex flex-wrap items-end gap-2">
                <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('journal.f.chain', { defaultValue: 'Chain' })}</span>
                  <select className="select" value={basics.chain} onChange={(e) => setB({ chain: e.target.value })}>{CHAINS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
                </label>
                <label className="block flex-1 min-w-[180px]"><span className="text-[11px] text-[var(--fg-4)]">{t('journal.f.asset', { defaultValue: 'Asset (symbol or token address)' })}</span>
                  <input className="input w-full" value={basics.identifier} onChange={(e) => setB({ identifier: e.target.value })} placeholder="SOL / 0x… / mint…" />
                </label>
                <button onClick={resolveAsset} disabled={pack.loading || !basics.identifier.trim()} className="btn btn--primary btn--sm disabled:opacity-50">
                  {pack.loading ? '…' : t('journal.f.load', { defaultValue: 'Load context' })}
                </button>
              </div>
              {entity && <div className="text-[12px] text-[var(--ok)]">✓ {entity.display_symbol || entity.canonical_ref_key}</div>}
              {pack.err && <div className="text-[12px] text-amber-300">{pack.err}</div>}

              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('journal.f.title', { defaultValue: 'Title' })}</span>
                  <input className="input w-full" value={basics.title} onChange={(e) => setB({ title: e.target.value })} /></label>
                <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('journal.f.stance', { defaultValue: 'Stance' })}</span>
                  <select className="select w-full" value={basics.stance} onChange={(e) => setB({ stance: e.target.value })}>{STANCES.map((x) => <option key={x} value={x}>{x.replace(/_/g, ' ')}</option>)}</select></label>
                <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('journal.f.horizon', { defaultValue: 'Time horizon' })}</span>
                  <select className="select w-full" value={basics.time_horizon} onChange={(e) => setB({ time_horizon: e.target.value })}>{HORIZONS.map((x) => <option key={x} value={x}>{x.replace(/_/g, ' ')}</option>)}</select></label>
                <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('journal.f.cadence', { defaultValue: 'Review cadence' })}</span>
                  <select className="select w-full" value={basics.review_cadence} onChange={(e) => setB({ review_cadence: e.target.value })}>{CADENCES.map((x) => <option key={x} value={x}>{x.replace(/_/g, ' ')}</option>)}</select></label>
                <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('journal.f.benchmark', { defaultValue: 'Benchmark' })}</span>
                  <input className="input w-full" value={basics.benchmark} onChange={(e) => setB({ benchmark: e.target.value })} placeholder="BTC" /></label>
                <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('journal.f.conviction', { defaultValue: 'Conviction (1-5)' })}</span>
                  <input type="number" min="1" max="5" className="input w-full" value={basics.conviction} onChange={(e) => setB({ conviction: Number(e.target.value) })} /></label>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="card p-4 space-y-2 text-[13px] text-[var(--fg-3)]">
              <div className="font-medium text-[var(--fg-1)]">{t('journal.evidence_step', { defaultValue: 'Select the evidence that matters' })}</div>
              <p className="text-[12px] text-[var(--fg-4)]">{t('journal.evidence_hint', { defaultValue: 'In the Asset Context Pack on the right, mark each card as support, risk, contradiction, a confirmation/invalidation rule, a metric to track, or noise.' })}</p>
              <div className="text-[12px]">{t('journal.selected', { defaultValue: 'Selected' })}: <b>{selectedCards.length}</b></div>
            </div>
          )}

          {step === 2 && (
            <div className="card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-[13px] font-medium text-[var(--fg-1)]">{t('journal.draft_step', { defaultValue: 'Draft your thesis' })}</div>
                <button onClick={runAiDraft} disabled={ai.loading} className="btn btn--quiet btn--sm"><Wand2 className="h-4 w-4" /> {ai.loading ? '…' : t('journal.ai_draft', { defaultValue: 'Draft with AI' })}</button>
              </div>
              {ai.err && <div className="text-[12px] text-amber-300">{ai.err}</div>}
              {ai.draft && (
                <div className="card--flat p-3 space-y-1.5 border-l-2 border-[var(--accent)]">
                  <div className="text-[12px] text-[var(--fg-2)]"><b>{t('journal.ai_proposed', { defaultValue: 'AI proposed' })}:</b> {ai.draft.statement}</div>
                  {ai.draft.why_now && <div className="text-[11px] text-[var(--fg-4)]">Why now: {ai.draft.why_now}</div>}
                  <button onClick={applyAiDraft} className="btn btn--primary btn--sm"><Check className="h-3.5 w-3.5" /> {t('journal.use_draft', { defaultValue: 'Use this draft' })}</button>
                  <div className="text-[10px] text-[var(--fg-5)]">{t('journal.ai_note', { defaultValue: 'Research framing, not advice — review and edit before saving.' })}</div>
                </div>
              )}
              {[['statement', 'My thesis in one sentence'], ['why_now', 'Why now?'], ['whats_missing', 'What is the market missing?'], ['supports', 'What supports this?'], ['weakens', 'What weakens this?'], ['proves_wrong', 'What would prove me wrong?'], ['opposing', 'Strongest opposing argument']].map(([k, label]) => (
                <label key={k} className="block"><span className="text-[11px] text-[var(--fg-4)]">{t(`journal.prompt.${k}`, { defaultValue: label })}</span>
                  <textarea className="textarea w-full" rows={k === 'statement' ? 2 : 2} value={draft[k]} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} /></label>
              ))}
            </div>
          )}

          {step === 3 && <ScenarioBuilder value={scenarios} onChange={(kind, p) => setScenarios((s) => ({ ...s, [kind]: { ...s[kind], ...p } }))} />}

          {step === 4 && (
            <div className="card p-4 space-y-3">
              <div className="text-[13px] font-medium text-[var(--fg-1)]">{t('journal.rules_step', { defaultValue: 'Confirmation & invalidation rules' })}</div>
              <p className="text-[12px] text-[var(--fg-4)]">{t('journal.rules_hint', { defaultValue: 'These become alerts. Evidence you marked as a rule is included automatically; add more below.' })}</p>
              {rules.map((r, i) => (
                <div key={i} className="card--flat p-2 flex items-center gap-2 text-[12px]">
                  <span className={`chip text-[10px] ${r.rule_kind === 'invalidation' ? 'chip--err' : 'chip--ok'}`}>{r.rule_kind}</span>
                  <input className="input flex-1" value={r.description || ''} onChange={(e) => setRules((rs) => rs.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} />
                  <button onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))} className="text-[var(--fg-4)] hover:text-red-400">✕</button>
                </div>
              ))}
              <div className="flex gap-2">
                <button onClick={() => setRules((rs) => [...rs, { rule_kind: 'confirmation', description: '', metric: 'manual', origin: 'user' }])} className="btn btn--quiet btn--sm">+ {t('journal.add_confirm', { defaultValue: 'Confirmation' })}</button>
                <button onClick={() => setRules((rs) => [...rs, { rule_kind: 'invalidation', description: '', metric: 'manual', origin: 'user' }])} className="btn btn--quiet btn--sm">+ {t('journal.add_invalidate', { defaultValue: 'Invalidation' })}</button>
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="card p-4 space-y-3">
              <div className="text-[13px] font-medium text-[var(--fg-1)]">{t('journal.review_step', { defaultValue: 'Review & save' })}</div>
              <div className="grid gap-2 sm:grid-cols-2 text-[12px] text-[var(--fg-3)]">
                <div>{t('journal.f.asset', { defaultValue: 'Asset' })}: <b>{symbol || '—'}</b></div>
                <div>{t('journal.f.stance', { defaultValue: 'Stance' })}: <b>{basics.stance}</b></div>
                <div>{t('journal.selected', { defaultValue: 'Evidence' })}: <b>{selectedCards.length}</b></div>
                <div>{t('journal.rules_step', { defaultValue: 'Rules' })}: <b>{rules.length}</b></div>
              </div>
              <p className="text-[11px] text-[var(--fg-5)]">{t('journal.baseline_note', { defaultValue: 'Saving snapshots an immutable baseline (price, benchmark, fundamentals, selected evidence) so the Journal can show what changed since this call — forever.' })}</p>
              <div className="flex items-center gap-2">
                <button onClick={runCritique} disabled={ai.loading} className="btn btn--quiet btn--sm"><Sparkles className="h-4 w-4" /> {t('journal.ai_critique', { defaultValue: 'AI critique' })}</button>
                <button onClick={save} disabled={saving || !entity} className="btn btn--primary btn--sm disabled:opacity-50">{saving ? '…' : t('journal.save', { defaultValue: 'Save thesis' })}</button>
              </div>
              {ai.critique && (
                <div className="card--flat p-3 space-y-1 border-l-2 border-[var(--accent)] text-[12px]">
                  <div className="text-[var(--fg-2)]">{ai.critique.critique}</div>
                  {Array.isArray(ai.critique.suggestions) && ai.critique.suggestions.map((s, i) => <div key={i} className="text-[11px] text-[var(--fg-4)]">• {s}</div>)}
                </div>
              )}
            </div>
          )}

          {/* nav */}
          <div className="flex items-center justify-between">
            <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0} className="btn btn--quiet btn--sm disabled:opacity-40"><ArrowLeft className="h-4 w-4" /> {t('journal.back', { defaultValue: 'Back' })}</button>
            {step < STEPS.length - 1 && <button onClick={() => setStep((s) => s + 1)} disabled={!canNext} className="btn btn--primary btn--sm disabled:opacity-40">{t('journal.next', { defaultValue: 'Next' })} <ArrowRight className="h-4 w-4" /></button>}
          </div>
        </div>

        {/* RIGHT — Asset Context Pack + live quality */}
        <div className="space-y-3">
          {entity && step >= 2 && <ThesisQualityScore quality={quality} loading={quality.loading} />}
          <AssetContextPack cards={pack.cards} selections={selections} onSelect={onSelect} loading={pack.loading} coverage={pack.coverage}
            emptyHint={!entity ? t('journal.pick_asset_first', { defaultValue: 'Load an asset above to pull its Context Pack.' }) : null} />
        </div>
      </div>
    </div>
  )
}
