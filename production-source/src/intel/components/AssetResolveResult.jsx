import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { RadialBars, Sunburst } from '../charts'
import { formatUsd } from '../lib/market-format'

// The resolver ladder, in the order the server walks it. Provenance is rendered
// in this order so the ring always reads the same way, whichever steps answered.
export const RESOLVE_LADDER = ['catalogue', 'entities', 'memecoin', 'cmc_metadata', 'cmc_dex', 'dexscreener', 'geckoterminal', 'birdeye', 'rpc']

// Outcome → ring value + tone. A miss is drawn at half so "we asked and it had
// nothing" is visibly different from "we never asked".
const OUTCOME = {
  hit: { value: 1, tone: 'green' },
  miss: { value: 0.5, tone: 'muted' },
  error: { value: 0.25, tone: 'red' },
  skipped: { value: 0, tone: 'muted' },
}

// English source text for each ladder step. Kept beside the ladder so a new step
// is never rendered as a bare identifier while its translation is pending.
const STEP_LABELS = {
  catalogue: 'Market catalogue',
  entities: 'Resolved entities',
  memecoin: 'Memecoin index',
  cmc_metadata: 'CoinMarketCap metadata',
  cmc_dex: 'CoinMarketCap DEX',
  dexscreener: 'DexScreener',
  geckoterminal: 'GeckoTerminal',
  birdeye: 'Birdeye',
  rpc: 'Chain RPC',
}

const ladderIndex = step => {
  const i = RESOLVE_LADDER.indexOf(step)
  return i === -1 ? RESOLVE_LADDER.length : i
}

const contractRouteFor = (symbol, chain, address) =>
  `/intel/markets/${encodeURIComponent(String(symbol || 'UNKNOWN').toUpperCase())}?${new URLSearchParams({ provider: 'contract', id: `${chain}:${address}` })}`

