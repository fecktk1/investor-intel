import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { RadialBars, Sunburst } from '../charts'
import { resolveAsset } from '../lib/markets-api'
import { chainIdFor, getChain, SOLANA_ADDRESS_RE } from '../lib/chains'
import {
  OUTCOME_TONE, ResolveCandidates, STEP_LABELS, contractRouteFor,
  indexProvenance, orderedProvenance, resolveStatusLine,
} from './AssetResolveResult'

// Investor Intel — how THIS asset page's identity was established (CMC plan
// Stage 4, proposal 31: the contract search long tail).
//
// The asset page already says what an asset is. This figure says how the
// platform knows: every rung of the resolver ladder, whether it answered, how
// long it took and what it said. Three things it must never blur:
//
//   1. `identity_only` is a RESOLUTION, not a failure. The chain answered with a
//      name and a symbol and no market source prices the contract. The asset is
//      indexed and searchable; every price on the page will be empty. Reporting
//      it as "nothing answered" would hide a real asset.
//   2. A step that was never asked (`skipped`) is not a step that was asked and
//      found nothing (`miss`). The ring draws a skipped step as its bare track —
//      no arc at all — and the table twin gives each its own word.
//   3. A resolution costs a provider read, so it is spent only when the page's
//      identity is something the resolver can actually be asked about: a
//      contract, or a CoinMarketCap id. An exchange-market identity renders
//      nothing rather than burning a read to be told it is not a contract.
//
// Shapes are `ResolveResult` in supabase/functions/_shared/intel/asset-resolver.ts
// (status, identity.deployments, provenance:[{step,outcome,ms,detail}]) as
// normalized by `resolveAsset` in ../lib/markets-api.

const CMC_ID_RE = /^\d{1,9}$/
const EIP155_KEY_RE = /^eip155:(\d{1,20}):(0x[0-9a-fA-F]{40})$/
const SOLANA_KEY_PREFIX = 'solana:'

const finite = value => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * The resolver question this page's identity is, or null when it is not one.
 *
 * `detectIdentifier` (supabase/functions/_shared/intel/asset-identifier.ts) reads
 * a BARE address plus a chain hint — `ethereum:0x…` as one string is not a form
 * it recognises and would come back `unrecognized_identifier`. So a contract
 * identity is split into { query: address, chain }, and a CoinMarketCap id is
 * sent in the one prefixed form the detector does accept, `cmc:<id>`.
 *
 * The chain hint must be an app chain id (`getChain`): an unknown hint is
 * `unknown_chain_hint`, which would spend the read to be told nothing.
 */
export function provenanceIdentity({ sourceProvider = null, providerId = null, canonicalKey = null } = {}) {
  const provider = typeof sourceProvider === 'string' ? sourceProvider.trim().toLowerCase() : ''
  const id = providerId == null ? '' : String(providerId).trim()

  if (provider === 'coinmarketcap' && CMC_ID_RE.test(id)) return { kind: 'cmc', query: `cmc:${id}`, chain: null }

  // The contract route's own identity: `?provider=contract&id=<chain>:<address>`.
  if (provider === 'contract' && id.includes(':')) {
    const at = id.indexOf(':')
    const chain = id.slice(0, at).trim().toLowerCase()
    const address = id.slice(at + 1).trim()
    if (address && getChain(chain)) return { kind: 'contract', query: address, chain }
  }

  const key = typeof canonicalKey === 'string' ? canonicalKey.trim() : ''
  if (key) {
    const eip = EIP155_KEY_RE.exec(key)
    // entities key an EVM chain by its numeric reference; the resolver hint is
    // the app chain id, so a reference with no registry chain is not asked about.
    if (eip) {
      const chain = chainIdFor('eip155', eip[1])
      if (chain) return { kind: 'contract', query: eip[2].toLowerCase(), chain }
    }
    // A native coin has no contract to trace, and `:native:` is how the key says so.
    if (key.startsWith(SOLANA_KEY_PREFIX) && !key.includes(':native')) {
      const mint = key.slice(SOLANA_KEY_PREFIX.length)
      if (SOLANA_ADDRESS_RE.test(mint)) return { kind: 'contract', query: mint, chain: 'solana' }
    }
  }
  return null
}

/**
 * One arc per ladder step, sized by how long that step took.
 *
 * `max` is the SLOWEST step in this resolution, so the ring reads as "where the
 * time went" rather than against an invented budget. A run in which nothing took
 * measurable time still draws (max falls back to 1) instead of dividing by zero,
 * and a step with no reported ms is a 0, never a guess.
 */
