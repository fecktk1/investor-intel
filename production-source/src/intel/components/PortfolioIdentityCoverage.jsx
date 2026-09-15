import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { RadialBars } from '../charts'
import { readPortfolioIdentity } from '../lib/markets-api'
import { formatPrice, formatUsd } from '../lib/market-format'

// Investor Intel — contract identity coverage for the open book (CMC plan
// Stage 4, proposal 25).
//
// A holding that arrived from a wallet sync carries a contract address and a
// chain but no price. On 2026-09-15, 98 open holdings were unpriced: 72 base,
// 9 bnb, 8 ethereum, 6 avalanche, 3 optimism. This panel says which of those a
// provider can actually be asked about, and then asks — on a button, never on
// render, because a run spends provider credits.
//
// THREE THINGS THIS PANEL MUST NOT BLUR
//
//  1. An UNSUPPORTED chain is not a failure. Only four CoinMarketCap DEX
//     platforms are verified (ethereum, base, arbitrum, solana); bnb, avalanche
//     and optimism are not, so those holdings are reported as unsupported with
//     the reason the server gave, never as "could not be priced" and never
//     silently dropped from a count.
//  2. A zero is a reading. A chain with nothing unpriced reports 0 — an absent
//     row would read as "no holdings there", which is a different fact.
//  3. `identity_only` (the server's `price_unavailable`) is not "not found".
//     The provider knew the token and quoted no price. Both are listed, apart.
//
// Shapes are `intel-portfolio-identity` (coverage / resolve / entities) and
// supabase/functions/_shared/intel/holding-identity.ts, read through
// `readPortfolioIdentity`, which never throws.

const count = value => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

const DASH = '—'

// One arc per chain: the share of that chain's OPEN holdings that carry a
// provider price. Tone says whether the chain is one a run could ask about at
// all — a 0% arc on an unsupported chain is not the same failure as a 0% arc on
// a supported one.
export function chainArcs(chains, { label = row => row.chain, supportedTone = 'green', unsupportedTone = 'muted' } = {}) {
  return (Array.isArray(chains) ? chains : []).map((row, index) => {
    const total = count(row?.total)
    const priced = count(row?.priced)
    const arc = {
      key: row?.chain ?? index,
      chain: String(row?.chain ?? ''),
      supported: row?.supported === true,
      total,
      priced,
      unpriced: count(row?.unpriced),
      stale: count(row?.stale),
      estimated: count(row?.estimated),
      resolvable: count(row?.resolvable),
      reason: row?.reason || null,
      // A chain with no open holdings is 0% covered, not NaN.
      value: total > 0 ? (priced / total) * 100 : 0,
      max: 100,
      tone: row?.supported === true ? supportedTone : unsupportedTone,
    }
    return { ...arc, label: label(arc) }
  })
}

/** Every total the server publishes, as a real number. A missing total is a
 *  book with nothing in it, which is a set of zeros — never a set of dashes. */
export function coverageTotals(totals) {
  return {
    chains: count(totals?.chains),
    total: count(totals?.total),
    priced: count(totals?.priced),
    unpriced: count(totals?.unpriced),
    stale: count(totals?.stale),
    estimated: count(totals?.estimated),
    resolvable: count(totals?.resolvable),
    unsupported: count(totals?.unsupported),
    missingContract: count(totals?.missingContract),
  }
}

/**
 * "in 45 seconds", "in 12 minutes", "in 2 hours" — the rate limit said WHEN, so
 * the surface says when. A limit with no usable retry window says "shortly"
 * rather than inventing a time.
 */
export function retryAfterWords(seconds, t) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return t('holding_identity.retry_soon', { defaultValue: 'shortly' })
  if (n < 90) return t('holding_identity.retry_seconds', { seconds: Math.ceil(n), defaultValue: 'in {{seconds}} seconds' })
  const minutes = Math.ceil(n / 60)
  if (minutes < 60) return t('holding_identity.retry_minutes', { minutes, defaultValue: 'in {{minutes}} minutes' })
  return t('holding_identity.retry_hours', { hours: Math.ceil(minutes / 60), defaultValue: 'in {{hours}} hours' })
}

