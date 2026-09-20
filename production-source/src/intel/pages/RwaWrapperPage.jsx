import React from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Layers } from 'lucide-react'
import { IntelPageHeader, IntelPageShell } from '../components/IntelPrimitives'
import CaptureReceipts from '../components/CaptureReceipts'
import RwaWrapperSpread from '../components/RwaWrapperSpread'

// /intel/rwa/wrappers — the same real-world asset wrapped several times, and the
// prices those wrappers disagree at.
//
// WHY ITS OWN ROUTE RATHER THAN A SECTION ON /intel/structure. That page already
// carries ten figures (rank map, RWA universe, issuer legitimacy, yield
// provenance, index concentration, two liquidation figures, exchange reserves,
// venue share and the receipts drawer), each with its own read. An eleventh
// figure carrying a ranked table, an expandable sub-table, a chart and a second
// reconciliation table would be the longest thing on the longest page in the
// workspace, and the RWA reader would have to scroll past four unrelated
// figures to reach it. It lives here instead and is linked from both the
// structure page and the RWA workspace entry in the sidebar.
//
// FREE. The read is served through the existing `capture_views` surface, which
// `intel_surface_tiers` carries at free / precomputed_shared: these rows are
// written once by a six-hourly lane and read by everyone, so opening this page
// spends no provider credit whoever opens it.
//
// The figure owns its own read, so an unrun capture, a capture that found no
// multi-wrapper asset and a failed query are three different, stated outcomes
// rather than one blank page.
const CAPTURE_RECEIPT_LANES = ['rwa_wrappers', 'rwa']

export default function RwaWrapperPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  return (
    <IntelPageShell>
      <IntelPageHeader
        icon={Layers}
        eyebrow={t('rwa_wrappers.eyebrow', { defaultValue: 'Our calculation' })}
        title={t('rwa_wrappers.page_title', { defaultValue: 'Wrapper premium and dispersion' })}
        subtitle={t('rwa_wrappers.page_subtitle', {
          defaultValue: 'One real-world asset, several wrapper tokens, several prices. For every tokenised asset carrying two or more wrappers this page shows the premium or discount of each wrapper against a named anchor, how far apart the wrappers of one asset sit, and the cheapest route you could actually reach. Two guards decide what counts: a price in the wrong weight unit is restated and labelled rather than published as a 97 percent discount, and a wrapper that accrues its yield inside its price carries an accrual gap rather than a permanent premium. Below the table, the two CoinMarketCap endpoints that describe the same asset are reconciled against each other.',
        })}
      />
      <CaptureReceipts lanes={CAPTURE_RECEIPT_LANES} />
      {/* The header above already carries the eyebrow, the title and the intro,
          so the figure is asked not to repeat its own. It keeps them wherever it
          is embedded in a section of another page. */}
      <RwaWrapperSpread showHeading={false} />
      <p className="text-[12px]">
        <Link className="intel-text-link" to="/intel/structure">
          {t('rwa_wrappers.back_to_structure', { defaultValue: 'Back to the structure figures, including the RWA universe' })}
        </Link>
      </p>
    </IntelPageShell>
  )
}