export function provenanceArcs(result, { label = step => STEP_LABELS[step] || step } = {}) {
  const steps = orderedProvenance(result)
  const slowest = steps.reduce((max, entry) => Math.max(max, finite(entry?.ms) ?? 0), 0)
  const max = slowest > 0 ? slowest : 1
  return steps.map(entry => ({
    key: `${entry.step}-${entry.index}`,
    step: entry.step,
    label: label(entry.step),
    outcome: entry.outcome,
    detail: entry.detail || null,
    ms: finite(entry?.ms) ?? 0,
    value: finite(entry?.ms) ?? 0,
    max,
    tone: OUTCOME_TONE[entry.outcome] || OUTCOME_TONE.skipped,
  }))
}

/** Chain → address, from the identity's deployments. `{ name, children: [] }`
 *  when nothing is deployed, so the Sunburst renders empty rather than throwing. */
export function deploymentRoot(result, { rootName = 'Deployments' } = {}) {
  const identity = result?.identity || null
  const deployments = Array.isArray(identity?.deployments) ? identity.deployments : []
  return {
    name: identity?.symbol || result?.query || rootName,
    children: deployments
      .filter(entry => entry?.chain)
      .map(entry => ({
        name: String(entry.chain),
        value: 1,
        children: entry.address ? [{ name: String(entry.address), value: 1 }] : [],
      })),
  }
}

const OUTCOME_LABELS = { hit: 'Answered', miss: 'No match', error: 'Failed', skipped: 'Not asked' }

