// IntelErrorNotice — drop-in replacement for the standard intel error banner
// that turns every intel_limit_reached:* error (raised by the DB limit
// triggers and intel_rate_check) into friendly copy with an upgrade link to
// /intel/upgrade. Non-limit errors render exactly like the old banner.
//
// Pages should store the RAW error message in state and let this component
// do the mapping, so new limit keys never need per-page handling.

import React from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowUpRight, Lock } from 'lucide-react'

const LIMIT_RE = /intel_limit_reached:([a-z_]+)/

// Legacy tokens some call sites throw instead of the raw DB message.
const TOKEN_ALIASES = {
  LIMIT_NEWS_SOURCES: 'news_sources',
  news_refreshes_per_day: 'news_refreshes_per_day',
}

export function intelLimitKeyFrom(message) {
  const s = String(message ?? '')
  const m = LIMIT_RE.exec(s)
  if (m) return m[1]
  if (TOKEN_ALIASES[s]) return TOKEN_ALIASES[s]
  return null
}

// A surface this membership cannot open, refused by the server BEFORE the
// reading was produced (see _shared/intel/intel-surface-access.ts). Distinct
// from a limit: a limit means the allowance for today is spent, a lock means
// this part belongs to a paid plan. Accepts the { error, surface } body the
// function answers with, or the raw thrown error.
export function intelSurfaceLockFrom(error) {
  if (error && typeof error === 'object' && error.error === 'intel_surface_locked') {
    return { surface: typeof error.surface === 'string' ? error.surface : null }
  }
  const s = String(error?.message ?? error ?? '')
  if (!s.includes('intel_surface_locked')) return null
  return { surface: typeof error?.surface === 'string' ? error.surface : null }
}

export default function IntelErrorNotice({ error, className = '' }) {
  const { t } = useTranslation('intel')
  if (!error) return null

  // A lock is not a failure. Name the plan that opens it and offer the way
  // there, rather than showing a red error the reader cannot act on.
  if (intelSurfaceLockFrom(error)) {
    return (
      <div className={`card--flat p-3 text-[13px] text-[var(--fg-2)] flex flex-wrap items-center gap-x-2 gap-y-1 border-[rgba(245,178,94,0.24)] ${className}`}>
        <Lock className="h-4 w-4 flex-shrink-0 text-[var(--forge-gold)]" />
        <span className="font-medium">
          {t('access.locked_title', {
            defaultValue: 'Available to {{tier}} members and above',
            tier: t('access.tier_starter', { defaultValue: 'Starter' }),
          })}
        </span>
        <Link
          to="/intel/upgrade"
          className="inline-flex items-center gap-0.5 font-semibold text-[var(--accent)] hover:underline"
        >
          {t('access.upgrade_cta', { defaultValue: 'See plans' })}
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    )
  }

  const key = intelLimitKeyFrom(error)
  if (!key) {
    return (
      <div className={`card--flat p-3 text-[13px] text-red-400 flex items-start gap-2 ${className}`}>
        <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
        <span>{String(error)}</span>
      </div>
    )
  }

  const label = t(`limits.${key}`, {
    defaultValue: t('limits.generic', { defaultValue: 'You have reached a limit on your current plan.' }),
  })

  return (
    <div className={`card--flat p-3 text-[13px] text-amber-300 flex flex-wrap items-center gap-x-2 gap-y-1 border-[rgba(245,178,94,0.24)] ${className}`}>
      <AlertTriangle className="h-4 w-4 flex-shrink-0" />
      <span className="font-medium">{label}</span>
      <Link
        to="/intel/upgrade"
        className="inline-flex items-center gap-0.5 font-semibold text-[var(--accent)] hover:underline"
      >
        {t('limits.upgrade_cta', { defaultValue: 'Upgrade your plan' })}
        <ArrowUpRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  )
}
