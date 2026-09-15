import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { useScreenParams } from '../lib/useScreenParams'
import { HeatStrip, RadialBars, Sunburst } from '../charts'
import { readAssetFacts } from '../lib/markets-api'
import { formatCompact, formatPct, formatUsd } from '../lib/market-format'

// What the provider has actually recorded about this asset: how much of its
// supply is verified and how much the project reports about itself, any listing
// notice, every chain it is deployed on, when it was listed and how that vintage
// has performed, and the daily movement in its market pairs and circulating
// supply.
//
// Every read here is of a row a daily job already wrote — no provider call, no
// credits. No section is ever filled in: a part that could not be read says why.

const DAYS_CHOICES = [30, 90, 400]
const TRUST_LABELS = { verified: 'Provider-verified', self_reported: 'Self-reported', mixed: 'Partly self-reported', unknown: 'Unknown' }

// English source text for every reason these reads can answer with, kept beside
// the component so a reason the backend adds tomorrow still reads as something
// before its translation lands. An unknown code is shown as the code.
const REASON_LABELS = {
  asset_not_found: 'No catalogue asset matches this identity.',
  asset_facts_unavailable: 'The recorded facts could not be read.',
  invalid_provider: 'That provider does not record these facts.',
  invalid_provider_id: 'That asset identifier is not one this read accepts.',
  invalid_days: 'That is not a window this read accepts.',
  invalid_op: 'That is not a read this endpoint offers.',
  no_facts_recorded: 'The daily metadata pass has not recorded facts for this asset yet.',
  no_rank_history: 'No daily capture has been recorded for this asset yet.',
}

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const day = value => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
const clock = value => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}
const count = value => (num(value) == null ? '—' : formatCompact(value))

