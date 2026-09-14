import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Newspaper, Sparkles } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { useArtifact } from '../lib/useArtifact'
import { listBriefs, upsertBrief } from '../lib/intel-data'
import { appendHistoryPage } from '../lib/history-page'
import { markSurfaceSeen } from '../lib/changes-api'
import ArtifactView from '../components/ArtifactView'
import IntelDisclaimer from '../components/IntelDisclaimer'
import { clarityMeta } from '../lib/narrative-ui'
import { usePortfolioSelection } from '../lib/PortfolioSelectionContext'
import BriefLibrary from '../components/BriefLibrary'

const SIG_CLS = { bullish: 'chip--ok', bearish: 'chip--err', mixed: 'chip--info' }

// Renders a cron-assembled brief (intel_briefs.assembled) — deterministic
// sections built from stored intelligence (regime, signals, narratives, news,
// watchlist/portfolio overlaps). "Assembled from cached intelligence" — zero
// per-org AI; the optional global synthesis is shared across all orgs.
function AssembledBrief({ b }) {
  const s = b.assembled || {}
  const Section = ({ title, children }) => children ? <div><div className="eyebrow">{title}</div><div className="mt-1 space-y-1">{children}</div></div> : null
  const has = (x) => Array.isArray(x) ? x.length > 0 : !!x
  return (
    <div className="intel-assembled-brief space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="text-[12px] text-[var(--fg-4)]">{b.period_date} · {b.brief_type} · {b.scope === 'personal' ? 'Private · only you' : 'Organization history · shared'}</span>
        <span className="text-[10px] text-[var(--fg-5)]">Assembled from cached intelligence · research context, not advice</span>
      </div>
      {s.portfolio_scope?.name && <p className="text-sm">Portfolio: {s.portfolio_scope.name}</p>}
      {s.no_meaningful_change && <div className="card--flat p-3 text-[13px] text-[var(--fg-2)]">{s.no_meaningful_change}</div>}
      {Object.values(s.context_coverage || {}).some(Boolean) && <p className="text-[12px] text-[var(--fg-4)]">Personal context uses up to 200 recent watchlist items, 200 holdings by value, and 8 recent transfers. Some older or smaller records are outside this brief.</p>}
      {s.market_regime && (
        <Section title="Market regime">
          <p className="text-[13px] text-[var(--fg-2)]"><b className="uppercase">{s.market_regime.regime}</b>{s.market_regime.flavor ? ` · ${s.market_regime.flavor}` : ''} — {s.market_regime.rationale}</p>
        </Section>
      )}
      {has(s.what_changed_overnight) && (
        <Section title="What changed overnight">
          {s.what_changed_overnight.map((c, i) => <p key={i} className="text-[12px] text-[var(--fg-2)]">· <b>{c.subject}</b> — {c.summary}</p>)}
        </Section>
      )}
      {s.watchlist_impact && (has(s.watchlist_impact.signals) || has(s.watchlist_impact.news)) && (
        <Section title="Watchlist impact">
          {(s.watchlist_impact.signals || []).map((x, i) => <p key={`s${i}`} className="text-[12px] text-[var(--fg-2)]">· <b>{x.subject}</b> <span className={`chip text-[9px] ${SIG_CLS[x.direction] || ''}`}>{x.direction}</span> {x.why}</p>)}
          {(s.watchlist_impact.news || []).map((x, i) => <p key={`n${i}`} className="text-[12px] text-[var(--fg-3)]">· {x.title}</p>)}
        </Section>
      )}
      {s.portfolio_impact && (
        <Section title="Portfolio impact">
          {(s.portfolio_impact.biggest_movers || []).map((m, i) => <p key={i} className="text-[12px] text-[var(--fg-2)]">· <b>{m.symbol}</b> {m.day_change_pct != null ? `${m.day_change_pct > 0 ? '+' : ''}${Number(m.day_change_pct).toFixed(1)}% (24h)` : ''}</p>)}
          {(s.portfolio_impact.signals || []).map((x, i) => <p key={`ps${i}`} className="text-[12px] text-[var(--fg-3)]">· {x.subject}: {x.why}</p>)}
          <p className="text-[10px] text-[var(--fg-5)]">{s.portfolio_impact.framing}</p>
        </Section>
      )}
      {has(s.narrative_heat) && (
        <Section title="Narrative heat">
          {s.narrative_heat.slice(0, 5).map((n, i) => (
            <p key={i} className="text-[12px] text-[var(--fg-2)] flex items-center gap-1.5 flex-wrap">
              · <b>{n.name}</b> <span className="text-[var(--fg-4)]">{String(n.stage || '').replace(/_/g, ' ')}</span>
              {n.signal && <span className={`chip text-[9px] ${SIG_CLS[n.signal] || ''}`}>{n.signal}</span>}
              {(n.clarity_labels || []).slice(0, 1).map((l) => { const m = clarityMeta(l.key); return <span key={l.key} className={`chip text-[9px] ${m.cls}`}>{m.label}</span> })}
            </p>
          ))}
        </Section>
      )}
      {has(s.major_risks) && (
        <Section title="Major risks">
          {s.major_risks.map((r, i) => <p key={i} className="text-[12px] text-[var(--fg-2)]">· <b>{r.subject}</b> — {r.note}</p>)}
        </Section>
      )}
      {has(s.news_that_matters) && (
        <Section title="News that matters">
          {s.news_that_matters.map((x, i) => <p key={i} className="text-[12px] text-[var(--fg-2)]">· {x.title}{x.watchlist_match ? ' ★' : ''}{x.why ? <span className="text-[var(--fg-4)]"> — {x.why}</span> : null}</p>)}
        </Section>
      )}
      {has(s.what_to_watch_next) && (
        <Section title="What to watch next">
          {s.what_to_watch_next.map((w, i) => <p key={i} className="text-[12px] text-[var(--fg-3)]">· {w}</p>)}
        </Section>
      )}
    </div>
  )
}

