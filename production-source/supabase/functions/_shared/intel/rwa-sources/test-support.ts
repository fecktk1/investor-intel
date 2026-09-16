// Shared fakes for the RWA primary-source adapter tests. No network, no clock.

export interface FakeRoute {
  status?: number
  body?: unknown
  /** Returned as `res.url`, so a redirect off the source's hosts is testable. */
  url?: string
  headers?: Record<string, string>
  throws?: 'abort' | 'network'
}

export interface FakeCall { url: string; headers: Record<string, string> }

/**
 * A fetch that answers from a route table keyed by exact URL, or by the first
 * key the URL starts with. An unrouted URL is a 404, so a test never silently
 * passes because it hit a route it did not mean to.
 */
export function fakeFetch(routes: Record<string, FakeRoute>) {
  const calls: FakeCall[] = []
  // deno-lint-ignore no-explicit-any
  const impl = (url: string, init?: any) => {
    calls.push({ url, headers: { ...(init?.headers ?? {}) } })
    const key = Object.keys(routes).find((k) => k === url) ?? Object.keys(routes).find((k) => url.startsWith(k))
    const route = key ? routes[key] : { status: 404, body: { error: 'unrouted' } }
    if (route.throws === 'abort') { const e = new Error('aborted'); e.name = 'AbortError'; return Promise.reject(e) }
    if (route.throws === 'network') return Promise.reject(new Error('connection refused'))
    const status = route.status ?? 200
    const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? {})
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      url: route.url ?? url,
      headers: { get: (name: string) => route.headers?.[name.toLowerCase()] ?? null },
      text: () => Promise.resolve(text),
    })
  }
  return { impl, calls }
}

/** Deterministic deps: no real clock, no real sleeping. */
export const deps = (fetchImpl: unknown, extra: Record<string, unknown> = {}) => ({
  // deno-lint-ignore no-explicit-any
  fetchImpl: fetchImpl as any,
  now: () => Date.parse('2026-09-16T14:00:00.000Z'),
  sleep: () => Promise.resolve(),
  ...extra,
})

export const EDGAR_AGENT = 'TheContentForge-InvestorIntel/1.0 (contact@example.test)'
