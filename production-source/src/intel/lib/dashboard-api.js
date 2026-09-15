// Investor Intel — home dashboard digest client.
export async function loadDashboard(supabase, orgId, { scope = 'all', chain = null, section = 'full' } = {}) {
  const { data, error } = await supabase.functions.invoke('intel-dashboard', { body: { orgId, scope, chain, section } })
  if (error) throw new Error(error.message || 'dashboard_failed')
  if (data?.error) throw new Error(data.error)
  return data
}

export const DASHBOARD_CACHE_TTL = 30_000
export function dashboardScopeKey({ userId, orgId, scope = 'all', chain = null, section = 'core' }) {
  if (!userId || !orgId) return null
  return JSON.stringify([userId, orgId, scope, chain, section])
}

// Owned by the mounted workspace, never shared across accounts or persisted.
export function createDashboardCache(now = Date.now) {
  const entries = new Map()
  return {
    clear: () => entries.clear(),
    load: async (key, fetcher, force = false) => {
      if (!key) throw new Error('Authenticated workspace required')
      const cached = entries.get(key)
      if (!force && cached && (cached.pending || cached.expires > now())) return cached.pending || cached.value
      const entry = { pending: null, expires: 0, value: null }
      entry.pending = Promise.resolve().then(fetcher).then(value => {
        if (!value || value.error) throw new Error(value?.error || 'dashboard_unavailable')
        entry.value = value; entry.expires = now() + DASHBOARD_CACHE_TTL; entry.pending = null
        return value
      }).catch(error => { if (entries.get(key) === entry) entries.delete(key); throw error })
      entries.delete(key); entries.set(key, entry)
      while (entries.size > 16) entries.delete(entries.keys().next().value)
      return entry.pending
    },
  }
}
