import React from 'react'
import { deferredRoute } from '../lib/deferred-route'
import { Routes, Route, Navigate } from 'react-router'
import { useProfile } from '../lib/profile-context'
import {useSupabase} from '../lib/useSupabase'
import IntelProfileGate from './components/IntelProfileGate'
import { IntelProvider } from './context/IntelContext'
import { IntelAccessProvider } from './context/IntelAccess'
import { PortfolioSelectionProvider } from './lib/PortfolioSelectionContext'
import { PersonalWorkspaceProvider } from './context/PersonalWorkspace'
import { WatchlistSelectionProvider } from './context/WatchlistSelection'
import { ResearchThreadsProvider } from './context/ResearchThreads'
import { DashboardCacheProvider } from './context/DashboardCache'
import { DisplayCurrencyProvider } from './lib/display-currency'
import './workspace.css'
import IntelModeShell from './components/IntelModeShell'
const IntelStubPage = React.lazy(() => import('./pages/IntelStubPage'))
const IntelOnboardingPage = React.lazy(() => import('./pages/IntelOnboardingPage'))
const WatchlistPage = React.lazy(() => import('./pages/WatchlistPage'))
const AssetBreakdownPage = deferredRoute(() => import('./pages/AssetBreakdownPage'), <div className="intel-route-loading" role="status">Loading research…</div>)
const ExplainPage = React.lazy(() => import('./pages/ExplainPage'))
const ComparePage = React.lazy(() => import('./pages/ComparePage'))
const MarketPulsePage = React.lazy(() => import('./pages/MarketPulsePage'))
const MarketResearchPage = React.lazy(() => import('./pages/MarketResearchPage'))
const InvestigationPage = React.lazy(() => import('./pages/InvestigationPage'))
const ChartSnapshotPage = React.lazy(() => import('./pages/ChartSnapshotPage'))
const MarketsPage = React.lazy(() => import('./pages/MarketsPage'))
const MarketStructurePage = React.lazy(() => import('./pages/MarketStructurePage'))
const CategoriesPage = React.lazy(() => import('./pages/CategoriesPage'))
const AirdropsPage = React.lazy(() => import('./pages/AirdropsPage'))
const ListingsPage = React.lazy(() => import('./pages/ListingsPage'))
const GraduationPage = React.lazy(() => import('./pages/GraduationPage'))
const MarketAssetPage = deferredRoute(() => import('./pages/MarketAssetPage'), <div className="intel-route-loading" role="status">Loading research…</div>)
const PortfolioPage = React.lazy(() => import('./pages/PortfolioPage'))
const PortfolioAssetPage = React.lazy(() => import('./pages/PortfolioAssetPage'))
const NarrativeRadarPage = React.lazy(() => import('./pages/NarrativeRadarPage'))
const NarrativeDetailPage = React.lazy(() => import('./pages/NarrativeDetailPage'))
const AnalyzeInputPage = React.lazy(() => import('./pages/AnalyzeInputPage'))
const ExecutionPage = React.lazy(() => import('./pages/ExecutionPage'))
const DefiPage = React.lazy(() => import('./pages/DefiPage'))
const MacroPage = React.lazy(() => import('./pages/MacroPage'))
const RegimePage = React.lazy(() => import('./pages/RegimePage'))
const BriefsPage = React.lazy(() => import('./pages/BriefsPage'))
const AlertsPage = React.lazy(() => import('./pages/AlertsPage'))
const ThesisPage = React.lazy(() => import('./pages/ThesisPage'))
const ThesisJournalLayout = React.lazy(() => import('./pages/ThesisJournalLayout'))
const ThesisDashboardPage = React.lazy(() => import('./pages/ThesisDashboardPage'))
const ThesisListPage = React.lazy(() => import('./pages/ThesisListPage'))
const ThesisBuilderPage = React.lazy(() => import('./pages/ThesisBuilderPage'))
const ThesisDetailPage = React.lazy(() => import('./pages/ThesisDetailPage'))
const TradeJournalPage = React.lazy(() => import('./pages/TradeJournalPage'))
const ReviewsPage = React.lazy(() => import('./pages/ReviewsPage'))
const ThesisAnalyticsPage = React.lazy(() => import('./pages/ThesisAnalyticsPage'))
const ThesisSettingsPage = React.lazy(() => import('./pages/ThesisSettingsPage'))
import { THESIS_JOURNAL_ENABLED } from './lib/flags'
const SavedResearchPage = React.lazy(() => import('./pages/SavedResearchPage'))
const IntelSettingsPage = React.lazy(() => import('./pages/IntelSettingsPage'))
const CommentKingPage = React.lazy(() => import('./pages/CommentKingPage'))
const NewsPage = React.lazy(() => import('./pages/NewsPage'))
const ChartLabPage = React.lazy(() => import('./pages/ChartLabPage'))
const DataBudgetPage = React.lazy(() => import('./pages/DataBudgetPage'))
const SupportInboxPage = React.lazy(() => import('../pages/SupportInboxPage'))
const SupportTicketPage = React.lazy(() => import('../pages/SupportTicketPage'))

