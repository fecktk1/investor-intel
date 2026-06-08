import React, { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Activity, Sparkles, ArrowRight, TrendingUp, TrendingDown, Newspaper, Radar, Bell, Bookmark, ExternalLink, RefreshCw } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { loadDashboard } from '../lib/dashboard-api'
import { useArtifact } from '../lib/useArtifact'
import ArtifactView from '../components/ArtifactView'
import RegimeBanner from '../components/RegimeBanner'
import MarketContextCard from '../components/MarketContextCard'
import MarketSignalBadge from '../components/MarketSignalBadge'
import IntelDisclaimer from '../components/IntelDisclaimer'

const STATUS_CLS = { hot: 'chip--err', emerging: 'chip--ok', cooling: 'chip--info' }
const SENT_CLS = { bullish: 'chip--ok', bearish: 'chip--err', mixed: 'chip--info', neutral: '' }
const assetHref = (ref) => `/intel/asset/${encodeURIComponent(ref || '')}`
const fmtPct = (v) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`
const fmtPrice = (p) => p == null ? '—' : p < 1 ? `$${Number(p).toPrecision(3)}` : `$${Number(p).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
const SIG_CLS = { bullish: 'chip--ok', bearish: 'chip--err', mixed: 'chip--info', neutral: '', unclear: 'text-[var(--fg-4)]', data_limited: 'text-[var(--fg-4)]' }
const SIG_LABEL = { bullish: 'Leans bullish', bearish: 'Leans bearish', mixed: 'Mixed', neutral: 'Neutral', unclear: 'Unclear', data_limited: 'Data-limited' }
const PSCOPE_LABEL = { market_wide: 'Market-wide', asset_specific: 'Asset-specific', chain_specific: 'Chain-specific', sector_specific: 'Sector-specific', narrative_specific: 'Narrative-specific', local: 'Asset-specific', unclear: 'Scope unclear' }
const CONF_LABEL = { high: 'High source support', medium: 'Medium confidence', thin: 'Thin coverage', low: 'Thin coverage' }
const timeAgo = (s) => { if (!s) return ''; const h = (Date.now() - new Date(s).getTime()) / 3_600_000; if (Number.isNaN(h)) return ''; if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`; if (h < 24) return `${Math.round(h)}h ago`; return `${Math.round(h / 24)}d ago` }

// One clean, explainable investor news card — never a raw row.
function NotableCard({ c }) {
  const tags = [...(c.chains || []), c.symbol].filter(Boolean).slice(0, 3)
  const a = c.analysis
  return (
    <div className="card--flat p-3 space-y-1.5">
      <div className="flex items-start gap-1.5">
        {c.url
          ? <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-[13px] font-medium text-[var(--fg-1)] hover:text-[var(--accent)] leading-snug">{c.title}<ExternalLink className="inline h-3 w-3 ml-1 text-[var(--fg-5)]" /></a>
          : <span className="text-[13px] font-medium text-[var(--fg-1)] leading-snug">{c.title}</span>}
      </div>
      <div className="text-[11px] text-[var(--fg-4)] flex items-center gap-1.5 flex-wrap">
        {c.source_category && <span className="chip text-[9px] uppercase">{c.source_category}</span>}
        <span className="text-[var(--fg-3)]">{c.source_name}</span>
        {c.published_at && <span>· {timeAgo(c.published_at)}</span>}
        {tags.length > 0 && <span>· {tags.join(' / ')}</span>}
        {c.source_support > 1 && <span>· {c.source_support} sources</span>}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`chip text-[10px] ${SIG_CLS[c.signal] || ''}`}>{SIG_LABEL[c.signal] || c.signal}</span>
        <span className="chip text-[10px]">{PSCOPE_LABEL[c.scope] || c.scope}</span>
        <span className="chip text-[10px] text-[var(--fg-4)]">{CONF_LABEL[c.confidence] || c.confidence}</span>
      </div>
      <MarketContextCard ctx={c.market_context} variant="flat" />
      {a && (a.what_happened || a.why_it_matters || a.crypto_market_impact) ? (
        <div className="space-y-1 pt-0.5 text-[12px] leading-snug">
          {a.what_happened && <p className="text-[var(--fg-2)]"><span className="text-[var(--fg-5)]">What happened: </span>{a.what_happened}</p>}
          {a.why_it_matters && <p className="text-[var(--fg-2)]"><span className="text-[var(--fg-5)]">Why it matters: </span>{a.why_it_matters}</p>}
          {a.crypto_market_impact && <p className="text-[var(--fg-2)]"><span className="text-[var(--fg-5)]">Crypto impact: </span>{a.crypto_market_impact}</p>}
          {a.what_to_watch && <p className="text-[var(--fg-3)]"><span className="text-[var(--fg-5)]">Watch: </span>{a.what_to_watch}</p>}
        </div>
      ) : (c.supporting_facts?.length > 0 && (
        <ul className="text-[11px] text-[var(--fg-4)] space-y-0.5 pt-0.5">{c.supporting_facts.slice(0, 3).map((f, i) => <li key={i}>· {f}</li>)}</ul>
      ))}
    </div>
  )
}

const SIG_CONF = { high: 'High confidence', medium: 'Medium confidence', low: 'Lower confidence' }
// One ranked Signal Radar card — facts + interpretation, never a bare chip.
function SignalCard({ s }) {
  return (
    <div className="card--flat p-3 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[13px] font-semibold text-[var(--fg-1)]">{s.asset_symbol ? `$${s.asset_symbol}` : s.name}</span>
        {s.kind === 'chain' && <span className="text-[11px] text-[var(--fg-4)]">chain</span>}
        <span className={`chip text-[10px] ${SIG_CLS[s.direction] || ''}`}>{SIG_LABEL[s.direction] || s.direction}</span>
      </div>
      <div className="text-[11px]"><span className="text-[var(--accent)]">{s.signal_type}</span><span className="text-[var(--fg-4)]"> · {PSCOPE_LABEL[s.signal_scope] || s.signal_scope} · {s.time_window} · {SIG_CONF[s.confidence] || s.confidence}</span></div>
      <MarketContextCard ctx={s.market_context} variant="flat" />
      {s.supporting_facts?.length > 0 && <ul className="text-[11px] text-[var(--fg-3)] space-y-0.5">{s.supporting_facts.slice(0, 3).map((f, i) => <li key={i}>· {f}</li>)}</ul>}
      {s.why_it_matters && <p className="text-[12px] text-[var(--fg-2)] leading-snug"><span className="text-[var(--fg-5)]">Why it matters: </span>{s.why_it_matters}</p>}
      {s.what_to_watch_next && <p className="text-[12px] text-[var(--fg-3)] leading-snug"><span className="text-[var(--fg-5)]">Watch next: </span>{s.what_to_watch_next}</p>}
    </div>
  )
}

// P3 — Scope-aware home dashboard: Everything / By chain / Following, with a
// chain selector and a per-chain project sub-selector.
export default function MarketPulsePage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [dash, setDash] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [scope, setScope] = useState('all')        // all | chain | following
  const [chain, setChain] = useState(null)
  const [project, setProject] = useState(null)     // selected project symbol within a chain
  const summary = useArtifact()

  const load = useCallback(async (sc, ch) => {
    if (!org?.id) return
    setLoading(true); setError(null)
    try { setDash(await loadDashboard(supabase, org.id, { scope: sc, chain: ch })) } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [org?.id, supabase])
  useEffect(() => { load(scope, chain) }, [scope, chain, load])

  const pickScope = (sc) => {
    setProject(null)
    if (sc === 'chain') { const first = dash?.followed_chains?.[0]?.id || dash?.available_chains?.[0]?.id || null; setChain(first); setScope('chain') }
    else { setChain(null); setScope(sc) }
  }

  const genSummary = useCallback(() => {
    summary.generate({
      artifactType: 'explain',
      extra: { title: 'Market Pulse', question: `Summarize what I should pay attention to ${scope === 'chain' ? `on ${chain}` : 'across everything I follow'} right now — notable changes, news and trends. For each notable item, briefly say why it matters for a crypto investor and whether the impact looks local to one asset or broader (chain / sector / narrative / market-wide). High-level, balanced, risk-aware research context — not advice.` },
      context: { scope, chain, movers: dash?.movers, news: (dash?.news || []).map((n) => ({ title: n.title, sentiment: n.sentiment })), narratives: (dash?.narratives || []).map((n) => ({ title: n.title, status: n.status })) },
    })
  }, [summary, dash, scope, chain])

  // Client-side project filter within a chain.
  const movers = (dash?.movers || []).filter((m) => !project || m.symbol === project)
  const news = (dash?.news || []).filter((n) => !project || (n.entity_symbol || n.entity?.display_symbol) === project)

  if (loading && !dash) return <div className="card p-10 grid place-items-center"><div className="animate-spin rounded-full h-7 w-7 border-b-2 border-[var(--accent)]" /></div>
  const empty = dash && dash.total_following === 0 && (dash.notable || []).length === 0 && (dash.signals || []).length === 0 && (dash.movers || []).length === 0 && (dash.chain_perf || []).length === 0

  const ScopeBtn = ({ id, label }) => (
    <button onClick={() => pickScope(id)} className={`btn btn--sm ${scope === id ? 'btn--primary' : 'btn--ghost'}`}>{label}</button>
  )

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><Activity className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
          <h1 className="page-title">{t('nav.market_pulse', { defaultValue: 'Market Pulse' })}</h1>
          <p className="page-sub">{t('pages.market_pulse_sub', { defaultValue: 'A live update of everything you follow.' })}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => load(scope, chain)} disabled={loading} title={t('pulse.refresh', { defaultValue: 'Refresh' })} className="btn btn--ghost btn--sm disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
          <button onClick={genSummary} disabled={summary.loading || empty} className="btn btn--primary btn--sm disabled:opacity-50">
            {summary.loading ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : <><Sparkles className="h-4 w-4" /> {t('pulse.generate', { defaultValue: 'What matters now' })}</>}
          </button>
        </div>
      </div>

      <RegimeBanner />

      {/* Scope selector */}
      <div className="flex items-center gap-2 flex-wrap">
        <ScopeBtn id="all" label={t('pulse.scope_all', { defaultValue: 'Everything' })} />
        <ScopeBtn id="chain" label={t('pulse.scope_chain', { defaultValue: 'By chain' })} />
        <ScopeBtn id="following" label={t('pulse.scope_following', { defaultValue: 'Following' })} />
      </div>

      {/* Chain + project selectors */}
      {scope === 'chain' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            {(dash?.followed_chains || []).map((c) => (
              <button key={c.id} onClick={() => { setChain(c.id); setProject(null) }} className={chain === c.id ? 'chip chip--accent' : 'chip'}>{c.label}{c.item_count ? ` · ${c.item_count}` : ''}</button>
            ))}
            <select className="select" value={chain || ''} onChange={(e) => { setChain(e.target.value); setProject(null) }}>
              <option value="">{t('pulse.pick_chain', { defaultValue: 'Any chain…' })}</option>
              {(dash?.available_chains || []).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          {(dash?.projects || []).length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-[var(--fg-4)]">{t('pulse.projects', { defaultValue: 'Projects' })}:</span>
              <button onClick={() => setProject(null)} className={!project ? 'chip chip--accent text-[11px]' : 'chip text-[11px]'}>{t('pulse.all', { defaultValue: 'All' })}</button>
              {dash.projects.map((p) => (
                <button key={p.symbol} onClick={() => setProject(p.symbol)} className={project === p.symbol ? 'chip chip--accent text-[11px]' : 'chip text-[11px]'}>
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

      {error && <div className="card--flat p-3 text-[13px] text-red-400">{error}</div>}
      {summary.result && <ArtifactView result={summary.result} loading={summary.loading} />}

      {empty ? (
        <div className="card p-8 text-center text-[var(--fg-3)] text-sm">
          {t('pulse.empty_home', { defaultValue: 'Add tokens, wallets and narratives to your watchlist and follow some sources — your dashboard fills in automatically.' })}
          <div className="mt-3 flex justify-center gap-2"><Link to="/intel/watchlist" className="btn btn--primary btn--sm">{t('nav.watchlist', { defaultValue: 'My Watchlist' })}</Link><Link to="/intel/news" className="btn btn--ghost btn--sm">{t('nav.news', { defaultValue: 'News' })}</Link></div>
        </div>
      ) : (
        <>
          {scope === 'all' && (
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
              <Link to="/intel/watchlist" className="card p-3"><div className="text-[10px] text-[var(--fg-4)] uppercase">{t('pulse.following', { defaultValue: 'Following' })}</div><div className="text-2xl font-bold">{dash?.total_following ?? 0}</div></Link>
              <Link to="/intel/alerts" className="card p-3"><div className="text-[10px] text-[var(--fg-4)] uppercase">{t('pulse.unread_alerts', { defaultValue: 'New alerts' })}</div><div className={`text-2xl font-bold ${dash?.unread_alerts ? 'text-[var(--accent)]' : ''}`}>{dash?.unread_alerts ?? 0}</div></Link>
              <Link to="/intel/narratives" className="card p-3"><div className="text-[10px] text-[var(--fg-4)] uppercase">{t('nav.narratives', { defaultValue: 'Narratives' })}</div><div className="text-2xl font-bold">{(dash?.narratives || []).length}</div></Link>
              <Link to="/intel/news" className="card p-3"><div className="text-[10px] text-[var(--fg-4)] uppercase">{t('nav.news', { defaultValue: 'News' })}</div><div className="text-2xl font-bold">{(dash?.news || []).length}</div></Link>
            </div>
          )}

          {movers.length > 0 && (
            <section className="space-y-2">
              <div className="eyebrow">{t('pulse.notable_changes', { defaultValue: 'Notable changes' })}</div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {movers.map((m) => (
                  <Link key={m.ref} to={assetHref(m.ref)} className="card p-3 hover:bg-[var(--bg-2)] transition-colors">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-[var(--fg-1)] truncate">{m.symbol}</span>
                      <span className={`text-[13px] font-semibold flex items-center gap-0.5 ${m.change24h >= 0 ? 'text-[var(--ok)]' : 'text-red-400'}`}>{m.change24h >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}{fmtPct(m.change24h)}</span>
                    </div>
                    <div className="text-[12px] text-[var(--fg-4)] mt-0.5">{fmtPrice(m.price)}</div>
                    {m.market_context?.direction && <div className="mt-1"><MarketSignalBadge direction={m.market_context.direction} size="sm" /></div>}
                  </Link>
                ))}
              </div>
            </section>
          )}

          {(dash?.chain_perf || []).length > 0 && (
            <section className="space-y-2">
              <div className="eyebrow">{t('pulse.chains_followed', { defaultValue: 'Chains you follow' })}</div>
              <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
                {dash.chain_perf.map((c) => (
                  <Link key={c.chain_id} to={assetHref(c.ref || `native:${c.chain_id}`)} className="card p-3 block hover:bg-[var(--bg-2)] transition-colors">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-[var(--fg-1)] truncate">{c.label}</span>
                      {c.change_24h != null && <span className={`text-[13px] font-semibold flex items-center gap-0.5 ${c.change_24h >= 0 ? 'text-[var(--ok)]' : 'text-red-400'}`}>{c.change_24h >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}{fmtPct(c.change_24h)}</span>}
                    </div>
                    <div className="text-[11px] text-[var(--fg-4)] mt-0.5">{c.symbol}{c.price != null ? ` · ${fmtPrice(c.price)}` : ''}</div>
                  </Link>
                ))}
              </div>
            </section>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="eyebrow flex items-center gap-1.5"><Newspaper className="h-3.5 w-3.5" /> {t('pulse.notable_news', { defaultValue: 'Notable news' })}</div>
                <Link to="/intel/news" className="text-[12px] text-[var(--accent)] flex items-center gap-1">{t('pulse.all', { defaultValue: 'All' })} <ArrowRight className="h-3 w-3" /></Link>
              </div>
              {news.length === 0 ? <p className="text-[13px] text-[var(--fg-3)]">{t('pulse.no_news', { defaultValue: 'No high-confidence notable news found yet. Monitoring fresh market, social, and on-chain signals.' })}</p> : (
                <div className="space-y-2">
                  {news.slice(0, scope === 'chain' ? 8 : 5).map((c) => <NotableCard key={c.story_hash || c.title} c={c} />)}
                </div>
              )}
              {(dash?.developing || []).length > 0 && (
                <div className="mt-3 pt-2 border-t border-[color:var(--border-default)]">
                  <div className="text-[10px] uppercase tracking-wide text-[var(--fg-5)] mb-1.5">{t('pulse.developing', { defaultValue: 'Developing chatter · lower confidence' })}</div>
                  <div className="space-y-1">
                    {dash.developing.slice(0, 4).map((c) => (
                      <div key={c.story_hash} className="text-[12px] text-[var(--fg-3)] flex items-center gap-1.5 min-w-0">
                        <span className={`chip text-[9px] ${SIG_CLS[c.signal] || ''}`}>{(SIG_LABEL[c.signal] || c.signal || '?').replace('Leans ', '')}</span>
                        {c.url ? <a href={c.url} target="_blank" rel="noopener noreferrer" className="truncate hover:text-[var(--accent)]">{c.title}</a> : <span className="truncate">{c.title}</span>}
                        {c.symbol && <span className="text-[var(--fg-5)] flex-shrink-0">· {c.symbol}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <section className="card p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="eyebrow flex items-center gap-1.5"><Radar className="h-3.5 w-3.5" /> {t('pulse.signal_radar', { defaultValue: 'Signal Radar' })}</div>
                <Link to="/intel/narratives" className="text-[12px] text-[var(--accent)] flex items-center gap-1">{t('pulse.all', { defaultValue: 'All' })} <ArrowRight className="h-3 w-3" /></Link>
              </div>
              {(dash?.signals || []).length === 0 ? (
                <div className="text-[12px] text-[var(--fg-3)] space-y-2">
                  <p>{t('pulse.no_signals', { defaultValue: 'No strong signals detected yet. We are monitoring chatter, market movement, wallets, DeFi activity, and source history.' })}</p>
                  <div className="flex flex-wrap gap-1.5">{['Chatter velocity', 'Wallet movement', 'Price/volume', 'DeFi TVL/APY', 'Narrative momentum', 'Source history'].map((x) => <span key={x} className="chip text-[10px] text-[var(--fg-4)]">{x}</span>)}</div>
                </div>
              ) : (
                <div className="space-y-2">{dash.signals.map((s) => <SignalCard key={s.id} s={s} />)}</div>
              )}
            </section>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="eyebrow flex items-center gap-1.5"><Bell className="h-3.5 w-3.5" /> {t('pulse.recent_alerts', { defaultValue: 'Recent alerts' })}</div>
                <Link to="/intel/alerts" className="text-[12px] text-[var(--accent)] flex items-center gap-1">{t('pulse.all', { defaultValue: 'All' })} <ArrowRight className="h-3 w-3" /></Link>
              </div>
              {(dash?.alerts || []).length === 0 ? (
                <div className="space-y-2">
                  <p className="text-[13px] text-[var(--fg-3)]">{t('pulse.no_alerts', { defaultValue: 'No alerts fired yet. Useful rules to set:' })}</p>
                  <div className="flex flex-wrap gap-1.5">{['Watchlist price/volume move', 'Narrative momentum shift', 'Macro event affecting crypto', 'Wallet movement', 'DeFi TVL/APY change', 'Bull/bear signal flip'].map((x) => <Link key={x} to="/intel/alerts" className="chip text-[11px]">{x}</Link>)}</div>
                </div>
              ) : (
                <div className="space-y-1.5">{dash.alerts.slice(0, 6).map((a) => (
                  <div key={a.id} className="flex items-center justify-between text-[13px]"><span className="text-[var(--fg-2)] truncate">{a.payload?.symbol ? <b>{a.payload.symbol} </b> : null}{t(`alerts.triggers.${a.payload?.trigger_type}`, { defaultValue: a.payload?.trigger_type || 'alert' })}{a.payload?.value != null ? ` ${Number(a.payload.value).toFixed(1)}%` : ''}</span><span className="text-[11px] text-[var(--fg-5)] flex-shrink-0">{new Date(a.fired_at).toLocaleDateString()}</span></div>
                ))}</div>
              )}
            </section>

            <section className="card p-4">
              <div className="flex items-center justify-between mb-2"><div className="eyebrow flex items-center gap-1.5"><Bookmark className="h-3.5 w-3.5" /> {t('pulse.brief_research', { defaultValue: 'Brief & research' })}</div><Link to="/intel/briefs" className="text-[12px] text-[var(--accent)] flex items-center gap-1">{t('nav.briefs', { defaultValue: 'Briefs' })} <ArrowRight className="h-3 w-3" /></Link></div>
              {dash?.latest_brief?.artifact?.structured?.summary ? <Link to="/intel/briefs" className="block mb-2"><div className="text-[11px] text-[var(--fg-4)]">{dash.latest_brief.period_date} · {dash.latest_brief.brief_type}</div><p className="text-[13px] text-[var(--fg-2)] line-clamp-2">{dash.latest_brief.artifact.structured.summary}</p></Link> : (
                <div className="mb-2">
                  <p className="text-[13px] text-[var(--fg-3)] mb-1">{t('pulse.brief_preview', { defaultValue: 'A Daily Brief covers:' })}</p>
                  <ul className="text-[12px] text-[var(--fg-4)] space-y-0.5 mb-2 list-disc pl-4"><li>{t('pulse.brief_b1', { defaultValue: 'Top bullish & bearish forces' })}</li><li>{t('pulse.brief_b2', { defaultValue: 'Macro impact + market regime' })}</li><li>{t('pulse.brief_b3', { defaultValue: 'Watchlist & thesis impact' })}</li><li>{t('pulse.brief_b4', { defaultValue: 'What to monitor next' })}</li></ul>
                  <Link to="/intel/briefs" className="btn btn--primary btn--sm">{t('pulse.gen_brief', { defaultValue: 'Generate Daily Brief' })}</Link>
                </div>
              )}
              {(dash?.recent_research || []).length > 0 && <div className="space-y-1 border-t border-[var(--border-subtle)] pt-2">{dash.recent_research.slice(0, 4).map((r) => <Link key={r.id} to="/intel/research" className="flex items-center justify-between text-[12px] text-[var(--fg-3)] hover:text-[var(--fg-1)]"><span className="truncate">{r.title || r.artifact_type}</span><span className="text-[10px] text-[var(--fg-5)] uppercase flex-shrink-0">{(r.artifact_type || '').replace(/_/g, ' ')}</span></Link>)}</div>}
            </section>
          </div>
        </>
      )}

      <IntelDisclaimer variant="block" />
    </div>
  )
}
