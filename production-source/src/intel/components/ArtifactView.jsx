import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert, TrendingUp, TrendingDown, Minus, Eye, CheckCircle2, XCircle, Bookmark, Check, RefreshCw, History } from 'lucide-react'
import SourcesFreshnessFooter from './SourcesFreshnessFooter'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { saveResearch } from '../lib/intel-data'

const LEVEL_CLS = { low: 'text-[var(--ok)]', medium: 'text-amber-400', high: 'text-red-400', unknown: 'text-[var(--fg-4)]' }
const SCOPE_LABEL = { local: 'Local to this asset', asset_specific: 'Asset-specific', chain: 'Chain-wide', chain_specific: 'Chain-wide', sector: 'Sector-wide', sector_specific: 'Sector-wide', narrative: 'Narrative-wide', narrative_specific: 'Narrative-wide', market_wide: 'Market-wide', unclear: 'Scope unclear' }
const SCOPE_CLS = { market_wide: 'text-amber-400', narrative: 'text-[var(--accent)]', narrative_specific: 'text-[var(--accent)]', sector: 'text-[var(--accent)]', sector_specific: 'text-[var(--accent)]', chain: 'text-[var(--fg-3)]', chain_specific: 'text-[var(--fg-3)]', local: 'text-[var(--fg-4)]', asset_specific: 'text-[var(--fg-4)]', unclear: 'text-[var(--fg-4)]' }
const NET_LABEL = { bullish: 'Leans bullish', bearish: 'Leans bearish', mixed: 'Mixed', neutral: 'Neutral', unclear: 'Unclear', data_limited: 'Data-limited' }
const NET_CLS = { bullish: 'chip--ok', bearish: 'chip--err', mixed: 'chip--info', neutral: '', unclear: 'text-[var(--fg-4)]', data_limited: 'text-[var(--fg-4)]' }
const CONSENSUS_LABEL = { strong_consensus: 'Strong model consensus', moderate_consensus: 'Moderate consensus', split_read: 'Split read', low_confidence: 'Low confidence', data_limited: 'Data-limited' }

