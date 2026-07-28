import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useProfile } from '../lib/profile-context'
import { IntelProvider } from './context/IntelContext'
import IntelModeShell from './components/IntelModeShell'
import IntelStubPage from './pages/IntelStubPage'
import IntelOnboardingPage from './pages/IntelOnboardingPage'
import WatchlistPage from './pages/WatchlistPage'
import AssetBreakdownPage from './pages/AssetBreakdownPage'
import ExplainPage from './pages/ExplainPage'
import ComparePage from './pages/ComparePage'
import MarketPulsePage from './pages/MarketPulsePage'
import MarketsPage from './pages/MarketsPage'
import MarketAssetPage from './pages/MarketAssetPage'
import PortfolioPage from './pages/PortfolioPage'
import PortfolioAssetPage from './pages/PortfolioAssetPage'
import NarrativeRadarPage from './pages/NarrativeRadarPage'
import NarrativeDetailPage from './pages/NarrativeDetailPage'
import AnalyzeInputPage from './pages/AnalyzeInputPage'
import ExecutionPage from './pages/ExecutionPage'
import DefiPage from './pages/DefiPage'
import MacroPage from './pages/MacroPage'
import BriefsPage from './pages/BriefsPage'
import AlertsPage from './pages/AlertsPage'
import ThesisPage from './pages/ThesisPage'
import ThesisJournalLayout from './pages/ThesisJournalLayout'
import ThesisDashboardPage from './pages/ThesisDashboardPage'
import ThesisListPage from './pages/ThesisListPage'
import ThesisBuilderPage from './pages/ThesisBuilderPage'
import ThesisDetailPage from './pages/ThesisDetailPage'
import TradeJournalPage from './pages/TradeJournalPage'
import ReviewsPage from './pages/ReviewsPage'
import ThesisAnalyticsPage from './pages/ThesisAnalyticsPage'
import ThesisSettingsPage from './pages/ThesisSettingsPage'
import { THESIS_JOURNAL_ENABLED } from './lib/flags'
import SavedResearchPage from './pages/SavedResearchPage'
import IntelSettingsPage from './pages/IntelSettingsPage'
import CommentKingPage from './pages/CommentKingPage'
import NewsPage from './pages/NewsPage'
import SupportInboxPage from '../pages/SupportInboxPage'
import SupportTicketPage from '../pages/SupportTicketPage'

// Investor Intel mode root. Mounted at /intel/* inside RequireAuth +
// RequireIntelMode (see src/App.jsx) and lazy-loaded so content-only users
// never download this chunk. Pages are stubs during the build; each feature
// phase swaps a stub for its real page without touching this wiring.
//
// NOTE: nav labels live in src/intel/intelNav.js; page copy in the `intel`
// i18n namespace (src/i18n/locales/<lng>/intel.json).
export default function IntelApp() {
  const { org, profileLoading } = useProfile()

  if (profileLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent)]" />
      </div>
    )
  }

  // A brand-new trial workspace must complete onboarding before the app opens.
  if (org && org.onboarding_completed === false) {
    return <IntelOnboardingPage />
  }

  return (
    <IntelProvider>
      <IntelModeShell>
        <Routes>
          <Route index element={<MarketPulsePage />} />
          <Route path="markets" element={<MarketsPage />} />
          <Route path="markets/:symbol" element={<MarketAssetPage />} />
          <Route path="macro" element={<MacroPage />} />
          <Route path="watchlist" element={<WatchlistPage />} />
          <Route path="portfolio" element={<PortfolioPage />} />
          <Route path="portfolio/:portfolioId/asset/:assetKey" element={<PortfolioAssetPage />} />

          {/* Entity-routed detail pages (resolved via the entity resolver) */}
          <Route path="asset/:ref" element={<AssetBreakdownPage />} />
          <Route path="wallet/:ref" element={<AssetBreakdownPage />} />

          <Route path="narratives" element={<NarrativeRadarPage />} />
          <Route path="narratives/:slug" element={<NarrativeDetailPage />} />
          <Route path="wallets" element={<AnalyzeInputPage artifactType="wallet_summary" titleKey="nav.wallets" defaultTitle="Wallet Watch" subKey="pages.wallets_sub" defaultSub="Follow whale, smart, dev and influencer wallets in simple terms." kind="wallet" defaultPh="Wallet address" />} />
          <Route path="defi" element={<DefiPage />} />
          <Route path="execution" element={<ExecutionPage />} />
          <Route path="compare" element={<ComparePage />} />

          {/* Thesis Journal (global kill switch: flag off → legacy Thesis Tracker
              fallback retained for one release). Static children rank above :id in v6. */}
          {THESIS_JOURNAL_ENABLED ? (
            <Route path="theses" element={<ThesisJournalLayout />}>
              <Route index element={<ThesisDashboardPage />} />
              <Route path="list" element={<ThesisListPage />} />
              <Route path="new" element={<ThesisBuilderPage />} />
              <Route path="trades" element={<TradeJournalPage />} />
              <Route path="reviews" element={<ReviewsPage />} />
              <Route path="analytics" element={<ThesisAnalyticsPage />} />
              <Route path="settings" element={<ThesisSettingsPage />} />
              <Route path=":id" element={<ThesisDetailPage />} />
            </Route>
          ) : (
            <>
              <Route path="theses" element={<ThesisPage />} />
              <Route path="theses/:id" element={<ThesisPage />} />
            </>
          )}

          <Route path="briefs" element={<BriefsPage />} />
          <Route path="briefs/:id" element={<BriefsPage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="news" element={<NewsPage />} />
          <Route path="explain" element={<ExplainPage />} />

          <Route path="comment-king" element={<CommentKingPage />} />

          <Route path="research" element={<SavedResearchPage />} />
          <Route path="settings" element={<IntelSettingsPage />} />
          <Route path="support" element={<SupportInboxPage basePath="/intel/support" />} />
          <Route path="support/:refCode" element={<SupportTicketPage basePath="/intel/support" />} />

          <Route path="*" element={<Navigate to="/intel" replace />} />
        </Routes>
      </IntelModeShell>
    </IntelProvider>
  )
}
