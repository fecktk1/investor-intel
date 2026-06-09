import React from 'react'
import { useTranslation } from 'react-i18next'
import { Hammer } from 'lucide-react'
import IntelDisclaimer from '../components/IntelDisclaimer'

// Generic placeholder for Investor Intel pages not yet built out. Each feature
// phase replaces the stub with the real page. Keeps the shell + navigation
// fully walkable during the build.
export default function IntelStubPage({ titleKey, defaultTitle, subtitleKey, defaultSubtitle }) {
  const { t } = useTranslation('intel', { useSuspense: false })

  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow">{t('brand.name', { defaultValue: 'Investor Intel' })}</div>
        <h1 className="page-title">{t(titleKey, { defaultValue: defaultTitle })}</h1>
        {(subtitleKey || defaultSubtitle) && (
          <p className="page-sub">{t(subtitleKey, { defaultValue: defaultSubtitle })}</p>
        )}
      </div>

      <div className="card p-8 flex flex-col items-center justify-center text-center gap-3">
        <div className="h-10 w-10 rounded-xl grid place-items-center" style={{ background: 'var(--accent-tint)' }}>
          <Hammer className="h-5 w-5" style={{ color: 'var(--accent)' }} />
        </div>
        <div>
          <p className="text-sm font-medium text-[var(--fg-1)]">
            {t('stub.coming_soon', { defaultValue: 'Coming soon' })}
          </p>
          <p className="text-[13px] text-[var(--fg-3)] mt-1 max-w-md">
            {t('stub.body', { defaultValue: 'This part of Investor Intel is being built.' })}
          </p>
        </div>
      </div>

      <IntelDisclaimer variant="block" />
    </div>
  )
}
