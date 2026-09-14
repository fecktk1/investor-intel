export const DEFI_PAGE_SIZE = 50
export const DEFI_CACHE_TTL = 60000

export function defiQuery({ chain = 'solana', view = 'vaults', product = 'all', search = '', sort = 'tvl_usd', direction = 'desc', page = 0 } = {}) {
  return { chain, view, product, search: String(search).trim().slice(0, 120), sort, direction,
    page: Math.max(0, Math.min(2000, Math.trunc(Number(page) || 0))), limit: DEFI_PAGE_SIZE }
}

// Per-mounted explorer cache, bounded in size and time. Repeated loads share one
// request, while results from a prior chain/query are guarded by the caller.
export function createDefiBrowseCache(now = Date.now) {
  const completed = new Map(), pending = new Map()
  return {
    async load(key, fetchPage, force = false) {
      const hit = completed.get(key)
      if (!force && hit && now() < hit.expiresAt) return hit.data
      if (pending.has(key)) return pending.get(key)
      const request = Promise.resolve().then(fetchPage).then((data) => {
        if (data.status === 'provider_error') throw new Error(data.error || 'defi_browse_failed')
        completed.delete(key)
        completed.set(key, { data, expiresAt: now() + DEFI_CACHE_TTL })
        while (completed.size > 24) completed.delete(completed.keys().next().value)
        return data
      }).finally(() => pending.delete(key))
      pending.set(key, request)
      return request
    },
  }
}

export async function loadDefiPage(supabase, orgId, options) {
  if (!orgId) throw new Error('Workspace unavailable')
  const { data, error } = await supabase.functions.invoke('intel-defi-browse', { body: { orgId, ...defiQuery(options) } })
  if (error) throw error
  if (data?.error || !Array.isArray(data?.rows)) throw new Error(data?.error || 'defi_browse_failed')
  return data
}
