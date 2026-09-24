// Investor Intel: what answered a lookup's quote, said in plain words beside it.
//
// The endpoint (supabase/functions/_shared/intel/rwa-lookup.ts, quoteReadOf)
// states per request whether ONE live CoinMarketCap call answered the quote or
// the stored copy did, why, and when CoinMarketCap itself last updated the
// asset. This turns that into the sentence the page shows, so the box never
// reads as live when it was not, and never hides why a call was not made.
//
// Times use the one as-of format (./as-of.js): UTC, and for the retrieval its
// age in the reader's language.

import { formatDataTime, formatUtcTime } from './as-of'

/** The reason codes a lookup can give, and the English behind each. The page
 * renders `rwa_lookup.reason_<code>` in the reader's language. */
export const LOOKUP_REASON_DEFAULTS = {
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
  lookup_check_daily_limit: "This address has used today's checks of CoinMarketCap. They reset at 00:00 UTC.",
  lookup_check_all_daily_limit: "Today's checks of CoinMarketCap for all visitors are used up. They reset at 00:00 UTC.",
  lookup_live_daily_limit: "This address has used today's live lookups. They reset at 00:00 UTC.",
  lookup_live_all_daily_limit: "Today's live lookups for all visitors are used up. They reset at 00:00 UTC.",
  lookup_allowance_unavailable: 'The allowance of live calls could not be checked, so no call was made.',
  refreshed_concurrently: 'Another lookup called CoinMarketCap a moment before, so its answer is shown.',
}

export function lookupReasonText(t, code) {
  if (!code) return null
  return t(`rwa_lookup.reason_${code}`, { defaultValue: LOOKUP_REASON_DEFAULTS[code] || t('rwa_lookup.reason_other', { code, defaultValue: 'The live read did not answer ({{code}}).' }) })
}

/** The sentence for one answer's `quoteRead`, or null when there is none. */
export function quoteReadSentence(t, read, { language, now = Date.now() } = {}) {
  if (!read || typeof read !== 'object' || (read.mode !== 'live' && read.mode !== 'stored')) return null
  const retrieved = formatDataTime(read.retrievedAt, { language, now })
  const updated = formatUtcTime(read.sourceUpdatedAt, language)
  const parts = []
  if (read.mode === 'live') {
    parts.push(retrieved
      ? t('rwa_lookup.read_live', { time: retrieved, defaultValue: 'Live: this lookup called CoinMarketCap at {{time}}.' })
      : t('rwa_lookup.read_live_undated', { defaultValue: 'Live: this lookup called CoinMarketCap.' }))
  } else {
    parts.push(retrieved
      ? t('rwa_lookup.read_stored', { time: retrieved, defaultValue: 'Stored answer from {{time}}.' })
      : t('rwa_lookup.read_stored_undated', { defaultValue: 'Stored answer.' }))
  }
  // "Would return the same prices" is said only when a known update schedule
  // shows CoinMarketCap has published nothing newer (the endpoint's
  // cmc_not_updated_since), never from the age of our copy alone.
  const same = read.mode === 'stored' && read.why === 'cmc_not_updated_since' && !read.refusal
  if (updated) {
    parts.push(same
      ? t('rwa_lookup.read_updated_same', { time: updated, defaultValue: 'CoinMarketCap last updated this asset at {{time}}, so a live call now would return the same prices.' })
      : t('rwa_lookup.read_updated', { time: updated, defaultValue: 'CoinMarketCap last updated this asset at {{time}}.' }))
  } else {
    parts.push(t('rwa_lookup.read_updated_unknown', { defaultValue: 'CoinMarketCap did not report when it last updated this asset.' }))
  }
  if (read.mode === 'stored') {
    if (read.refusal) {
      parts.push(read.asked
        ? t('rwa_lookup.read_check_refused', { defaultValue: 'Your check of CoinMarketCap was not made.' })
        : t('rwa_lookup.read_live_refused', { defaultValue: 'A live call was due but was not made.' }))
      parts.push(lookupReasonText(t, read.refusal))
    } else if (read.why === 'copy_recent') {
      const minutes = Math.max(1, Math.round((Number(read.liveAfterSeconds) || 600) / 60))
      parts.push(t('rwa_lookup.read_recent', { minutes, defaultValue: 'A live call is made once the stored answer is more than {{minutes}} minutes old, so none was made for this lookup.' }))
    }
  }
  return parts.filter(Boolean).join(' ')
}

/** The lookup receipt as the shared cost line reads it (ReceiptCostLine):
 * "1 provider call · 1 credit · live" for a live read, the shared-cache line
 * with the original call's charge for a stored copy, the capture line for a
 * stored capture. A kept last good copy is none of those and gets no line. */
export function lookupCostReceipt(r) {
  if (!r || typeof r !== 'object') return null
  const origin = r.served === 'live' ? 'live' : r.served === 'cache' ? 'cache' : r.served === 'capture' ? 'capture' : null
  if (!origin) return null
  return { origin, creditCount: r.creditCount ?? null, capturedAt: r.capturedAt ?? null, fetchedAt: r.capturedAt ?? null,
    proof: r.originCreditCount != null ? { creditCount: r.originCreditCount } : null }
}
