import React from 'react'
import { useTranslation } from 'react-i18next'
import { RadialGauge, RadialBars, StackedShare, Sparkline } from '../charts'

// Investor Intel — Data budget figures (CMC plan proposal 6). Renders one read
// of the `intel-data-budget` contract: the credit month, the plan in force, the
// per-feature projection, cache reuse, capture depth, connected demand and the
// cron jobs that produce all of it.
//
// Rules this file follows, the same ones MarketsCharts.jsx follows: plain
// figures with a table twin, no cards and no pills, every colour from a
// workspace token, every string through a translation key with an English
// default, a reported zero is a reading and never an empty state, and every
// part that could not be read says why rather than drawing silence.

// One row until a chart can no longer be read, then two, then one.
const ROW = { display: 'grid', gap: '1.5rem 2.5rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 17rem), 1fr))', alignItems: 'start' }

// The gauge kit draws one ring per series and the innermost radius floors, so
// past five rings the rings stop being separable. The figure shows the five
// largest projections; the table below it carries every feature, always.
const RING_LIMIT = 5
// Endpoint bands past this point are thinner than their own label.
const ENDPOINT_LIMIT = 10

// The enforced ceiling per plan: 80% of that plan's published monthly credits,
// which is the reserve cmcCreditCeiling() applies in
// supabase/functions/_shared/market-assets/cmc-transport.ts. Kept here as a
// constant — not imported — because that module reads Deno env at call time.
// It exists so the "on Basic after 1 October" line can name the number it will
// be measured against before the plan actually changes.
export const PLAN_CREDIT_CEILING = { basic: 12000, builder: 120000, startup: 360000, growth: 1600000, professional: 4000000 }

const DAY_MS = 86400000

// null / '' / booleans / NaN stay null. A reported 0 stays 0: a feature that
// spent nothing this month is a reading, not a gap.
export const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const credits = value => (num(value) == null ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 }))
const count = value => (num(value) == null ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 }))
const instant = value => {
  const ms = Date.parse(String(value ?? ''))
  return Number.isFinite(ms) ? ms : null
}
const stamp = value => { const ms = instant(value); return ms == null ? '—' : new Date(ms).toLocaleString() }

// Cadence as a reader says it, from seconds. 0 and null are different things:
// zero seconds is a recorded cadence of zero, null was never reported.
export const cadenceLabel = (seconds, t) => {
  const s = num(seconds)
  if (s == null) return t('data_budget.not_reported', { defaultValue: 'not reported' })
  if (s === 0) return t('data_budget.cadence_zero', { defaultValue: '0s' })
  if (s % 86400 === 0) return t('data_budget.cadence_days', { value: s / 86400, defaultValue: '{{value}}d' })
  if (s % 3600 === 0) return t('data_budget.cadence_hours', { value: s / 3600, defaultValue: '{{value}}h' })
  if (s % 60 === 0) return t('data_budget.cadence_minutes', { value: s / 60, defaultValue: '{{value}}m' })
  return t('data_budget.cadence_seconds', { value: s, defaultValue: '{{value}}s' })
}

// A cron schedule only yields a cadence when it is a plain `*/N` step on one
// field and everything coarser is a wildcard. Anything else (a list, a range, a
// weekday, a named schedule) is left alone: an unknown cadence must not become
// a guessed one, because the staleness marker is derived from it.
export function cadenceSecondsFromSchedule(schedule) {
  const fields = String(schedule ?? '').trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') return null
  const step = field => { const m = /^\*\/([1-9][0-9]{0,3})$/.exec(field); return m ? Number(m[1]) : null }
  const minuteStep = step(minute), hourStep = step(hour)
  if (minuteStep != null && hour === '*') return minuteStep * 60
  if (hourStep != null && /^([0-9]|[1-5][0-9])$/.test(minute)) return hourStep * 3600
  return null
}

