import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readCaptureView } from './capture-api'
import { formatMoney as formatMoneyScaled, formatPrice } from './market-format'

// Investor Intel — display currency (CMC plan proposal 26).
//
// THE RULE this whole module exists to preserve: every amount Investor Intel
// stores stays denominated in USD. Nothing here rewrites a stored figure, a
// portfolio cost basis or a captured history. One rate an hour is read from the
// `fx` capture view and applied at RENDER time only, so switching currency
// changes what a reader sees and never what the product recorded.
//
// The provider is mounted once, around the Intel routes, and holds:
//   * the reader's chosen currency (their own row in `intel_user_preferences`,
//     falling back to localStorage, falling back to USD), and
//   * the newest captured hour of USD→currency rates, refreshed hourly while
//     mounted.
//
// When there is no usable rate — nothing captured yet, the read failed, the
// reader is on USD — every figure renders in dollars and `fallback` is true, so
// a surface can say "rates unavailable, showing USD" instead of quietly showing
// a number that is wrong by an unknown factor.

export const DISPLAY_CURRENCY_STORAGE_KEY = 'intel.displayCurrency'
export const BASE_CURRENCY = 'USD'
/** Rates older than this are used, but reported as stale. Mirrors
 * FX_STALE_AFTER_MS in supabase/functions/_shared/intel/capture-fx-read.ts. */
export const FX_STALE_AFTER_MS = 6 * 3600 * 1000
const REFRESH_MS = 3600 * 1000

// Mirrors FX_CURRENCIES in supabase/functions/_shared/intel/capture-fx-read.ts.
// Held here as well so the settings select can offer every currency in the hour
// before the first capture lands, and so a failed read never empties the menu.
// `sign: null` means the sign is ambiguous (three different "kr", a bare "R",
// right-to-left dirham and riyal glyphs) and the ISO code is what a reader can
// actually identify; `suffix` marks the signs that follow the amount.
export const SUPPORTED_CURRENCIES = [
  { code: 'USD', name: 'United States Dollar', sign: '$' },
  { code: 'EUR', name: 'Euro', sign: '€' },
  { code: 'GBP', name: 'Pound Sterling', sign: '£' },
  { code: 'JPY', name: 'Japanese Yen', sign: '¥' },
  { code: 'CHF', name: 'Swiss Franc', sign: null },
  { code: 'CAD', name: 'Canadian Dollar', sign: 'CA$' },
  { code: 'AUD', name: 'Australian Dollar', sign: 'A$' },
  { code: 'NZD', name: 'New Zealand Dollar', sign: 'NZ$' },
  { code: 'SGD', name: 'Singapore Dollar', sign: 'S$' },
  { code: 'HKD', name: 'Hong Kong Dollar', sign: 'HK$' },
  { code: 'KRW', name: 'South Korean Won', sign: '₩' },
  { code: 'INR', name: 'Indian Rupee', sign: '₹' },
  { code: 'BRL', name: 'Brazilian Real', sign: 'R$' },
  { code: 'MXN', name: 'Mexican Peso', sign: 'MX$' },
  { code: 'ZAR', name: 'South African Rand', sign: null },
  { code: 'TRY', name: 'Turkish Lira', sign: '₺' },
  { code: 'SEK', name: 'Swedish Krona', sign: null },
  { code: 'NOK', name: 'Norwegian Krone', sign: null },
  { code: 'DKK', name: 'Danish Krone', sign: null },
  { code: 'PLN', name: 'Polish Zloty', sign: 'zł', suffix: true },
  { code: 'CZK', name: 'Czech Koruna', sign: 'Kč', suffix: true },
  { code: 'HUF', name: 'Hungarian Forint', sign: 'Ft', suffix: true },
  { code: 'AED', name: 'United Arab Emirates Dirham', sign: null },
  { code: 'SAR', name: 'Saudi Riyal', sign: null },
  { code: 'ILS', name: 'Israeli New Shekel', sign: '₪' },
  { code: 'THB', name: 'Thai Baht', sign: '฿' },
  { code: 'IDR', name: 'Indonesian Rupiah', sign: 'Rp' },
  { code: 'PHP', name: 'Philippine Peso', sign: '₱' },
  { code: 'VND', name: 'Vietnamese Dong', sign: '₫', suffix: true },
  { code: 'NGN', name: 'Nigerian Naira', sign: '₦' },
]

