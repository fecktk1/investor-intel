import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDisplayCurrency } from '../lib/display-currency'
import { isUncataloguedContract, uncataloguedContractLabel } from '../lib/contract-suggestion'

// Investor Intel — the Markets search box.
//
// Typing still filters the screen exactly as it did; what is new is that the
// shared catalogue is asked, in parallel, which assets the text names, and the
// answer is offered as a list under the field. Choosing one opens that asset at
// its EXACT identity (provider + provider id), the same address the table rows
// link to, so a ticker that two catalogues carry never becomes a guess.
//
// The read is the free `market_boards` catalogue read: no provider call, no
// credit, nothing per-member. It waits for a pause in typing and for at least
// two characters, and every superseded request is aborted.
//
// WHO OWNS THE TEXT. The screen filter lives in the address bar (`m_search`), and
// writing it there is a navigation: the route re-renders and the field is handed
// back whatever the URL now says. Binding the field straight to that value loses
// keystrokes — typed at speed, "bitcoin" arrived as one surviving character, and
// a pasted address as one digit. So the field keeps its OWN value while it has
// focus and is the only writer of it; the URL is caught up on a trailing pause.
// The URL is copied back into the field only on mount and while the field is not
// focused, which is what makes Back and Forward still work. A paste is a single
// change event and therefore a single edit, never a race.

const DEBOUNCE_MS = 200
/** Trailing pause before the typed text reaches the address bar and the screen
 *  filter. Longer than a fast typist's gap between keys, short enough that the
 *  filtered rows follow the moment they stop. */
const SYNC_MS = 250
/** Mirrors SUGGEST_MIN_LENGTH in markets-api (and the server's own floor). Held
 *  here so this field never depends on the read module it is given. */
const MIN_LENGTH = 2
const CACHE_LIMIT = 24
const CACHE_MS = 30_000
// How long a suggestion stays highlighted before onPreview is told about it: a
// pause on a row, not every row the arrow keys pass over.
export const PREVIEW_MS = 250

/** The project name, else the ticker. A contract no metadata source has named
 *  has neither, and is said to be unnamed rather than labelled with its own
 *  address twice — the identity line below already carries the address. */
export function suggestionLabel(row) {
  return row?.displayName || row?.symbol || ''
}

// A pasted address no catalogue carries is named by the shared helper, so the
// asset page's identity choice says exactly the same thing this list does.
export { isUncataloguedContract, uncataloguedContractLabel }

/** The identity line under the name: ticker, then the chain when the catalogue
 *  knows one and the provider identity otherwise. Never a claim we do not hold. */
export function suggestionIdentity(row) {
  return [row?.symbol, row?.chain, `${row?.sourceProvider} ${row?.providerId}`].filter(Boolean).join(' · ')
}

