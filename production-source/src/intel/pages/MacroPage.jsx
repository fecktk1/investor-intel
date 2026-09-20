import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Landmark, CalendarClock, Newspaper, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { useSupabase } from '../../lib/useSupabase'
import { loadMacroNews, loadMacroIndicators, loadMacroCalendar } from '../lib/macro-api'
import WhyImportant from '../components/WhyImportant'
import IntelDisclaimer from '../components/IntelDisclaimer'
import { IntelHeroRead, IntelPageHeader, IntelPageShell, IntelSkeleton } from '../components/IntelPrimitives'
import { providerLabel } from '../lib/source-receipt'

const trendIcon = (tr) => tr === 'up' ? <TrendingUp className="h-3.5 w-3.5 text-emerald-400" /> : tr === 'down' ? <TrendingDown className="h-3.5 w-3.5 text-red-400" /> : <Minus className="h-3.5 w-3.5 text-[var(--fg-4)]" />
const fmtWhen = (s) => { if (!s) return ''; const d = new Date(s); return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }
const fmtDay = (s) => { if (!s) return ''; const d = new Date(s); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }
const sentClass = (s) => s === 'bullish' ? 'text-emerald-400' : s === 'bearish' ? 'text-red-400' : 'text-[var(--fg-4)]'
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDaysLocal = (d, days) => {
  const next = new Date(d)
  next.setDate(next.getDate() + days)
  return next
}
const calendarBucket = (scheduledAt) => {
  const date = scheduledAt ? new Date(scheduledAt) : null
  if (!date || Number.isNaN(date.getTime())) return 'later'
  const today = startOfDay(new Date())
  const day = startOfDay(date)
  if (day.getTime() === today.getTime()) return 'today'
  if (day < addDaysLocal(today, 7)) return 'week'
  if (day < addDaysLocal(today, 14)) return 'next'
  return 'later'
}

