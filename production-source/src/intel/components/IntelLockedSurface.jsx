import React from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Lock, ArrowUpRight } from 'lucide-react'
import { IntelSectionHeader, cx } from './IntelPrimitives'

// A surface this membership cannot open yet, rendered as the product rather
// than as an error or an empty state.
//
// THE RULE THIS COMPONENT EXISTS TO KEEP. The blurred shape below is a
// PLACEHOLDER, generated here from a fixed pattern. It is never the withheld
// reading. The server refuses a locked surface before the reading is produced
// (supabase/functions/_shared/intel/intel-surface-access.ts), so the response
// that brought us here carries an error code and a surface name and nothing
// else. There is deliberately no prop on this component that could carry a
// value, a series or a row: blurring real data in the browser would be a leak
// wearing a visual, and the only way to be sure it never happens is to give the
// component no way to receive it.
//
// The placeholder is aria-hidden. A reader on assistive technology gets the
// sentence that explains the lock, never a decorative shape read out as data.

// Fixed proportions for the placeholder bars. Not data, not derived from data,
// and identical on every locked surface so nobody reads meaning into them.
const PLACEHOLDER_BARS = [72, 46, 88, 34, 61, 53, 79, 41, 67, 30]

export default function IntelLockedSurface({ surface, title, minTier = 'starter', className = '' }) {
  const { t } = useTranslation('intel', { useSuspense: false })

  const tierLabel = t(`access.tier_${minTier}`, { defaultValue: minTier.charAt(0).toUpperCase() + minTier.slice(1) })
  const surfaceLabel = surface
    ? t(`access.surface_${surface}`, { defaultValue: null })
    : null

  return (
    <section className={cx('intel-locked', className)} aria-label={t('access.locked_region', { defaultValue: 'Locked part of Investor Intel' })}>
      <IntelSectionHeader
        icon={Lock}
        eyebrow={t('access.locked_eyebrow', { defaultValue: 'Locked' })}
        label={title || surfaceLabel || t('access.locked_heading', { defaultValue: 'This part of the terminal' })}
        subtitle={t('access.locked_title', {
          defaultValue: 'Available to {{tier}} members and above',
          tier: tierLabel,
        })}
      />

      {/* Placeholder only. Nothing here came from a response. */}
      <div className="intel-locked-sample" aria-hidden="true">
        {PLACEHOLDER_BARS.map((width, i) => (
          <span key={i} className="intel-locked-bar" style={{ width: `${width}%` }} />
        ))}
      </div>

      <div className="intel-locked-note">
        <p className="text-[13px] text-[var(--fg-3)] leading-relaxed max-w-2xl">
          {t('access.locked_body', {
            defaultValue: 'Your free membership reads every market board, the regime figures, the recorded captures and the saved charts. This part runs a fresh request for you each time it is opened, so it belongs to a paid plan.',
          })}
        </p>
        <p className="text-[12px] text-[var(--fg-4)] leading-relaxed max-w-2xl mt-1.5">
          {t('access.locked_placeholder_note', {
            defaultValue: 'The shape above is a placeholder. Your reading is not loaded on this membership, so there is nothing hidden on this page.',
          })}
        </p>
        <Link
          to="/intel/upgrade"
          className="inline-flex items-center gap-0.5 text-[13px] font-semibold text-[var(--accent)] hover:underline mt-3"
        >
          {t('access.upgrade_cta', { defaultValue: 'See plans' })}
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </section>
  )
}
