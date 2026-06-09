import React from 'react'
import { isBannedActionLabel } from '../lib/guardrails'

// The single sanctioned button primitive for Investor Intel CTAs. Investor
// Intel is read-only intelligence, so the UI must never render a trade-action
// affordance (Buy / Sell / Trade / Ape / Long / Short / Enter / Exit). This
// enforces the no-action-buttons rule at the component layer: it throws in dev
// and refuses to render in prod if a banned action label slips through.
export default function IntelActionButton({ label, children, className = 'btn btn--quiet btn--sm', ...props }) {
  const text = label ?? (typeof children === 'string' ? children : '')
  if (isBannedActionLabel(text)) {
    const msg = `[IntelActionButton] banned action label blocked: "${text}". Investor Intel is read-only — use a research-framed label (e.g. "Review risk", "Check execution quality").`
    if (import.meta.env?.DEV) throw new Error(msg)
    // eslint-disable-next-line no-console
    console.error(msg)
    return null
  }
  return (
    <button className={className} {...props}>
      {children ?? label}
    </button>
  )
}
