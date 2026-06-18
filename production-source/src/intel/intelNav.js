// Investor Intel — sidebar navigation config.
//
// Same shape as the content app's `allNavItems` (src/components/Layout.jsx)
// but rendered by IntelModeShell. Deliberately has NO `allowedOrg` slug gate
// (that content-app pattern hardcodes a single customer — an anti-pattern we
// never copy). Access is gated by product_mode / entitlement upstream.
//
// Detail routes (/intel/asset/:ref, /intel/wallet/:ref, /intel/briefs/:id,
// /intel/theses/:id) are reached from Markets (search + chain browse),
// Watchlist, and Market Pulse — not the sidebar directly.

import {
  Activity, Compass, Star, Radar, Wallet, BarChart3, LineChart, Scale,
  NotebookPen, Newspaper, Bell, HelpCircle, MessageSquare, Bookmark, Settings, Rss, Landmark, Briefcase, LifeBuoy,
  LayoutDashboard, CalendarCheck,
} from 'lucide-react'
import { THESIS_JOURNAL_ENABLED } from './lib/flags'

// Thesis Journal replaces the single "Thesis Tracker" item with a multi-item
// section. Global kill switch: flag off → legacy single Thesis Tracker entry.
const JOURNAL_SECTION = THESIS_JOURNAL_ENABLED
  ? {
      sectionKey: 'section.journal',
      items: [
        { to: '/intel/theses',           end: true, icon: LayoutDashboard, labelKey: 'journal.nav.dashboard', defaultLabel: 'Dashboard' },
        { to: '/intel/theses/list',                 icon: NotebookPen,     labelKey: 'journal.nav.theses',    defaultLabel: 'Theses' },
        { to: '/intel/theses/trades',               icon: LineChart,       labelKey: 'journal.nav.trades',    defaultLabel: 'Trades' },
        { to: '/intel/theses/reviews',              icon: CalendarCheck,   labelKey: 'journal.nav.reviews',   defaultLabel: 'Reviews' },
        { to: '/intel/theses/analytics',            icon: BarChart3,       labelKey: 'journal.nav.analytics', defaultLabel: 'Analytics' },
      ],
    }
  : {
      sectionKey: 'section.theses',
      items: [
        { to: '/intel/theses', icon: NotebookPen, labelKey: 'nav.theses', defaultLabel: 'Thesis Tracker' },
      ],
    }

export const INTEL_NAV = [
  {
    sectionKey: 'section.pulse',
    items: [
      { to: '/intel',            end: true, icon: Activity,    labelKey: 'nav.market_pulse', defaultLabel: 'Market Pulse' },
      { to: '/intel/markets',               icon: Compass,     labelKey: 'nav.markets',      defaultLabel: 'Markets' },
      { to: '/intel/macro',                 icon: Landmark,    labelKey: 'nav.macro',        defaultLabel: 'Macro' },
      { to: '/intel/watchlist',             icon: Star,        labelKey: 'nav.watchlist',    defaultLabel: 'My Watchlist' },
      { to: '/intel/portfolio',             icon: Briefcase,   labelKey: 'nav.portfolio',    defaultLabel: 'Portfolio' },
    ],
  },
  {
    sectionKey: 'section.research',
    items: [
      { to: '/intel/narratives', icon: Radar,     labelKey: 'nav.narratives', defaultLabel: 'Narrative Radar' },
      { to: '/intel/wallets',    icon: Wallet,    labelKey: 'nav.wallets',    defaultLabel: 'Wallet Watch' },
      { to: '/intel/defi',       icon: BarChart3, labelKey: 'nav.defi',       defaultLabel: 'DeFi Intelligence' },
      { to: '/intel/execution',  icon: LineChart, labelKey: 'nav.execution',  defaultLabel: 'Execution Intelligence' },
      { to: '/intel/compare',    icon: Scale,     labelKey: 'nav.compare',    defaultLabel: 'Compare' },
    ],
  },
  JOURNAL_SECTION,
  {
    sectionKey: 'section.daily',
    items: [
      { to: '/intel/news',    icon: Rss,        labelKey: 'nav.news',    defaultLabel: 'News' },
      { to: '/intel/briefs',  icon: Newspaper,  labelKey: 'nav.briefs',  defaultLabel: 'Daily Brief' },
      { to: '/intel/alerts',  icon: Bell,       labelKey: 'nav.alerts',  defaultLabel: 'Alerts' },
      { to: '/intel/explain', icon: HelpCircle, labelKey: 'nav.explain', defaultLabel: 'Explain This' },
    ],
  },
  {
    sectionKey: 'section.create',
    items: [
      { to: '/intel/comment-king', icon: MessageSquare, labelKey: 'nav.comment_king', defaultLabel: 'Comment King' },
    ],
  },
  {
    sectionKey: 'section.me',
    items: [
      { to: '/intel/research', icon: Bookmark, labelKey: 'nav.research', defaultLabel: 'Saved Research' },
      { to: '/intel/support', icon: LifeBuoy, labelKey: 'nav.support', defaultLabel: 'Support' },
      { to: '/intel/settings', icon: Settings, labelKey: 'nav.settings', defaultLabel: 'Settings' },
    ],
  },
]
