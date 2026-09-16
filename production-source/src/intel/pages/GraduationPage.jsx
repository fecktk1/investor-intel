import React from 'react'
import { useTranslation } from 'react-i18next'
import { Rocket } from 'lucide-react'
import { IntelPageHeader, IntelPageShell } from '../components/IntelPrimitives'
import CaptureReceipts from '../components/CaptureReceipts'
import GraduationFunnel from '../components/GraduationFunnel'

// /intel/graduation — the hourly meme launch-stage capture (CMC plan proposal 30)
// read as a lifecycle: the stage funnel of the newest capture, the cohort
// graduation rate, how long graduations took and how much of a cohort was still
// listed later.
//
// The figure owns its read, so an unrun capture, a provider that reported empty
// lists and a failed query are three different, stated outcomes rather than one
// blank page.
// The capture lanes whose newest run the receipt drawer describes.
const CAPTURE_RECEIPT_LANES = ['meme_stages']

export default function GraduationPage() {
  const { t } = useTranslation('intel', { useSuspense: false })

  return (
    <IntelPageShell>
      <IntelPageHeader
        icon={Rocket}
        eyebrow={t('graduation.eyebrow', { defaultValue: 'Meme graduation' })}
        title={t('graduation.title', { defaultValue: 'Meme graduation lifecycle' })}
        subtitle={t('graduation.subtitle', {
          defaultValue: 'The launch lists CoinMarketCap publishes for Solana, Base, Ethereum and Arbitrum, captured once an hour and read as a lifecycle: what is at each stage now, how much of a cohort graduated, how long that took and how much of it was still listed later. Four.meme launches on BNB Chain and is not covered.',
        })}
      />
      <CaptureReceipts lanes={CAPTURE_RECEIPT_LANES} />
      <GraduationFunnel />
    </IntelPageShell>
  )
}