// Renders a research_artifact's structured output uniformly across every Intel
// feature: summary, risk context, bull/bear/neutral, what-to-watch, thesis
// confirm/invalidate, and the provenance footer. Honors the safety block.
// `onRefresh` (optional) enables the "Refresh analysis" affordance shown on
// reused / delta artifacts (force regeneration; plan-limited server-side).
export default function ArtifactView({ result, loading, onRefresh }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { supabase } = useSupabase()
  const { org } = useProfile()
  const [saved, setSaved] = useState(false)

  if (loading) {
    return <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
  }
  if (!result?.artifact) return null
  const a = result.artifact
  const s = a.structured || {}

  // Reuse / delta provenance banner — honest about what was reused and why,
  // with deterministic change drivers as chips + an optional force refresh.
  const reuseKind = a.reuse_kind || (result.reused ? 'reuse_stale_unchanged' : result.delta ? 'delta' : null)
  const drivers = result.change_drivers || s.change_drivers || a.validator_outcome?.drivers || []
  const reuseBanner = (reuseKind === 'reuse_stale_unchanged' || reuseKind === 'delta' || reuseKind === 'explain_similar') ? (
    <div className="card--flat p-2.5 flex items-center gap-2 flex-wrap text-[12px]">
      <History className="h-3.5 w-3.5 text-[var(--accent)] flex-shrink-0" />
      <span className="text-[var(--fg-3)]">
        {reuseKind === 'delta'
          ? t('artifact.reuse_delta', { defaultValue: 'Updated since the last analysis — only what changed was re-analyzed.' })
          : reuseKind === 'explain_similar'
            ? t('artifact.reuse_similar', { defaultValue: 'Reused a recent answer to a very similar question.' })
            : t('artifact.reuse_unchanged', { defaultValue: 'Reused — underlying data unchanged since the last analysis.' })}
      </span>
      {Array.isArray(drivers) && drivers.slice(0, 3).map((d, i) => <span key={i} className="chip text-[10px] text-[var(--fg-4)]">{d}</span>)}
      {onRefresh && (
        <button onClick={onRefresh} className="btn btn--quiet btn--sm ml-auto">
          <RefreshCw className="h-3.5 w-3.5" /> {t('artifact.refresh', { defaultValue: 'Refresh analysis' })}
        </button>
      )}
    </div>
  ) : null

  if (result.blocked) {
    return (
      <div className="card--flat p-4 flex items-start gap-2.5 text-amber-400">
        <ShieldAlert className="h-5 w-5 flex-shrink-0 mt-0.5" />
        <div>
          <div className="font-medium">{t('artifact.blocked_title', { defaultValue: 'Output withheld' })}</div>
          <div className="text-[13px] text-[var(--fg-3)]">{t('artifact.blocked_body', { defaultValue: 'This response did not pass our non-financial-advice safety check and was not shown.' })}</div>
        </div>
      </div>
    )
  }

  const saveBtn = a.id && (
    <div className="flex justify-end">
      <button
        onClick={async () => { if (!org?.id) return; try { await saveResearch(supabase, org.id, null, { artifactId: a.id, title: a.title, snapshot: { summary: s.summary, confidence: a.confidence, artifact_type: a.artifact_type } }); setSaved(true) } catch { /* ignore */ } }}
        className="btn btn--quiet btn--sm" disabled={saved}>
        {saved ? <><Check className="h-4 w-4 text-[var(--ok)]" /> {t('artifact.saved', { defaultValue: 'Saved' })}</> : <><Bookmark className="h-4 w-4" /> {t('artifact.save', { defaultValue: 'Save to research' })}</>}
      </button>
    </div>
  )

  // Pool-framed renderer: defi_report analyzes a POOL/VAULT/LENDING MARKET, not a
  // token, so it uses a yield/TVL/risk layout instead of the bull/bear token shape.
  if (a.artifact_type === 'defi_report' && (s.yield_analysis || s.pool_overview || s.tvl_liquidity)) {
    const ya = s.yield_analysis || {}, tl = s.tvl_liquidity || {}, po = s.pool_overview || {}
    const Field = ({ label, children }) => children ? <div><div className="eyebrow">{label}</div><p className="text-[13px] text-[var(--fg-2)] mt-1 leading-relaxed">{children}</p></div> : null
    return (
      <div className="space-y-4">
        {reuseBanner}
        {s.summary && <div className="card p-4"><p className="text-[14px] text-[var(--fg-1)] leading-relaxed whitespace-pre-wrap">{s.summary}</p></div>}
        {po.what_it_is && <div className="card p-4"><Field label={t('defi.ai_what', { defaultValue: 'What this is' })}>{po.what_it_is}</Field></div>}

        {(ya.apy_read || ya.base_vs_reward || ya.sustainability) && (
          <div className="card p-4 space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="eyebrow">{t('defi.ai_yield', { defaultValue: 'Yield analysis' })}</div>
              {ya.apy_trend && <span className="chip">{ya.apy_trend}</span>}
              {ya.reward_dependence && <span className={`chip ${ya.reward_dependence === 'high' ? 'chip--err' : ya.reward_dependence === 'medium' ? 'text-amber-400' : ''}`}>{t('defi.ai_reward_dep', { defaultValue: 'reward dependence' })}: {ya.reward_dependence}</span>}
            </div>
            <Field label={t('defi.apy', { defaultValue: 'APY' })}>{ya.apy_read}</Field>
            <Field label={t('defi.ai_split', { defaultValue: 'Base vs reward' })}>{ya.base_vs_reward}</Field>
            <Field label={t('defi.ai_sustain', { defaultValue: 'Yield sustainability' })}>{ya.sustainability}</Field>
          </div>
        )}

        {(tl.tvl_read || tl.depth_note) && (
          <div className="card p-4 space-y-3">
            <div className="flex items-center gap-2"><div className="eyebrow">{t('defi.ai_tvl', { defaultValue: 'TVL & liquidity' })}</div>{tl.tvl_trend && <span className="chip">{tl.tvl_trend}</span>}</div>
            <Field label={t('defi.tvl', { defaultValue: 'TVL' })}>{tl.tvl_read}</Field>
            <Field label={t('defi.ai_depth', { defaultValue: 'Liquidity depth' })}>{tl.depth_note}</Field>
          </div>
        )}

        {s.collateral_or_il && <div className="card p-4"><Field label={t('defi.ai_il', { defaultValue: 'Impermanent loss / collateral risk' })}>{s.collateral_or_il}</Field></div>}

        {Array.isArray(s.risk_assessment) && s.risk_assessment.length > 0 && (
          <div className="card p-4 space-y-2">
            <div className="eyebrow">{t('defi.ai_risk', { defaultValue: 'Risk assessment' })}</div>
            {s.risk_assessment.map((r, i) => (
              <div key={i} className="flex items-start gap-2 text-[13px]">
                <span className={`uppercase text-[10px] font-bold mt-0.5 w-14 flex-shrink-0 ${LEVEL_CLS[r.level] || LEVEL_CLS.unknown}`}>{r.level || '?'}</span>
                <span className="text-[var(--fg-2)]"><b className="text-[var(--fg-1)]">{r.factor}:</b> {r.explanation}</span>
              </div>
            ))}
          </div>
        )}

        {(s.who_its_for || (Array.isArray(s.comparisons) && s.comparisons.length > 0)) && (
          <div className="card p-4 space-y-3">
            <Field label={t('defi.ai_who', { defaultValue: 'Who it suits' })}>{s.who_its_for}</Field>
            {Array.isArray(s.comparisons) && s.comparisons.length > 0 && <div><div className="eyebrow mb-1">{t('defi.ai_compare', { defaultValue: 'How it compares' })}</div><ul className="list-disc pl-5 text-[13px] text-[var(--fg-2)] space-y-1">{s.comparisons.map((c, i) => <li key={i}>{c}</li>)}</ul></div>}
          </div>
        )}

        {Array.isArray(s.what_to_watch) && s.what_to_watch.length > 0 && (
          <div className="card p-4 space-y-1.5">
            <div className="flex items-center gap-1.5 eyebrow"><Eye className="h-3.5 w-3.5" />{t('artifact.watch', { defaultValue: 'What to watch' })}</div>
            <ul className="list-disc pl-5 text-[13px] text-[var(--fg-2)] space-y-1">{s.what_to_watch.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </div>
        )}

        {saveBtn}
        {s.coverage_note && <div className="text-[11px] text-[var(--fg-4)] italic px-1">{s.coverage_note}</div>}
        <SourcesFreshnessFooter artifact={a} />
      </div>
    )
  }

  const cases = [
    ['bull_case', TrendingUp, 'artifact.bull', 'Bull case'],
    ['neutral_case', Minus, 'artifact.neutral', 'Neutral case'],
    ['bear_case', TrendingDown, 'artifact.bear', 'Bear case'],
  ]
  const aff = s.affected || {}
  const affectedChips = [...(aff.assets || []), ...(aff.chains || []), ...(aff.sectors || []), ...(aff.narratives || [])].filter(Boolean).slice(0, 12)

  return (
    <div className="space-y-4">
      {reuseBanner}
      {s.summary && <div className="card p-4"><p className="text-[14px] text-[var(--fg-1)] leading-relaxed whitespace-pre-wrap">{s.summary}</p></div>}

      {/* Delta-mode sections — what changed / still holds / now different */}
      {(s.what_changed || s.still_holds || s.now_different) && (
        <div className="card p-4 space-y-3">
          {s.what_changed && <div><div className="eyebrow">{t('artifact.what_changed', { defaultValue: 'What changed' })}</div><p className="text-[13px] text-[var(--fg-2)] mt-1 leading-relaxed">{s.what_changed}</p></div>}
          {s.still_holds && <div><div className="eyebrow">{t('artifact.still_holds', { defaultValue: 'Still holds' })}</div><p className="text-[13px] text-[var(--fg-2)] mt-1 leading-relaxed">{s.still_holds}</p></div>}
          {s.now_different && <div><div className="eyebrow">{t('artifact.now_different', { defaultValue: 'Now different' })}</div><p className="text-[13px] text-[var(--fg-2)] mt-1 leading-relaxed">{s.now_different}</p></div>}
          {Array.isArray(s.updated_what_to_watch) && s.updated_what_to_watch.length > 0 && (
            <div><div className="eyebrow">{t('artifact.watch_next', { defaultValue: 'What to watch next' })}</div>
              <ul className="text-[13px] text-[var(--fg-2)] mt-1 space-y-0.5">{s.updated_what_to_watch.slice(0, 5).map((w, i) => <li key={i}>· {w}</li>)}</ul></div>
          )}
        </div>
      )}

      {(s.what_happened || s.why_it_matters || s.crypto_market_impact) && (
        <div className="card p-4 space-y-3">
          {s.what_happened && <div><div className="eyebrow">{t('impact.what_happened', { defaultValue: 'What happened' })}</div><p className="text-[13px] text-[var(--fg-2)] mt-1 leading-relaxed">{s.what_happened}</p></div>}
          {s.why_it_matters && <div><div className="eyebrow">{t('impact.why', { defaultValue: 'Why it matters' })}</div><p className="text-[13px] text-[var(--fg-2)] mt-1 leading-relaxed">{s.why_it_matters}</p></div>}
          {s.crypto_market_impact && (
            <div>
              <div className="flex items-center gap-2">
                <div className="eyebrow">{t('impact.crypto', { defaultValue: 'Crypto market impact' })}</div>
                {s.impact_scope && <span className={`chip ${SCOPE_CLS[s.impact_scope] || ''}`}>{SCOPE_LABEL[s.impact_scope] || s.impact_scope}</span>}
              </div>
              <p className="text-[13px] text-[var(--fg-2)] mt-1 leading-relaxed">{s.crypto_market_impact}</p>
            </div>
          )}
          {affectedChips.length > 0 && (
            <div>
              <div className="eyebrow mb-1">{t('impact.affected', { defaultValue: 'Affected' })}</div>
              <div className="flex items-center gap-1.5 flex-wrap">{affectedChips.map((x, i) => <span key={i} className="chip">{x}</span>)}</div>
            </div>
          )}
        </div>
      )}

      {(s.net_signal || s.bullish_signals?.length || s.bearish_signals?.length || s.neutral_or_mixed_signals?.length) && (
        <div className="card p-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="eyebrow">{t('signals.net', { defaultValue: 'Net read' })}</div>
            {s.net_signal && <span className={`chip ${NET_CLS[s.net_signal] || ''}`}>{NET_LABEL[s.net_signal] || s.net_signal}</span>}
            {s.signal_confidence && <span className="chip">{s.signal_confidence}</span>}
            {(s.signal_scope || s.impact_scope) && <span className={`chip ${SCOPE_CLS[s.signal_scope || s.impact_scope] || ''}`}>{SCOPE_LABEL[s.signal_scope || s.impact_scope] || s.signal_scope || s.impact_scope}</span>}
            {s.model_consensus && <span className="chip text-[var(--fg-4)]">{CONSENSUS_LABEL[s.model_consensus] || s.model_consensus}</span>}
          </div>
          {s.model_disagreement && <p className="text-[12px] text-[var(--fg-4)] italic leading-relaxed">{s.model_disagreement}</p>}
          {(s.bullish_signals?.length > 0 || s.bearish_signals?.length > 0) && (
            <div className="grid sm:grid-cols-2 gap-3">
              {s.bullish_signals?.length > 0 && <div><div className="text-[10px] uppercase tracking-wide text-emerald-400 mb-1">{t('signals.bull', { defaultValue: 'Bullish signals' })}</div><ul className="list-disc pl-4 text-[12px] text-[var(--fg-2)] space-y-0.5">{s.bullish_signals.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
              {s.bearish_signals?.length > 0 && <div><div className="text-[10px] uppercase tracking-wide text-red-400 mb-1">{t('signals.bear', { defaultValue: 'Bearish signals' })}</div><ul className="list-disc pl-4 text-[12px] text-[var(--fg-2)] space-y-0.5">{s.bearish_signals.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
            </div>
          )}
          {s.neutral_or_mixed_signals?.length > 0 && <div><div className="text-[10px] uppercase tracking-wide text-[var(--fg-4)] mb-1">{t('signals.mixed', { defaultValue: 'Mixed / unclear' })}</div><ul className="list-disc pl-4 text-[12px] text-[var(--fg-3)] space-y-0.5">{s.neutral_or_mixed_signals.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
        </div>
      )}

      {Array.isArray(s.risk_context) && s.risk_context.length > 0 && (
        <div className="card p-4 space-y-2">
          <div className="eyebrow">{t('artifact.risk', { defaultValue: 'Risk context' })}</div>
          {s.risk_context.map((r, i) => (
            <div key={i} className="flex items-start gap-2 text-[13px]">
              <span className={`uppercase text-[10px] font-bold mt-0.5 w-14 flex-shrink-0 ${LEVEL_CLS[r.level] || LEVEL_CLS.unknown}`}>{r.level || '?'}</span>
              <span className="text-[var(--fg-2)]"><b className="text-[var(--fg-1)]">{r.factor}:</b> {r.explanation}</span>
            </div>
          ))}
        </div>
      )}

      {cases.some(([k]) => s[k]) && (
        <div className="grid gap-3 sm:grid-cols-3">
          {cases.map(([k, Icon, key, def]) => s[k] && (
            <div key={k} className="card p-3 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--fg-2)]"><Icon className="h-3.5 w-3.5" />{t(key, { defaultValue: def })}</div>
              <p className="text-[13px] text-[var(--fg-3)] leading-relaxed">{s[k]}</p>
            </div>
          ))}
        </div>
      )}

      {Array.isArray(s.what_to_watch) && s.what_to_watch.length > 0 && (
        <div className="card p-4 space-y-1.5">
          <div className="flex items-center gap-1.5 eyebrow"><Eye className="h-3.5 w-3.5" />{t('artifact.watch', { defaultValue: 'What to watch' })}</div>
          <ul className="list-disc pl-5 text-[13px] text-[var(--fg-2)] space-y-1">{s.what_to_watch.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}

      {(s.confirms_bullish_read || s.confirms_bearish_read || s.invalidates_current_read) && (
        <div className="grid gap-3 sm:grid-cols-3">
          {s.confirms_bullish_read && <div className="card p-3"><div className="flex items-center gap-1.5 text-[11px] text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" />{t('signals.confirm_bull', { defaultValue: 'Confirms bullish' })}</div><p className="text-[12px] text-[var(--fg-3)] mt-1">{s.confirms_bullish_read}</p></div>}
          {s.confirms_bearish_read && <div className="card p-3"><div className="flex items-center gap-1.5 text-[11px] text-red-400"><CheckCircle2 className="h-3.5 w-3.5" />{t('signals.confirm_bear', { defaultValue: 'Confirms bearish' })}</div><p className="text-[12px] text-[var(--fg-3)] mt-1">{s.confirms_bearish_read}</p></div>}
          {s.invalidates_current_read && <div className="card p-3"><div className="flex items-center gap-1.5 text-[11px] text-amber-400"><XCircle className="h-3.5 w-3.5" />{t('signals.invalidate', { defaultValue: 'Invalidates read' })}</div><p className="text-[12px] text-[var(--fg-3)] mt-1">{s.invalidates_current_read}</p></div>}
        </div>
      )}

      {!(s.confirms_bullish_read || s.confirms_bearish_read || s.invalidates_current_read) && (s.what_would_confirm || s.what_would_invalidate) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {s.what_would_confirm && <div className="card p-3"><div className="flex items-center gap-1.5 text-[12px] text-[var(--ok)]"><CheckCircle2 className="h-3.5 w-3.5" />{t('artifact.confirm', { defaultValue: 'Would confirm the thesis' })}</div><p className="text-[13px] text-[var(--fg-3)] mt-1">{s.what_would_confirm}</p></div>}
          {s.what_would_invalidate && <div className="card p-3"><div className="flex items-center gap-1.5 text-[12px] text-red-400"><XCircle className="h-3.5 w-3.5" />{t('artifact.invalidate', { defaultValue: 'Would invalidate the thesis' })}</div><p className="text-[13px] text-[var(--fg-3)] mt-1">{s.what_would_invalidate}</p></div>}
        </div>
      )}

      {a.id && (
        <div className="flex justify-end">
          <button
            onClick={async () => { if (!org?.id) return; try { await saveResearch(supabase, org.id, null, { artifactId: a.id, title: a.title, snapshot: { summary: s.summary, confidence: a.confidence, artifact_type: a.artifact_type } }); setSaved(true) } catch { /* ignore */ } }}
            className="btn btn--quiet btn--sm" disabled={saved}>
            {saved ? <><Check className="h-4 w-4 text-[var(--ok)]" /> {t('artifact.saved', { defaultValue: 'Saved' })}</> : <><Bookmark className="h-4 w-4" /> {t('artifact.save', { defaultValue: 'Save to research' })}</>}
          </button>
        </div>
      )}
      {s.coverage_note && <div className="text-[11px] text-[var(--fg-4)] italic px-1">{s.coverage_note}</div>}
      <SourcesFreshnessFooter artifact={a} />
    </div>
  )
}