export default function AssetFactsPanel({ sourceProvider, providerId, symbol }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [params, setParams] = useScreenParams('f_', { days: 30 })
  const [facts, setFacts] = useState(null)
  const [cohorts, setCohorts] = useState(null)

  const days = DAYS_CHOICES.includes(params.days) ? params.days : 30
  const canRead = !!(org?.id && sourceProvider && providerId != null)

  useEffect(() => {
    if (!canRead) return undefined
    let alive = true
    const controller = new AbortController()
    ;(async () => {
      const payload = await readAssetFacts(supabase, { orgId: org.id, sourceProvider, providerId, days, signal: controller.signal })
      if (alive) setFacts(payload)
    })()
    return () => { alive = false; controller.abort() }
  }, [canRead, org?.id, supabase, sourceProvider, providerId, days])

  useEffect(() => {
    if (!canRead) return undefined
    let alive = true
    const controller = new AbortController()
    ;(async () => {
      const payload = await readAssetFacts(supabase, { orgId: org.id, op: 'cohorts', provider: sourceProvider, signal: controller.signal })
      if (alive) setCohorts(payload)
    })()
    return () => { alive = false; controller.abort() }
  }, [canRead, org?.id, supabase, sourceProvider])

  const reasonText = reason => (reason
    ? t(`asset_facts.reason_${reason}`, { defaultValue: REASON_LABELS[reason] || reason })
    : t('charts.no_reason', { defaultValue: 'No reason was reported.' }))

  const heading = t('asset_facts.heading', { defaultValue: 'Recorded asset facts' })
  if (!canRead) return null

  if (!facts) {
    return (
      <section className="intel-asset-facts space-y-3" aria-label={heading}>
        <div className="eyebrow">{heading}</div>
        <p className="intel-analysis-caption" role="status">{t('asset_facts.loading', { defaultValue: 'Reading recorded asset facts…' })}</p>
      </section>
    )
  }

  if (facts.state === 'unavailable') {
    return (
      <section className="intel-asset-facts space-y-3" aria-label={heading}>
        <div className="eyebrow">{heading}</div>
        <p className="intel-analysis-caption" role="alert">
          {t('asset_facts.unavailable', { defaultValue: 'The recorded facts for this asset could not be read.' })} {reasonText(facts.reason)}
        </p>
      </section>
    )
  }

  const supply = facts.supply || null
  const age = facts.age || null
  const notice = facts.notice || null
  const deployments = Array.isArray(facts.deployments) ? facts.deployments : []
  const deltas = facts.deltas || { rows: [], unavailable: true, reason: 'asset_facts_unavailable' }
  const deltaRows = Array.isArray(deltas.rows) ? deltas.rows : []

  // One scale for every supply reading, so the arcs are comparable. Without a
  // maximum supply the largest reported figure is the scale.
  const supplyScale = Math.max(0, ...[supply?.circulating, supply?.total, supply?.max, supply?.selfReportedCirculating].map(value => num(value) ?? 0))
  const supplySeries = supply ? [
    { key: 'circulating', label: t('asset_facts.supply_circulating', { defaultValue: 'Circulating' }), value: num(supply.circulating), max: supplyScale, tone: 'accent' },
    { key: 'total', label: t('asset_facts.supply_total', { defaultValue: 'Total' }), value: num(supply.total), max: supplyScale, tone: 'blue' },
    { key: 'max', label: t('asset_facts.supply_max', { defaultValue: 'Maximum' }), value: num(supply.max), max: supplyScale, tone: 'muted' },
    ...(num(supply.selfReportedCirculating) == null ? [] : [{
      key: 'self_circulating',
      label: t('asset_facts.supply_self_circulating', { defaultValue: 'Self-reported circulating' }),
      value: num(supply.selfReportedCirculating), max: supplyScale, tone: 'yellow',
    }]),
  ] : []

  const cohortRows = Array.isArray(cohorts?.cohorts) ? cohorts.cohorts : []
  const cohortScale = Math.max(1, ...cohortRows.map(row => Math.abs(num(row.medianChange30dPct) ?? 0)))
  // A median change can be negative and an arc cannot. Arc length is therefore
  // the size of the move and the tone is its direction; the table below carries
  // the signed number, which is the authority.
  const cohortSeries = cohortRows.map(row => {
    const median = num(row.medianChange30dPct)
    const mine = age?.cohort != null && row.cohort === age.cohort
    return {
      key: String(row.cohort ?? 'unlisted'),
      label: row.cohort == null
        ? t('asset_facts.cohort_unlisted', { defaultValue: 'No listing date' })
        : mine ? t('asset_facts.cohort_mine', { defaultValue: '{{cohort}} · this asset', cohort: row.cohort }) : String(row.cohort),
      // A cohort with no captured 30-day change has no arc and no number; it is
      // not a zero move.
      value: median == null ? null : Math.abs(median),
      max: cohortScale,
      tone: mine ? 'accent' : median == null ? 'muted' : median < 0 ? 'red' : 'green',
    }
  })

  return (
    <section className="intel-asset-facts space-y-3" aria-label={heading}>
      <div className="eyebrow">{heading}</div>
      <p className="intel-event-meta">
        {[facts.asset?.name, facts.asset?.symbol || symbol, facts.attribution].filter(Boolean).join(' · ')}
        {facts.factsAt ? ` · ${t('asset_facts.facts_at', { defaultValue: 'Recorded {{factsAt}}', factsAt: clock(facts.factsAt) })}` : ''}
      </p>

      {/* (a) Supply trust */}
      <div className="intel-asset-facts-supply space-y-2">
        <div className="eyebrow">{t(`asset_facts.trust_${supply?.trust || 'unknown'}`, { defaultValue: TRUST_LABELS[supply?.trust] || TRUST_LABELS.unknown })}</div>
        <RadialBars
          title={t('asset_facts.supply_title', { defaultValue: 'Supply' })}
          description={[
            t('asset_facts.supply_sub', { defaultValue: 'Circulating, total and maximum supply as the provider reports them.' }),
            num(supply?.circulatingShareOfMax) == null ? null : t('asset_facts.supply_share_of_max', { defaultValue: '{{pct}} of the maximum supply is circulating.', pct: formatPct(supply.circulatingShareOfMax * 100).replace(/^\+/, '') }),
            supply?.infiniteSupply === true ? t('asset_facts.supply_infinite', { defaultValue: 'The provider records this asset as having an infinite supply, so there is no maximum to compare against.' }) : null,
            num(supply?.selfReportedDiffersPct) == null ? null : t('asset_facts.supply_differs', { defaultValue: 'The self-reported circulating supply differs from the verified figure by {{pct}}.', pct: formatPct(supply.selfReportedDiffersPct) }),
          ].filter(Boolean).join(' ')}
          series={supplySeries}
          formatValue={count}
          state={supply ? (supplySeries.some(row => row.value != null) ? 'ready' : 'empty') : 'error'}
          reason={supply ? reasonText(supply?.reason) : reasonText(facts.reason)}
        />
        <p className="intel-analysis-caption">
          {t('asset_facts.supply_sentence', { defaultValue: 'The circulating, total and maximum figures are the ones the provider verified. Any figure labelled self-reported comes from the project itself and is shown beside the verified numbers, never instead of them.' })}
        </p>
        <details className="intel-chart-table intel-asset-facts-supply-table">
          <summary>{t('asset_facts.supply_table', { defaultValue: 'Show supply and market cap as a table' })}</summary>
          <table>
            <caption>{t('asset_facts.supply_title', { defaultValue: 'Supply' })}</caption>
            <thead>
              <tr>
                <th scope="col">{t('asset_facts.column_measure', { defaultValue: 'Measure' })}</th>
                <th scope="col" className="intel-number">{t('charts.value', { defaultValue: 'Value' })}</th>
              </tr>
            </thead>
            <tbody>
              <tr><th scope="row">{t('asset_facts.supply_circulating', { defaultValue: 'Circulating' })}</th><td className="intel-number">{count(supply?.circulating)}</td></tr>
              <tr><th scope="row">{t('asset_facts.supply_total', { defaultValue: 'Total' })}</th><td className="intel-number">{count(supply?.total)}</td></tr>
              <tr><th scope="row">{t('asset_facts.supply_max', { defaultValue: 'Maximum' })}</th><td className="intel-number">{count(supply?.max)}</td></tr>
              <tr><th scope="row">{t('asset_facts.supply_self_circulating', { defaultValue: 'Self-reported circulating' })}</th><td className="intel-number">{count(supply?.selfReportedCirculating)}</td></tr>
              <tr><th scope="row">{t('asset_facts.market_cap', { defaultValue: 'Market cap' })}</th><td className="intel-number">{num(supply?.marketCap) == null ? '—' : formatUsd(supply.marketCap)}</td></tr>
              <tr><th scope="row">{t('asset_facts.self_market_cap', { defaultValue: 'Self-reported market cap' })}</th><td className="intel-number">{num(supply?.selfReportedMarketCap) == null ? '—' : formatUsd(supply.selfReportedMarketCap)}</td></tr>
              <tr><th scope="row">{t('asset_facts.market_pairs', { defaultValue: 'Market pairs' })}</th><td className="intel-number">{count(facts.asset?.numMarketPairs)}</td></tr>
            </tbody>
          </table>
        </details>
      </div>

      {/* (b) Listing notice */}
      <div className="intel-asset-facts-notice space-y-2">
        <div className="eyebrow">{t('asset_facts.notice_title', { defaultValue: 'Listing notice' })}</div>
        {notice?.present && notice.text
          ? (
            <>
              {String(notice.text).split(/\n{2,}/).map((paragraph, index) => (
                <p key={index} className="text-sm text-[var(--fg-2)]" style={{ lineHeight: 1.65 }}>{paragraph}</p>
              ))}
              <p className="intel-event-meta">{t('asset_facts.notice_recorded', { defaultValue: 'Recorded {{factsAt}}', factsAt: clock(notice.factsAt || facts.factsAt) })}</p>
            </>
          )
          : <p className="intel-analysis-caption" role="status">{t('asset_facts.notice_absent', { defaultValue: 'No listing notice recorded at {{factsAt}}', factsAt: clock(notice?.factsAt || facts.factsAt) })}</p>}
      </div>

      {/* (c) Deployments */}
      <Sunburst
        title={t('asset_facts.deployments_title', { defaultValue: 'Where this asset is deployed' })}
        description={t('asset_facts.deployments_sub', { defaultValue: 'One inner ring per chain, with the contract addresses it carries. A chain the app does not map keeps the name the provider gave it.' })}
        root={{
          name: facts.asset?.symbol || symbol || '',
          children: [...new Map(deployments.map(deployment => [deployment.chain || deployment.platformName || deployment.platformSlug, deployment])).keys()].map(key => ({
            name: String(key ?? '—'),
            children: deployments
              .filter(deployment => (deployment.chain || deployment.platformName || deployment.platformSlug) === key)
              .map(deployment => ({
                name: deployment.primary
                  ? `${deployment.address} · ${t('asset_facts.deployment_primary', { defaultValue: 'primary' })}`
                  : String(deployment.address ?? '—'),
                value: 1,
                tone: deployment.primary ? 'accent' : undefined,
              })),
          })),
        }}
        depth={2}
        formatValue={value => (Number(value) === 1
          ? t('asset_facts.deployment_one', { defaultValue: '1 address' })
          // `count` is reserved by i18next's plural resolver, so the placeholder
          // is named for what it holds.
          : t('asset_facts.deployment_many', { defaultValue: '{{addresses}} addresses', addresses: Number(value) || 0 }))}
        state={deployments.length ? 'ready' : 'empty'}
      />

      {/* (d) Listing age and its cohort */}
      <div className="intel-asset-facts-age space-y-2">
        <div className="eyebrow">{t('asset_facts.age_title', { defaultValue: 'Listing age' })}</div>
        {age
          ? (
            <p className="intel-analysis-caption">
              {t('asset_facts.age_sentence', {
                defaultValue: 'Listed {{dateAdded}} · launched {{dateLaunched}} · {{ageDays}} days on the provider · cohort {{cohort}}',
                dateAdded: day(age.dateAdded),
                dateLaunched: day(age.dateLaunched),
                ageDays: num(age.ageDays) == null ? '—' : age.ageDays,
                cohort: age.cohort || t('asset_facts.cohort_unlisted', { defaultValue: 'No listing date' }),
              })}
              {age.reason ? ` ${reasonText(age.reason)}` : ''}
            </p>
          )
          : <p className="intel-analysis-caption" role="status">{t('asset_facts.age_unavailable', { defaultValue: 'No listing date was recorded for this asset.' })}</p>}

        <RadialBars
          title={t('asset_facts.cohort_title', { defaultValue: 'How each listing vintage has moved' })}
          description={t('asset_facts.cohort_sub', { defaultValue: 'Median 30-day change per listing quarter, from captured prices. The arc is the size of the move and its colour the direction; the table carries the signed number. This asset’s own quarter is picked out.' })}
          series={cohortSeries}
          formatValue={value => (value == null ? '—' : formatPct(value).replace(/^\+/, ''))}
          state={cohorts == null ? 'empty' : cohorts.state === 'unavailable' ? 'error' : cohortSeries.length ? 'ready' : 'empty'}
          reason={cohorts?.state === 'unavailable' ? reasonText(cohorts.reason) : undefined}
        />
        {cohortRows.length ? (
          <details className="intel-chart-table intel-asset-facts-cohort-table">
            <summary>{t('asset_facts.cohort_table', { defaultValue: 'Show listing vintages as a table' })}</summary>
            <table>
              <caption>{t('asset_facts.cohort_title', { defaultValue: 'How each listing vintage has moved' })}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('asset_facts.column_cohort', { defaultValue: 'Listing quarter' })}</th>
                  <th scope="col" className="intel-number">{t('asset_facts.column_median_change', { defaultValue: 'Median 30-day change' })}</th>
                  <th scope="col" className="intel-number">{t('asset_facts.column_median_cap', { defaultValue: 'Median market cap' })}</th>
                  <th scope="col" className="intel-number">{t('asset_facts.column_assets', { defaultValue: 'Assets' })}</th>
                  <th scope="col" className="intel-number">{t('asset_facts.column_assets_with_change', { defaultValue: 'With a change' })}</th>
                </tr>
              </thead>
              <tbody>
                {cohortRows.map(row => (
                  <tr key={String(row.cohort ?? 'unlisted')}>
                    <th scope="row">{row.cohort ?? t('asset_facts.cohort_unlisted', { defaultValue: 'No listing date' })}</th>
                    <td className="intel-number">{num(row.medianChange30dPct) == null ? '—' : formatPct(row.medianChange30dPct)}</td>
                    <td className="intel-number">{num(row.medianMarketCap) == null ? '—' : formatUsd(row.medianMarketCap)}</td>
                    <td className="intel-number">{count(row.count)}</td>
                    <td className="intel-number">{count(row.assetsWithChange)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ) : null}
      </div>

      {/* (e) Market-pair and supply movement */}
      <div className="intel-asset-facts-deltas space-y-2">
        <div className="intel-investigation-controls" role="group" aria-label={t('asset_facts.days_group', { defaultValue: 'Delta window' })}>
          {DAYS_CHOICES.map(choice => (
            <button
              key={choice}
              type="button"
              className="intel-text-link"
              aria-pressed={days === choice}
              onClick={() => setParams({ days: choice })}
            >
              {t('asset_facts.days_choice', { defaultValue: '{{days}} days', days: choice })}
            </button>
          ))}
        </div>
        <HeatStrip
          title={t('asset_facts.deltas_title', { defaultValue: 'Daily change in market pairs' })}
          description={t('asset_facts.deltas_sub', { defaultValue: 'Each cell is one recorded day against the previous recorded day. A day the capture job did not write is a gap the next day’s delta spans; nothing is interpolated. Intensity shows the size of an increase, so a fall reads as the lightest cell and the table carries its signed value.' })}
          cells={deltaRows.map(row => ({ t: row.date, value: num(row.pairsDelta) ?? 0, label: day(row.date) }))}
          columns={7}
          formatValue={value => formatCompact(value)}
          state={deltas.unavailable ? 'error' : deltaRows.length ? 'ready' : 'empty'}
          reason={deltas.unavailable ? reasonText(deltas.reason) : undefined}
        />
        {deltaRows.length ? (
          <details className="intel-chart-table intel-asset-facts-delta-table">
            <summary>{t('asset_facts.deltas_table', { defaultValue: 'Show pair and supply movement as a table' })}</summary>
            <table>
              <caption>{t('asset_facts.deltas_title', { defaultValue: 'Daily change in market pairs' })}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('asset_facts.column_date', { defaultValue: 'Date' })}</th>
                  <th scope="col" className="intel-number">{t('asset_facts.market_pairs', { defaultValue: 'Market pairs' })}</th>
                  <th scope="col" className="intel-number">{t('asset_facts.column_pairs_delta', { defaultValue: 'Pairs change' })}</th>
                  <th scope="col" className="intel-number">{t('asset_facts.supply_circulating', { defaultValue: 'Circulating' })}</th>
                  <th scope="col" className="intel-number">{t('asset_facts.column_supply_delta', { defaultValue: 'Supply change' })}</th>
                  <th scope="col" className="intel-number">{t('asset_facts.market_cap', { defaultValue: 'Market cap' })}</th>
                  <th scope="col" className="intel-number">{t('asset_facts.column_rank', { defaultValue: 'Rank' })}</th>
                </tr>
              </thead>
              <tbody>
                {deltaRows.map(row => (
                  <tr key={String(row.date)}>
                    <th scope="row">{day(row.date)}</th>
                    <td className="intel-number">{count(row.numMarketPairs)}</td>
                    <td className="intel-number">{num(row.pairsDelta) == null ? '—' : `${row.pairsDelta > 0 ? '+' : ''}${row.pairsDelta}`}</td>
                    <td className="intel-number">{count(row.circulatingSupply)}</td>
                    <td className="intel-number">{num(row.supplyDelta) == null ? '—' : `${row.supplyDelta > 0 ? '+' : ''}${formatCompact(row.supplyDelta)}`}</td>
                    <td className="intel-number">{num(row.marketCap) == null ? '—' : formatUsd(row.marketCap)}</td>
                    <td className="intel-number">{num(row.rank) == null ? '—' : row.rank}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ) : null}
      </div>
    </section>
  )
}
