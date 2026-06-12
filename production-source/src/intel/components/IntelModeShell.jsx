import React, { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { Helmet } from 'react-helmet-async'
import { useTranslation } from 'react-i18next'
import { Gauge, Menu, ArrowLeftRight, LogOut, Shield, Radio, Bug } from 'lucide-react'
import { useAuth } from '../../lib/auth-context'
import { useProfile } from '../../lib/profile-context'
import { useIntel } from '../context/IntelContext'
import { INTEL_NAV } from '../intelNav'
import LanguageSwitcher from '../../components/LanguageSwitcher'
import SubmitTicketModal from '../../components/support/SubmitTicketModal'
import IntelDisclaimer from './IntelDisclaimer'

// Investor Intel shell. Modeled on the demo shell (src/demo/components/
// DemoLayout.jsx) — same design tokens — but auth-guarded and driven by real
// org-scoped data instead of fixtures. Deliberately separate from the content
// app's Layout so the two products never entangle.
export default function IntelModeShell({ children }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { signOut } = useAuth()
  const { org, switchOrg, isSuperAdmin } = useProfile()
  const { contentOrg, trialDaysRemaining } = useIntel()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)

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
    <div className="h-screen flex bg-black overflow-hidden">
      <Helmet>
        <title>{`${t('brand.name', { defaultValue: 'Investor Intel' })} · TheContentForge`}</title>
        <meta name="robots" content="noindex" />
      </Helmet>

      {open && <div className="fixed inset-0 bg-black/50 z-30 lg:hidden" onClick={() => setOpen(false)} />}

      <aside className={`fixed lg:static inset-y-0 left-0 z-40 w-64 bg-[var(--bg-1)] border-r border-[var(--border-subtle)] transform transition-transform duration-200 ${open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'} flex flex-col`}>
        <div className="p-4 border-b border-[var(--border-subtle)] flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg grid place-items-center flex-shrink-0" style={{ background: 'var(--accent-tint)' }}>
            <Gauge className="h-5 w-5" style={{ color: 'var(--accent)' }} />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-white truncate">{t('brand.name', { defaultValue: 'Investor Intel' })}</h1>
            <p className="text-[11px] text-[var(--fg-4)] truncate">{org?.name || t('brand.tagline', { defaultValue: 'Crypto intelligence & risk context' })}</p>
          </div>
        </div>

        {trialDaysRemaining != null && (
          <div className="px-3 pt-3">
            <div className="card--accent px-3 py-2 text-[12px] text-[var(--fg-2)]">
              {t('trial.banner', { count: trialDaysRemaining, defaultValue: `Trial — ${trialDaysRemaining} days left` })}
            </div>
          </div>
        )}

        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {navGroups.map((group) => (
            <div key={group.sectionKey}>
              <div className="eyebrow px-3 pt-3 pb-1.5">{t(group.sectionKey, { defaultValue: group.sectionDefault })}</div>
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} onClick={() => setOpen(false)}>
                  {({ isActive }) => (
                    <span
                      className={`relative flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${isActive ? 'font-medium' : 'text-[var(--fg-3)] hover:text-[var(--fg-1)] hover:bg-[var(--bg-2)]'}`}
                      style={isActive ? { background: 'var(--accent-tint)', color: 'var(--accent)' } : undefined}
                    >
                      {isActive && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-full" style={{ background: 'var(--accent)' }} />}
                      <item.icon className="h-4 w-4 flex-shrink-0" />
                      <span className="flex-1 min-w-0 truncate">{t(item.labelKey, { defaultValue: item.defaultLabel })}</span>
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="p-3 border-t border-[var(--border-subtle)] space-y-1">
          <button
            onClick={() => setReportOpen(true)}
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-[var(--fg-3)] hover:text-[var(--fg-1)] hover:bg-[var(--bg-2)] w-full transition-colors"
          >
            <Bug className="h-4 w-4 flex-shrink-0" />
            <span className="flex-1 min-w-0 truncate text-left">{t('shell.report_issue', { defaultValue: 'Report Issue' })}</span>
          </button>
          {contentOrg && (
            <button
              onClick={() => switchOrg(contentOrg.id)}
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-[var(--fg-3)] hover:text-[var(--fg-1)] hover:bg-[var(--bg-2)] w-full transition-colors"
            >
              <ArrowLeftRight className="h-4 w-4 flex-shrink-0" />
              <span className="flex-1 min-w-0 truncate text-left">{t('shell.switch_to_team', { defaultValue: 'Switch to a team workspace' })}</span>
            </button>
          )}
          <button
            onClick={handleSignOut}
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-[var(--fg-3)] hover:text-red-400 hover:bg-[var(--bg-2)] w-full transition-colors"
          >
            <LogOut className="h-4 w-4" />
            {t('shell.sign_out', { defaultValue: 'Sign out' })}
          </button>
          <div className="px-1 pt-1">
            <LanguageSwitcher variant="footer" dropPosition="up" />
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="lg:hidden flex items-center gap-3 p-4 border-b border-[var(--border-subtle)] bg-[var(--bg-1)]">
          <button onClick={() => setOpen(true)} className="text-[var(--fg-3)] hover:text-white"><Menu className="h-5 w-5" /></button>
          <span className="font-bold text-sm text-white">{t('brand.name', { defaultValue: 'Investor Intel' })}</span>
        </header>
        <IntelDisclaimer variant="bar" />
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          <div className="max-w-6xl mx-auto">{children}</div>
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
