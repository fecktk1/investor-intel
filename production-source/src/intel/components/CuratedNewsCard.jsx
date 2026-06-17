import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, TrendingUp, TrendingDown, AlertTriangle, ShieldCheck, ChevronDown } from 'lucide-react'
import MarketSignalBadge from './MarketSignalBadge'

const QUALITY = (q) => q == null ? null
  : q >= 75 ? { cls: 'text-emerald-400', key: 'q_high', def: 'High-quality source' }
  : q >= 45 ? { cls: 'text-[var(--fg-4)]', key: 'q_med', def: 'Standard source' }
  : { cls: 'text-amber-400', key: 'q_low', def: 'Low-quality source' }

const normSignal = (s) => {
  const v = String(s || '').toLowerCase()
  if (v === 'bullish' || v === 'bearish' || v === 'caution' || v === 'neutral') return v
  if (v === 'mixed') return 'caution'
  return null
}

// supporting_sources items vary in shape (string | object) — fall back through
// the common name/handle/url keys so we never render "[object Object]".
const srcLabel = (s) => {
  if (!s) return 'Source'
  if (typeof s === 'string') return s
  const direct = s.source_name || s.name || s.title || s.publication || s.outlet || s.handle
  if (direct) return String(direct)
  if (s.url) { try { return new URL(s.url).hostname.replace(/^www\./, '') } catch { return String(s.url) } }
  return 'Source'
}
const srcUrl = (s) => (s && typeof s === 'object') ? (s.url || s.link || null) : null

// Rich curated-news card — the AI-analyzed story (what happened, why it matters,
// bull/bear, source quality, verification) from intel_curated_news, ranked by
// final_score. Read-only surfacing of data the curation pipeline already produces.
export default function CuratedNewsCard({ c }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const title = c.cleaned_title || c.title
  const q = QUALITY(c.source_quality_score)
  const sig = normSignal(c.signal || c.signal_bias)
  const tags = [...(c.tokens || []), ...(c.narratives || [])].filter(Boolean).slice(0, 4)
  const [showSources, setShowSources] = useState(false)
  const supporting = Array.isArray(c.supporting_sources) ? c.supporting_sources : []
  const srcCats = Array.isArray(c.source_categories) ? c.source_categories : []
  const sourceCount = c.source_count || supporting.length || srcCats.length || 0
  const hasSourceDetail = supporting.length > 0 || srcCats.length > 0
  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        {c.primary_url
          ? <a href={c.primary_url} target="_blank" rel="noopener noreferrer" className="text-[13px] font-medium text-[var(--fg-1)] hover:text-[var(--accent)] leading-snug flex items-start gap-1.5 min-w-0">{title}<ExternalLink className="h-3 w-3 flex-shrink-0 text-[var(--fg-5)] mt-0.5" /></a>
          : <span className="text-[13px] font-medium text-[var(--fg-1)] leading-snug min-w-0">{title}</span>}
        {sig && <MarketSignalBadge direction={sig} size="sm" />}
      </div>

      <div className="flex items-center gap-2 flex-wrap text-[11px] text-[var(--fg-4)]">
        {c.news_category && <span className="chip text-[9px]">{String(c.news_category).replace(/_/g, ' ')}</span>}
        {q && <span className={`text-[10px] inline-flex items-center gap-0.5 ${q.cls}`} title={t('news.source_quality', { defaultValue: 'Source quality' })}><ShieldCheck className="h-3 w-3" />{t(`news.${q.key}`, { defaultValue: q.def })}</span>}
        {c.needs_confirmation && <span className="text-[10px] text-amber-400 inline-flex items-center gap-0.5" title={t('news.unverified_hint', { defaultValue: 'Single-source or developing — not yet corroborated.' })}><AlertTriangle className="h-3 w-3" />{t('news.unverified', { defaultValue: 'Unverified' })}</span>}
        {(sourceCount > 1 || hasSourceDetail) && (
          <button type="button" onClick={() => setShowSources((v) => !v)} className="inline-flex items-center gap-0.5 hover:text-[var(--fg-2)]" aria-expanded={showSources}>
            {sourceCount ? `${sourceCount} ` : ''}{t('news.sources', { defaultValue: 'sources' })}
            <ChevronDown className={`h-3 w-3 transition-transform ${showSources ? 'rotate-180' : ''}`} />
          </button>
        )}
        {c.published_at && <span>{new Date(c.published_at).toLocaleDateString()}</span>}
      </div>

      {showSources && hasSourceDetail && (
        <div className="card--flat p-2 space-y-1">
          {supporting.length > 0
            ? supporting.slice(0, 12).map((s, i) => {
                const lbl = srcLabel(s); const url = srcUrl(s)
                return (
                  <div key={i} className="text-[11px] truncate">
                    {url
                      ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-[var(--fg-3)] hover:text-[var(--accent)] inline-flex items-center gap-1 max-w-full"><span className="truncate">{lbl}</span><ExternalLink className="h-2.5 w-2.5 flex-shrink-0 text-[var(--fg-5)]" /></a>
                      : <span className="text-[var(--fg-3)]">{lbl}</span>}
                  </div>
                )
              })
            : <div className="flex flex-wrap gap-1">{srcCats.map((c2, i) => <span key={i} className="chip text-[9px] text-[var(--fg-4)]">{c2}</span>)}</div>}
        </div>
      )}

      {(c.what_happened || c.why_it_matters || c.crypto_impact) && (
        <div className="space-y-1 text-[12px] leading-snug">
          {c.what_happened && <p className="text-[var(--fg-2)]"><span className="text-[var(--fg-5)]">{t('impact.what_happened', { defaultValue: 'What happened' })}: </span>{c.what_happened}</p>}
          {c.why_it_matters && <p className="text-[var(--fg-2)]"><span className="text-[var(--fg-5)]">{t('impact.why', { defaultValue: 'Why it matters' })}: </span>{c.why_it_matters}</p>}
          {c.crypto_impact && <p className="text-[var(--fg-3)]"><span className="text-[var(--fg-5)]">{t('impact.crypto', { defaultValue: 'Crypto impact' })}: </span>{c.crypto_impact}</p>}
        </div>
      )}

      {(c.bull_case || c.bear_case) && (
        <div className="grid sm:grid-cols-2 gap-2">
          {c.bull_case && <div className="card--flat p-2"><div className="text-[10px] uppercase text-emerald-400 flex items-center gap-1"><TrendingUp className="h-3 w-3" />{t('artifact.bull', { defaultValue: 'Bull case' })}</div><p className="text-[11px] text-[var(--fg-3)] mt-0.5 leading-snug">{c.bull_case}</p></div>}
          {c.bear_case && <div className="card--flat p-2"><div className="text-[10px] uppercase text-red-400 flex items-center gap-1"><TrendingDown className="h-3 w-3" />{t('artifact.bear', { defaultValue: 'Bear case' })}</div><p className="text-[11px] text-[var(--fg-3)] mt-0.5 leading-snug">{c.bear_case}</p></div>}
        </div>
      )}

      {tags.length > 0 && <div className="flex flex-wrap gap-1">{tags.map((x, i) => <span key={i} className="chip text-[9px] text-[var(--fg-4)]">{x}</span>)}</div>}

      {c.watch_next && <p className="text-[11px] text-[var(--fg-4)] leading-snug"><span className="text-[var(--fg-5)]">{t('artifact.watch', { defaultValue: 'What to watch' })}: </span>{c.watch_next}</p>}
    </div>
  )
}
