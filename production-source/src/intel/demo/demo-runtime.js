// Investor Intel public demo: switching a document into the demo.
//
// main.jsx calls bootIntelDemo() once, before React renders. When the demo is
// requested and there is no real session (./demo-mode.js), it:
//   * routes both Supabase data clients through demoFetch (src/lib/supabase.js),
//   * disables Realtime on both clients,
//   * wraps window.fetch so a raw fetch to the backend host (auth-context, the
//     help status probe, active-org helpers) is answered by demoFetch too,
//   * refuses WebSocket connections to the backend host,
//   * blocks same-origin serverless functions.
// Nothing is persisted: the store and the snapshot cache live in this module.

import { setSupabaseFetch, disableSupabaseRealtime } from '../../lib/supabase'
import { createDemoFetch, missBody } from './demo-fetch'
import { createDemoStore } from './demo-store'
import { createSnapshotReader, isDemoBucketUrl } from './demo-snapshot'
import { isIntelDemoActive, resolveDemoActive, setIntelDemoActive } from './demo-mode'

let reader = null
let installed = null

function hrefOf(input) {
  if (typeof input === 'string') return input
  if (input && typeof input.url === 'string') return input.url
  try { return String(input) } catch { return '' }
}

/** Install the demo network layer on `win`. Returns the pieces for tests. */
export function installIntelDemo({ supabaseUrl, win = globalThis } = {}) {
  if (installed) return installed
  const base = String(supabaseUrl || '').replace(/\/+$/, '')
  const originalFetch = typeof win.fetch === 'function' ? win.fetch.bind(win) : null
  // The reader alone keeps the original fetch, and only for public bucket reads.
  const bucketFetch = (input, init) => {
    if (!originalFetch || !isDemoBucketUrl(base, hrefOf(input))) return Promise.reject(new Error('demo_snapshot_url_refused'))
    return originalFetch(input, { ...(init || {}), credentials: 'omit' })
  }
  reader = createSnapshotReader({ supabaseUrl: base, fetchImpl: bucketFetch })
  const store = createDemoStore()
  // In development only, every request the demo cannot answer is kept on
  // window.__intelDemoMisses, so a page's missing inputs can be read off it.
  const onMiss = import.meta.env?.DEV
    ? (detail) => { try { (win.__intelDemoMisses ||= []).push({ at: win.location?.pathname || '', ...detail }) } catch { /* diagnostics only */ } }
    : null
  const demoFetch = createDemoFetch({ supabaseUrl: base, reader, store, onMiss })

  setIntelDemoActive(true)
  setSupabaseFetch(demoFetch)
  disableSupabaseRealtime()

  const sameOriginFunctions = (href) => {
    try {
      const url = new URL(href, win.location?.href || 'http://localhost/')
      return url.origin === win.location?.origin && url.pathname.startsWith('/.netlify/functions/')
    } catch { return false }
  }
  win.fetch = (input, init) => {
    const href = hrefOf(input)
    if (base && href.startsWith(base)) return demoFetch(input, init)
    if (sameOriginFunctions(href)) return Promise.resolve(new Response(JSON.stringify(missBody()), { status: 404, headers: { 'Content-Type': 'application/json' } }))
    return originalFetch ? originalFetch(input, init) : Promise.reject(new Error('fetch_unavailable'))
  }

  const OriginalSocket = win.WebSocket
  if (typeof OriginalSocket === 'function' && base) {
    const host = (() => { try { return new URL(base).host } catch { return '' } })()
    const Guarded = function WebSocket(url, protocols) {
      let target = ''
      try { target = new URL(String(url)).host } catch { target = '' }
      if (host && target === host) throw new Error('Realtime is off in the Investor Intel demo')
      return protocols === undefined ? new OriginalSocket(url) : new OriginalSocket(url, protocols)
    }
    Guarded.prototype = OriginalSocket.prototype
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Guarded[k] = OriginalSocket[k]
    try { win.WebSocket = Guarded } catch { /* read-only global */ }
  }

  installed = { demoFetch, store, reader, originalFetch }
  return installed
}

/** Decide and install, once per document. */
export function bootIntelDemo({ supabaseUrl = import.meta.env.VITE_SUPABASE_URL, win = globalThis } = {}) {
  if (installed) return true
  if (!resolveDemoActive({ session: win.sessionStorage, local: win.localStorage, pathname: win.location?.pathname })) return false
  installIntelDemo({ supabaseUrl, win })
  return isIntelDemoActive()
}

/** latest.json of the snapshot in force, or null. */
export function getDemoManifest() {
  return reader ? reader.manifest() : Promise.resolve(null)
}

/** Test hook. */
export function resetIntelDemoRuntimeForTests() {
  installed = null
  reader = null
  setIntelDemoActive(false)
  setSupabaseFetch(null)
}
