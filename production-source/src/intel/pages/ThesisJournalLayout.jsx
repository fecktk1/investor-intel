import React,{useState} from 'react'
import { NavLink, Outlet } from 'react-router'
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
  const [menuOpen,setMenuOpen]=useState(false)
  return (
    <div className="space-y-4">
      <div className="intel-journal-toolbar flex items-center justify-between gap-3 flex-wrap">
        <button className="intel-journal-menu-toggle" aria-expanded={menuOpen} aria-controls="journal-destinations" onClick={()=>setMenuOpen(open=>!open)}>{t('journal.title',{defaultValue:'Thesis Journal'})} ▾</button>
        <nav id="journal-destinations" aria-label="Thesis Journal" data-open={menuOpen} className="intel-journal-nav">
          {SUB_NAV.map((it) => {
            const Icon = it.icon
            return (
              <NavLink
                key={it.to}
                to={it.to}
                end={it.end}
                onClick={()=>setMenuOpen(false)}
                className={({ isActive }) =>
                  `text-[12px] flex items-center gap-1.5 ${isActive ? 'text-[var(--accent)] underline underline-offset-4' : 'text-[var(--fg-3)]'}`}
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
