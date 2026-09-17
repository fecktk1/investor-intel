import React from 'react'
import { useTranslation } from 'react-i18next'
import { Gift } from 'lucide-react'
import { IntelPageHeader, IntelPageShell } from '../components/IntelPrimitives'
import CaptureReceipts from '../components/CaptureReceipts'
import AirdropCalendar from '../components/AirdropCalendar'

// /intel/airdrops — the recorded CoinMarketCap airdrop list as a calendar over
// the next ninety days, plus a ring of what is still ahead. One read for both
// figures; the capture runs once a day at 05:30 UTC and the figures say so
// rather than drawing an empty calendar as if nothing were scheduled.
// The capture lanes whose newest run the receipt drawer describes.
const CAPTURE_RECEIPT_LANES = ['airdrops']

export default function AirdropsPage() {
  const { t } = useTranslation('intel', { useSuspense: false })

  return (
    <IntelPageShell>
      <IntelPageHeader
        icon={Gift}
        eyebrow={t('airdrops.eyebrow', { defaultValue: 'Airdrops' })}
        title={t('airdrops.title', { defaultValue: 'Airdrop calendar' })}
        subtitle={t('airdrops.subtitle', {
          defaultValue: 'Every airdrop the daily capture recorded, laid out over the next ninety days and ranked by what is still ahead. Dates, prize pools and winner counts are what the provider published. They are not a promise that a distribution happens.',
        })}
      />
      <CaptureReceipts lanes={CAPTURE_RECEIPT_LANES} />
      <AirdropCalendar />
    </IntelPageShell>
  )
}