// P9 — Daily Investor Brief (in-app). Assembled daily by the intel-brief-cron
// from stored intelligence (zero per-org AI); on-demand generation stays
// available and flows through the reuse/delta cache.
export default function BriefsPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const selection = usePortfolioSelection()
  const [briefs, setBriefs] = useState([])
  const [loading, setLoading] = useState(true)
  const brief = useArtifact(selection.portfolioId || '')
  const [error, setError] = useState(null)
  const [nextCursor, setNextCursor] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selectedKey, setSelectedKey] = useState(null)
  const scope = `${org?.id || ''}:${user?.id || ''}`
  const active = useRef(scope); active.current = scope
  const generationScope = `${scope}:${selection.portfolioId || ''}`
  const activeGeneration = useRef(generationScope); activeGeneration.current = generationScope
  const operation = useRef(0)
  const [loadedScope, setLoadedScope] = useState(null)

  // Mark the brief surface as seen on unmount (powers the Intel onboarding
  // checklist "review a brief" item, and the standard what-changed indicator).
  useEffect(() => () => { if (org?.id) markSurfaceSeen(supabase, 'brief', '', { orgId: org.id, userId: user?.id }) }, [org?.id, user?.id, supabase])

  const load = useCallback(async (cursor = null) => {
    if (!org?.id || !user?.id) return
    const seq = ++operation.current
    cursor ? setLoadingMore(true) : setLoading(true)
    setError(null)
    try {
      const page = await listBriefs(supabase, org.id, { cursor, paged: true })
      if (active.current !== scope || operation.current !== seq) return
      setBriefs(previous => cursor ? appendHistoryPage(previous, page.rows) : page.rows)
      setNextCursor(page.nextCursor); setLoadedScope(scope)
    } catch (e) { if (active.current === scope && operation.current === seq) setError(e.message || 'Brief history could not be loaded') }
    finally { if (active.current === scope && operation.current === seq) { setLoading(false); setLoadingMore(false) } }
  }, [org?.id, user?.id, supabase, scope])
  useEffect(() => { setBriefs([]); setSelectedKey(null); setNextCursor(null); load(); return () => { operation.current++ } }, [load])

  const generate = useCallback(async () => {
    if (!org?.id || !user?.id) return
    setError(null)
    const res = await brief.generate({
      artifactType: 'daily_brief', portfolioId: selection.portfolioId, staleMinutes: 720,
      extra: { title: t('briefs.today', { defaultValue: "Today's brief" }) },
      // Server assembly reads this user's verified cached portfolio/watchlist.
    })
    if (activeGeneration.current !== generationScope) return
    if (res?.artifact && !res.blocked) {
      try { const saved = await upsertBrief(supabase, org.id, { briefType: 'daily', artifactId: res.artifact.id }); if (activeGeneration.current === generationScope) { setSelectedKey(`personal:${saved.id}`); await load(); if (activeGeneration.current === generationScope) brief.setResult(null) } }
      catch (e) { if (activeGeneration.current === generationScope) setError(e.message || 'Generated brief could not be saved. Your result is still available above.') }
    }
  }, [org?.id, user?.id, supabase, brief, t, load, generationScope, selection.portfolioId])

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><Newspaper className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
          <h1 className="page-title">{t('nav.briefs', { defaultValue: 'Daily Brief' })}</h1>
          <p className="page-sub">{t('pages.briefs_sub', { defaultValue: 'Your personalized daily investor brief.' })}</p>
        </div>
        <div className="intel-investigation-controls">
        <label className="text-xs text-[var(--fg-3)]">Portfolio<select className="select ml-2" value={selection.portfolioId || ''} onChange={e=>selection.selectPortfolio(e.target.value)} disabled={selection.loading}>{!selection.portfolios.length&&<option value="">No portfolio</option>}{selection.portfolios.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <button onClick={generate} disabled={brief.loading || selection.loading || !!selection.error} className="btn btn--primary btn--sm disabled:opacity-50">
          {brief.loading ? 'Preparing your brief…' : <><Sparkles className="h-4 w-4" /> {t('briefs.generate', { defaultValue: "Generate today's brief" })}</>}
        </button>
        </div>
      </div>

      {brief.loading && <p role="status" className="text-sm text-[var(--fg-3)]">Preparing your brief from saved evidence. You can keep reading the archive.</p>}
      {brief.result && <ArtifactView key={brief.result.artifact?.id} result={brief.result} loading={brief.loading} />}
      {brief.error && <div className="card--flat p-3 text-[13px] text-red-400">{brief.error}</div>}
      {error && <div role="alert" className="text-sm text-red-400">{error} <button className="btn btn--quiet btn--sm" onClick={() => load()}>Retry history</button></div>}

      {loading ? (
        <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
      ) : loadedScope !== scope ? null : briefs.length === 0 ? (
        <div className="card p-8 text-center text-[var(--fg-3)] text-sm">{t('briefs.empty', { defaultValue: 'No briefs yet. Generate your first one above.' })}</div>
      ) : (
        <BriefLibrary briefs={briefs} selectedKey={selectedKey} onSelect={setSelectedKey} nextCursor={nextCursor} loadingMore={loadingMore} onLoadMore={() => load(nextCursor)} renderBrief={b => <React.Fragment key={`${b.scope}:${b.id}`}>
          {b.assembled && Object.keys(b.assembled).length > 0 ? <AssembledBrief b={b} /> : <p className="intel-brief-date">{b.period_date} · {b.brief_type} · {b.scope === 'personal' ? 'Private · only you' : 'Organization history · shared'}</p>}
          {b.artifact && <ArtifactView key={b.artifact.id} result={{ artifact: b.artifact }} />}
        </React.Fragment>} />
      )}

      <IntelDisclaimer variant="block" />
    </div>
  )
}
