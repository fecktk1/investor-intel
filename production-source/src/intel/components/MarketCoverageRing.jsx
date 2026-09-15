import React from 'react'
import { useTranslation } from 'react-i18next'
import { RadialBars } from '../charts'

// Every section the platform can carry for an asset, in page order. The payload
// is authoritative; this list only fixes the order so the ring reads the same
// way for every asset.
export const COVERAGE_SECTIONS = ['quote', 'candles', 'venues', 'derivatives', 'liquidity', 'contract', 'rwa', 'narrative', 'supply', 'metadata', 'signals', 'orderbook']

const TONE = { available: 'green', not_applicable: 'yellow', unavailable: 'muted' }

// English source text, kept beside the section list so a section the backend adds
// tomorrow is still readable before its translation lands.
const SECTION_LABELS = {
  quote: 'Quote', candles: 'Price history', venues: 'Venues', derivatives: 'Derivatives',
  liquidity: 'Liquidity', contract: 'Contract', rwa: 'Real-world asset', narrative: 'Narrative',
  supply: 'Supply', metadata: 'Project metadata', signals: 'Signals', orderbook: 'Order book',
}
const STATE_LABELS = { available: 'Available', unavailable: 'Unavailable', not_applicable: 'Not applicable' }

const sectionIndex = key => {
  const i = COVERAGE_SECTIONS.indexOf(key)
  return i === -1 ? COVERAGE_SECTIONS.length : i
}

// Which parts of the platform this identity can actually feed, and why the rest
// cannot. "Not applicable" is kept distinct from "unavailable": a spot-only asset
// has no derivatives to show, which is not a gap.
export default function MarketCoverageRing({ coverage, identity }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const sections = Array.isArray(coverage?.sections) ? coverage.sections : []
  if (!sections.length) return null

  const rows = sections
    .map((section, index) => ({ ...section, index }))
    .sort((a, b) => (sectionIndex(a.key) - sectionIndex(b.key)) || (a.index - b.index))
    .map(section => ({
      key: section.key,
      label: t(`coverage.section_${section.key}`, { defaultValue: SECTION_LABELS[section.key] || section.key }),
      value: section.state === 'available' ? 1 : 0,
      max: 1,
      tone: TONE[section.state] || TONE.unavailable,
      state: section.state,
      reason: section.reason || null,
    }))

  const total = Number.isFinite(Number(coverage?.totalCount)) ? Number(coverage.totalCount) : rows.length
  const available = Number.isFinite(Number(coverage?.availableCount)) ? Number(coverage.availableCount) : rows.filter(row => row.value === 1).length

  return (
    <section className="intel-coverage-ring space-y-2" aria-label={t('coverage.heading', { defaultValue: 'Platform coverage for this asset' })}>
      <RadialBars
        title={t('coverage.heading', { defaultValue: 'Platform coverage for this asset' })}
        description={t('coverage.available_count', { defaultValue: '{{available}} of {{total}} sections available', available, total })}
        series={rows}
        formatValue={value => (Number(value) >= 1
          ? t('coverage.state_available', { defaultValue: 'Available' })
          : t('coverage.state_unavailable', { defaultValue: 'Unavailable' }))}
      />
      {identity ? (
        <p className="intel-event-meta">{[identity.kind, identity.provider, identity.providerId, identity.chain, identity.address].filter(Boolean).join(' · ')}</p>
      ) : null}
      <details className="intel-chart-table intel-coverage-table">
        <summary>{t('coverage.table', { defaultValue: 'Show coverage as a table' })}</summary>
        <table>
          <caption>{t('coverage.heading', { defaultValue: 'Platform coverage for this asset' })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('coverage.column_section', { defaultValue: 'Section' })}</th>
              <th scope="col" data-align="right" className="intel-number">{t('coverage.column_state', { defaultValue: 'State' })}</th>
              <th scope="col" data-align="right" className="intel-number">{t('coverage.column_reason', { defaultValue: 'Reason' })}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.key}>
                <th scope="row">{row.key}</th>
                <td className="intel-number">{t(`coverage.state_${row.state}`, { defaultValue: STATE_LABELS[row.state] || row.state })}</td>
                <td className="intel-number">{row.reason ? t(`coverage.reason_${row.reason}`, { defaultValue: row.reason }) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  )
}