const CODES = new Set(SUPPORTED_CURRENCIES.map(c => c.code))
const USD_DESCRIPTOR = SUPPORTED_CURRENCIES[0]

/** A well-formed, supported code, or null. An unknown code is never trusted into
 * a format call: it would render a dollar amount under someone else's sign. */
export const normalizeCurrency = value => {
  const code = String(value ?? '').trim().toUpperCase()
  return CODES.has(code) ? code : null
}

export const currencyDescriptor = (code, currencies = SUPPORTED_CURRENCIES) =>
  currencies.find(c => c?.code === code) || SUPPORTED_CURRENCIES.find(c => c.code === code) || USD_DESCRIPTOR

const readStoredCurrency = () => {
  try { return normalizeCurrency(window.localStorage.getItem(DISPLAY_CURRENCY_STORAGE_KEY)) } catch { return null }
}
const writeStoredCurrency = code => {
  try { window.localStorage.setItem(DISPLAY_CURRENCY_STORAGE_KEY, code) } catch { /* private window, blocked storage */ }
}

/**
 * The formatters for one currency and one rate. Exported on its own so a test,
 * or a surface that already knows its rate, can build the same pair without a
 * React tree.
 */
export function buildMoneyFormatters({ currency = BASE_CURRENCY, rate = 1, currencies = SUPPORTED_CURRENCIES } = {}) {
  const usable = currency !== BASE_CURRENCY && Number.isFinite(Number(rate)) && Number(rate) > 0
  const descriptor = usable ? currencyDescriptor(currency, currencies) : USD_DESCRIPTOR
  const factor = usable ? Number(rate) : 1
  const options = { currency: descriptor.code, rate: factor, sign: descriptor.sign, suffix: !!descriptor.suffix }
  return {
    fallback: currency !== BASE_CURRENCY && !usable,
    descriptor,
    // Compact money: market cap, FDV, volume.
    formatMoney: (usd, extra) => formatMoneyScaled(usd, extra ? { ...options, ...extra } : options),
    // A price keeps its own precision ladder (2dp, 4dp, subscript zeros for a
    // memecoin), so it is formatted by formatPrice and re-signed rather than
    // squeezed onto the compact ladder. formatPrice emits exactly one '$'.
    formatMoneyPrice: usd => {
      const converted = usd == null || usd === '' || typeof usd === 'boolean' || !Number.isFinite(Number(usd))
        ? usd
        : Number(usd) * factor
      const text = formatPrice(converted)
      if (text === '—') return text
      return descriptor.sign
        ? (descriptor.suffix ? `${text.replace('$', '')} ${descriptor.sign}` : text.replace('$', descriptor.sign))
        : `${text.replace('$', '')} ${descriptor.code}`
    },
  }
}

const usdValue = () => ({
  currency: BASE_CURRENCY,
  setCurrency: () => {},
  rate: 1,
  state: 'unavailable',
  reason: null,
  observedAt: null,
  asOf: null,
  currencies: SUPPORTED_CURRENCIES,
  loading: false,
  saving: false,
  error: null,
  ...buildMoneyFormatters(),
})

// A surface rendered outside the provider (a demo, an isolated test) still
// formats money — in dollars — rather than throwing.
const DisplayCurrencyContext = createContext(usdValue())

