import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Rocket } from 'lucide-react'
import { IntelPageHeader, IntelPageShell } from '../components/IntelPrimitives'
import CaptureReceipts from '../components/CaptureReceipts'
import GraduationFunnel from '../components/GraduationFunnel'

// /intel/graduation — the hourly launch-stage capture read as a lifecycle: the
// stage funnel of the newest capture, a board of the launchpads that wrote into
// the window, the three stage lists, the cohort graduation rate, how long
// graduations took and how much of a cohort was still listed later.
//
// THREE LANES, THREE RECEIPTS. `launchpad_stages` reads real launchpads on
// Solana, BNB Chain, Base and Robinhood Chain through CoinGecko's onchain API;
// `sunpump_stages` reads SunPump's launch log off TRON through TronGrid;
// `meme_stages` reads the CoinMarketCap DEX launch lists. All three write the
// same two tables, so the receipts drawer names all three lanes and the figure
// hands it what each lane actually left inside the window being read. A lane
// left off this list is a lane a reader would never learn had stopped.
//
// The figure owns its read, so an unrun capture, a lane that reported empty
// lists and a failed query are three different, stated outcomes rather than one
// blank page.
const CAPTURE_RECEIPT_LANES = ['launchpad_stages', 'sunpump_stages', 'meme_stages']

export default function GraduationPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  // The figure holds the read; the receipts drawer above it holds the question
  // "what did each lane leave here". Lifting the answer is one setState per
  // read, and it keeps the page on a single capture read.
  const [sources, setSources] = useState(null)
  const onSources = useCallback(next => setSources(Array.isArray(next) ? next : null), [])

  return (
    <IntelPageShell>
      <IntelPageHeader
        icon={Rocket}
        eyebrow={t('graduation.eyebrow', { defaultValue: 'Meme graduation' })}
        title={t('graduation.title', { defaultValue: 'Meme graduation lifecycle' })}
        subtitle={t('graduation.subtitle', {
          defaultValue: 'Launchpad activity from three capture lanes: the CoinGecko onchain lane, which reads Pump.fun, Meteora DBC, LetsBonk on Raydium LaunchLab, Four.meme, TikTok.fun, Virtuals, Bankr, o1 and Pons across Solana, BNB Chain, Base and Robinhood Chain, the SunPump launch log read straight off TRON, and the CoinMarketCap DEX launch lists. All three are captured once an hour and read as a lifecycle: what is at each stage now, how much of a cohort graduated, how long that took and how much of it was still listed later. The capture hour is ours, so every hour figure is time since we first saw a contract, not since it was deployed.',
        })}
      />
      <CaptureReceipts lanes={CAPTURE_RECEIPT_LANES} sources={sources} />
      <GraduationFunnel onSources={onSources} />
    </IntelPageShell>
  )
}
