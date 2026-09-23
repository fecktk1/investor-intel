import React, { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import SEO from '../../components/SEO'
import { DEMO_ENTRY_PATH, demoTargetFrom, hasRealSession, legacyDemoTarget, requestIntelDemo } from './demo-mode'

// /intel/demo: public, outside RequireAuth. Turns the demo on for this tab and
// reloads into the real Investor Intel pages: the page named by `?to=` (a
// signed-out visitor who opened an Intel link directly) or the RWA workspace. A signed-in member is simply sent
// to the same page as themselves: a real session always wins.
//
// /demo/intel and /demo/intel/<section> (the old showroom's links) render this
// page with `legacy`: the same entry, landing on the matching real page
// (legacyDemoTarget in ./demo-mode.js).
export default function IntelDemoEntryPage({ legacy = false, storage = globalThis.localStorage, session = globalThis.sessionStorage, location = globalThis.location }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const navigate = useNavigate()
  const { pathname, search } = useLocation()
  const target = legacy ? legacyDemoTarget(pathname, search) : demoTargetFrom(search)
  useEffect(() => {
    if (hasRealSession(storage)) { navigate(target, { replace: true }); return }
    requestIntelDemo(session)
    // A full document load, so the demo network layer is installed before any
    // provider or page makes its first request.
    try { location?.replace?.(target) } catch { /* test environment */ }
  }, [navigate, storage, session, location, target])
  return (
    <div className="min-h-screen flex items-center justify-center bg-black text-sm text-[var(--fg-3)]" role="status">
      <SEO title={t('intel_demo.entry_title', { defaultValue: 'Investor Intel live demo' })} path={legacy ? pathname : DEMO_ENTRY_PATH} noindex />
      {t('intel_demo.entry_loading', { defaultValue: 'Opening the live demo…' })}
    </div>
  )
}