// The server's per-holding verdicts, in the order a reader cares about them.
export const ANSWER_REASONS = ['priced', 'price_unavailable', 'not_found_on_provider', 'unsupported_platform', 'no_contract_address', 'over_run_limit']

const ANSWER_LABELS = {
  priced: 'Priced',
  price_unavailable: 'Identity only',
  not_found_on_provider: 'Not found',
  unsupported_platform: 'Unsupported chain',
  no_contract_address: 'No contract address',
  over_run_limit: 'Over this run’s limit',
}

// English source text for every reason code the function publishes, kept beside
// the component so a reason is never rendered as a bare identifier while its
// translation is pending — and never swallowed.
const REASON_LABELS = {
  unsupported_platform: 'CoinMarketCap’s DEX aggregate does not cover this chain, so nothing on it can be asked about.',
  holdings_unavailable: 'Your holdings could not be read.',
  entities_unavailable: 'The entity list could not be read.',
  resolution_rate_limited: 'This workspace has used all its paid runs for the hour.',
  resolution_rate_unavailable: 'The run ledger could not be read, so no paid run was started.',
  portfolio_identity_unavailable: 'The identity service did not answer. Try again.',
  invalid_org: 'This workspace identity was not accepted.',
  invalid_portfolio: 'That portfolio identity was not accepted.',
  invalid_limit: 'That run size is not one this function accepts.',
}

const ENTITY_LABELS = {
  linked: 'Linked',
  ambiguous_provider_id: 'More than one id',
  not_found_on_provider: 'Not found',
  write_failed: 'Could not be saved',
}

const shorten = address => {
  const value = String(address || '')
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value || DASH
}

/** One row per holding the run answered about, ordered by verdict so the priced
 *  ones read first and the skipped ones are still there rather than implied. */
export function answerRows(holdings) {
  return (Array.isArray(holdings) ? holdings : [])
    .map((row, index) => ({
      key: `${row?.holdingId ?? index}`,
      holdingId: String(row?.holdingId ?? ''),
      asset: row?.symbol || row?.name || shorten(row?.address),
      chain: String(row?.chain ?? ''),
      reason: String(row?.reason ?? ''),
      price: row?.cmcDexPrice == null ? null : Number(row.cmcDexPrice),
      value: row?.value == null ? null : Number(row.value),
      priceFrom: row?.priceFrom || null,
      index,
    }))
    .sort((a, b) => {
      const rank = reason => {
        const i = ANSWER_REASONS.indexOf(reason)
        return i === -1 ? ANSWER_REASONS.length : i
      }
      return rank(a.reason) - rank(b.reason) || a.index - b.index
    })
}

