import React, { useState, useCallback, useMemo } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Activity, Sparkles, ArrowRight, TrendingUp, TrendingDown, Newspaper, Radar, Bell, Bookmark, Wallet, ExternalLink, RefreshCw } from 'lucide-react'
import { useDashboard } from '../lib/useDashboard'
import { useArtifact } from '../lib/useArtifact'
import ArtifactView from '../components/ArtifactView'
import RegimeBanner from '../components/RegimeBanner'
import MarketContextCard from '../components/MarketContextCard'
import MarketSignalBadge from '../components/MarketSignalBadge'
import IntelDisclaimer from '../components/IntelDisclaimer'
import SignalCard from '../components/SignalCard'
import WhatChanged from '../components/WhatChanged'
import TodaysPicture from '../components/TodaysPicture'
import BookCalendar from '../components/BookCalendar'
import { IntelPageHeader, IntelPageShell, IntelHeroRead, IntelMetricCard, IntelEmptyState, IntelSectionHeader } from '../components/IntelPrimitives'
import DeskPositions from '../components/DeskPositions'
import DashboardReadStatus,{dashboardReadFailed} from '../components/DashboardReadStatus'
import DisplayOptions from '../components/DisplayOptions'
import DeskModules, { DeskModule, DESK_MODULES } from '../components/DeskModules'
import { useWorkspacePreference } from '../context/PersonalWorkspace'
import OnboardingChecklistCard from '../../components/help/OnboardingChecklistCard'
import FigureProvenance from '../components/FigureProvenance'
import MetricAgreementChip from '../components/MetricAgreementChip'
import { envelopeKind } from '../lib/source-receipt'