export default function AssetProvenance({ sourceProvider = null, providerId = null, canonicalKey = null }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const navigate = useNavigate()
  const orgId = org?.id || null
  const target = useMemo(
    () => provenanceIdentity({ sourceProvider, providerId, canonicalKey }),
    [sourceProvider, providerId, canonicalKey],
  )
  const [read, setRead] = useState({ status: 'loading', result: null })
  const [revision, setRevision] = useState(0)
  const key = target ? `${target.kind}|${target.query}|${target.chain || ''}` : null

  useEffect(() => {
    if (!key) return undefined
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', result: null })
    // resolveAsset never throws and never returns an empty object: a transport
    // failure arrives as an 'unresolved' result carrying its own reason. It is
    // still wrapped, because a caller that hands this component a stubbed or
    // rejected resolver must degrade to "nothing answered" rather than take the
    // asset page down with it.
    Promise.resolve(resolveAsset(supabase, target.query, target.chain, { orgId, signal: controller.signal }))
      .then(result => { if (alive) setRead({ status: 'ready', result: result && typeof result === 'object' ? result : null }) })
      .catch(() => { if (alive) setRead({ status: 'ready', result: null }) })
    return () => { alive = false; controller.abort() }
  }, [supabase, orgId, key, revision]) // eslint-disable-line react-hooks/exhaustive-deps

  const outcomeWord = useCallback(
    outcome => t(`resolve.outcome_${outcome === 'hit' ? 'hit' : outcome === 'miss' ? 'miss' : outcome === 'error' ? 'error' : 'skipped'}`, {
      defaultValue: OUTCOME_LABELS[outcome] || OUTCOME_LABELS.skipped,
    }),
    [t],
  )

  const result = read.result
  const arcs = useMemo(
    () => provenanceArcs(result, { label: step => t(`resolve.step_${step}`, { defaultValue: STEP_LABELS[step] || step }) }),
    [result, t],
  )
  const root = useMemo(
    () => deploymentRoot(result, { rootName: t('provenance.deployments_root', { defaultValue: 'Deployments' }) }),
    [result, t],
  )

  // A page whose identity is an exchange market has no contract and no
  // CoinMarketCap id to trace. Nothing is read and nothing is drawn.
  if (!target) return null

  const status = result?.status || 'unresolved'
  const identity = result?.identity || null
  const indexEntry = indexProvenance(result)
  const loading = read.status === 'loading'
  const reasonText = result?.reason ? t(`resolve.reason_${result.reason}`, { defaultValue: result.reason }) : null
  const identityRoute = identity
    ? identity.route || (identity.chain && identity.address ? contractRouteFor(identity.symbol || result?.query, identity.chain, identity.address) : null)
    : null

  return (
    <section className="intel-asset-provenance space-y-3" aria-label={t('provenance.heading', { defaultValue: 'How this asset was identified' })}>
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="eyebrow">{t('provenance.heading', { defaultValue: 'How this asset was identified' })}</div>
        <button
          type="button"
          className="intel-text-link"
          disabled={loading}
          onClick={() => setRevision(value => value + 1)}
        >
          {loading
            ? t('provenance.resolving', { defaultValue: 'Resolving…' })
            : t('provenance.resolve_now', { defaultValue: 'Resolve now' })}
        </button>
      </div>

      <p className="text-sm text-[var(--fg-2)]" role="status">
        {loading
          ? t('provenance.reading', { defaultValue: 'Asking every source in ladder order…' })
          : <>
            {resolveStatusLine(t, status)}
            {status === 'identity_only'
              ? <> {t('provenance.identity_only_detail', { defaultValue: 'It is indexed and searchable; every market figure on this page stays empty until a source lists it.' })}</>
              : null}
            {reasonText && status !== 'identity_only' ? <> {reasonText}</> : null}
            {identityRoute && status === 'identity_only'
              ? <> <button type="button" className="intel-text-link" onClick={() => navigate(identityRoute)}>{t('resolve.open', { defaultValue: 'Open' })}</button></>
              : null}
          </>}
      </p>

      {identity && !loading && (
        <p className="intel-event-meta">
          {[identity.symbol, identity.name, identity.chain, identity.address || identity.providerId, identity.provider].filter(Boolean).join(' · ')}
        </p>
      )}

      {status === 'ambiguous' && !loading && (
        <ResolveCandidates candidates={Array.isArray(result?.candidates) ? result.candidates : []} onPick={route => navigate(route)} />
      )}

      <div className="grid gap-x-8 gap-y-3 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] items-start">
        <RadialBars
          title={t('provenance.ring_title', { defaultValue: 'Where the resolution spent its time' })}
          description={t('provenance.ring_sub', { defaultValue: 'One arc per source, in ladder order, sized by the milliseconds that source took. A source that was never asked draws no arc at all — only its track.' })}
          series={arcs}
          formatValue={value => t('provenance.ms', { ms: Math.round(Number(value) || 0), defaultValue: '{{ms}} ms' })}
          state={loading ? 'empty' : arcs.length ? 'ready' : 'empty'}
          reason={reasonText || undefined}
        />
        {arcs.length && !loading ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] intel-provenance-steps">
              <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
                {t('provenance.table_caption', {
                  query: target.query,
                  chain: target.chain || t('provenance.no_chain', { defaultValue: 'no chain hint' }),
                  defaultValue: 'Every source asked about {{query}} ({{chain}}), in the order the ladder walks them.',
                })}
              </caption>
              <thead>
                <tr>
                  {[
                    t('resolve.column_step', { defaultValue: 'Source' }),
                    t('resolve.column_outcome', { defaultValue: 'Outcome' }),
                    t('resolve.column_ms', { defaultValue: 'Milliseconds' }),
                    t('provenance.column_detail', { defaultValue: 'What it said' }),
                  ].map(column => (
                    <th key={column} scope="col" className="text-left font-normal text-[var(--fg-4)] border-b border-[var(--border-default)] py-2 pr-3">{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {arcs.map(arc => (
                  <tr key={arc.key}>
                    <th scope="row" className="text-left font-normal text-[var(--fg-2)] border-b border-[var(--border-default)] py-2 pr-3">{arc.label}</th>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{outcomeWord(arc.outcome)}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{arc.ms}</td>
                    {/* A detail the server did not report is a dash, never an
                        invented explanation of what the source meant. */}
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{arc.detail || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {indexEntry && !loading && (
        <p className="intel-provenance-index intel-event-meta">
          {indexEntry.outcome === 'hit'
            ? t('resolve.index_hit', { defaultValue: 'Indexed for everyone' })
            : indexEntry.outcome === 'miss'
              ? t('resolve.index_miss', { defaultValue: 'Already indexed' })
              : t('resolve.index_not', {
                defaultValue: 'Not indexed: {{detail}}',
                detail: indexEntry.detail || t('resolve.index_no_detail', { defaultValue: 'no reason given' }),
              })}
        </p>
      )}

      {root.children.length && !loading ? (
        <Sunburst
          title={t('resolve.deployments_title', { defaultValue: 'Where this asset is deployed' })}
          description={t('resolve.deployments_sub', { defaultValue: 'One ring per chain, with the contract address it carries there. Choose a chain to open it.' })}
          root={root}
          depth={2}
          onSelect={arc => {
            const chain = arc?.path?.[1]
            const deployment = (identity?.deployments || []).find(entry => entry.chain === chain)
            if (!deployment) return
            navigate(contractRouteFor(identity?.symbol || result?.query, deployment.chain, deployment.address))
          }}
        />
      ) : null}

      <p className="text-[12px] text-[var(--fg-4)]">
        {t('provenance.caption', { defaultValue: 'A resolution walks the sources in order and stops asking once it has an identity, so a source that reads “not asked” was never reached — it did not refuse. Timings are this resolution’s own, not an average.' })}
      </p>
    </section>
  )
}