export default function PortfolioIdentityCoverage({ portfolioId = null }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  // Org-scoped Edge read on the reader's authenticated client: the function
  // verifies the user, the membership and the Intel entitlement.
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [read, setRead] = useState({ status: 'loading', payload: null })
  const [run, setRun] = useState(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!orgId) return undefined
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null })
    // A coverage read is rows only: no provider call, no credits, safe on mount.
    readPortfolioIdentity(supabase, { orgId, op: 'coverage', portfolioId, signal: controller.signal })
      .then(payload => { if (alive) setRead({ status: payload.state === 'ready' ? 'ready' : 'unavailable', payload }) })
    return () => { alive = false; controller.abort() }
  }, [supabase, orgId, portfolioId, revision])

  const start = useCallback(async op => {
    setRun({ op, busy: true, payload: null })
    const payload = await readPortfolioIdentity(supabase, { orgId, op, portfolioId })
    setRun({ op, busy: false, payload })
    // A resolve run writes prices, so the coverage it was started from is now
    // stale. It is re-read rather than patched locally: the book is the record.
    if (op === 'resolve' && payload.state === 'ready') setRevision(value => value + 1)
  }, [supabase, orgId, portfolioId])

  const payload = read.payload
  const arcs = useMemo(() => chainArcs(payload?.chains, {
    label: row => t('holding_identity.arc_label', {
      chain: row.chain,
      priced: row.priced,
      total: row.total,
      defaultValue: '{{chain}} — {{priced}} of {{total}} priced',
    }),
  }), [payload, t])
  const totals = coverageTotals(payload?.totals)
  const answers = useMemo(() => answerRows(run?.op === 'resolve' ? run?.payload?.holdings : null), [run])
  const entities = Array.isArray(run?.payload?.entities) && run?.op === 'entities' ? run.payload.entities : []

  if (!orgId) return null

  const loading = read.status === 'loading'
  const failed = read.status === 'unavailable'
  const reasonText = failed && payload?.reason
    ? t(`holding_identity.reason_${payload.reason}`, { defaultValue: REASON_LABELS[payload.reason] || payload.reason })
    : undefined
  const busy = !!run?.busy
  const rateLimited = run?.payload?.reason === 'resolution_rate_limited'

  const TOTAL_FIELDS = [
    ['priced', 'Priced'],
    ['unpriced', 'Unpriced'],
    ['stale', 'Stale'],
    ['estimated', 'Estimated'],
    ['unsupported', 'Unsupported chain'],
    ['missingContract', 'No contract address'],
  ]

  return (
    <section className="intel-holding-identity space-y-3" aria-label={t('holding_identity.heading', { defaultValue: 'Contract identity coverage' })}>
      <div className="eyebrow">{t('holding_identity.heading', { defaultValue: 'Contract identity coverage' })}</div>

      <div className="grid gap-x-8 gap-y-3 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] items-start">
        <RadialBars
          title={t('holding_identity.ring_title', { defaultValue: 'Priced share of your open book, by chain' })}
          description={t('holding_identity.ring_sub', { defaultValue: 'One arc per chain your open holdings sit on. The arc is the share of that chain’s holdings a provider has priced; a chain nothing can be asked about is drawn muted and says why in the table.' })}
          series={arcs}
          formatValue={value => `${(Number(value) || 0).toFixed(1)}%`}
          state={failed ? 'error' : (!loading && arcs.length) ? 'ready' : 'empty'}
          reason={reasonText}
        />
        {arcs.length && !loading && !failed ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] intel-holding-identity-chains">
              <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
                {t('holding_identity.table_caption', {
                  chains: totals.chains,
                  total: totals.total,
                  resolvable: totals.resolvable,
                  defaultValue: '{{total}} open holdings across {{chains}} chains. {{resolvable}} of them sit on a verified DEX chain with a usable contract address, which is what a run can ask about.',
                })}
              </caption>
              <thead>
                <tr>
                  {[
                    t('holding_identity.col_chain', { defaultValue: 'Chain' }),
                    t('holding_identity.col_total', { defaultValue: 'Open' }),
                    t('holding_identity.col_priced', { defaultValue: 'Priced' }),
                    t('holding_identity.col_unpriced', { defaultValue: 'Unpriced' }),
                    t('holding_identity.col_stale', { defaultValue: 'Stale' }),
                    t('holding_identity.col_estimated', { defaultValue: 'Estimated' }),
                    t('holding_identity.col_resolvable', { defaultValue: 'Askable' }),
                    t('holding_identity.col_reason', { defaultValue: 'Reason' }),
                  ].map(column => (
                    <th key={column} scope="col" className="text-left font-normal text-[var(--fg-4)] border-b border-[var(--border-default)] py-2 pr-3">{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {arcs.map(row => (
                  <tr key={row.key}>
                    <th scope="row" className="text-left font-normal text-[var(--fg-2)] border-b border-[var(--border-default)] py-2 pr-3">{row.chain}</th>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{row.total}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{row.priced}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{row.unpriced}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{row.stale}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{row.estimated}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{row.resolvable}</td>
                    {/* The reason an unsupported chain is unsupported is the
                        actionable fact; a supported chain has none to state. */}
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">
                      {row.reason ? t(`holding_identity.reason_${row.reason}`, { defaultValue: REASON_LABELS[row.reason] || row.reason }) : DASH}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {loading ? <p role="status" className="text-[12px] text-[var(--fg-4)]">{t('holding_identity.loading', { defaultValue: 'Reading your book…' })}</p> : null}
      {failed ? (
        <p role="alert" className="text-[12px] text-[var(--fg-4)]">
          {t('holding_identity.read_failed', { defaultValue: 'Your identity coverage could not be read.' })} {reasonText}{' '}
          <button type="button" className="intel-text-link" onClick={() => setRevision(value => value + 1)}>{t('common.retry', { defaultValue: 'Retry' })}</button>
        </p>
      ) : null}

      {!loading && !failed ? (
        <p className="text-[12px] text-[var(--fg-4)] flex flex-wrap gap-x-4 gap-y-1">
          {TOTAL_FIELDS.map(([field, fallback]) => (
            <span key={field}>
              {t(`holding_identity.total_${field}`, { defaultValue: fallback })}{' '}
              <span className="intel-number text-[var(--fg-2)]">{totals[field]}</span>
            </span>
          ))}
          {payload?.truncated ? <span>{t('holding_identity.truncated', { defaultValue: 'Your book is larger than one read: these counts cover the first 5,000 open holdings.' })}</span> : null}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy || loading || failed} onClick={() => start('resolve')}>
          {busy && run?.op === 'resolve'
            ? t('holding_identity.resolving', { defaultValue: 'Asking the provider…' })
            : t('holding_identity.resolve_now', { defaultValue: 'Resolve now' })}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy || loading || failed} onClick={() => start('entities')}>
          {busy && run?.op === 'entities'
            ? t('holding_identity.linking', { defaultValue: 'Looking ids up…' })
            : t('holding_identity.link_entities', { defaultValue: 'Attach CoinMarketCap ids to entities' })}
        </button>
      </div>

      {run && !run.busy && rateLimited ? (
        <p role="alert" className="text-[12px] text-[var(--fg-4)]">
          {t('holding_identity.rate_limited', {
            limit: count(run.payload?.limit),
            when: retryAfterWords(run.payload?.retryAfterSeconds, t),
            defaultValue: 'This workspace has used all {{limit}} paid runs for the hour. The next one can start {{when}}.',
          })}
        </p>
      ) : null}

      {run && !run.busy && !rateLimited && run.payload?.state !== 'ready' ? (
        <p role="alert" className="text-[12px] text-[var(--fg-4)]">
          {t('holding_identity.run_failed', { defaultValue: 'That run could not be completed.' })}{' '}
          {t(`holding_identity.reason_${run.payload?.reason}`, { defaultValue: REASON_LABELS[run.payload?.reason] || String(run.payload?.reason || '') })}
        </p>
      ) : null}

      {run?.op === 'resolve' && !run.busy && run.payload?.state === 'ready' ? (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] intel-holding-identity-run">
            <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
              {t('holding_identity.run_caption', {
                requested: count(run.payload.requested),
                priced: count(run.payload.priced),
                identityOnly: count(run.payload.identityOnly),
                notFound: count(run.payload.notFound),
                credits: count(run.payload.credits),
                defaultValue: 'Asked about {{requested}} holdings: {{priced}} priced, {{identityOnly}} identity only, {{notFound}} not found. {{credits}} provider calls were made.',
              })}
              {' '}
              {(run.payload.unsupported || []).length
                ? t('holding_identity.run_unsupported', {
                  chains: (run.payload.unsupported || []).map(row => `${row.chain} (${count(row.count)})`).join(', '),
                  defaultValue: 'Not asked about, because CoinMarketCap’s DEX aggregate does not cover the chain: {{chains}}.',
                })
                : null}
              {' '}
              {run.payload.planTruncated
                ? t('holding_identity.run_truncated', { defaultValue: 'More holdings were eligible than one run asks about; run it again to continue.' })
                : null}
              {(run.payload.writeErrors || []).length
                ? ` ${t('holding_identity.run_write_errors', { errors: (run.payload.writeErrors || []).length, defaultValue: '{{errors}} prices the provider gave could not be saved to your book.' })}`
                : null}
            </caption>
            <thead>
              <tr>
                {[
                  t('holding_identity.col_asset', { defaultValue: 'Asset' }),
                  t('holding_identity.col_chain', { defaultValue: 'Chain' }),
                  t('holding_identity.col_outcome', { defaultValue: 'Outcome' }),
                  t('holding_identity.col_price', { defaultValue: 'Price' }),
                  t('holding_identity.col_value', { defaultValue: 'Value' }),
                ].map(column => (
                  <th key={column} scope="col" className="text-left font-normal text-[var(--fg-4)] border-b border-[var(--border-default)] py-2 pr-3">{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {answers.length ? answers.map(row => (
                <tr key={row.key}>
                  <th scope="row" className="text-left font-normal text-[var(--fg-2)] border-b border-[var(--border-default)] py-2 pr-3">{row.asset || DASH}</th>
                  <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{row.chain || DASH}</td>
                  <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">
                    {t(`holding_identity.answer_${row.reason}`, { defaultValue: ANSWER_LABELS[row.reason] || row.reason })}
                  </td>
                  {/* No price is an absence, not a zero: a zero would value a
                      real position at nothing. */}
                  <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{row.price == null ? DASH : formatPrice(row.price)}</td>
                  <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{row.value == null ? DASH : formatUsd(row.value)}</td>
                </tr>
              )) : (
                <tr>
                  <th scope="row" className="text-left font-normal text-[var(--fg-2)] border-b border-[var(--border-default)] py-2 pr-3">{t('holding_identity.run_none', { defaultValue: 'Nothing to ask about' })}</th>
                  <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3" colSpan={4}>
                    {t('holding_identity.run_none_detail', { defaultValue: 'No open holding is unpriced or stale on a verified DEX chain, so no provider call was made and nothing was spent.' })}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : null}

      {run?.op === 'entities' && !run.busy && run.payload?.state === 'ready' ? (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] intel-holding-identity-entities">
            <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
              {t('holding_identity.entities_caption', {
                examined: count(run.payload.examined),
                eligible: count(run.payload.eligible),
                requested: count(run.payload.requested),
                updated: count(run.payload.updated),
                deferred: count(run.payload.deferred),
                credits: count(run.payload.credits),
                defaultValue: 'Examined {{examined}} entities, {{eligible}} of them eligible; looked up {{requested}} and linked {{updated}}. {{deferred}} are still waiting for a later run. {{credits}} provider calls were made.',
              })}
            </caption>
            <thead>
              <tr>
                {[
                  t('holding_identity.col_entity', { defaultValue: 'Entity' }),
                  t('holding_identity.col_chain', { defaultValue: 'Chain' }),
                  t('holding_identity.col_address', { defaultValue: 'Address' }),
                  t('holding_identity.col_cmc_id', { defaultValue: 'CoinMarketCap id' }),
                  t('holding_identity.col_outcome', { defaultValue: 'Outcome' }),
                ].map(column => (
                  <th key={column} scope="col" className="text-left font-normal text-[var(--fg-4)] border-b border-[var(--border-default)] py-2 pr-3">{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entities.length ? entities.map((row, index) => (
                <tr key={`${row?.entityId ?? index}`}>
                  <th scope="row" className="text-left font-normal text-[var(--fg-2)] border-b border-[var(--border-default)] py-2 pr-3">{shorten(row?.entityId)}</th>
                  <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{row?.chain || DASH}</td>
                  <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{shorten(row?.address)}</td>
                  <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{row?.cmcId || DASH}</td>
                  <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">
                    {t(`holding_identity.entity_${row?.reason}`, { defaultValue: ENTITY_LABELS[row?.reason] || String(row?.reason || '') })}
                  </td>
                </tr>
              )) : (
                <tr>
                  <th scope="row" className="text-left font-normal text-[var(--fg-2)] border-b border-[var(--border-default)] py-2 pr-3">{t('holding_identity.entities_none', { defaultValue: 'Nothing to link' })}</th>
                  <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3" colSpan={4}>
                    {t('holding_identity.entities_none_detail', { defaultValue: 'Every contract entity on a verified chain already carries a CoinMarketCap id.' })}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="text-[12px] text-[var(--fg-4)]">
        {t('holding_identity.caption', { defaultValue: 'Prices here come from CoinMarketCap’s DEX aggregate, not from a wallet or an exchange. A run spends provider credits and this workspace may start four an hour; what is recorded is the workspace’s run, never the person who started it.' })}
      </p>
    </section>
  )
}