// Universal resolution read-out. Shows what the resolver decided, every ladder
// step it walked (hit, miss, skipped or error, with its cost), the competing
// candidates when the identifier is ambiguous, and where a resolved asset is
// deployed. A failure is always explained: no blank space, no silent fallback.
export default function AssetResolveResult({ result, onPick, onRefresh }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const status = result?.status || 'unresolved'
  const identity = result?.identity || null
  const candidates = Array.isArray(result?.candidates) ? result.candidates : []
  const deployments = Array.isArray(identity?.deployments) ? identity.deployments : []

  const steps = useMemo(() => {
    const provenance = Array.isArray(result?.provenance) ? result.provenance : []
    return provenance
      .map((entry, index) => ({ ...entry, index }))
      // `index` is the shared-record write, not a source the ladder asked. It is
      // reported on its own line below; it is never a tenth rung of the ring.
      .filter(entry => entry.step !== 'index')
      .sort((a, b) => (ladderIndex(a.step) - ladderIndex(b.step)) || (a.index - b.index))
      .map(entry => {
        const outcome = OUTCOME[entry.outcome] || OUTCOME.skipped
        return {
          key: `${entry.step}-${entry.index}`,
          step: entry.step,
          outcome: entry.outcome,
          ms: entry.ms,
          detail: entry.detail,
          label: t(`resolve.step_${entry.step}`, { defaultValue: STEP_LABELS[entry.step] || entry.step }),
          value: outcome.value,
          max: 1,
          tone: outcome.tone,
        }
      })
  }, [result, t])

  const outcomeWord = value => {
    if (value >= 1) return t('resolve.outcome_hit', { defaultValue: 'Answered' })
    if (value >= 0.5) return t('resolve.outcome_miss', { defaultValue: 'No match' })
    if (value >= 0.25) return t('resolve.outcome_error', { defaultValue: 'Failed' })
    return t('resolve.outcome_skipped', { defaultValue: 'Not asked' })
  }

  // On-demand indexing: the first successful resolution of an asset by anyone
  // creates the shared market_assets record. The server reports it as an `index`
  // provenance entry appended after the nine ladder steps.
  const indexEntry = useMemo(() => {
    const provenance = Array.isArray(result?.provenance) ? result.provenance : []
    return provenance.find(entry => entry?.step === 'index') || null
  }, [result])

  const indexLine = indexEntry ? (
    indexEntry.outcome === 'hit' ? t('resolve.index_hit', { defaultValue: 'Indexed for everyone' })
      : indexEntry.outcome === 'miss' ? t('resolve.index_miss', { defaultValue: 'Already indexed' })
        : t('resolve.index_not', {
          defaultValue: 'Not indexed: {{detail}}',
          detail: indexEntry.detail || t('resolve.index_no_detail', { defaultValue: 'no reason given' }),
        })
  ) : null

  const statusLine = {
    resolved: t('resolve.status_resolved', { defaultValue: 'One asset matches this identifier.' }),
    ambiguous: t('resolve.status_ambiguous', { defaultValue: 'More than one asset matches this identifier. Choose the one you mean.' }),
    unresolved: t('resolve.status_unresolved', { defaultValue: 'No provider recognised this identifier.' }),
    invalid: t('resolve.status_invalid', { defaultValue: 'This is not an identifier any supported namespace uses.' }),
    // resolveAsset already folds a rate-limited answer into 'unresolved'; this
    // entry keeps a raw payload readable if one ever reaches the component.
    rate_limited: t('resolve.status_rate_limited', { defaultValue: 'This hour’s resolution limit has been reached.' }),
  }[status] || t('resolve.status_unresolved', { defaultValue: 'No provider recognised this identifier.' })

  const sunburstRoot = deployments.length >= 2 ? {
    name: identity.symbol || result?.query || '',
    children: deployments.map(deployment => ({
      name: deployment.chain,
      value: 1,
      children: [{ name: deployment.address, value: 1 }],
    })),
  } : null

  return (
    <section className="intel-resolve-result space-y-3" aria-label={t('resolve.heading', { defaultValue: 'Identifier resolution' })}>
      <div className="eyebrow">{t('resolve.heading', { defaultValue: 'Identifier resolution' })}</div>
      <p className="text-sm text-[var(--fg-2)]" role="status">
        {statusLine}
        {result?.reason ? <> {t(`resolve.reason_${result.reason}`, { defaultValue: result.reason })}</> : null}
        {onRefresh ? <> <button type="button" className="intel-text-link" onClick={onRefresh}>{t('resolve.retry', { defaultValue: 'Resolve again' })}</button></> : null}
      </p>

      {identity && (
        <p className="intel-event-meta">
          {[identity.symbol, identity.name, identity.chain, identity.address || identity.providerId, identity.provider].filter(Boolean).join(' · ')}
        </p>
      )}

      {status === 'ambiguous' && (
        <ul className="intel-resolve-candidates" aria-label={t('resolve.candidates', { defaultValue: 'Matching assets' })}>
          {candidates.map((candidate, index) => (
            <li key={`${candidate.chain}:${candidate.address}:${index}`} className="flex items-baseline justify-between gap-3 flex-wrap border-t border-[var(--border-default)] py-2">
              <span className="text-sm text-[var(--fg-1)]">
                {[candidate.chain, candidate.symbol, candidate.name].filter(Boolean).join(' · ')}
              </span>
              <span className="intel-event-meta">
                {[candidate.address, formatUsd(candidate.liquidityUsd), candidate.source].filter(Boolean).join(' · ')}
              </span>
              <button
                type="button"
                className="intel-text-link"
                onClick={() => onPick?.(candidate.route || contractRouteFor(candidate.symbol, candidate.chain, candidate.address))}
              >
                {t('resolve.open', { defaultValue: 'Open' })}
              </button>
            </li>
          ))}
        </ul>
      )}

      <RadialBars
        title={t('resolve.provenance_title', { defaultValue: 'How this identifier was resolved' })}
        description={t('resolve.provenance_sub', { defaultValue: 'Every source the resolver walked, in ladder order. An outer ring is asked first.' })}
        series={steps}
        formatValue={outcomeWord}
        state={steps.length ? 'ready' : 'empty'}
        reason={result?.reason ? t(`resolve.reason_${result.reason}`, { defaultValue: result.reason }) : undefined}
      />

      <details className="intel-chart-table intel-resolve-provenance">
        <summary>{t('resolve.provenance_table', { defaultValue: 'Show resolution steps as a table' })}</summary>
        <table>
          <caption>{t('resolve.provenance_title', { defaultValue: 'How this identifier was resolved' })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('resolve.column_step', { defaultValue: 'Source' })}</th>
              <th scope="col">{t('resolve.column_outcome', { defaultValue: 'Outcome' })}</th>
              <th scope="col">{t('resolve.column_ms', { defaultValue: 'Milliseconds' })}</th>
            </tr>
          </thead>
          <tbody>
            {steps.map(step => (
              <tr key={step.key}>
                <th scope="row">{step.label}</th>
                <td className="intel-number">{outcomeWord(step.value)}{step.detail ? ` · ${step.detail}` : ''}</td>
                <td className="intel-number">{Number.isFinite(Number(step.ms)) ? Number(step.ms) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      {indexLine && (
        <p className="intel-resolve-index intel-event-meta">{indexLine}</p>
      )}

      {sunburstRoot && (
        <Sunburst
          title={t('resolve.deployments_title', { defaultValue: 'Where this asset is deployed' })}
          description={t('resolve.deployments_sub', { defaultValue: 'One ring per chain, with the contract address it carries there. Choose a chain to open it.' })}
          root={sunburstRoot}
          depth={2}
          onSelect={arc => {
            const chain = arc?.path?.[1]
            const deployment = deployments.find(entry => entry.chain === chain)
            if (!deployment) return
            onPick?.(contractRouteFor(identity.symbol || result?.query, deployment.chain, deployment.address))
          }}
        />
      )}
    </section>
  )
}
