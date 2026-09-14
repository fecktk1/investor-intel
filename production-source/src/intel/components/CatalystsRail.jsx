import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarClock } from 'lucide-react'
import { useSupabase } from '../../lib/useSupabase'
import { loadMacroCalendar } from '../lib/macro-api'

const IMP_CLS = { high: 'text-red-400', medium: 'text-amber-400', low: 'text-[var(--fg-4)]' }
const fmtWhen = (s) => { if (!s) return ''; const d = new Date(s); return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }

// "Catalysts this week" — upcoming macro calendar events (CPI/FOMC/jobs/etc.) from
// the shared intel_macro_calendar, so the dashboard shows what's coming, not just
// what already happened. Self-contained (fetches its own data) and renders nothing
// with explicit loading, failed-read and empty-coverage states.
export default function CatalystsRail({ days = 7, limit = 6 }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { supabase } = useSupabase()
  const [events, setEvents] = useState(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setEvents(null)
    setError(false)
    loadMacroCalendar(supabase, { days })
      .then((rows) => { if (alive) setEvents(rows) })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [supabase, days, attempt])

  const now = Date.now()
  const upcoming = (events || [])
    .filter((e) => !['cancelled','postponed','completed','unknown'].includes(e.raw?.status) && e.scheduled_at && new Date(e.scheduled_at).getTime() >= now - 3600_000)
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))
    .slice(0, limit)

  return (
    <section className="border-y border-[var(--border-default)] py-4 space-y-2">
      <div className="eyebrow flex items-center gap-1.5"><CalendarClock className="h-3.5 w-3.5" /> {t('pulse.catalysts', { defaultValue: 'Catalysts this week' })}</div>
      {error ? <div role="alert"><p>{t('macro.calendar_failed', { defaultValue: 'The calendar could not be loaded. Upcoming event coverage is unknown.' })}</p><button type="button" onClick={() => setAttempt(n => n + 1)}>{t('common.retry', { defaultValue: 'Retry' })}</button></div>
        : !events ? <p role="status">{t('macro.calendar_loading', { defaultValue: 'Loading calendar…' })}</p>
        : !upcoming.length ? <p>{t('macro.calendar_empty', { defaultValue: 'No upcoming events in the loaded calendar. Coverage may be incomplete.' })}</p> : null}
      <div className="space-y-1.5">
        {upcoming.map((e) => (
          <div key={e.id || `${e.event_key}-${e.scheduled_at}`} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13px] text-[var(--fg-1)] leading-snug">{e.title}</span>
                {e.importance && <span className={`text-[10px] uppercase ${IMP_CLS[e.importance] || 'text-[var(--fg-4)]'}`}>{e.importance}</span>}
                {e.country && <span className="text-[10px] text-[var(--fg-5)]">{e.country}</span>}
              </div>
              {(e.forecast != null || e.previous != null) && (
                <div className="text-[11px] text-[var(--fg-4)] mt-0.5">
                  {e.forecast != null ? `${t('macro.forecast', { defaultValue: 'forecast' })} ${e.forecast}` : ''}
                  {e.forecast != null && e.previous != null ? ' · ' : ''}
                  {e.previous != null ? `${t('macro.previous', { defaultValue: 'prev' })} ${e.previous}` : ''}
                </div>
              )}
            </div>
            <span className="text-[11px] text-[var(--fg-4)] whitespace-nowrap flex-shrink-0">{fmtWhen(e.scheduled_at)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
