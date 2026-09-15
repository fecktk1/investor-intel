// Short-lived navigation data, never a shared/private evidence store.
export function createMarketDetailCache({ now = Date.now, ttlMs = 60000, limit = 8 } = {}) {
  const entries = new Map()
  let version = 0
  return {
    clear() { version++; entries.clear() },
    read(identity, load, { force = false } = {}) {
      if (!identity?.sourceProvider || identity.providerId == null) return load()
      const key = JSON.stringify([identity.sourceProvider, String(identity.providerId)])
      const found = entries.get(key)
      if (!force && found && found.until > now()) return found.promise
      if (entries.size >= limit) entries.delete(entries.keys().next().value)
      const ownerVersion = version
      const entry = { until: now() + ttlMs }
      entry.promise = Promise.resolve().then(load).then(data => {
        if (version !== ownerVersion) return data
        if (!data || data.error || !Array.isArray(data.candles) || !data.candles.length || JSON.stringify(data).length > 1024 * 1024) {
          if (entries.get(key) === entry) entries.delete(key)
        }
        return data
      }, error => { if (entries.get(key) === entry) entries.delete(key); throw error })
      entries.set(key, entry)
      return entry.promise
    },
  }
}
