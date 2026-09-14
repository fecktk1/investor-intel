import React, { createContext, useContext, useLayoutEffect, useMemo } from 'react'
import { createMarketDetailCache } from '../lib/market-detail-cache'
const MarketDetailCache = createContext(null)
// The shell keys this provider by both user and organization.
export function MarketDetailCacheProvider({ children }) {
  const cache = useMemo(() => createMarketDetailCache(), [])
  useLayoutEffect(() => () => cache.clear(), [cache])
  return <MarketDetailCache.Provider value={cache}>{children}</MarketDetailCache.Provider>
}
export const useMarketDetailCache = () => useContext(MarketDetailCache)
