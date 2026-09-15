import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router'
export function useScreenParams(prefix, defaults) {
  const [search, setSearch] = useSearchParams()
  const serialized = search.toString()
  const searchRef = useRef(search)
  useLayoutEffect(() => { searchRef.current = search }, [search])
  const defaultsKey = JSON.stringify(defaults)
  const read = useCallback(params => Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const raw = params.get(`${prefix}${key}`)
    const parsed = raw == null ? fallback : typeof fallback === 'boolean' ? raw === 'true' : typeof fallback === 'number' ? Math.max(0, Math.min(5000, Number(raw) || 0)) : raw.slice(0, 300)
    return [key, key === 'limit' ? Math.max(1, Math.min(100, parsed)) : parsed]
  })), [defaultsKey, prefix])
  const value = useMemo(() => read(search), [serialized, read])
  const setValue = useCallback(updater => {
    const next = typeof updater === 'function' ? updater(read(searchRef.current)) : updater
    const params = new URLSearchParams(searchRef.current)
    for (const [key, fallback] of Object.entries(defaults)) { if (next[key] === fallback || next[key] == null) params.delete(`${prefix}${key}`); else params.set(`${prefix}${key}`, String(next[key])) }
    // Chart callbacks may report the current selection after any parent render.
    // Replacing an identical URL would rerender the route and retrigger them,
    // as well as clearing an in-page research/position anchor.
    if (params.toString() === searchRef.current.toString()) return
    searchRef.current = params
    setSearch(params, { replace: true })
  }, [read, prefix, defaultsKey, setSearch])
  return [value, setValue]
}
