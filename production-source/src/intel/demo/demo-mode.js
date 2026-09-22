// Investor Intel public demo: when is it on, and how does a visitor leave it.
//
// The demo is a no-account walk through the REAL Investor Intel pages, served
// from a daily snapshot (see ./demo-fetch.js). It is on for this browser tab
// only when BOTH hold:
//   * sessionStorage 'tcf_intel_demo' is '1' (set by /intel/demo), and
//   * there is no real signed-in session in localStorage.
// A real session always wins: the flag is then ignored and nothing here runs.
//
// The decision is made once per document, before React renders (main.jsx calls
// bootIntelDemo). Entering and leaving are full document navigations, so no
// module state, cache or client ever straddles a demo and a real session.

export const DEMO_FLAG_KEY = 'tcf_intel_demo'
export const DEMO_ENTRY_PATH = '/intel/demo'
export const DEMO_START_PATH = '/intel/rwa'
export const DEMO_LEAVE_PATH = '/investors'
export const DEMO_SIGNUP_PATH = '/intel/signup?plan=free'

let active = false

function readSession(storage) {
  try { return storage?.getItem?.(DEMO_FLAG_KEY) === '1' } catch { return false }
}

/** Is a real signed-in session stored in this browser? */
export function hasRealSession(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.('supabase_session')
    if (!raw) return false
    const parsed = JSON.parse(raw)
    return !!(parsed && typeof parsed.access_token === 'string' && parsed.access_token)
  } catch {
    return false
  }
}

/** Was the demo requested in this tab? */
export function demoRequested(storage = globalThis.sessionStorage) {
  return readSession(storage)
}

/** Paths the demo can serve. Everything else leaves the demo first. */
export function isDemoPath(pathname) {
  const path = String(pathname || '')
  if (path !== '/intel' && !path.startsWith('/intel/')) return false
  // Account creation, checkout, trial start and admin screens are real flows.
  const real = ['/intel/signup', '/intel/upgrade', '/intel/start', '/intel/shared-chart', '/intel/super-admin', '/intel/chart-link']
  return !real.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

/** Decide, once, whether this document runs as the demo. */
export function resolveDemoActive({
  session = globalThis.sessionStorage,
  local = globalThis.localStorage,
  pathname = globalThis.location?.pathname,
} = {}) {
  if (!demoRequested(session)) return false
  if (hasRealSession(local)) return false
  return isDemoPath(pathname)
}

/** Is this document the demo? */
export function isIntelDemoActive() {
  return active
}

/** Test and boot hook. */
export function setIntelDemoActive(value) {
  active = !!value
}

// The old fictional showroom lived at /demo/intel/<section>. Those links now
// enter the real demo and land on the matching real page.
export const LEGACY_DEMO_PREFIX = '/demo/intel'
export const LEGACY_DEMO_SECTIONS = Object.freeze([
  'markets', 'structure', 'listings', 'macro', 'watchlist', 'portfolio', 'narratives', 'wallets', 'defi', 'graduation',
  'execution', 'compare', 'theses', 'news', 'briefs', 'alerts', 'explain', 'comment-king', 'research', 'settings',
])

/** The real demo page for an old /demo/intel[/<section>] link. */
export function legacyDemoTarget(pathname, search = '') {
  const path = String(pathname || '').replace(/\/+$/, '')
  if (path !== LEGACY_DEMO_PREFIX && !path.startsWith(`${LEGACY_DEMO_PREFIX}/`)) return DEMO_START_PATH
  let section = ''
  try { section = decodeURIComponent(path.slice(LEGACY_DEMO_PREFIX.length).split('/')[1] || '') } catch { return DEMO_START_PATH }
  const query = new URLSearchParams(String(search || '').replace(/^\?/, ''))
  const withQuery = (to) => (query.toString() ? `${to}?${query.toString()}` : to)
  if (!section) return DEMO_START_PATH
  if (section === 'pulse') return withQuery('/intel')
  if (section === 'degen') { query.set('mode', 'degen'); return withQuery('/intel/markets') }
  if (LEGACY_DEMO_SECTIONS.includes(section)) return withQuery(`/intel/${section}`)
  return DEMO_START_PATH
}

// The visitor's own sections. They start empty in the demo and say so once.
export const DEMO_PERSONAL_SECTIONS = Object.freeze(['watchlist', 'portfolio', 'wallets', 'theses', 'alerts', 'briefs', 'research', 'settings'])

/** Is this one of the visitor's own (personal) sections? */
export function isDemoPersonalPath(pathname) {
  const path = String(pathname || '')
  return DEMO_PERSONAL_SECTIONS.some((section) => path === `/intel/${section}` || path.startsWith(`/intel/${section}/`))
}

/** Turn the flag on for this tab (the /intel/demo entry route). */
export function requestIntelDemo(storage = globalThis.sessionStorage) {
  try { storage?.setItem?.(DEMO_FLAG_KEY, '1') } catch { /* private mode: the demo simply stays off */ }
}

/** Clear the flag and leave with a full navigation, so nothing lingers. */
export function exitIntelDemo(to = DEMO_LEAVE_PATH, { storage = globalThis.sessionStorage, location = globalThis.location } = {}) {
  try { storage?.removeItem?.(DEMO_FLAG_KEY) } catch { /* nothing to clear */ }
  active = false
  const target = typeof to === 'string' && to.startsWith('/') && !to.startsWith('//') ? to : DEMO_LEAVE_PATH
  try { location?.assign?.(target) } catch { /* test environment */ }
}
