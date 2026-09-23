import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fmtPrice, fmtVol } from '../lib/market-format'
import { lookupRwaAsset, normaliseLookupQuery, RWA_LOOKUP_EXAMPLES, RWA_LOOKUP_PATTERN } from '../lib/rwa-lookup-api'

// "Look up any tokenised asset, now": one input and one answer, on /intel/rwa
// for members and demo visitors alike. The answer names the asset, its price,
// tokenised value, wrappers and premium when present, and under "How this was
// fetched" the proof for each figure: endpoint, parameters, cache or live with
// its age, HTTP status, credits, the reproduce curl (never a key) and a trimmed
// raw JSON excerpt.
//
// House style: no pills, chips, badges, cards or tiles. A sentence, hairline
// tables, text links and a <details> disclosure.

const rule = 'border-b border-[var(--border-default)]'
const cell = `${rule} py-2 pr-3 align-top`
const num = (v) => (v == null || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v))

const FIGURE_DEFAULTS = { identity: 'Identity', quote: 'Latest quote', wrappers: 'Wrappers', premium: 'Premium against the anchor' }
const SERVED_DEFAULTS = {
  live: 'Live call to CoinMarketCap for this lookup',
  cache: 'Shared cache, {{age}} old, no call made',
  retained: 'Kept copy, {{age}} old: the live read did not answer',
  capture: 'Recorded capture, {{age}} old, no call made for this lookup',
  unavailable: 'Nothing answered',
}
const REASON_DEFAULTS = {
  provider_unavailable: 'CoinMarketCap did not answer the live read (for example a plan refusal or an outage).',
  insufficient_entitlement: 'Our CoinMarketCap plan does not include this read right now.',
  credential_unavailable: 'The live CoinMarketCap connection is not configured.',
  quota_exhausted: 'The CoinMarketCap monthly allowance is used up.',
  rate_limited: 'CoinMarketCap asked us to slow down.',
  free_rwa_budget_exhausted: "Today's shared allowance of free live reads is used up.",
  free_rwa_budget_unavailable: "The shared allowance of free live reads could not be checked, so no live read was made.",
  free_rwa_lane_disabled: 'Free live reads are switched off for now.',
  free_rwa_background_read: 'A background refresh never makes a live read.',
  free_rwa_ip_hourly_limit: 'This address has used its live reads for the hour, so the newest copy is shown.',
  refresh_required: 'The shared cache had no copy inside its window.',
  live_read_unavailable: 'No live read was possible for this lookup.',
  shared_cache_past_refresh: 'The shared copy is past its refresh window; it is shown with its age.',
  call_log_not_retained: 'The call log for this capture is no longer kept, so its HTTP status and credits are not shown.',
  wrapper_rows_unavailable: 'The wrapper rows of this capture could not be read.',
  no_quote_captured: 'No quote for this asset has been captured yet.',
}

export function ageText(t, seconds) {
  const s = num(seconds)
  if (s == null) return t('rwa_lookup.age_unknown', { defaultValue: 'of unknown age' })
  if (s < 90) return t('rwa_lookup.age_seconds', { count: Math.round(s), defaultValue: '{{count}} seconds' })
  if (s < 90 * 60) return t('rwa_lookup.age_minutes', { count: Math.round(s / 60), defaultValue: '{{count}} minutes' })
  if (s < 48 * 3600) return t('rwa_lookup.age_hours', { count: Math.round(s / 3600), defaultValue: '{{count}} hours' })
  return t('rwa_lookup.age_days', { count: Math.round(s / 86400), defaultValue: '{{count}} days' })
}

export function reasonText(t, code) {
  if (!code) return null
  return t(`rwa_lookup.reason_${code}`, { defaultValue: REASON_DEFAULTS[code] || t('rwa_lookup.reason_other', { code, defaultValue: 'The live read did not answer ({{code}}).' }) })
}

