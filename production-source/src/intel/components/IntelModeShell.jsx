import React, { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { Helmet } from 'react-helmet-async'
import { useTranslation } from 'react-i18next'
import { Gauge, Menu, ArrowLeftRight, LogOut, Shield, Radio, Bug, Flame } from 'lucide-react'
import { useAuth } from '../../lib/auth-context'
import { useProfile } from '../../lib/profile-context'
import { useIntel } from '../context/IntelContext'
import SparqHolderBadge from '../../components/SparqHolderBadge'
import { INTEL_NAV } from '../intelNav'
import AskButton from '../../components/help/AskButton'
import LanguageSwitcher from '../../components/LanguageSwitcher'
import ThemeSwitcher from '../../components/ThemeSwitcher'
import SubmitTicketModal from '../../components/support/SubmitTicketModal'
import IntelDisclaimer from './IntelDisclaimer'
import { useScrollRestoration } from '../lib/useScrollRestoration'

// Investor Intel shell. Modeled on the demo shell (src/demo/components/
// DemoLayout.jsx) — same design tokens — but auth-guarded and driven by real
// org-scoped data instead of fixtures. Deliberately separate from the content
// app's Layout so the two products never entangle.
export default function IntelModeShell({ children }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { signOut } = useAuth()
  const { org, switchOrg, isSuperAdmin, sparqHolder } = useProfile()
  const { contentOrg, trialDaysRemaining } = useIntel()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const scrollRef = useScrollRestoration()

  // Super admins get the Intel control center in the Intel shell too, so they
  // never have to switch to a team workspace to manage Intel. Kept out of the
  // shared INTEL_NAV (which is customer-facing) and appended only for admins.
  const navGroups = isSuperAdmin
    ? [
        ...INTEL_NAV,
        {
          sectionKey: 'section.admin',
          sectionDefault: 'Super admin',
          items: [
            { to: '/intel/super-admin', end: true, icon: Shield, labelKey: 'nav.intel_admin', defaultLabel: 'Intel controls' },
            { to: '/intel/super-admin/signals', icon: Radio, labelKey: 'nav.signal_admin', defaultLabel: 'Signal sources' },
          ],
        },
      ]
    : INTEL_NAV

  const handleSignOut = () => {
    signOut()
    navigate('/login')
  }

  return (
    <div className="intel-root h-screen flex overflow-hidden">
      <Helmet>
        <title>{`${t('brand.name', { defaultValue: 'Investor Intel' })} · TheContentForge`}</title>
        <meta name="robots" content="noindex" />
      </Helmet>

      {open && <div className="fixed inset-0 bg-pure-black/60 backdrop-blur-sm z-30 lg:hidden" onClick={() => setOpen(false)} />}

      <aside className={`fixed lg:static inset-y-0 left-0 z-40 w-72 bg-[var(--intel-sidebar-bg)] backdrop-blur-xl border-r border-[var(--intel-border-soft)] transform transition-transform duration-200 ${open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'} flex flex-col shadow-2xl lg:shadow-none`}>
        <div className="p-4 border-b border-[var(--intel-border-soft)]">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl grid place-items-center flex-shrink-0 border border-[var(--forge-gold-border)] shadow-[var(--intel-shadow-inset)]" style={{ background: 'radial-gradient(circle at 35% 20%, rgba(235,181,86,0.28), rgba(235,181,86,0.08) 54%, rgba(255,255,255,0.035))' }}>
              <Gauge className="h-5 w-5" style={{ color: 'var(--forge-gold)' }} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h1 className="text-sm font-semibold text-white truncate">{t('brand.name', { defaultValue: 'Investor Intel' })}</h1>
                <Flame className="h-3.5 w-3.5 text-[var(--ember-accent)]" />
              </div>
              <p className="text-[11px] text-[var(--fg-4)] truncate">TheContentForge</p>
            </div>
          </div>
          <div className="mt-3 rounded-2xl border border-[var(--intel-border-soft)] bg-white/[0.035] px-3 py-2 shadow-[var(--intel-shadow-inset)]">
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

        <nav className="flex-1 overflow-y-auto p-3 space-y-3">
          {navGroups.map((group) => (
            <div key={group.sectionKey} className="space-y-1">
              <div className="eyebrow px-3 pt-2 pb-1">{t(group.sectionKey, { defaultValue: group.sectionDefault })}</div>
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} onClick={() => setOpen(false)}>
                  {({ isActive }) => (
                    <span
                      className={`relative flex items-center gap-3 px-3 py-2.5 rounded-2xl text-sm border transition-all duration-200 ${isActive ? 'font-semibold bg-[var(--forge-gold-soft)] border-[var(--forge-gold-border)] text-[var(--forge-gold)] shadow-[var(--intel-shadow-inset)]' : 'border-transparent text-[var(--fg-3)] hover:text-[var(--fg-1)] hover:bg-white/[0.045] hover:border-[var(--intel-border-soft)]'}`}
                    >
                      {isActive && <span className="absolute left-1 top-1/2 -translate-y-1/2 w-1 h-5 rounded-full" style={{ background: 'var(--forge-gold)' }} />}
                      <item.icon className="h-4 w-4 flex-shrink-0" />
                      <span className="flex-1 min-w-0 truncate">{t(item.labelKey, { defaultValue: item.defaultLabel })}</span>
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="p-3 border-t border-[var(--intel-border-soft)] space-y-1 bg-black/10">
          <button
            onClick={() => setReportOpen(true)}
            className="flex items-center gap-3 px-3 py-2.5 rounded-2xl text-sm text-[var(--fg-3)] hover:text-[var(--fg-1)] hover:bg-white/[0.045] w-full transition-colors"
          >
            <Bug className="h-4 w-4 flex-shrink-0" />
            <span className="flex-1 min-w-0 truncate text-left">{t('shell.report_issue', { defaultValue: 'Report Issue' })}</span>
          </button>
          {contentOrg && (
            <button
              onClick={() => switchOrg(contentOrg.id)}
              className="flex items-center gap-3 px-3 py-2.5 rounded-2xl text-sm text-[var(--fg-3)] hover:text-[var(--fg-1)] hover:bg-white/[0.045] w-full transition-colors"
            >
              <ArrowLeftRight className="h-4 w-4 flex-shrink-0" />
              <span className="flex-1 min-w-0 truncate text-left">{t('shell.switch_to_team', { defaultValue: 'Switch to a team workspace' })}</span>
            </button>
          )}
          <button
            onClick={handleSignOut}
            className="flex items-center gap-3 px-3 py-2.5 rounded-2xl text-sm text-[var(--fg-3)] hover:text-[var(--signal-red)] hover:bg-white/[0.045] w-full transition-colors"
          >
            <LogOut className="h-4 w-4" />
            {t('shell.sign_out', { defaultValue: 'Sign out' })}
          </button>
          <div className="px-1 pt-1 flex items-center gap-1">
            <AskButton className="flex-1" />
            <LanguageSwitcher variant="footer" dropPosition="up" />
            <ThemeSwitcher variant="footer" />
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="lg:hidden flex items-center gap-3 p-4 border-b border-[var(--intel-border-soft)] bg-[var(--intel-header-bg)] backdrop-blur-xl">
          <button onClick={() => setOpen(true)} className="text-[var(--fg-3)] hover:text-white rounded-xl p-1.5 hover:bg-white/[0.055]"><Menu className="h-5 w-5" /></button>
          <span className="font-semibold text-sm text-white">{t('brand.name', { defaultValue: 'Investor Intel' })}</span>
        </header>
        <IntelDisclaimer variant="bar" />
        <main ref={scrollRef} className="flex-1 overflow-y-auto p-4 lg:p-6 xl:p-7">
          <div className="max-w-7xl mx-auto">{children}</div>
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
    </div>
  )
}