const assetHref = (ref) => `/intel/asset/${encodeURIComponent(ref || '')}`
const marketHrefForChain = (c) => assetHref(c?.ref || `native:${c?.chain_id || ''}`)
const fmtPct = (v) => v == null || !Number.isFinite(Number(v)) ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`
const fmtPrice = (p) => p == null ? '—' : p < 1 ? `$${Number(p).toPrecision(3)}` : `$${Number(p).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
const SIG_CLS = { bullish: 'text-[var(--ok)]', bearish: 'text-red-400', mixed: 'text-[var(--fg-3)]', neutral: '', unclear: 'text-[var(--fg-4)]', data_limited: 'text-[var(--fg-4)]' }
const SIG_LABEL = { bullish: 'Leans bullish', bearish: 'Leans bearish', mixed: 'Mixed', neutral: 'Neutral', unclear: 'Unclear', data_limited: 'Data-limited' }
const PSCOPE_LABEL = { market_wide: 'Market-wide', asset_specific: 'Asset-specific', chain_specific: 'Chain-specific', sector_specific: 'Sector-specific', narrative_specific: 'Narrative-specific', local: 'Asset-specific', unclear: 'Scope unclear' }
const CONF_LABEL = { high: 'High source support', medium: 'Medium confidence', thin: 'Thin coverage', low: 'Thin coverage' }
const timeAgo = (s) => { if (!s) return ''; const h = (Date.now() - new Date(s).getTime()) / 3_600_000; if (Number.isNaN(h)) return ''; if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`; if (h < 24) return `${Math.round(h)}h ago`; return `${Math.round(h / 24)}d ago` }

function DeskSignal({ s }) {
  return <details className="intel-desk-signal">
    <summary><span>{s.asset_symbol ? `$${s.asset_symbol}` : s.name}</span><small className={SIG_CLS[s.direction] || ''}>{SIG_LABEL[s.direction] || s.direction}</small></summary>
    <SignalCard s={s} />
  </details>
}

// One clean, explainable investor news card — never a raw row.
function NotableCard({ c }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const tags = [...(c.chains || []), c.symbol].filter(Boolean).slice(0, 3)
  // Play 7: a curated summary past its review window is a different kind of
  // record. It is never drawn as the current analysis, only under its own label,
  // and the window is re-checked here because a cached desk can outlive it.
  const staleCurated = envelopeKind(c.provenance) === 'curated_stale'
  const a = staleCurated ? null : c.analysis
  const staleAnalysis = staleCurated ? (c.stale_analysis || c.analysis || null) : null
  return (
    <div className="border-t border-[var(--border-default)] py-3 space-y-1.5">
      <div className="flex items-start gap-1.5">
        {c.url
          ? <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-[13px] font-medium text-[var(--fg-1)] hover:text-[var(--accent)] leading-snug">{c.title}<ExternalLink className="inline h-3 w-3 ml-1 text-[var(--fg-5)]" /></a>
          : <span className="text-[13px] font-medium text-[var(--fg-1)] leading-snug">{c.title}</span>}
      </div>
      <div className="text-[11px] text-[var(--fg-4)] flex items-center gap-1.5 flex-wrap">
        {c.source_category && <span className="text-[9px] uppercase">{c.source_category}</span>}
        <span className="text-[var(--fg-3)]">{c.source_name}</span>
        {c.published_at && <span>· {timeAgo(c.published_at)}</span>}
        {tags.length > 0 && <span>· {tags.join(' / ')}</span>}
        {c.source_support > 1 && <span>· {c.source_support} sources</span>}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`text-[10px] ${SIG_CLS[c.signal] || ''}`}>{SIG_LABEL[c.signal] || c.signal}</span>
        <span className="text-[10px]">{PSCOPE_LABEL[c.scope] || c.scope}</span>
        <span className="text-[10px] text-[var(--fg-4)]">{CONF_LABEL[c.confidence] || c.confidence}</span>
      </div>
      <details className="intel-news-detail"><summary>Read the evidence</summary>
      <MarketContextCard ctx={c.market_context} variant="flat" />
      {a && (a.what_happened || a.why_it_matters || a.crypto_market_impact) ? (
        <div className="space-y-1 pt-0.5 text-[12px] leading-snug">
          {a.what_happened && <p className="text-[var(--fg-2)]"><span className="text-[var(--fg-5)]">What happened: </span>{a.what_happened}</p>}
          {a.why_it_matters && <p className="text-[var(--fg-2)]"><span className="text-[var(--fg-5)]">Why it matters: </span>{a.why_it_matters}</p>}
          {a.crypto_market_impact && <p className="text-[var(--fg-2)]"><span className="text-[var(--fg-5)]">Crypto impact: </span>{a.crypto_market_impact}</p>}
          {a.what_to_watch && <p className="text-[var(--fg-3)]"><span className="text-[var(--fg-5)]">Watch: </span>{a.what_to_watch}</p>}
        </div>
      ) : staleCurated ? (
        <div className="space-y-1 pt-0.5 text-[12px] leading-snug" data-envelope="curated_stale">
          <p className="text-[var(--fg-3)]"><strong>{t('receipt_state.curated_stale', { defaultValue: 'Past its review window' })}</strong> {t('receipt_state.curated_stale_note', { defaultValue: 'This summary was written for an earlier review window and has not been reviewed since.' })}</p>
          {staleAnalysis?.what_happened && <p className="text-[var(--fg-4)]">{staleAnalysis.what_happened}</p>}
          {staleAnalysis?.why_it_matters && <p className="text-[var(--fg-4)]">{staleAnalysis.why_it_matters}</p>}
        </div>
      ) : (c.supporting_facts?.length > 0 && (
        <ul className="text-[11px] text-[var(--fg-4)] space-y-0.5 pt-0.5">{c.supporting_facts.slice(0, 3).map((f, i) => <li key={i}>· {f}</li>)}</ul>
      ))}
      {c.provenance && <FigureProvenance envelope={c.provenance} />}
      </details>
    </div>
  )
}

// P3 — Scope-aware home dashboard: Everything / By chain / Following, with a
// chain selector and a per-chain project sub-selector.
export default function MarketPulsePage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const display = useWorkspacePreference('desk')
  const [displayError, setDisplayError] = useState(null)
  const saveDisplay = patch => display.save(patch).then(() => setDisplayError(null)).catch(e => setDisplayError(e.message))
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const scope = ['all', 'chain', 'following'].includes(params.get('pulse_scope')) ? params.get('pulse_scope') : 'all'
  const chain = scope === 'chain' ? params.get('pulse_chain') || null : null
  const project = scope === 'chain' ? params.get('pulse_project') || null : null
  const setSelection = updates => setParams(previous => {
    const next = new URLSearchParams(previous)
    for (const [name, value] of Object.entries(updates)) value ? next.set(`pulse_${name}`, value) : next.delete(`pulse_${name}`)
    return next
  }, { replace: true })
  const setProject = value => setSelection({ project: value })
  const { data: dash, loading, error, grounding, groundingLoading, groundingError, refresh, key: deskKey } = useDashboard({ scope, chain })
  const summary = useArtifact()
  const [summaryKey, setSummaryKey] = useState(null)
  const activeSummary = summaryKey === deskKey

  const pickScope = (sc) => {
    const first = sc === 'chain' ? dash?.followed_chains?.[0]?.id || dash?.available_chains?.[0]?.id || null : null
    setSelection({ scope: sc, chain: first, project: null })
  }

  const genSummary = useCallback(() => {
    setSummaryKey(deskKey)
    summary.generate({
      artifactType: 'explain',
      extra: { title: 'Market Pulse', question: `Summarize what I should pay attention to ${scope === 'chain' ? `on ${chain}` : 'across everything I follow'} right now — notable changes, news and trends. For each notable item, briefly say why it matters for a crypto investor and whether the impact looks local to one asset or broader (chain / sector / narrative / market-wide). High-level, balanced, risk-aware research context — not advice.` },
      context: { scope, chain, movers: dash?.movers, news: (dash?.news || []).map((n) => ({ title: n.title, sentiment: n.sentiment })), narratives: (dash?.narratives || []).map((n) => ({ title: n.title, status: n.status })) },
    })
  }, [summary, dash, scope, chain, deskKey])

  // Client-side project filter within a chain.
  // Cold Birdeye cache → dash.movers is []; fall back to the exchange-layer
  // market_movers (already in the response) so "Notable changes" doesn't vanish.
  const moverList = dash?.movers?.length ? dash.movers : (dash?.market_movers || [])
  const movers = moverList.filter((m) => !project || m.symbol === project)
  const news = (dash?.news || []).filter((n) => !project || (n.entity_symbol || n.entity?.display_symbol) === project)
  // Focused signal lenses the dashboard already returns; followed is deduped
  // against holdings so a card never appears in both focused rails.
  const affectsHoldings = dash?.affects_holdings || []
  const affectsIds = new Set(affectsHoldings.map((s) => s.id))
  const followedSignals = (dash?.followed_signals || []).filter((s) => !affectsIds.has(s.id))
  const returnState = useMemo(() => ({ from: `${location.pathname}${location.search}` }), [location.pathname, location.search])

  const empty = dash && !Object.values(dash.read_states||{}).some(r=>r.state==='error') && dash.total_following === 0 && (dash.notable || []).length === 0 && (dash.signals || []).length === 0 && (dash.movers || []).length === 0 && (dash.market_movers || []).length === 0 && (dash.chain_perf || []).length === 0
  const marketReadTitle = empty
    ? t('pulse.today_read_empty', { defaultValue: 'Your desk is ready for the first signal.' })
    : t('pulse.desk_read_title', { defaultValue: 'Your watchlist and holdings, in context.' })
  const marketReadBody = scope === 'chain' && chain
    ? t('pulse.today_read_chain', { defaultValue: 'Focused on the selected chain: notable moves, related stories, and signal changes are filtered below.' })
    : t('pulse.desk_read_body', { defaultValue: 'Recorded changes, market conditions, and the research behind the assets you follow.' })

  const ScopeBtn = ({ id, label }) => (
    <button onClick={() => pickScope(id)} className={`btn btn--sm ${scope === id ? 'btn--primary' : 'btn--ghost'}`}>{label}</button>
  )

  return (
    <IntelPageShell className="intel-desk">
      <IntelPageHeader
        icon={Activity}
        eyebrow={t('brand.name', { defaultValue: 'Investor Intel' })}
        title={t('nav.my_intel', { defaultValue: 'My Intel' })}
        subtitle={t('pages.my_intel_sub', { defaultValue: 'Your research desk. Market Pulse, followed assets, and saved work.' })}
        actions={(
          <>
          <button onClick={refresh} disabled={loading} aria-label={t('pulse.refresh', { defaultValue: 'Refresh' })} title={t('pulse.refresh', { defaultValue: 'Refresh' })} className="btn btn--ghost btn--sm disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
          <button onClick={genSummary} disabled={(activeSummary && summary.loading) || !dash || empty} className="btn btn--primary btn--sm disabled:opacity-50">
            {activeSummary && summary.loading ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : <><Sparkles className="h-4 w-4" /> {t('pulse.generate', { defaultValue: 'What matters now' })}</>}
          </button>
          </>
        )}
      />

      {/* Intel onboarding checklist — self-gates on tutorials_enabled + completion.
          Previously mounted only on the content dashboard, so intel users never
          saw theirs on-surface. */}
      <details className="intel-desk-setup"><summary>{t('pulse.workspace_setup', { defaultValue: 'Workspace setup' })}</summary><OnboardingChecklistCard compact /></details>

      <div className="intel-desk-toolbar">
        <div className="flex items-center gap-2 flex-wrap">
          <ScopeBtn id="all" label={t('pulse.scope_all', { defaultValue: 'Everything' })} />
          <ScopeBtn id="chain" label={t('pulse.scope_chain', { defaultValue: 'By chain' })} />
          <ScopeBtn id="following" label={t('pulse.scope_following', { defaultValue: 'Following' })} />
        </div>
        <nav aria-label="On this page" className="intel-desk-jumps">
          {movers.length > 0 && (!display.value.modules || display.value.modules.includes('moves')) && <a href="#desk-moves">{t('pulse.notable_changes', { defaultValue: 'Notable changes' })}</a>}
          {dash?.chain_perf?.length > 0 && (!display.value.modules || display.value.modules.includes('chains')) && <a href="#desk-chains">{t('pulse.chains_followed', { defaultValue: 'Chains you follow' })}</a>}
          {dash?.for_you?.length > 0 && (!display.value.modules || display.value.modules.includes('personal')) && <a href="#desk-for-you">{t('pulse.for_you', { defaultValue: 'For you' })}</a>}
        </nav>
      </div>

      <div className="flex items-start gap-4 flex-wrap"><DisplayOptions label="Customize your desk" items={DESK_MODULES} order={display.value.moduleOrder} visible={display.value.modules} disabled={display.loading || !!display.error} onChange={(moduleOrder, modules) => saveDisplay({moduleOrder, modules})}/><label className="text-sm flex items-center gap-2"><input type="checkbox" checked={!!display.value.advanced} disabled={display.loading || !!display.error} onChange={e => saveDisplay({advanced:e.target.checked})}/>Advanced source details</label></div>
      {(displayError || display.error) && <p role="alert">{displayError || display.error} <button className="intel-text-link" onClick={display.reload}>Reload preferences</button></p>}
      <DeskModules order={display.value.moduleOrder} visible={display.value.modules}>
      <DeskModule moduleId="context"><IntelHeroRead className="intel-desk-intro"
        eyebrow={t('pulse.today_read', { defaultValue: "Today's Market Read" })}
        title={marketReadTitle}
        meta={dash ? (
          <>
            <span>{movers.length} {t('pulse.meta_moves', { defaultValue: 'notable moves' })}</span>
            <span>·</span>
            <span>{news.length} {t('pulse.meta_stories', { defaultValue: 'stories' })}</span>
            <span>·</span>
            <span>{(dash?.signals || []).length} {t('pulse.meta_signals', { defaultValue: 'signals' })}</span>
            <span>·</span>
            <span>{dashboardReadFailed(dash,'alerts')?'—':dash?.unread_alerts ?? 0} {t('pulse.meta_alerts', { defaultValue: 'new alerts' })}</span>
          </>
        ) : null}
      >
        <p className="text-[13px] text-[var(--fg-2)] leading-relaxed max-w-4xl">{marketReadBody}</p>
      </IntelHeroRead>

      <div className="intel-desk-context">
        <RegimeBanner />
        <TodaysPicture grounding={grounding || dash?.intelligence_grounding} />
      </div>
      {display.value.advanced && <details><summary>Source coverage and assembly</summary><p className="text-sm">This read combines independently observed sources. Inspect the original evidence for each signal before comparing observation times.</p><dl className="intel-source-details"><dt>Scope</dt><dd>{scope}{chain ? ` · ${chain}` : ''}</dd><dt>Assembled</dt><dd>{dash?.generated_at ? new Date(dash.generated_at).toLocaleString(undefined,{timeZoneName:'short'}) : 'Not yet available'}</dd><dt>Loaded stories</dt><dd>{news.length}</dd><dt>Holdings signals</dt><dd>{affectsHoldings.length}</dd><dt>Followed signals</dt><dd>{followedSignals.length}</dd></dl></details>}
      </DeskModule>

      {loading && <p role="status" className="text-[12px] text-[var(--fg-4)]">{dash ? 'Refreshing your market read…' : 'Loading your recorded market read…'}</p>}
      <DashboardReadStatus data={dash} onRetry={refresh}/>
      {dash?.generated_at && <p className="text-[11px] text-[var(--fg-4)]">Read assembled {new Date(dash.generated_at).toLocaleString()} · Cached market sources</p>}
      {groundingLoading && !grounding && <p role="status" className="text-[11px] text-[var(--fg-4)]">Loading market context…</p>}
      {groundingError && <p className="text-[12px] text-[var(--fg-4)]">Market context is temporarily unavailable. <button onClick={refresh} className="underline">Retry</button></p>}

      <DeskModule moduleId="moves">{movers.length > 0 && (
        <section id="desk-moves" className="space-y-2">
          <IntelSectionHeader label={t('pulse.notable_changes', { defaultValue: 'Notable changes' })} subtitle={t('pulse.notable_changes_sub', { defaultValue: 'Price and signal moves from the current dashboard scope.' })} />
          <div className="intel-desk-quotes">
            {movers.map((m) => {
              const inner = (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-[var(--fg-1)] truncate">{m.symbol}</span>
                    <span className={`text-[13px] font-semibold flex items-center gap-0.5 ${m.change24h >= 0 ? 'text-[var(--ok)]' : 'text-red-400'}`}>{m.change24h >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}{fmtPct(m.change24h)}</span>
                  </div>
                  {m.price != null && <div className="text-[12px] text-[var(--fg-4)] mt-0.5">{fmtPrice(m.price)}</div>}
                  {m.market_context?.direction && <div className="mt-1"><MarketSignalBadge direction={m.market_context.direction} size="sm" /></div>}
                </>
              )
              return m.ref
                ? <Link key={m.ref} to={assetHref(m.ref)} className="border-b border-[var(--border-subtle)] py-3 hover:bg-[var(--bg-2)] transition-colors">{inner}</Link>
                : <div key={m.symbol} className="border-b border-[var(--border-subtle)] py-3">{inner}</div>
            })}
          </div>
          {/* Birdeye movers when the overview cache is warm, exchange movers otherwise. */}
          <FigureProvenance envelope={dash?.movers?.length ? dash?.figure_provenance?.movers : dash?.figure_provenance?.market_movers} />
        </section>
      )}

      </DeskModule>
      {/* Chain + project selectors */}
      {scope === 'chain' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            {(dash?.followed_chains || []).map((c) => (
              <button key={c.id} onClick={() => { setSelection({ chain: c.id, project: null }) }} className={chain === c.id ? 'btn btn--quiet text-[var(--accent)] underline underline-offset-8' : 'btn btn--quiet'}>{c.label}{c.item_count ? ` · ${c.item_count}` : ''}</button>
            ))}
            <select className="select" value={chain || ''} onChange={(e) => { setSelection({ chain: e.target.value, project: null }) }}>
              <option value="">{t('pulse.pick_chain', { defaultValue: 'Any chain…' })}</option>
              {(dash?.available_chains || []).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          {(dash?.projects || []).length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-[var(--fg-4)]">{t('pulse.projects', { defaultValue: 'Projects' })}:</span>
              <button onClick={() => setProject(null)} className={!project ? 'btn btn--quiet text-[var(--accent)] underline underline-offset-8 text-[11px]' : 'btn btn--quiet text-[11px]'}>{t('pulse.all', { defaultValue: 'All' })}</button>
              {dash.projects.map((p) => (
                <button key={p.symbol} onClick={() => setProject(p.symbol)} className={project === p.symbol ? 'btn btn--quiet text-[var(--accent)] underline underline-offset-8 text-[11px]' : 'btn btn--quiet text-[11px]'}>
                  {p.symbol}{p.followed ? '' : ' +'}
                </button>
              ))}
            </div>
          )}
          {project && (dash?.projects || []).find((p) => p.symbol === project)?.ref && (
            <Link to={assetHref(dash.projects.find((p) => p.symbol === project).ref)} className="btn btn--quiet btn--sm"><ExternalLink className="h-4 w-4" /> {t('pulse.open_breakdown', { defaultValue: 'Open full breakdown' })}</Link>
          )}
        </div>
      )}

      {error && <div className="border-t border-[var(--border-default)] py-3 text-[13px] text-red-400">{error}</div>}
      {activeSummary && summary.error && <p role="alert" className="text-[13px] text-red-400">{summary.error}</p>}
      {activeSummary && (summary.result || summary.loading) && <ArtifactView result={summary.result} loading={summary.loading} />}

      {/* What changed since your last visit (deterministic; stored-data only) */}
      <DeskModule moduleId="changes"><WhatChanged items={dash?.what_changed} context={dash?.what_changed_context || (error ? { coverage: 'unavailable' } : null)} loading={loading && !dash} title={t('pulse.what_changed', { defaultValue: 'What changed since your last visit' })} /></DeskModule>

      <DeskModule moduleId="positions"><DeskPositions/></DeskModule>
      <DeskModule moduleId="calendar"><BookCalendar/></DeskModule>

      {empty ? (
        <IntelEmptyState
          title={t('pulse.empty_title', { defaultValue: 'No personal signal feed yet' })}
          body={t('pulse.empty_home', { defaultValue: 'Add tokens, wallets and narratives to your watchlist and follow some sources — your dashboard fills in automatically.' })}
          action={<div className="flex justify-center gap-2 flex-wrap"><Link to="/intel/watchlist" className="btn btn--primary btn--sm">{t('nav.watchlist', { defaultValue: 'My Watchlist' })}</Link><Link to="/intel/news" className="btn btn--ghost btn--sm">{t('nav.news', { defaultValue: 'News' })}</Link></div>}
        />
      ) : (
        <>
          <DeskModule moduleId="overview">{scope === 'all' && (
            <div className="flex flex-wrap gap-x-10 gap-y-5 border-y border-[var(--border-default)] py-5">
              <Link to="/intel/watchlist" className="block"><IntelMetricCard label={t('pulse.following', { defaultValue: 'Following' })} value={dashboardReadFailed(dash,'watchlist')?'—':dash?.total_following ?? '—'} /></Link>
              <Link to="/intel/alerts" className="block"><IntelMetricCard label={t('pulse.unread_alerts', { defaultValue: 'New alerts' })} value={dash?.unread_alerts ?? '—'} tone={dash?.unread_alerts ? 'warning' : 'default'} /></Link>
              <Link to="/intel/narratives" className="block"><IntelMetricCard label={t('nav.narratives', { defaultValue: 'Narratives' })} value={dash&&!dashboardReadFailed(dash,'narratives') ? (dash.narratives || []).length : '—'} /></Link>
              <Link to="/intel/news" className="block"><IntelMetricCard label={t('nav.news', { defaultValue: 'News' })} value={dash&&!dashboardReadFailed(dash,'custom_news','global_news','curated_news') ? (dash.news || []).length : '—'} /></Link>
            </div>
          )}

          </DeskModule>
          <DeskModule moduleId="chains">{(dash?.chain_perf || []).filter((c) => c.price != null || c.change_24h != null).length > 0 && (
            <section id="desk-chains" className="space-y-2">
              <div className="eyebrow">{t('pulse.chains_followed', { defaultValue: 'Chains you follow' })}</div>
              <div className="intel-desk-quotes">
                {/* skip rows without data — they'd render as empty shells */}
                {dash.chain_perf.filter((c) => c.price != null || c.change_24h != null).map((c) => (
                  <Link key={c.chain_id} to={marketHrefForChain(c)} state={returnState} className="border-b border-[var(--border-subtle)] py-3 block hover:bg-[var(--bg-2)] transition-colors">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-[var(--fg-1)] truncate">{c.label}</span>
                      {c.change_24h != null && <span className={`text-[13px] font-semibold flex items-center gap-0.5 ${c.change_24h >= 0 ? 'text-[var(--ok)]' : 'text-red-400'}`}>{c.change_24h >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}{fmtPct(c.change_24h)}</span>}
                    </div>
                    <div className="text-[11px] text-[var(--fg-4)] mt-0.5">{c.symbol}{c.price != null ? ` · ${fmtPrice(c.price)}` : ''}</div>
                    {c.as_of&&<div className="text-[11px] text-[var(--fg-4)] mt-1">{c.source==='coinmarketcap'?'CoinMarketCap':'CoinGecko'} · <time dateTime={c.as_of}>{new Date(c.as_of).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</time>{c.stale?' · Delayed':''}</div>}
                    <MetricAgreementChip agreement={c.metric_agreement} />
                  </Link>
                ))}
              </div>
              <FigureProvenance envelope={dash?.figure_provenance?.chain_perf} receipts={dash?.receipts?.chain_perf} />
            </section>
          )}

          </DeskModule>
          <DeskModule moduleId="personal">{(dash?.for_you?.length > 0) && (
            <section id="desk-for-you" className="border-t border-[var(--border-default)] py-5 space-y-2">
              <div className="flex items-center justify-between mb-1">
                <div className="eyebrow flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" /> {t('pulse.for_you', { defaultValue: 'For you' })}</div>
                <span className="text-[11px] text-[var(--fg-5)]">{t('pulse.for_you_sub', { defaultValue: 'Ranked by your watchlist, holdings, narratives & chains' })}</span>
              </div>
              <div className="intel-desk-stories">{dash.for_you.map((s) => <DeskSignal key={s.id} s={s} />)}</div>
              {(dash?.outside_bubble?.length > 0) && (
                <div className="pt-2 border-t border-[var(--border-subtle)]">
                  <div className="text-[10px] uppercase tracking-wide text-[var(--fg-5)] mb-1.5">{t('pulse.outside_bubble', { defaultValue: 'Outside your watchlist · still notable' })}</div>
                  <div className="intel-desk-stories">{dash.outside_bubble.map((s) => <DeskSignal key={s.id} s={s} />)}</div>
                </div>
              )}
            </section>
          )}

          </DeskModule>
          <DeskModule moduleId="holdings">{affectsHoldings.length > 0 && (
            <section className="border-t border-[var(--border-default)] py-5 space-y-2">
              <div className="flex items-center justify-between mb-1">
                <div className="eyebrow flex items-center gap-1.5"><Wallet className="h-3.5 w-3.5" /> {t('pulse.affects_holdings', { defaultValue: 'Affects your holdings' })}</div>
                <span className="text-[11px] text-[var(--fg-5)]">{t('pulse.affects_holdings_sub', { defaultValue: 'Signals touching coins you hold' })}</span>
              </div>
              <div className="intel-desk-stories">{affectsHoldings.map((s) => <DeskSignal key={s.id} s={s} />)}</div>
            </section>
          )}

          </DeskModule>
          <DeskModule moduleId="followed">{followedSignals.length > 0 && (
            <section className="border-t border-[var(--border-default)] py-5 space-y-2">
              <div className="flex items-center justify-between mb-1">
                <div className="eyebrow flex items-center gap-1.5"><Bookmark className="h-3.5 w-3.5" /> {t('pulse.followed_signals', { defaultValue: 'Followed' })}</div>
                <span className="text-[11px] text-[var(--fg-5)]">{t('pulse.followed_signals_sub', { defaultValue: 'Watchlist & narratives you follow' })}</span>
              </div>
              <div className="intel-desk-stories">{followedSignals.map((s) => <DeskSignal key={s.id} s={s} />)}</div>
            </section>
          )}

          </DeskModule>
          <DeskModule moduleId="news"><div className="grid gap-4 lg:grid-cols-2">
            <section className="border-t border-[var(--border-default)] py-5">
              <div className="flex items-center justify-between mb-2">
                <div className="eyebrow flex items-center gap-1.5"><Newspaper className="h-3.5 w-3.5" /> {t('pulse.notable_news', { defaultValue: 'Notable news' })}</div>
                <Link to="/intel/news" className="text-[12px] text-[var(--accent)] flex items-center gap-1">{t('pulse.all', { defaultValue: 'All' })} <ArrowRight className="h-3 w-3" /></Link>
              </div>
              {news.length === 0 ? <p className="text-[13px] text-[var(--fg-3)]">{loading && !dash ? 'Loading stored stories…' : dashboardReadFailed(dash,'custom_news','global_news','curated_news') ? t('pulse.news_read_failed',{defaultValue:'Stories could not be read completely. Retry the desk read above.'}) : t('pulse.no_stored_news', { defaultValue: 'No notable stories are available in this scope yet.' })}</p> : (
                <div className="space-y-2">
                  {news.slice(0, scope === 'chain' ? 8 : 5).map((c) => <NotableCard key={c.story_hash || c.title} c={c} />)}
                </div>
              )}
              {news.length > 0 && <FigureProvenance envelope={dash?.figure_provenance?.news} />}
              {(dash?.developing || []).length > 0 && (
                <div className="mt-3 pt-2 border-t border-[color:var(--border-default)]">
                  <div className="text-[10px] uppercase tracking-wide text-[var(--fg-5)] mb-1.5">{t('pulse.developing', { defaultValue: 'Developing chatter · lower confidence' })}</div>
                  <div className="space-y-1">
                    {dash.developing.slice(0, 4).map((c) => (
                      <div key={c.story_hash} className="text-[12px] text-[var(--fg-3)] flex items-center gap-1.5 min-w-0">
                        <span className={`text-[9px] ${SIG_CLS[c.signal] || ''}`}>{(SIG_LABEL[c.signal] || c.signal || '?').replace('Leans ', '')}</span>
                        {c.url ? <a href={c.url} target="_blank" rel="noopener noreferrer" className="truncate hover:text-[var(--accent)]">{c.title}</a> : <span className="truncate">{c.title}</span>}
                        {c.symbol && <span className="text-[var(--fg-5)] flex-shrink-0">· {c.symbol}</span>}
                        {envelopeKind(c.provenance) === 'curated_stale' && <span className="text-[var(--fg-5)] flex-shrink-0">· {t('receipt_state.curated_stale', { defaultValue: 'Past its review window' })}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <section className="border-t border-[var(--border-default)] py-5">
              <div className="flex items-center justify-between mb-2">
                <div className="eyebrow flex items-center gap-1.5"><Radar className="h-3.5 w-3.5" /> {t('pulse.signal_radar', { defaultValue: 'Signal Radar' })}</div>
                <Link to="/intel/narratives" className="text-[12px] text-[var(--accent)] flex items-center gap-1">{t('pulse.all', { defaultValue: 'All' })} <ArrowRight className="h-3 w-3" /></Link>
              </div>
              {(dash?.signals || []).length === 0 ? (
                <div className="text-[12px] text-[var(--fg-3)] space-y-2">
                  <p>{loading && !dash ? 'Loading recorded signals…' : dashboardReadFailed(dash,'signal_feed') ? t('pulse.signals_read_failed',{defaultValue:'Personalized signals could not be read. Retry the desk read above.'}) : t('pulse.no_stored_signals', { defaultValue: 'No strong signals are available in the stored sources for this scope. Explore a source or add assets to your watchlist.' })}</p>
                  <div className="flex flex-wrap gap-1.5">{['Chatter velocity', 'Wallet movement', 'Price/volume', 'DeFi TVL/APY', 'Narrative momentum', 'Source history'].map((x) => <span key={x} className="text-[10px] text-[var(--fg-4)]">{x}</span>)}</div>
                </div>
              ) : (
                <div className="space-y-2">{dash.signals.map((s) => <DeskSignal key={s.id} s={s} />)}</div>
              )}
              {(dash?.signals || []).length > 0 && <FigureProvenance envelope={dash?.figure_provenance?.signals} />}
            </section>
          </div>

          </DeskModule>
          <DeskModule moduleId="research"><div className="grid gap-4 lg:grid-cols-2">
            <section className="border-t border-[var(--border-default)] py-5">
              <div className="flex items-center justify-between mb-2">
                <div className="eyebrow flex items-center gap-1.5"><Bell className="h-3.5 w-3.5" /> {t('pulse.recent_alerts', { defaultValue: 'Recent alerts' })}</div>
                <Link to="/intel/alerts" className="text-[12px] text-[var(--accent)] flex items-center gap-1">{t('pulse.all', { defaultValue: 'All' })} <ArrowRight className="h-3 w-3" /></Link>
              </div>
              {(dash?.alerts || []).length === 0 ? (
                <div className="space-y-2">
                  <p className="text-[13px] text-[var(--fg-3)]">{dashboardReadFailed(dash,'alerts')?t('pulse.alerts_read_failed',{defaultValue:'Recent alerts could not be read. Retry before deciding whether any alerts have fired.'}):t('pulse.no_alerts', { defaultValue: 'No alerts fired yet. Useful rules to set:' })}</p>
                  <div className="flex flex-wrap gap-1.5">{['Watchlist price/volume move', 'Narrative momentum shift', 'Macro event affecting crypto', 'Wallet movement', 'DeFi TVL/APY change', 'Bull/bear signal flip'].map((x) => <Link key={x} to="/intel/alerts" className="text-[11px]">{x}</Link>)}</div>
                </div>
              ) : (
                <div className="space-y-1.5">{dash.alerts.slice(0, 6).map((a) => (
                  <div key={a.id} className="flex items-center justify-between text-[13px]"><span className="text-[var(--fg-2)] truncate">{a.payload?.symbol ? <b>{a.payload.symbol} </b> : null}{t(`alerts.triggers.${a.payload?.trigger_type}`, { defaultValue: a.payload?.trigger_type || 'alert' })}{a.payload?.value != null ? ` ${Number(a.payload.value).toFixed(1)}%` : ''}</span><span className="text-[11px] text-[var(--fg-5)] flex-shrink-0">{new Date(a.fired_at).toLocaleDateString()}</span></div>
                ))}</div>
              )}
            </section>

            <section className="border-t border-[var(--border-default)] py-5">
              <div className="flex items-center justify-between mb-2"><div className="eyebrow flex items-center gap-1.5"><Bookmark className="h-3.5 w-3.5" /> {t('pulse.brief_research', { defaultValue: 'Brief & research' })}</div><Link to="/intel/briefs" className="text-[12px] text-[var(--accent)] flex items-center gap-1">{t('nav.briefs', { defaultValue: 'Briefs' })} <ArrowRight className="h-3 w-3" /></Link></div>
              {dash?.latest_brief?.artifact?.structured?.summary ? <Link to="/intel/briefs" className="block mb-2"><div className="text-[11px] text-[var(--fg-4)]">{dash.latest_brief.period_date} · {dash.latest_brief.brief_type}</div><p className="text-[13px] text-[var(--fg-2)] line-clamp-2">{dash.latest_brief.artifact.structured.summary}</p></Link> : (
                <div className="mb-2">
                  <p className="text-[13px] text-[var(--fg-3)] mb-1">{dashboardReadFailed(dash,'brief')?t('pulse.brief_read_failed',{defaultValue:'The latest brief could not be read. Open Briefs or retry the desk read.'}):t('pulse.brief_preview', { defaultValue: 'A Daily Brief covers:' })}</p>
                  <ul className="text-[12px] text-[var(--fg-4)] space-y-0.5 mb-2 list-disc pl-4"><li>{t('pulse.brief_b1', { defaultValue: 'Top bullish & bearish forces' })}</li><li>{t('pulse.brief_b2', { defaultValue: 'Macro impact + market regime' })}</li><li>{t('pulse.brief_b3', { defaultValue: 'Watchlist & thesis impact' })}</li><li>{t('pulse.brief_b4', { defaultValue: 'What to monitor next' })}</li></ul>
                  <Link to="/intel/briefs" className="btn btn--primary btn--sm">{t('pulse.gen_brief', { defaultValue: 'Generate Daily Brief' })}</Link>
                </div>
              )}
              {(dash?.recent_research || []).length > 0 && <div className="space-y-1 border-t border-[var(--border-subtle)] pt-2">{dash.recent_research.slice(0, 4).map((r) => <Link key={r.id} to={`/intel/research?research_id=${r.id}`} className="flex items-center justify-between text-[12px] text-[var(--fg-3)] hover:text-[var(--fg-1)]"><span className="truncate">{r.title || r.artifact_type}</span><span className="text-[10px] text-[var(--fg-5)] uppercase flex-shrink-0">{(r.artifact_type || '').replace(/_/g, ' ')}</span></Link>)}</div>}
            </section>
          </div>
        </DeskModule></>
      )}
      </DeskModules>
      <IntelDisclaimer variant="block" />
    </IntelPageShell>
  )
}
