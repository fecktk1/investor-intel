import React from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { LayoutDashboard, NotebookPen, LineChart, CalendarCheck, BarChart3, Settings, Plus } from 'lucide-react'

// Thesis Journal shell: a sub-nav strip above the routed page. The five primary
// destinations also live in the sidebar (intelNav.js); Settings lives here to
// keep the sidebar lean. New Thesis is always one click away.
const SUB_NAV = [
  { to: '/intel/theses',          end: true, icon: LayoutDashboard, key: 'journal.nav.dashboard', label: 'Dashboard' },
  { to: '/intel/theses/list',                icon: NotebookPen,     key: 'journal.nav.theses',    label: 'Theses' },
  { to: '/intel/theses/trades',              icon: LineChart,       key: 'journal.nav.trades',    label: 'Trades' },
  { to: '/intel/theses/reviews',             icon: CalendarCheck,   key: 'journal.nav.reviews',   label: 'Reviews' },
  { to: '/intel/theses/analytics',           icon: BarChart3,       key: 'journal.nav.analytics', label: 'Analytics' },
  { to: '/intel/theses/settings',            icon: Settings,        key: 'journal.nav.settings',  label: 'Settings' },
]

export default function ThesisJournalLayout() {
  const { t } = useTranslation('intel', { useSuspense: false })
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <nav className="flex items-center gap-1 flex-wrap">
          {SUB_NAV.map((it) => {
            const Icon = it.icon
            return (
              <NavLink
                key={it.to}
                to={it.to}
                end={it.end}
                className={({ isActive }) =>
                  `chip text-[12px] flex items-center gap-1.5 ${isActive ? 'chip--active bg-[var(--accent)] text-black' : 'text-[var(--fg-3)]'}`}
              >
                <Icon className="h-3.5 w-3.5" /> {t(it.key, { defaultValue: it.label })}
              </NavLink>
            )
          })}
        </nav>
        <NavLink to="/intel/theses/new" className="btn btn--primary btn--sm">
          <Plus className="h-4 w-4" /> {t('journal.new_thesis', { defaultValue: 'New thesis' })}
        </NavLink>
      </div>
      <Outlet />
    </div>
  )
}