// Investor Intel mode root. Mounted at /intel/* inside RequireAuth +
// RequireIntelMode (see src/App.jsx) and lazy-loaded so content-only users
// never download this chunk. Pages are stubs during the build; each feature
// phase swaps a stub for its real page without touching this wiring.
//
// NOTE: nav labels live in src/intel/intelNav.js; page copy in the `intel`
// i18n namespace (src/i18n/locales/<lng>/intel.json).
export default function IntelApp() {
  const { org, profile, profileLoading } = useProfile(),{user}=useSupabase()

  // A brand-new trial workspace must complete onboarding before the app opens.
  if (org && org.onboarding_completed === false) {
    return <React.Suspense fallback={<p role="status">Loading workspace…</p>}><IntelOnboardingPage /></React.Suspense>
  }

  return (
    <IntelProfileGate loading={profileLoading} user={user} profile={profile} org={org}><IntelProvider>
      {/* Which surfaces this membership may open, read once for the whole mode
          so a costly panel can be rendered as a lock in its own place. A LABEL
          only: every gated read is refused again at the server, so nothing here
          grants access and a failed read never invents a refusal. */}
      <IntelAccessProvider>
      {/* One FX read an hour for the whole mode: money columns render in the
          reader's chosen currency, converted from the stored USD at display
          time. Outermost of the data providers so every route shares one rate. */}
      <DisplayCurrencyProvider>
      <DashboardCacheProvider><PersonalWorkspaceProvider><ResearchThreadsProvider><WatchlistSelectionProvider><PortfolioSelectionProvider>
      <IntelModeShell>
        <React.Suspense fallback={<div className="intel-route-loading" role="status">Loading research…</div>}>
        <Routes>
          <Route index element={<MarketPulsePage />} />
          <Route path="markets" element={<MarketsPage />} />
          {/* CMC capture figures (rank map, RWA universe, index constituents,
              liquidation heat). Distinct from /intel/market-structure, which is
              the exchange market-research workspace. */}
          <Route path="structure" element={<MarketStructurePage />} />
          {/* CMC category list (a second breadth source) and the recorded
              airdrop calendar. Both read the same capture service. */}
          <Route path="categories" element={<CategoriesPage />} />
          <Route path="airdrops" element={<AirdropsPage />} />
          {/* The daily new-listing due-diligence cohort and the hourly meme
              launch-stage lifecycle. Both read the same capture service. */}
          <Route path="listings" element={<ListingsPage />} />
          <Route path="graduation" element={<GraduationPage />} />
          <Route path="rwa" element={<MarketResearchPage workspace="rwa" />} />
          <Route path="market-structure" element={<MarketResearchPage workspace="structure" />} />
          <Route path="discovery" element={<MarketResearchPage workspace="discovery" />} />
          <Route path="market-context" element={<MarketResearchPage workspace="context" />} />
          <Route path="investigate" element={<InvestigationPage />} />
          <Route path="chart-snapshots/:id" element={<ChartSnapshotPage />} />
          <Route path="markets/:symbol" element={<MarketAssetPage />} />
          <Route path="macro" element={<MacroPage />} />
          <Route path="regime" element={<RegimePage />} />
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

          {/* Internal chart kit gallery; the page itself gates on super admin. */}
          <Route path="lab/charts" element={<ChartLabPage />} />

          {/* Provider plan, schedule cost and capture depth; the page itself
              gates on super admin and the edge function answers 403 as well. */}
          <Route path="admin/data-budget" element={<DataBudgetPage />} />

          <Route path="research" element={<SavedResearchPage />} />
          <Route path="settings" element={<IntelSettingsPage />} />
          <Route path="support" element={<SupportInboxPage basePath="/intel/support" />} />
          <Route path="support/:refCode" element={<SupportTicketPage basePath="/intel/support" />} />

          <Route path="*" element={<Navigate to="/intel" replace />} />
        </Routes>
      </React.Suspense>
      </IntelModeShell>
      </PortfolioSelectionProvider></WatchlistSelectionProvider></ResearchThreadsProvider></PersonalWorkspaceProvider></DashboardCacheProvider>
      </DisplayCurrencyProvider>
      </IntelAccessProvider>
    </IntelProvider></IntelProfileGate>
  )
}
