import React from 'react'
import { useTranslation } from 'react-i18next'
import AnalyzeInputPage from './AnalyzeInputPage'
import IntelSurfaceGate from '../components/IntelSurfaceGate'

// Wallet Watch (P6). The same generic analyze page DeFi and Execution use, with
// the one difference that matters here: following a wallet runs a fresh request
// for the asking member, so a membership that does not carry the surface gets
// the lock that names the plan which opens it instead of the workspace. The
// page header lives inside AnalyzeInputPage, so the whole body is the child:
// nothing is mounted, and there is no read here to withhold.
export default function WalletWatchPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  return (
    <IntelSurfaceGate surface="wallet_watch" title={t('access.surface_wallet_watch', { defaultValue: 'Wallet Watch' })}>
      <AnalyzeInputPage
        artifactType="wallet_summary"
        titleKey="nav.wallets"
        defaultTitle="Wallet Watch"
        subKey="pages.wallets_sub"
        defaultSub="Follow whale, smart, dev and influencer wallets in simple terms."
        kind="wallet"
        defaultPh="Wallet address"
      />
    </IntelSurfaceGate>
  )
}
