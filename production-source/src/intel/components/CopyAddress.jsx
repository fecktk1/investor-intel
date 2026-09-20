import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

// Investor Intel — one contract address, readable and copyable.
//
// A contract address is the only thing on an asset page a reader has to carry
// somewhere else: into an explorer, a wallet, a message to someone. Reading it
// off the screen character by character is how a reader ends up at the wrong
// token, so every surface that prints one prints it through here.
//
// Three rules this component keeps:
//
//   1. The SHORT form is what is displayed; the FULL address is always on the
//      title attribute and always what the button writes. A shortened address is
//      a label, never a value, and nothing here ever copies the label.
//   2. "Copied" is a status, not a new button label. The button keeps saying
//      what it does, and the confirmation is announced beside it and withdrawn
//      again after a moment.
//   3. A browser without the clipboard API is not an error. The full address is
//      rendered in monospace and selected for the reader, so the keyboard copy
//      they already know still works.

const HEAD = 8
const TAIL = 6

/** The display form: first and last characters with an ellipsis between them.
 *  A short address is returned whole rather than padded into a fake ellipsis. */
export function shortenAddress(value, head = HEAD, tail = TAIL) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  return raw.length <= head + tail + 1 ? raw : `${raw.slice(0, head)}…${raw.slice(-tail)}`
}

function selectElementText(node) {
  if (!node || typeof window === 'undefined' || typeof document === 'undefined') return
  const selection = window.getSelection?.()
  if (!selection || typeof document.createRange !== 'function') return
  try {
    const range = document.createRange()
    range.selectNodeContents(node)
    selection.removeAllRanges()
    selection.addRange(range)
  } catch { /* selection is a convenience; the address is on screen either way */ }
}

/**
 * @param {string} value          The FULL address. Nothing else is ever copied.
 * @param {boolean} showAddress   Render the shortened address beside the button
 *                                (default) or the button alone, for a caller
 *                                that already prints the address itself.
 */
export default function CopyAddress({ value, showAddress = true, className = '' }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const address = String(value ?? '').trim()
  const [copied, setCopied] = useState(false)
  const [manual, setManual] = useState(false)
  const timer = useRef(null)
  const manualRef = useRef(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  // A new address is a new subject: any confirmation or fallback from the last
  // one is withdrawn rather than left standing beside the wrong value.
  useEffect(() => { setCopied(false); setManual(false) }, [address])
  useEffect(() => { if (manual) selectElementText(manualRef.current) }, [manual, address])

  const copy = useCallback(async () => {
    if (!address) return
    const clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard
    if (clipboard && typeof clipboard.writeText === 'function') {
      try {
        await clipboard.writeText(address)
        setManual(false)
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1500)
        return
      } catch { /* a refused write is a browser that cannot copy for us */ }
    }
    setCopied(false)
    setManual(true)
  }, [address])

  if (!address) return null
  const copyLabel = t('copy_address.copy', { defaultValue: 'Copy contract address' })

  return (
    <span className={`inline-flex flex-wrap items-baseline gap-2 ${className}`.trim()} data-testid="copy-address">
      {showAddress && <span className="font-mono text-[var(--fg-2)] break-all" title={address}>{shortenAddress(address)}</span>}
      <button type="button" className="intel-text-link" aria-label={copyLabel} title={copyLabel} onClick={copy}>{copyLabel}</button>
      <span role="status" className="intel-event-meta">{copied ? t('copy_address.copied', { defaultValue: 'Copied' }) : ''}</span>
      {manual && (
        <span className="intel-event-meta flex flex-wrap items-baseline gap-2">
          <span>{t('copy_address.manual', { defaultValue: 'This browser will not copy for us. The full address is selected, so copy it with your keyboard.' })}</span>
          <span ref={manualRef} className="font-mono text-[var(--fg-2)] break-all" data-testid="copy-address-full">{address}</span>
        </span>
      )}
    </span>
  )
}