const time = (v) => (v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString() : null)
const bps = (v) => { const n = num(v); return n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)} bps` }

function servedText(t, receipt) {
  const served = receipt?.served || 'unavailable'
  return t(`rwa_lookup.served_${served}`, { age: ageText(t, receipt?.ageSeconds), defaultValue: SERVED_DEFAULTS[served] || served })
}

function FigureReceipt({ name, figure }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const r = figure?.receipt
  if (!r) return null
  const absent = t('rwa_lookup.not_reported', { defaultValue: 'not reported' })
  const params = Object.entries(r.params || {})
  return (
    <div className={`${rule} py-3`} data-figure={name}>
      <h4 className="text-[13px] font-medium">{t(`rwa_lookup.figure_${name}`, { defaultValue: FIGURE_DEFAULTS[name] })}</h4>
      <dl className="intel-event-facts">
        <dt>{t('rwa_lookup.endpoint', { defaultValue: 'Endpoint' })}</dt><dd className="break-all">{r.endpoint || absent}</dd>
        <dt>{t('rwa_lookup.parameters', { defaultValue: 'Parameters' })}</dt><dd className="break-all">{params.length ? params.map(([k, v]) => `${k}=${v}`).join(' · ') : t('common.none', { defaultValue: 'None' })}</dd>
        <dt>{t('rwa_lookup.answered_by', { defaultValue: 'Answered by' })}</dt><dd data-served={r.served}>{servedText(t, r)}</dd>
        <dt>{t('rwa_lookup.captured_at', { defaultValue: 'Captured at' })}</dt><dd>{time(r.capturedAt) || absent}</dd>
        <dt>{t('rwa_lookup.http_status', { defaultValue: 'HTTP status' })}</dt><dd>{r.httpStatus == null ? absent : String(r.httpStatus)}</dd>
        {/* A reported 0 is a real charge of zero and reads as 0. */}
        <dt>{t('rwa_lookup.credits', { defaultValue: 'Credits charged (credit_count)' })}</dt><dd>{r.creditCount == null ? (r.served === 'cache' ? t('rwa_lookup.credits_cache', { defaultValue: 'none for this lookup; the original charge is not kept with a cached copy' }) : absent) : String(r.creditCount)}</dd>
        {r.caller && <><dt>{t('rwa_lookup.capture_lane', { defaultValue: 'Capture lane' })}</dt><dd>{r.caller}</dd></>}
        {r.reason && <><dt>{t('rwa_lookup.why', { defaultValue: 'Why' })}</dt><dd>{reasonText(t, r.reason)}</dd></>}
        {r.curl && <>
          <dt>{r.curlMeaning === 'this_call' ? t('rwa_lookup.curl_this_call', { defaultValue: 'Reproduce this call' }) : t('rwa_lookup.curl_same_request', { defaultValue: 'Check it yourself' })}</dt>
          <dd><code className="break-all" data-testid="rwa-lookup-curl">{r.curl}</code>
            <p className="intel-analysis-caption">{t('rwa_lookup.curl_caption', { defaultValue: 'Runs with your own CoinMarketCap key from the CMC_API_KEY environment variable. The key is never part of this command.' })}</p></dd>
        </>}
      </dl>
      <p className="text-[12px] text-[var(--fg-4)]">{r.rawTruncated ? t('rwa_lookup.raw_trimmed', { defaultValue: 'Raw JSON excerpt (trimmed)' }) : t('rwa_lookup.raw', { defaultValue: 'Raw JSON excerpt' })}</p>
      <pre className="text-[11px] overflow-x-auto whitespace-pre-wrap break-all max-h-64" data-testid="rwa-lookup-raw">{JSON.stringify(r.raw, null, 2)}</pre>
    </div>
  )
}

function Answer({ answer, onPick }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (answer.state === 'not_found' || answer.state === 'unavailable') {
    const cat = answer.catalogue || {}
    return (
      <div role="status" className="text-[13px] space-y-1">
        <p>{answer.state === 'unavailable'
          ? t('rwa_lookup.catalogue_unavailable', { defaultValue: 'The asset catalogue could not be read just now, so nothing could be looked up. Try again in a moment.' })
          : t('rwa_lookup.not_found', { query: answer.query, count: cat.count ?? '—', date: time(cat.capturedAt) || '—', defaultValue: 'Nothing matches “{{query}}” in the CoinMarketCap real-world asset catalogue we hold ({{count}} assets, captured {{date}}). Try a ticker such as NVDA, or a name.' })}</p>
      </div>
    )
  }
  const a = answer.asset || {}
  const f = answer.figures || {}
  const q = f.quote?.value || null
  const wrappers = Array.isArray(f.wrappers?.value) ? f.wrappers.value : []
  const premium = f.premium?.value || null
  const anyPremium = wrappers.some((w) => w.premiumBps != null)
  // Derivative prices ride along in the provider's token list but are not wrappers.
  const wrapperCount = wrappers.filter((w) => !w.derivative).length
  return (
    <div className="space-y-3" data-testid="rwa-lookup-answer">
      <div>
        <h3 className="text-lg font-medium">{a.name}{a.symbol ? ` · ${a.symbol}` : ''}</h3>
        <p className="text-[12px] text-[var(--fg-4)]">{[a.assetType ? String(a.assetType).replaceAll('_', ' ') : null, t('rwa_lookup.rwa_id', { id: a.rwaId, defaultValue: 'rwa_id {{id}}' }), a.primaryExchange].filter(Boolean).join(' · ')}</p>
      </div>
      {q ? (
        <dl className="intel-event-facts">
          <dt>{t('rwa_lookup.price', { defaultValue: 'Average tokenised price (USD)' })}</dt><dd>{q.averageTokenizedPrice == null ? t('rwa_lookup.not_reported', { defaultValue: 'not reported' }) : fmtPrice(q.averageTokenizedPrice)}</dd>
          <dt>{t('rwa_lookup.value', { defaultValue: 'Tokenised value (USD)' })}</dt><dd>{q.tokenizedMarketCap == null ? t('rwa_lookup.not_reported', { defaultValue: 'not reported' }) : fmtVol(q.tokenizedMarketCap)}</dd>
          <dt>{t('rwa_lookup.volume', { defaultValue: '24h tokenised volume (USD)' })}</dt><dd>{q.tokenizedVolume24h == null ? t('rwa_lookup.not_reported', { defaultValue: 'not reported' }) : fmtVol(q.tokenizedVolume24h)}</dd>
          <dt>{t('rwa_lookup.observed', { defaultValue: 'Quote observed' })}</dt><dd>{time(q.lastUpdated) || t('rwa_lookup.not_reported', { defaultValue: 'not reported' })}</dd>
          <dt>{t('rwa_lookup.answered_by', { defaultValue: 'Answered by' })}</dt><dd data-served={f.quote.receipt?.served}>{servedText(t, f.quote.receipt)}</dd>
          {f.quote.receipt?.reason && <><dt>{t('rwa_lookup.why', { defaultValue: 'Why' })}</dt><dd>{reasonText(t, f.quote.receipt.reason)}</dd></>}
        </dl>
      ) : (
        <p role="status" className="text-[13px]">{t('rwa_lookup.no_quote', { reason: reasonText(t, answer.reason) || '', defaultValue: 'No quote could be served for this asset. {{reason}}' })}</p>
      )}
      {wrappers.length > 0 && (
        <table className="w-full text-[12px]">
          <caption className="text-left text-[13px] font-medium pb-1">{t('rwa_lookup.wrappers_title', { count: wrapperCount, defaultValue: 'Wrappers ({{count}})' })}</caption>
          <thead>
            <tr className="text-left text-[var(--fg-4)]">
              <th scope="col" className={cell}>{t('rwa_lookup.col_token', { defaultValue: 'Token' })}</th>
              <th scope="col" className={cell}>{t('rwa_lookup.col_issuer', { defaultValue: 'Issuer' })}</th>
              <th scope="col" className={`${cell} text-right`}>{t('rwa_lookup.col_price', { defaultValue: 'Price' })}</th>
              <th scope="col" className={`${cell} text-right`}>{t('rwa_lookup.col_value', { defaultValue: 'Market cap' })}</th>
              {anyPremium && <th scope="col" className={`${cell} text-right`}>{t('rwa_lookup.col_premium', { defaultValue: 'Premium vs anchor' })}</th>}
            </tr>
          </thead>
          <tbody>
            {wrappers.map((w, i) => (
              <tr key={`${w.cryptoId || w.symbol}-${i}`}>
                <td className={cell}>{w.symbol}<span className="text-[var(--fg-4)]"> {w.name && w.name !== w.symbol ? w.name : ''}</span>
                  {w.derivative && <span className="block text-[11px] text-[var(--fg-4)]" data-derivative="">{t('rwa_lookup.derivative_label', { defaultValue: 'Derivative price, not a wrapper you can hold. Shown for comparison, never part of the anchor.' })}</span>}</td>
                <td className={cell}>{w.issuerName || '—'}</td>
                <td className={`${cell} text-right tabular-nums`}>{w.price == null ? '—' : fmtPrice(w.price)}</td>
                <td className={`${cell} text-right tabular-nums`}>{w.marketCap == null ? '—' : fmtVol(w.marketCap)}</td>
                {anyPremium && <td className={`${cell} text-right tabular-nums`}>{bps(w.premiumBps)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {premium && (
        <p className="text-[13px]">{t('rwa_lookup.premium_line', {
          anchor: premium.anchorPrice == null ? '—' : fmtPrice(premium.anchorPrice), kind: String(premium.anchorKind || '—').replaceAll('_', ' '),
          premium: bps(premium.widestPremiumBps), discount: bps(premium.widestDiscountBps), age: ageText(t, f.premium.receipt?.ageSeconds),
          defaultValue: 'Against its anchor ({{kind}}, {{anchor}}), the widest wrapper premium was {{premium}} and the widest discount {{discount}}, in the capture {{age}} ago.',
        })}</p>
      )}
      {answer.alternatives?.length > 0 && (
        <p className="text-[12px] text-[var(--fg-4)]">{t('rwa_lookup.also_matching', { defaultValue: 'Also matching:' })}{' '}
          {answer.alternatives.map((alt, i) => <React.Fragment key={alt.rwaId}>{i > 0 ? ', ' : ''}<button type="button" className="intel-text-link" onClick={() => onPick(alt.rwaId)}>{alt.name}{alt.symbol ? ` (${alt.symbol})` : ''}</button></React.Fragment>)}
        </p>
      )}
      <details className="intel-source-call-receipt" data-testid="rwa-lookup-how">
        <summary>{t('rwa_lookup.how', { defaultValue: 'How this was fetched' })}</summary>
        {['quote', 'wrappers', 'premium', 'identity'].map((name) => f[name] ? <FigureReceipt key={name} name={name} figure={f[name]} /> : null)}
      </details>
    </div>
  )
}

export default function RwaLookup({ lookup = lookupRwaAsset }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [draft, setDraft] = useState('')
  const [read, setRead] = useState({ status: 'idle', answer: null, error: null })
  const controller = useRef(null)
  useEffect(() => () => controller.current?.abort(), [])

  const run = async (value) => {
    const q = normaliseLookupQuery(value)
    setDraft(q)
    if (!RWA_LOOKUP_PATTERN.test(q)) { setRead({ status: 'error', answer: null, error: { code: 'invalid_query' } }); return }
    controller.current?.abort()
    const ctl = new AbortController()
    controller.current = ctl
    setRead({ status: 'loading', answer: null, error: null })
    try {
      const answer = await lookup(q, { signal: ctl.signal })
      if (!ctl.signal.aborted) setRead({ status: 'ready', answer, error: null })
    } catch (error) {
      if (ctl.signal.aborted || error?.name === 'AbortError') return
      setRead({ status: 'error', answer: null, error: { code: error?.code || 'lookup_unavailable', retryAfter: error?.retryAfter ?? null } })
    }
  }

  const errorText = (e) => e.code === 'invalid_query'
    ? t('rwa_lookup.error_invalid', { defaultValue: 'Type one ticker, name or rwa_id: letters, digits, spaces and . & \' ( ) -, up to 60 characters.' })
    : e.code === 'rate_limited'
      ? t('rwa_lookup.error_rate', { seconds: e.retryAfter ?? 60, defaultValue: 'Too many lookups from this address. Try again in {{seconds}} seconds.' })
      : t('rwa_lookup.error_unavailable', { defaultValue: 'The lookup did not answer just now. Try again in a moment.' })

  return (
    <section className="intel-rwa-lookup space-y-3 border-b border-[var(--border-default)] pb-5" aria-labelledby="intel-rwa-lookup-title">
      <div>
        <div className="eyebrow">{t('rwa_lookup.eyebrow', { defaultValue: 'Live lookup' })}</div>
        <h3 id="intel-rwa-lookup-title" className="text-lg font-medium mt-1">{t('rwa_lookup.title', { defaultValue: 'Look up any tokenised asset, now' })}</h3>
      </div>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); run(draft) }}>
        <label className="text-xs flex flex-col gap-1">{t('rwa_lookup.label', { defaultValue: 'Ticker, name or rwa_id' })}
          <input className="input" type="search" value={draft} maxLength={60} autoComplete="off" spellCheck={false} data-testid="rwa-lookup-input"
            placeholder={t('rwa_lookup.placeholder', { defaultValue: 'NVDA' })} onChange={(e) => setDraft(e.target.value)} />
        </label>
        <button type="submit" className="btn btn--quiet" disabled={read.status === 'loading'}>{t('rwa_lookup.submit', { defaultValue: 'Look up' })}</button>
      </form>
      <p className="text-[12px] text-[var(--fg-4)]">{t('rwa_lookup.try', { defaultValue: 'Try' })}{' '}
        {RWA_LOOKUP_EXAMPLES.map((ex, i) => <React.Fragment key={ex.q}>{i > 0 ? (i === RWA_LOOKUP_EXAMPLES.length - 1 ? ` ${t('rwa_lookup.or', { defaultValue: 'or' })} ` : ', ') : ''}<button type="button" className="intel-text-link" onClick={() => run(ex.q)}>{ex.q}</button> <span>({t(`rwa_lookup.${ex.key}`, { defaultValue: ex.label })})</span></React.Fragment>)}.
      </p>
      {read.status === 'loading' && <p role="status" className="text-[13px]">{t('rwa_lookup.loading', { defaultValue: 'Asking our cache, and CoinMarketCap if the cache has nothing…' })}</p>}
      {read.status === 'error' && <p role="alert" className="text-[13px]">{errorText(read.error)}</p>}
      {read.status === 'ready' && read.answer && <Answer answer={read.answer} onPick={run} />}
      <p className="text-[11px] text-[var(--fg-4)]">{t('rwa_lookup.attribution', { defaultValue: 'Data provided by CoinMarketCap.com' })}</p>
    </section>
  )
}
