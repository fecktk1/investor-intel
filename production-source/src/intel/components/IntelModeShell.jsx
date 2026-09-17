import React, { useCallback, useEffect, useRef, useState } from 'react'
import { NavLink, useNavigate, useLocation } from 'react-router'
import { Helmet } from 'react-helmet-async'
import { useTranslation } from 'react-i18next'
import { Gauge, Menu, ArrowLeftRight, LogOut, Shield, Bug, Flame, ChevronDown, X } from 'lucide-react'
import { useAuth } from '../../lib/auth-context'
import { useSupabase } from '../../lib/useSupabase'
import { useProfile } from '../../lib/profile-context'
import { useIntel } from '../context/IntelContext'
import SparqHolderBadge from '../../components/SparqHolderBadge'
import { INTEL_NAV, INTEL_UTILITY_NAV } from '../intelNav'
import AskButton from '../../components/help/AskButton'
import LanguageSwitcher from '../../components/LanguageSwitcher'
import ThemeSwitcher from '../../components/ThemeSwitcher'
import SubmitTicketModal from '../../components/support/SubmitTicketModal'
import SupportEventLogger from '../../components/support/SupportEventLogger'
import IntelDisclaimer from './IntelDisclaimer'
import IntelMembershipNotice from './IntelMembershipNotice'
import { useScrollRestoration } from '../lib/useScrollRestoration'
import { markSurfaceSeen } from '../lib/changes-api'
import WorkspaceSearch from '../../components/navigation/WorkspaceSearch'
import { searchIntelAssets } from '../lib/workspace-search'
import { intelSearchActions } from '../lib/search-actions'
import { THESIS_JOURNAL_ENABLED } from '../lib/flags'
import { MarketDetailCacheProvider } from '../context/MarketDetailCache'
import PinnedResearch from './PinnedResearch'