export function DisplayCurrencyProvider({ children, currency: forced = null }) {
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const orgId = org?.id || null
  const userId = user?.id || null

  const [currency, setCurrencyState] = useState(() => normalizeCurrency(forced) || readStoredCurrency() || BASE_CURRENCY)
  const [fx, setFx] = useState({ rates: {}, currencies: SUPPORTED_CURRENCIES, state: 'unavailable', reason: null, observedAt: null, asOf: null })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  // The stored preference wins over localStorage, but only until the reader
  // picks something: a slow round trip must never overwrite a fresh choice.
  const chosen = useRef(!!normalizeCurrency(forced))

  useEffect(() => {
    if (!userId || chosen.current) return undefined
    let alive = true
    ;(async () => {
      try {
        const { data, error: readError } = await supabase
          .from('intel_user_preferences').select('display_currency').eq('user_id', userId).maybeSingle()
        if (!alive || chosen.current) return
        if (readError) return
        const stored = normalizeCurrency(data?.display_currency)
        if (stored) setCurrencyState(stored)
      } catch { /* a reader with no preference row simply keeps the local one */ }
    })()
    return () => { alive = false }
  }, [supabase, userId])

  const loadRates = useCallback(async () => {
    if (!orgId) { setLoading(false); return }
    try {
      const view = await readCaptureView('fx', {}, { orgId, supabase })
      setFx({
        rates: view?.rates && typeof view.rates === 'object' ? view.rates : {},
        currencies: Array.isArray(view?.currencies) && view.currencies.length ? view.currencies : SUPPORTED_CURRENCIES,
        state: view?.state === 'fresh' || view?.state === 'stale' ? view.state : 'unavailable',
        reason: view?.reason || null,
        observedAt: view?.observedAt || null,
        asOf: view?.asOf || null,
      })
      setError(null)
    } catch (e) {
      // An undeployed or failing capture function is an explicit unavailable
      // state, never a silent zero rate.
      setFx(current => ({ ...current, rates: {}, state: 'unavailable', reason: e?.code || e?.message || 'fx_unavailable' }))
      setError(e?.message || 'fx_unavailable')
    } finally {
      setLoading(false)
    }
  }, [orgId, supabase])

  useEffect(() => {
    let alive = true
    setLoading(true)
    loadRates()
    const timer = setInterval(() => { if (alive) loadRates() }, REFRESH_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [loadRates])

  const setCurrency = useCallback(async next => {
    const code = normalizeCurrency(next)
    if (!code) return
    chosen.current = true
    setCurrencyState(code)
    writeStoredCurrency(code)
    if (!userId) return
    setSaving(true)
    setError(null)
    try {
      // Destructured: a silent RLS refusal must surface, not vanish.
      const { error: writeError } = await supabase
        .from('intel_user_preferences')
        .upsert({ user_id: userId, display_currency: code }, { onConflict: 'user_id' })
      if (writeError) throw writeError
    } catch (e) {
      setError(e?.message || 'preference_not_saved')
    } finally {
      setSaving(false)
    }
  }, [supabase, userId])

  const value = useMemo(() => {
    const entry = currency === BASE_CURRENCY ? { rate: 1, observedAt: fx.observedAt } : fx.rates?.[currency]
    const rate = Number.isFinite(Number(entry?.rate)) && Number(entry?.rate) > 0 ? Number(entry.rate) : null
    // A stale rate is still a rate; an unavailable read is not.
    const usable = currency === BASE_CURRENCY || (rate != null && fx.state !== 'unavailable')
    const formatters = buildMoneyFormatters({ currency, rate: usable ? rate : null, currencies: fx.currencies })
    return {
      currency,
      setCurrency,
      rate: usable ? rate : null,
      state: currency === BASE_CURRENCY ? fx.state : (usable ? fx.state : 'unavailable'),
      reason: fx.reason,
      observedAt: entry?.observedAt || fx.observedAt || null,
      asOf: fx.asOf,
      currencies: fx.currencies,
      loading,
      saving,
      error,
      ...formatters,
      // True only when the reader ASKED for another currency and cannot have it.
      fallback: currency !== BASE_CURRENCY && !usable,
    }
  }, [currency, error, fx, loading, saving, setCurrency])

  return <DisplayCurrencyContext.Provider value={value}>{children}</DisplayCurrencyContext.Provider>
}

export function useDisplayCurrency() {
  return useContext(DisplayCurrencyContext)
}

export default DisplayCurrencyProvider
