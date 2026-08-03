import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'

export function useUrlState(defaults = {}) {
  const [searchParams, setSearchParams] = useSearchParams()

  const state = useMemo(() => {
    const out = { ...defaults }
    for (const [key, fallback] of Object.entries(defaults)) {
      const raw = searchParams.get(key)
      out[key] = raw == null ? fallback : raw
    }
    return out
  }, [defaults, searchParams])

  const setUrlState = useCallback((patch, opts = {}) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const [key, value] of Object.entries(patch || {})) {
        if (value == null || value === '' || value === defaults[key]) next.delete(key)
        else next.set(key, String(value))
      }
      return next
    }, { replace: opts.replace !== false })
  }, [defaults, setSearchParams])

  return [state, setUrlState]
}