// Investor Intel shell. Modeled on the demo shell (src/demo/components/
// DemoLayout.jsx) — same design tokens — but auth-guarded and driven by real
// org-scoped data instead of fixtures. Deliberately separate from the content
// app's Layout so the two products never entangle.
export default function IntelModeShell({ children }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { signOut } = useAuth()
  const { supabase, user } = useSupabase()
  const { org, switchOrg, isSuperAdmin, sparqHolder } = useProfile()
  const { contentOrg, trialDaysRemaining } = useIntel()
  const navigate = useNavigate()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [compact, setCompact] = useState(() => new URLSearchParams(location.search).get('compact') === '1')
  const compactParams = new URLSearchParams(location.search); compactParams.set('compact', '1')
  const [reportOpen, setReportOpen] = useState(false)
  const [utilitiesOpen, setUtilitiesOpen] = useState(false)
  const [expandedGroup, setExpandedGroup] = useState(null)
  const menuRef = useRef(null)
  const menuButtonRef = useRef(null)
  const searchAssets = useCallback((query, signal) => searchIntelAssets(supabase, org?.id, query, signal, t), [supabase, org?.id, t])
  const closeNavigation = useCallback(() => setOpen(false), [])
  useEffect(() => { setUtilitiesOpen(false); setOpen(false) }, [org?.id, user?.id])
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement
    const focusable = () => [...(menuRef.current?.querySelectorAll('a,button,input,select,[tabindex="0"]') || [])].filter(el => !el.disabled && el.getClientRects().length)
    focusable()[0]?.focus()
    const key = e => {
      if (e.key === 'Escape') { setOpen(false); menuButtonRef.current?.focus(); return }
      if (e.key === 'Tab') { const nodes = focusable(); const first = nodes[0], last = nodes.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() } }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus?.() }
  }, [open])
  const scrollRef = useScrollRestoration(`intel:${user?.id || ""}:${org?.id || ""}`)

  // One cheap upsert on entry plus a visible-tab heartbeat. Background portfolio
  // repricing uses this to stop work after 48 hours without Investor Intel use.
  useEffect(() => {
    const heartbeat = () => {
      if (org?.id && user?.id && (typeof document === 'undefined' || document.visibilityState === 'visible')) markSurfaceSeen(supabase, 'intel_activity', '', { orgId: org.id, userId: user.id })
    }
    heartbeat()
    const interval = window.setInterval(heartbeat, 15 * 60 * 1000)
    document.addEventListener('visibilitychange', heartbeat)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', heartbeat)
    }
  }, [supabase, org?.id, user?.id])

  // Super Admin is a product-independent control center. Intel exposes a
  // single parent entry; the global admin shell owns all child navigation.
  const navGroups = isSuperAdmin
    ? [
        ...INTEL_NAV,
        {
          sectionKey: 'section.admin',
          sectionDefault: 'Super admin',
          items: [
            { to: '/super-admin', icon: Shield, labelKey: 'nav.super_admin', defaultLabel: 'Super Admin' },
            // Internal Intel-only surfaces. They live here rather than in
            // INTEL_NAV because every reader of INTEL_NAV can open its routes.
            { to: '/intel/admin/data-budget', icon: Gauge, labelKey: 'nav.data_budget', defaultLabel: 'Data budget' },
          ],
        },
      ]
    : INTEL_NAV
  const currentGroup = navGroups.flatMap(group => group.items.map(item => ({ group: group.sectionKey, item })))
    .filter(({ item }) => location.pathname === item.to || (!item.end && location.pathname.startsWith(`${item.to}/`)))
    .sort((a, b) => b.item.to.length - a.item.to.length)[0]?.group
    || (location.pathname.startsWith('/intel/asset/') ? 'section.markets_workspace' : null)
  useEffect(() => { setExpandedGroup(currentGroup) }, [currentGroup])

  // signOut() navigates the document to /login itself (see auth-context) so the
  // previous account's cached org state is flushed; no navigate() to race it.
  const handleSignOut = () => { signOut() }

  return (
    <div className={`intel-root h-screen flex overflow-hidden ${compact ? 'intel-compact' : ''}`} data-navigation-open={open}>
      <a href="#intel-main" className="intel-skip-link">{t('shell.skip', { defaultValue: 'Skip to research' })}</a>
      <Helmet>
        <title>{`${t('brand.name', { defaultValue: 'Investor Intel' })} · TheContentForge`}</title>
        <meta name="robots" content="noindex" />
      </Helmet>

      {open && <div className="intel-navigation-backdrop fixed inset-0 bg-pure-black/60 backdrop-blur-sm z-30 lg:hidden" onClick={() => setOpen(false)} />}

      <aside id="intel-navigation" ref={menuRef} aria-label={t('shell.navigation', { defaultValue: 'Investor Intel navigation' })} className={`fixed lg:static inset-y-0 left-0 z-40 w-64 bg-[var(--intel-sidebar-bg)] backdrop-blur-xl border-r border-[var(--intel-border-soft)] transform transition-transform duration-200 ${open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'} flex flex-col intel-navigation`}>
        <button type="button" aria-label={t('shell.close_navigation', { defaultValue: 'Close navigation' })} onClick={() => setOpen(false)} className="intel-navigation-close lg:hidden absolute top-0 right-0 p-2 text-[var(--fg-3)]"><X className="h-4 w-4" /></button>
        <div className="p-4 border-b border-[var(--intel-border-soft)]">
          <div className="flex items-center gap-3">
            <div className="intel-brand-mark">
              <Gauge className="h-5 w-5" style={{ color: 'var(--forge-gold)' }} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h1 className="intel-brand-title">{t('brand.name', { defaultValue: 'Investor Intel' })}</h1>
                <Flame className="h-3.5 w-3.5 text-[var(--ember-accent)]" />
              </div>
              <p className="text-[11px] text-[var(--fg-4)] truncate">TheContentForge</p>
            </div>
          </div>
          <div className="mt-3 text-[var(--fg-4)]">
            <p className="text-[11px] text-[var(--fg-3)] truncate">{org?.name || t('brand.tagline', { defaultValue: 'Crypto intelligence & risk context' })}</p>
          </div>
        </div>

        {sparqHolder && (
          <div className="px-3 pt-3">
            <div className="intel-surface intel-surface--accent px-3 py-2 flex items-center">
              <SparqHolderBadge holder={sparqHolder} />
            </div>
          </div>
        )}

        {trialDaysRemaining != null && (
          <div className="px-3 pt-3">
            <div className="intel-surface intel-surface--accent px-3 py-2 text-[12px] text-[var(--fg-2)]">
              {t('trial.banner', { count: trialDaysRemaining, defaultValue: `Trial — ${trialDaysRemaining} days left` })}
            </div>
          </div>
        )}

        {/* Says, once, that the trial ended and nothing was lost. Renders
            itself only for a workspace that reached the free tier that way. */}
        <IntelMembershipNotice />

        <nav className="flex-1 overflow-y-auto p-3 intel-nav-groups">
          {navGroups.map((group) => {
            const primary = group.items.find(item => group.sectionKey === 'section.research_workspace' && item.to === '/intel/research') || group.items[0]
            const expanded = expandedGroup === group.sectionKey
            const label = t(group.sectionKey, { defaultValue: group.sectionDefault })
            return <div key={group.sectionKey}>
              <div className={`intel-nav-group-heading ${currentGroup === group.sectionKey ? 'is-current' : ''}`}>
                <NavLink to={primary.to} onClick={() => setOpen(false)}><primary.icon size={18} /><span>{label}</span></NavLink>
                {group.items.length > 1 && <button aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`} aria-expanded={expanded} aria-controls={`nav-${group.sectionKey}`} onClick={() => setExpandedGroup(expanded ? null : group.sectionKey)}><ChevronDown size={15} className={expanded ? 'is-expanded' : ''} /></button>}
              </div>
              {expanded && group.items.length > 1 && <div id={`nav-${group.sectionKey}`} className="intel-nav-children">{group.items.filter(item => item !== primary || group.sectionKey === 'section.research_workspace').map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} onClick={() => setOpen(false)}>
                  {({ isActive }) => (
                    <span
                      className={`intel-nav-link ${isActive ? 'is-active' : ''}`}
                    >

                      <span className="flex-1 min-w-0 truncate">{t(item.labelKey, { defaultValue: item.defaultLabel })}</span>
                    </span>
                  )}
                </NavLink>
              ))}</div>}
            </div>
          })}
          <div className="intel-nav-utilities" aria-label={t('shell.account_utilities', { defaultValue: 'Settings and support' })}>
            {INTEL_UTILITY_NAV.map(item => (
              <NavLink key={item.to} to={item.to} onClick={() => setOpen(false)} className={({ isActive }) => `intel-nav-link ${isActive ? 'is-active' : ''}`}>
                <item.icon size={16} /><span>{t(item.labelKey, { defaultValue: item.defaultLabel })}</span>
              </NavLink>
            ))}
          </div>
        </nav>

        <div className="intel-nav-footer p-3 border-t border-[var(--intel-border-soft)] space-y-1">
          <button type="button" className="intel-account-trigger" aria-expanded={utilitiesOpen} aria-controls="intel-account-actions" onClick={() => setUtilitiesOpen(value => !value)}>{t('shell.account_actions', { defaultValue: 'Account & help' })}<ChevronDown size={15}/></button>
          {utilitiesOpen && <div id="intel-account-actions" className="intel-account-actions">
          <button
            onClick={() => setReportOpen(true)}
            className="flex items-center gap-3 px-3 py-2.5 rounded-none text-sm text-[var(--fg-3)] hover:text-[var(--fg-1)] hover:bg-white/[0.045] w-full transition-colors"
          >
            <Bug className="h-4 w-4 flex-shrink-0" />
            <span className="flex-1 min-w-0 truncate text-left">{t('shell.report_issue', { defaultValue: 'Report Issue' })}</span>
          </button>
          {contentOrg && (
            <button
              onClick={() => switchOrg(contentOrg.id, { to: '/dashboard' })}
              className="flex items-center gap-3 px-3 py-2.5 rounded-none text-sm text-[var(--fg-3)] hover:text-[var(--fg-1)] hover:bg-white/[0.045] w-full transition-colors"
            >
              <ArrowLeftRight className="h-4 w-4 flex-shrink-0" />
              <span className="flex-1 min-w-0 truncate text-left">{t('shell.switch_to_team', { defaultValue: 'Switch to a team workspace' })}</span>
            </button>
          )}
          <button
            onClick={handleSignOut}
            className="flex items-center gap-3 px-3 py-2.5 rounded-none text-sm text-[var(--fg-3)] hover:text-[var(--signal-red)] hover:bg-white/[0.045] w-full transition-colors"
          >
            <LogOut className="h-4 w-4" />
            {t('shell.sign_out', { defaultValue: 'Sign out' })}
          </button>
          <AskButton className="w-full justify-center" />
          </div>}
          <div className="intel-nav-preferences">
            <LanguageSwitcher variant="footer" dropPosition="up" className="min-w-0" />
            <ThemeSwitcher variant="footer" className="min-w-0" />
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="intel-workspace-header">
          <button ref={menuButtonRef} aria-label={t('shell.open_navigation', { defaultValue: 'Open navigation' })} aria-expanded={open} aria-controls="intel-navigation" onClick={() => setOpen(value => !value)} className="intel-navigation-open lg:hidden text-[var(--fg-3)] p-1.5"><Menu className="h-5 w-5" /></button>
          <span className="intel-workspace-location">{t(currentGroup || 'brand.name', { defaultValue: navGroups.find(group => group.sectionKey === currentGroup)?.sectionDefault || 'Investor Intel' })}</span>
          <WorkspaceSearch scope={`${user?.id || ''}:${org?.id || ''}:intel`} disabled={!org?.id || !user?.id} searchRemote={searchAssets} onOpen={closeNavigation} pages={[
            ...intelSearchActions(navGroups, t, THESIS_JOURNAL_ENABLED),
            ...navGroups.flatMap(group => group.items.map(item => ({ to: item.to, label: t(item.labelKey, { defaultValue: item.defaultLabel }), group: t(group.sectionKey, { defaultValue: group.sectionDefault }), keywords: item.to }))),
            ...INTEL_UTILITY_NAV.map(item => ({ to: item.to, label: t(item.labelKey, { defaultValue: item.defaultLabel }), group: t('shell.account_utilities', { defaultValue: 'Settings and support' }) })),
          ]}/>
          {compact ? <button className="intel-text-link intel-window-control" onClick={() => { setCompact(false); const next = new URLSearchParams(location.search); next.delete('compact'); navigate(`${location.pathname}?${next}`, {replace:true}) }}>Full workspace</button> : <a className="intel-text-link intel-window-control" aria-label="Open compact window" href={`${location.pathname}?${compactParams}`} target="_blank" rel="noopener">Compact window</a>}
        </header>
        <IntelDisclaimer variant="bar" />
        <PinnedResearch/>
        <main id="intel-main" ref={scrollRef} className="flex-1 overflow-y-auto p-4 lg:p-6 xl:p-7">
          <div className="max-w-7xl mx-auto"><MarketDetailCacheProvider key={`${user?.id || ""}:${org?.id || ""}`}>{children}</MarketDetailCacheProvider><footer className="mt-6 pt-3 border-t border-[var(--border-default)] text-xs text-[var(--fg-4)]"><a href="https://coinmarketcap.com/" target="_blank" rel="noreferrer" className="underline underline-offset-4">Data provided by CoinMarketCap.com</a><span> · Additional sources identified alongside their data.</span></footer></div>
        </main>
      </div>

      {/* Report Issue / feedback / feature request reuses the org-side
          support flow, mounted inside Intel at /intel/support. */}
      <SubmitTicketModal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        initialKind="bug"
        redirectBasePath="/intel/support"
      />
      <SupportEventLogger />
    </div>
  )
}