// Macro Intelligence — market-wide context for retail investors. Reuses the
// shared global macro store (indicators + calendar) and the high-signal macro
// news every org already retains. Every item has a "Why is this important?"
// button that runs the same Explain This generation.
export default function MacroPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { supabase } = useSupabase()
  const [indicators, setIndicators] = useState([])
  const [calendar, setCalendar] = useState([])
  const [news, setNews] = useState([])
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState({})
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      setErrors({})
      const results = await Promise.allSettled([
        loadMacroIndicators(supabase),
        loadMacroCalendar(supabase, { days: 21 }),
        loadMacroNews(supabase, { limit: 40 }),
      ])
      if (!alive) return
      const failures = {}
      const values = results.map((result, i) => {
        if (result.status === 'fulfilled' && Array.isArray(result.value)) return result.value
        failures[['indicators', 'calendar', 'news'][i]] = true
        return []
      })
      setIndicators(values[0]); setCalendar(values[1]); setNews(values[2]); setErrors(failures); setLoading(false)
    })()
    return () => { alive = false }
  }, [supabase, attempt])
  const count = (key, value) => loading ? t('common.loading', { defaultValue: 'Loading…' }) : errors[key]
    ? t('common.unavailable', { defaultValue: 'Unavailable' }) : value.toLocaleString()
  const readError = (key, fallback) => <div role="alert"><p>{t(`macro.${key}_failed`, { defaultValue: fallback })}</p>
    <button type="button" onClick={() => setAttempt(n => n + 1)}>{t('common.retry', { defaultValue: 'Retry' })}</button></div>
  const calendarGroups = useMemo(() => {
    const defs = [
      { key: 'today', label: t('macro.today', { defaultValue: 'Today' }), items: [] },
      { key: 'week', label: t('macro.this_week', { defaultValue: 'This week' }), items: [] },
      { key: 'next', label: t('macro.next_week', { defaultValue: 'Next week' }), items: [] },
      { key: 'later', label: t('macro.later', { defaultValue: 'Later' }), items: [] },
    ]
    const byKey = Object.fromEntries(defs.map((g) => [g.key, g]))
    for (const event of calendar) byKey[calendarBucket(event.scheduled_at)].items.push(event)
    return defs.filter((g) => g.items.length > 0)
  }, [calendar, t])
  const highImportanceCount = calendar.filter((e) => e.importance === 'high').length

  return (
    <IntelPageShell className="intel-macro-page">
      <IntelPageHeader
        icon={Landmark}
        eyebrow={t('brand.name', { defaultValue: 'Investor Intel' })}
        title={t('macro.title', { defaultValue: 'Macro Intelligence' })}
        subtitle={t('macro.sub', { defaultValue: 'The big picture: market-moving news, key economic data and what is coming up.' })}
      />

      <IntelHeroRead
        eyebrow={t('macro.read', { defaultValue: 'Macro read' })}
        title={t('macro.read_title', { defaultValue: 'Indicators, scheduled events, and macro headlines in one review path' })}
        body={t('macro.read_body', { defaultValue: 'Scan the current data first, then review upcoming economic events grouped by timing, and finish with corroborated macro headlines. Explain actions remain available on each item for education-only context.' })}
        meta={[
          { label: t('macro.data', { defaultValue: 'Economic data' }), value: count('indicators', indicators.length) },
          { label: t('macro.calendar', { defaultValue: 'Economic calendar' }), value: count('calendar', calendar.length) },
          { label: t('macro.high_importance', { defaultValue: 'High importance' }), value: count('calendar', highImportanceCount) },
          { label: t('macro.news', { defaultValue: 'Big macro news' }), value: count('news', news.length) },
        ]}
      />

      <div className="hidden">
        <div className="eyebrow flex items-center gap-1.5"><Landmark className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
        <h1 className="page-title">{t('macro.title', { defaultValue: 'Macro Intelligence' })}</h1>
        <p className="page-sub">{t('macro.sub', { defaultValue: 'The big picture: market-moving news, key economic data and what’s coming up.' })}</p>
      </div>

      <div className="intel-macro-results" aria-busy={loading}>
      {loading && <div role="status"><p>{t('macro.loading', { defaultValue: 'Loading macro sources…' })}</p><IntelSkeleton className="h-40" /></div>}

      {!loading && (
        <>
          {/* Economic data */}
          <section className="space-y-2">
            <div className="eyebrow flex items-center gap-1.5"><TrendingUp className="h-3.5 w-3.5" /> {t('macro.data', { defaultValue: 'Economic data' })}</div>
            {errors.indicators ? readError('indicators', 'Economic indicators could not be loaded. Coverage is unknown.') : indicators.length === 0 ? (
              <div className="card p-6 text-center text-[13px] text-[var(--fg-4)]">{t('macro.no_data', { defaultValue: 'Economic indicators will appear here once the daily macro refresh has run.' })}</div>
            ) : (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {indicators.map((m) => (
                  <div key={m.metric_key} className="card p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] text-[var(--fg-4)] leading-tight">{m.label}</div>
                      {trendIcon(m.trend)}
                    </div>
                    <div className="text-lg font-semibold text-[var(--fg-1)] mt-1">{m.value}{m.unit ? <span className="text-[12px] text-[var(--fg-4)] ml-0.5">{m.unit}</span> : null}</div>
                    {m.change != null && String(m.change).trim() && String(m.change).trim() !== '—' && <div className={`text-[11px] mt-0.5 ${/up|ris|gain|pos/i.test(String(m.trend || '')) ? 'text-emerald-400' : /down|fall|drop|neg/i.test(String(m.trend || '')) ? 'text-red-400' : 'text-[var(--fg-4)]'}`}>{m.change}</div>}
                    {(m.as_of || m.period) && <div className="text-[10px] text-[var(--fg-5)] mt-0.5">{m.period || m.as_of}</div>}
                    {/* Each indicator names the body that published it. The store
                        already records this (intel_macro_indicators.raw.source plus
                        source_url), so the card states its issuer rather than leaving
                        a number with no author. An indicator with no recorded source
                        says so in words rather than showing nothing. */}
                    <div className="text-[10px] text-[var(--fg-5)] mt-0.5">
                      {m.raw?.source
                        ? (m.source_url
                          ? <a href={m.source_url} target="_blank" rel="noreferrer" className="underline underline-offset-2">{t('figure_source.line', { source: providerLabel(m.raw.source, t), defaultValue: 'Source: {{source}}' })}</a>
                          : t('figure_source.line', { source: providerLabel(m.raw.source, t), defaultValue: 'Source: {{source}}' }))
                        : t('figure_source.unknown', { defaultValue: 'The source of this figure was not reported.' })}
                    </div>
                    <WhyImportant topic={`${m.label}${m.value != null ? ` is currently ${m.value}${m.unit || ''}` : ''}`} context="A macroeconomic indicator." />
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Economic calendar */}
          <section className="space-y-2">
            <div className="eyebrow flex items-center gap-1.5"><CalendarClock className="h-3.5 w-3.5" /> {t('macro.calendar', { defaultValue: 'Economic calendar' })}</div>
            {errors.calendar ? readError('calendar', 'The calendar could not be loaded. Upcoming event coverage is unknown.') : calendar.length === 0 ? (
              <div className="card p-6 text-center text-[13px] text-[var(--fg-4)]">{t('macro.calendar_empty', { defaultValue: 'No upcoming events in the loaded calendar. Coverage may be incomplete.' })}</div>
            ) : (
              <div className="space-y-4">
                {calendarGroups.map((group) => (
                  <div key={group.key} className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[12px] font-semibold text-[var(--fg-2)]">{group.label}</div>
                      <span className="chip text-[10px]">{group.items.length}</span>
                    </div>
                    {group.items.map((e) => (
                  <div key={e.id} className="card p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[13px] font-medium text-[var(--fg-1)]">{e.title}</span>
                          {e.importance && <span className={`chip ${e.importance === 'high' ? 'text-red-400' : e.importance === 'medium' ? 'text-amber-400' : 'text-[var(--fg-4)]'}`}>{e.importance}</span>}
                          {e.country && <span className="text-[10px] text-[var(--fg-5)]">{e.country}</span>}
                        </div>
                        <div className="text-[11px] text-[var(--fg-4)] mt-0.5">
                          {fmtWhen(e.scheduled_at)}
                          {e.forecast != null ? ` · ${t('macro.forecast', { defaultValue: 'forecast' })} ${e.forecast}` : ''}
                          {e.previous != null ? ` · ${t('macro.previous', { defaultValue: 'prev' })} ${e.previous}` : ''}
                        </div>
                      </div>
                      <div className="text-[11px] text-[var(--fg-4)] whitespace-nowrap">{fmtDay(e.scheduled_at)}</div>
                    </div>
                    <WhyImportant topic={`${e.title} (scheduled ${fmtWhen(e.scheduled_at)})`} context="An upcoming scheduled macroeconomic event." />
                  </div>
                ))}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Big macro news */}
          <section className="space-y-2">
            <div className="eyebrow flex items-center gap-1.5"><Newspaper className="h-3.5 w-3.5" /> {t('macro.news', { defaultValue: 'Big macro news' })}</div>
            {errors.news ? readError('news', 'Macro news could not be loaded. Headline coverage is unknown.') : news.length === 0 ? (
              <div className="card p-6 text-center text-[13px] text-[var(--fg-4)]">{t('macro.no_news', { defaultValue: 'High-signal macro headlines will appear here as sources are crawled.' })}</div>
            ) : (
              <div className="space-y-2">
                {news.map((n, i) => (
                  <div key={n.url || i} className="card p-3">
                    <a href={n.url || '#'} target="_blank" rel="noopener noreferrer" className="block">
                      <div className="text-[13px] text-[var(--fg-1)] leading-snug hover:text-[var(--accent)] transition-colors">{n.title}</div>
                      <div className="text-[11px] text-[var(--fg-4)] mt-0.5">
                        {n.source_name}
                        {n.corroboration > 1 ? <span className="ml-1.5 text-[var(--accent)]">· {n.corroboration} {t('macro.sources', { defaultValue: 'sources' })}</span> : null}
                        {n.sentiment ? <span className={`ml-1.5 ${sentClass(n.sentiment)}`}>· {n.sentiment}</span> : null}
                        {n.published_at ? ` · ${fmtDay(n.published_at)}` : ''}
                      </div>
                    </a>
                    <WhyImportant topic={n.title} context={n.summary || 'A macro / market-moving news headline.'} />
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      </div>
      <IntelDisclaimer variant="block" />
    </IntelPageShell>
  )
}
