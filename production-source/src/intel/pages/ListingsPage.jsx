import React from 'react'
import { useTranslation } from 'react-i18next'
import { ListPlus } from 'lucide-react'
import { IntelPageHeader, IntelPageShell } from '../components/IntelPrimitives'
import CaptureReceipts from '../components/CaptureReceipts'
import NewListingsBoard from '../components/NewListingsBoard'

// /intel/listings — the daily new-listing capture (CMC plan proposal 21) read as
// a due-diligence cohort: what was listed, what carries a contract on a chain the
// provider publishes security flags for, and what those flags said at the
// capture.
//
// The figure owns its read, so an undeployed or unrun capture degrades to its own
// stated reason instead of blanking the page.
// The capture lanes whose newest run the receipt drawer describes.
const CAPTURE_RECEIPT_LANES = ['new_listings']

export default function ListingsPage() {
  const { t } = useTranslation('intel', { useSuspense: false })

  return (
    <IntelPageShell>
      <IntelPageHeader
        icon={ListPlus}
        eyebrow={t('listings.eyebrow', { defaultValue: 'New listings' })}
        title={t('listings.title', { defaultValue: 'New-listing due diligence' })}
        subtitle={t('listings.subtitle', {
          defaultValue: 'Every asset the daily 06:10 UTC listing capture recorded, built from its newest snapshot, with the security flags the provider reported for its contract beside it. The run inspects at most twenty-five contracts a day, so most of a cohort is genuinely uninspected — and a listing nobody looked at is never shown as a clean one.',
        })}
      />
      <CaptureReceipts lanes={CAPTURE_RECEIPT_LANES} />
      <NewListingsBoard />
    </IntelPageShell>
  )
}