// A job is stale when its newest run is older than twice the cadence its own
// schedule states. No derivable cadence, or no recorded run, means no marker —
// never a marker based on a guess.
export function jobStaleness(job, nowMs) {
  const cadenceSeconds = cadenceSecondsFromSchedule(job?.schedule)
  const last = instant(job?.lastRun?.end) ?? instant(job?.lastRun?.start)
  if (cadenceSeconds == null || cadenceSeconds <= 0 || last == null || !Number.isFinite(nowMs)) {
    return { cadenceSeconds, ageSeconds: last == null || !Number.isFinite(nowMs) ? null : Math.max(0, Math.round((nowMs - last) / 1000)), stale: false }
  }
  const ageSeconds = Math.max(0, Math.round((nowMs - last) / 1000))
  return { cadenceSeconds, ageSeconds, stale: ageSeconds > cadenceSeconds * 2 }
}

// Enabled / disabled / gated are three different facts and are marked three
// different ways — a word in the label and in the table, not only a tone.
export function featureStatus(feature) {
  if (feature?.allowedOnPlan === false) return 'gated'
  return feature?.enabled === true ? 'enabled' : 'disabled'
}
const STATUS_TONE = { enabled: 'accent', disabled: 'muted', gated: 'yellow' }

export default function DataBudgetFigures({ budget = null, now = null }) {
  const { t } = useTranslation('intel', { useSuspense: false })

  if (!budget) {
    return (
      <p className="intel-analysis-caption" role="status">
        {t('data_budget.no_read', { defaultValue: 'No data budget read has been loaded yet.' })}
      </p>
    )
  }

  const nowMs = num(now) ?? instant(budget.generatedAt) ?? Date.now()
  const degraded = Array.isArray(budget.degraded) ? budget.degraded : []
  const plan = budget.plan || {}
  const account = budget.account || null
  const month = budget.month || {}
  const projection = budget.projection || {}
  const features = Array.isArray(budget.features) ? budget.features : []
  const jobs = Array.isArray(budget.jobs) ? budget.jobs : []
  const cacheReuse = Array.isArray(budget.cacheReuse) ? budget.cacheReuse : []
  const demandDaily = Array.isArray(budget.demandDaily) ? budget.demandDaily : []
  const capture = Array.isArray(budget.capture) ? budget.capture : []

  // ---- (a) the credit month -------------------------------------------------
  const used = num(month.used), reserved = num(month.reserved)
  const ceiling = num(month.ceiling), projected = num(month.projectedAtCurrentCadence)
  const hardCap = num(month.hardCap)
  const gaugeReady = ceiling != null && ceiling > 0
  const bound = value => Math.min(Math.max(value, 0), gaugeReady ? ceiling : 0)
  const usedTo = bound(used ?? 0)
  const reservedTo = Math.max(usedTo, bound((used ?? 0) + (reserved ?? 0)))
  const gaugeZones = [
    { to: usedTo, label: t('data_budget.gauge_used', { defaultValue: 'Used' }), tone: 'accent' },
    { to: reservedTo, label: t('data_budget.gauge_reserved', { defaultValue: 'Reserved' }), tone: 'blue' },
    { to: gaugeReady ? ceiling : 0, label: t('data_budget.gauge_headroom', { defaultValue: 'Headroom' }), tone: 'muted' },
  ]
  const gaugeDescription = t('data_budget.gauge_sub', {
    used: credits(used ?? 0), reserved: credits(reserved ?? 0), ceiling: credits(ceiling),
    projected: projected == null ? t('data_budget.not_reported', { defaultValue: 'not reported' }) : credits(projected),
    defaultValue: '{{used}} used and {{reserved}} reserved of {{ceiling}} credits. The needle marks {{projected}} — the month projected from the cadences now in force.',
  })

  // ---- (b) the plan line ----------------------------------------------------
  const expiresMs = instant(plan.expiresAt)
  // Whole days only. A profile that expires in eleven hours has zero days left,
  // which is the honest reading; rounding it up to one would read as a day of
  // headroom that does not exist.
  const daysLeft = expiresMs == null ? null : Math.max(0, Math.floor((expiresMs - nowMs) / DAY_MS))
  const planCeiling = key => PLAN_CREDIT_CEILING[String(key || '').toLowerCase()] ?? null
  const projectionRows = [
    ['startup', num(projection.startup)],
    ['basic', num(projection.basic)],
  ]

  // ---- (c) per-feature projection ------------------------------------------
  const featureRows = features.map(feature => {
    const status = featureStatus(feature)
    return {
      ...feature,
      status,
      statusLabel: t(`data_budget.status_${status}`, { defaultValue: status === 'gated' ? 'Gated' : status === 'enabled' ? 'Enabled' : 'Disabled' }),
      projected: num(feature?.projectedCredits) ?? 0,
    }
  })
  const ringMax = featureRows.reduce((top, row) => Math.max(top, row.projected), 0)
  const rings = [...featureRows].sort((a, b) => b.projected - a.projected).slice(0, RING_LIMIT).map(row => ({
    key: row.feature,
    // The status word rides in the label so the three kinds of row are told
    // apart in the legend, the tooltip and the accessible name — not by tone.
    label: `${row.feature} · ${row.statusLabel}`,
    value: row.projected,
    max: ringMax,
    tone: STATUS_TONE[row.status],
  }))

  // ---- (d) cache reuse ------------------------------------------------------
  const endpoints = cacheReuse.slice(0, ENDPOINT_LIMIT)
  const reuseSeries = [
    { key: 'live', label: t('data_budget.reuse_live', { defaultValue: 'Live calls' }), tone: 'accent', points: endpoints.map((row, i) => ({ t: i, value: num(row?.live) ?? 0 })) },
    { key: 'hits', label: t('data_budget.reuse_hits', { defaultValue: 'Cache hits' }), tone: 'green', points: endpoints.map((row, i) => ({ t: i, value: num(row?.hits) ?? 0 })) },
    { key: 'misses', label: t('data_budget.reuse_misses', { defaultValue: 'Cache misses' }), tone: 'red', points: endpoints.map((row, i) => ({ t: i, value: num(row?.misses) ?? 0 })) },
  ]
  const endpointName = index => String(endpoints[Number(index)]?.endpoint ?? index)

  // ---- (f) connected demand -------------------------------------------------
  const demandAssets = demandDaily.map(row => num(row?.assets) ?? 0)
  const demandCounts = demandDaily.map(row => num(row?.demands) ?? 0)
  const lastDay = demandDaily.length ? demandDaily[demandDaily.length - 1] : null

  // ---- (g) jobs -------------------------------------------------------------
  const jobRows = jobs.map(job => ({ ...job, ...jobStaleness(job, nowMs) }))

  return (
    <div className="intel-data-budget space-y-6">
      <section aria-label={t('data_budget.degraded_label', { defaultValue: 'Parts of this read that failed' })} className="space-y-1">
        <h2 className="intel-section-title">{t('data_budget.degraded_title', { defaultValue: 'Parts that could not be read' })}</h2>
        {degraded.length === 0 ? (
          <p className="intel-analysis-caption" role="status">
            {t('data_budget.degraded_none', { defaultValue: 'Every part of this read returned a result.' })}
          </p>
        ) : (
          <ul role="alert" className="intel-analysis-caption space-y-1">
            {degraded.map((entry, i) => (
              <li key={`${entry?.part ?? 'part'}-${i}`}>
                {String(entry?.part ?? t('data_budget.unnamed_part', { defaultValue: 'unnamed part' }))}
                {' — '}
                {String(entry?.reason || t('data_budget.no_reason', { defaultValue: 'no reason was reported' }))}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div style={ROW}>
        <RadialGauge
          title={t('data_budget.gauge_title', { defaultValue: 'Credits this month' })}
          description={gaugeDescription}
          value={projected ?? used ?? 0}
          min={0}
          max={gaugeReady ? ceiling : 100}
          zones={gaugeZones}
          formatValue={credits}
          state={gaugeReady ? 'ready' : 'error'}
          reason={t('data_budget.gauge_no_ceiling', { defaultValue: 'No monthly credit ceiling was reported, so used and reserved credits cannot be placed on a scale.' })}
        />
        <RadialBars
          title={t('data_budget.features_title', { defaultValue: 'Projected credits by feature' })}
          description={t('data_budget.features_sub', {
            shown: rings.length, total: featureRows.length,
            defaultValue: 'The {{shown}} largest of {{total}} scheduled features, at the cadences now in force. Each ring is labelled enabled, disabled or gated; the table below carries every feature with its cadence, minimum plan, reason and spend so far this month.',
          })}
          series={rings}
          formatValue={credits}
          state={rings.length ? 'ready' : 'empty'}
        />
        <StackedShare
          title={t('data_budget.reuse_title', { defaultValue: 'Cache reuse by endpoint' })}
          description={t('data_budget.reuse_sub', {
            shown: endpoints.length, total: cacheReuse.length,
            defaultValue: 'Share of live calls, cache hits and cache misses for the {{shown}} of {{total}} busiest endpoints.',
          })}
          series={reuseSeries}
          formatTime={endpointName}
          state={endpoints.length ? 'ready' : 'empty'}
        />
      </div>

      <section aria-label={t('data_budget.plan_label', { defaultValue: 'Plan in force' })} className="space-y-1">
        <h2 className="intel-section-title">{t('data_budget.plan_title', { defaultValue: 'Plan in force' })}</h2>
        <p>
          {t('data_budget.plan_line', {
            effective: String(plan.effective ?? t('data_budget.not_reported', { defaultValue: 'not reported' })),
            profile: String(plan.profile ?? t('data_budget.not_reported', { defaultValue: 'not reported' })),
            baseline: String(plan.baseline ?? t('data_budget.not_reported', { defaultValue: 'not reported' })),
            defaultValue: 'Effective plan {{effective}} · access profile {{profile}} · declared baseline {{baseline}}',
          })}
        </p>
        <p>
          {plan.expired === true
            ? t('data_budget.plan_expired', { date: stamp(plan.expiresAt), defaultValue: 'The promotional profile expired on {{date}}; the baseline plan is what is enforced.' })
            : daysLeft == null
              ? t('data_budget.plan_no_expiry', { defaultValue: 'No expiry date was reported for the promotional profile.' })
              : t('data_budget.plan_countdown', { date: stamp(plan.expiresAt), days: daysLeft, defaultValue: 'The promotional profile expires {{date}} — {{days}} days from this read.' })}
        </p>
        <ul className="intel-analysis-caption space-y-1">
          {projectionRows.map(([key, value]) => {
            const against = planCeiling(key)
            return (
              <li key={key}>
                {t('data_budget.projection_line', {
                  plan: key, credits: credits(value),
                  ceiling: against == null ? t('data_budget.not_reported', { defaultValue: 'not reported' }) : credits(against),
                  defaultValue: 'On {{plan}}: {{credits}} credits per month against {{ceiling}}',
                })}
                {against != null && value != null && value > against
                  ? ` · ${t('data_budget.projection_over', { defaultValue: 'over that ceiling' })}`
                  : ''}
              </li>
            )
          })}
          <li>
            {hardCap == null
              ? t('data_budget.hard_cap_missing', { defaultValue: 'No hard cap was recorded for the current credit period.' })
              : t('data_budget.hard_cap', { value: credits(hardCap), defaultValue: 'Hard cap for the current period: {{value}} credits' })}
            {month.ceilingPlan && plan.effective && month.ceilingPlan !== plan.effective
              ? ` · ${t('data_budget.ceiling_plan_mismatch', { plan: String(month.ceilingPlan), defaultValue: 'the enforced ceiling was computed for {{plan}}' })}`
              : ''}
          </li>
          <li>
            {account
              ? t('data_budget.account_line', {
                  limit: credits(account.creditLimit), rate: count(account.rateLimit),
                  reset: stamp(account.resetAt), verified: stamp(account.verifiedAt),
                  defaultValue: 'Provider account: {{limit}} credit limit · {{rate}} calls per minute · resets {{reset}} · verified {{verified}}',
                })
              : t('data_budget.account_missing', { defaultValue: 'The provider account row could not be read, so the published limits are unknown.' })}
          </li>
          <li>
            {t('data_budget.period_line', {
              start: stamp(month.periodStart), end: stamp(month.periodEnd),
              defaultValue: 'Credit period {{start}} to {{end}}',
            })}
          </li>
        </ul>
      </section>

      <section aria-label={t('data_budget.features_label', { defaultValue: 'Scheduled features' })} className="space-y-2">
        <h2 className="intel-section-title">{t('data_budget.features_table_title', { defaultValue: 'Scheduled features' })}</h2>
        {featureRows.length === 0 ? (
          <p className="intel-analysis-caption" role="status">{t('data_budget.features_empty', { defaultValue: 'No scheduled features were reported.' })}</p>
        ) : (
          <div className="intel-table-scroll">
            <table data-testid="data-budget-features">
              <caption className="sr-only">{t('data_budget.features_table_title', { defaultValue: 'Scheduled features' })}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('data_budget.col_feature', { defaultValue: 'Feature' })}</th>
                  <th scope="col">{t('data_budget.col_status', { defaultValue: 'Status' })}</th>
                  <th scope="col">{t('data_budget.col_cadence', { defaultValue: 'Cadence' })}</th>
                  <th scope="col">{t('data_budget.col_target', { defaultValue: 'Plan target' })}</th>
                  <th scope="col">{t('data_budget.col_min_plan', { defaultValue: 'Minimum plan' })}</th>
                  <th scope="col">{t('data_budget.col_projected', { defaultValue: 'Projected credits' })}</th>
                  <th scope="col">{t('data_budget.col_used', { defaultValue: 'Used this month' })}</th>
                  <th scope="col">{t('data_budget.col_reason', { defaultValue: 'Reason' })}</th>
                </tr>
              </thead>
              <tbody>
                {featureRows.map(row => (
                  <tr key={row.feature} data-feature={row.feature} data-status={row.status}>
                    <th scope="row">{row.feature}</th>
                    <td>{row.statusLabel}</td>
                    <td className="intel-number">{cadenceLabel(row.cadenceSeconds, t)}</td>
                    <td className="intel-number">{cadenceLabel(row.targetCadenceSeconds, t)}</td>
                    <td>{row.minPlan || t('data_budget.any_plan', { defaultValue: 'any' })}</td>
                    <td className="intel-number">{credits(row.projectedCredits)}</td>
                    <td className="intel-number">{credits(row.usedThisMonth)}</td>
                    <td>{row.reason || row.managedReason || t('data_budget.no_reason', { defaultValue: 'no reason was reported' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-label={t('data_budget.capture_label', { defaultValue: 'Capture tables' })} className="space-y-2">
        <h2 className="intel-section-title">{t('data_budget.capture_title', { defaultValue: 'Capture tables' })}</h2>
        {capture.length === 0 ? (
          <p className="intel-analysis-caption" role="status">{t('data_budget.capture_empty', { defaultValue: 'No capture table counts were reported.' })}</p>
        ) : (
          <div className="intel-table-scroll">
            <table data-testid="data-budget-capture">
              <caption className="sr-only">{t('data_budget.capture_title', { defaultValue: 'Capture tables' })}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('data_budget.col_table', { defaultValue: 'Table' })}</th>
                  <th scope="col">{t('data_budget.col_rows', { defaultValue: 'Rows' })}</th>
                  <th scope="col">{t('data_budget.col_newest', { defaultValue: 'Newest row' })}</th>
                  <th scope="col">{t('data_budget.col_newest_column', { defaultValue: 'Dated by' })}</th>
                </tr>
              </thead>
              <tbody>
                {capture.map(row => (
                  <tr key={row?.table}>
                    <th scope="row">{row?.table}</th>
                    <td className="intel-number">{row?.rows == null ? t('data_budget.not_reported', { defaultValue: 'not reported' }) : count(row.rows)}</td>
                    <td className="intel-number">{row?.newest == null ? t('data_budget.no_rows', { defaultValue: 'no rows' }) : stamp(row.newest)}</td>
                    <td>{row?.newestColumn || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-label={t('data_budget.demand_label', { defaultValue: 'Connected demand' })} className="space-y-2">
        <h2 className="intel-section-title">{t('data_budget.demand_title', { defaultValue: 'Connected demand, last 30 days' })}</h2>
        {demandDaily.length === 0 ? (
          <p className="intel-analysis-caption" role="status">{t('data_budget.demand_empty', { defaultValue: 'No connected demand was recorded for this window.' })}</p>
        ) : (
          <div className="intel-table-scroll">
            <table data-testid="data-budget-demand">
              <caption className="sr-only">{t('data_budget.demand_title', { defaultValue: 'Connected demand, last 30 days' })}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('data_budget.col_series', { defaultValue: 'Series' })}</th>
                  <th scope="col">{t('data_budget.col_shape', { defaultValue: 'Shape' })}</th>
                  <th scope="col">{t('data_budget.col_latest', { defaultValue: 'Newest day' })}</th>
                  <th scope="col">{t('data_budget.col_peak', { defaultValue: 'Peak' })}</th>
                  <th scope="col">{t('data_budget.col_days', { defaultValue: 'Days recorded' })}</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['assets', t('data_budget.demand_assets', { defaultValue: 'Distinct assets' }), demandAssets],
                  ['demands', t('data_budget.demand_requests', { defaultValue: 'Demand records' }), demandCounts],
                ].map(([key, label, values]) => (
                  <tr key={key}>
                    <th scope="row">{label}</th>
                    <td>
                      <Sparkline values={values} tone={key === 'assets' ? 'accent' : 'blue'} ariaLabel={t('data_budget.demand_spark_label', { label, days: values.length, defaultValue: '{{label}} across {{days}} recorded days' })} />
                    </td>
                    <td className="intel-number">{count(values[values.length - 1])}</td>
                    <td className="intel-number">{count(values.length ? Math.max(...values) : null)}</td>
                    <td className="intel-number">{count(values.length)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {lastDay ? (
          <p className="intel-analysis-caption">
            {t('data_budget.demand_newest_day', { day: String(lastDay.day ?? '—'), defaultValue: 'Newest recorded day: {{day}}' })}
          </p>
        ) : null}
      </section>

      <section aria-label={t('data_budget.jobs_label', { defaultValue: 'Scheduled jobs' })} className="space-y-2">
        <h2 className="intel-section-title">{t('data_budget.jobs_title', { defaultValue: 'Scheduled jobs' })}</h2>
        {jobRows.length === 0 ? (
          <p className="intel-analysis-caption" role="status">{t('data_budget.jobs_empty', { defaultValue: 'No scheduled jobs were reported.' })}</p>
        ) : (
          <div className="intel-table-scroll">
            <table data-testid="data-budget-jobs">
              <caption className="sr-only">{t('data_budget.jobs_title', { defaultValue: 'Scheduled jobs' })}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('data_budget.col_job', { defaultValue: 'Job' })}</th>
                  <th scope="col">{t('data_budget.col_schedule', { defaultValue: 'Schedule' })}</th>
                  <th scope="col">{t('data_budget.col_active', { defaultValue: 'Active' })}</th>
                  <th scope="col">{t('data_budget.col_last_run', { defaultValue: 'Last run' })}</th>
                  <th scope="col">{t('data_budget.col_last_status', { defaultValue: 'Last status' })}</th>
                </tr>
              </thead>
              <tbody>
                {jobRows.map(row => (
                  <tr key={row?.jobname} data-job={row?.jobname} data-stale={row.stale ? 'true' : 'false'}>
                    <th scope="row">
                      {row?.jobname}
                      {row.stale ? (
                        <span className="intel-analysis-caption"> · {t('data_budget.job_stale', {
                          cadence: cadenceLabel(row.cadenceSeconds, t),
                          defaultValue: 'Stale: the newest run is more than twice its {{cadence}} cadence old',
                        })}</span>
                      ) : null}
                    </th>
                    <td className="intel-number">{row?.schedule || '—'}</td>
                    <td>{row?.active === true ? t('data_budget.job_active', { defaultValue: 'Active' }) : row?.active === false ? t('data_budget.job_paused', { defaultValue: 'Paused' }) : t('data_budget.not_reported', { defaultValue: 'not reported' })}</td>
                    <td className="intel-number">{row?.lastRun ? stamp(row.lastRun.end ?? row.lastRun.start) : t('data_budget.job_never', { defaultValue: 'no run recorded' })}</td>
                    <td>{row?.lastRun?.status || t('data_budget.not_reported', { defaultValue: 'not reported' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="intel-analysis-caption">
        {t('data_budget.generated_at', { date: stamp(budget.generatedAt), defaultValue: 'Read at {{date}}. Nothing on this page calls a provider or spends a credit.' })}
      </p>
    </div>
  )
}