export default function MarketSearchTypeahead({ value, onChange, onOpen, onPreview = null, suggest, disabled = false, label, placeholder }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const money = useDisplayCurrency()
  const id = useId()
  const [state, setState] = useState(null)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [focused, setFocused] = useState(false)
  const cache = useRef(new Map())
  const box = useRef(null)

  // `draft` is what the reader is looking at. `sent` is the last text this field
  // handed upward, so an inbound value that is merely our own write echoing back
  // is never mistaken for someone else changing the address.
  const [draft, setDraft] = useState(() => String(value ?? ''))
  const draftRef = useRef(draft)
  const sentRef = useRef(String(value ?? ''))
  const focusedRef = useRef(false)
  const syncTimer = useRef(null)

  const push = useCallback(next => {
    if (next === sentRef.current) return
    sentRef.current = next
    onChange(next)
  }, [onChange])

  /** Hand the current text upward now, cancelling any pending pause. */
  const flush = useCallback(() => {
    if (syncTimer.current) { clearTimeout(syncTimer.current); syncTimer.current = null }
    push(draftRef.current)
  }, [push])

  const edit = useCallback(next => {
    draftRef.current = next
    setDraft(next)
    if (syncTimer.current) clearTimeout(syncTimer.current)
    syncTimer.current = setTimeout(() => { syncTimer.current = null; push(draftRef.current) }, SYNC_MS)
  }, [push])

  // The address changed under us — Back, Forward, a restored screen. Adopt it,
  // but never while the reader is mid-word in this field.
  useEffect(() => {
    const incoming = String(value ?? '')
    if (focusedRef.current || incoming === sentRef.current) return
    sentRef.current = incoming
    draftRef.current = incoming
    setDraft(incoming)
  }, [value])

  useEffect(() => () => { if (syncTimer.current) clearTimeout(syncTimer.current) }, [])

  const query = draft.trim().slice(0, 100)
  const rows = state?.query === query && !state.pending ? (state.rows || []) : []
  const pending = state?.query === query && state.pending === true
  const failed = state?.query === query ? state.error || null : null
  const open = focused && !dismissed && query.length >= MIN_LENGTH && (rows.length > 0 || pending || !!failed)
  const index = Math.min(active, Math.max(0, rows.length - 1))

  // The highlighted row, handed to onPreview once it has stayed highlighted for
  // PREVIEW_MS, so the page can start reading what Enter would open.
  const previewRow = open && rows.length ? rows[index] : null
  const previewRef = useRef(previewRow)
  previewRef.current = previewRow
  const previewKey = previewRow?.href || null
  useEffect(() => {
    if (!onPreview || !previewKey) return undefined
    const timer = setTimeout(() => { if (previewRef.current?.href === previewKey) onPreview(previewRef.current) }, PREVIEW_MS)
    return () => clearTimeout(timer)
  }, [onPreview, previewKey])

  useEffect(() => { setDismissed(false); setActive(0) }, [query])

  useEffect(() => {
    if (!suggest || query.length < MIN_LENGTH) { setState(null); return }
    const cached = cache.current.get(query)
    if (cached && cached.until > Date.now()) { setState({ query, rows: cached.rows }); return }
    const controller = new AbortController()
    let alive = true
    setState({ query, pending: true, rows: [] })
    const timer = setTimeout(async () => {
      try {
        const found = await suggest(query, controller.signal)
        if (!alive) return
        if (cache.current.size >= CACHE_LIMIT) cache.current.delete(cache.current.keys().next().value)
        cache.current.set(query, { until: Date.now() + CACHE_MS, rows: found })
        setState({ query, rows: found })
      } catch {
        if (!alive || controller.signal.aborted) return
        setState({ query, rows: [], error: t('markets.suggest_failed', { defaultValue: 'Asset suggestions are unavailable. Typing still filters this screen.' }) })
      }
    }, DEBOUNCE_MS)
    return () => { alive = false; clearTimeout(timer); controller.abort() }
  }, [query, suggest, t])

  const choose = useCallback(row => {
    if (!row) return
    setDismissed(true)
    // The screen this reader is leaving keeps the text they typed, so the way
    // back from the asset lands on the same filtered rows.
    flush()
    onOpen(row)
  }, [onOpen, flush])

  const keyDown = event => {
    if (event.isComposing) return
    if (event.key === 'Escape') { if (open) { event.preventDefault(); setDismissed(true) } return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!rows.length) return
      event.preventDefault()
      setDismissed(false)
      setActive(Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
      return
    }
    if (event.key === 'Enter' && open && rows.length) { event.preventDefault(); choose(rows[index]) }
  }

  const fieldLabel = label || t('markets.search', { defaultValue: 'Search name, symbol, contract…' })
  const listId = `${id}-suggestions`
  const status = useMemo(() => {
    if (pending) return t('markets.suggest_searching', { defaultValue: 'Searching the shared asset catalogue…' })
    if (!open || !rows.length) return ''
    return t('markets.suggest_count', { total: rows.length, defaultValue: '{{total}} matching assets. Use the up and down arrows to choose one, then Enter to open it.' })
  }, [pending, open, rows.length, t])

  return (
    <div className="intel-market-typeahead" ref={box} onBlur={event => { if (!box.current?.contains(event.relatedTarget)) { focusedRef.current = false; setFocused(false); flush() } }}>
      <input
        role="combobox"
        aria-label={fieldLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && rows.length ? `${id}-suggestion-${index}` : undefined}
        autoComplete="off"
        maxLength={100}
        disabled={disabled}
        className="input text-[12px]"
        placeholder={placeholder || fieldLabel}
        value={draft}
        onFocus={() => { focusedRef.current = true; setFocused(true) }}
        onChange={event => edit(event.target.value)}
        onKeyDown={keyDown}
      />
      <div id={listId} role="listbox" aria-label={t('markets.suggest_results', { defaultValue: 'Matching assets' })} className="intel-market-typeahead-list" hidden={!open}>
        {rows.map((row, i) => (
          <div
            key={`${row.sourceProvider}:${row.providerId}`}
            role="option"
            id={`${id}-suggestion-${i}`}
            aria-selected={i === index}
            tabIndex={-1}
            onMouseDown={event => event.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => choose(row)}
            className="intel-market-typeahead-option"
          >
            <span className="intel-market-typeahead-name">{isUncataloguedContract(row) ? uncataloguedContractLabel(row, t) : suggestionLabel(row) || t('markets.suggest_unnamed', { defaultValue: 'Unnamed contract' })}</span>
            <span className="intel-market-typeahead-meta">{suggestionIdentity(row)}</span>
            <span className="intel-market-typeahead-cap">{row.marketCap == null ? t('markets.suggest_no_market_cap', { defaultValue: 'No market cap' }) : money.formatMoney(row.marketCap)}</span>
          </div>
        ))}
        {!rows.length && pending && <p className="intel-market-typeahead-state">{t('markets.suggest_searching', { defaultValue: 'Searching the shared asset catalogue…' })}</p>}
        {!rows.length && !pending && failed && <p className="intel-market-typeahead-state" role="alert">{failed}</p>}
      </div>
      <p className="sr-only" role="status" aria-live="polite">{status}</p>
    </div>
  )
}
