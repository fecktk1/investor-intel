import { useEffect, useMemo, useRef } from 'react'
import { useLocation } from 'react-router-dom'

const positions = new Map()

export function useScrollRestoration(keyPrefix = 'intel') {
  const ref = useRef(null)
  const location = useLocation()
  const key = useMemo(() => `${keyPrefix}:${location.pathname}${location.search}`, [keyPrefix, location.pathname, location.search])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const y = positions.get(key) || 0
    requestAnimationFrame(() => { el.scrollTop = y })
  }, [key])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let ticking = false
    const onScroll = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(() => {
        positions.set(key, el.scrollTop)
        ticking = false
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      positions.set(key, el.scrollTop)
      el.removeEventListener('scroll', onScroll)
    }
  }, [key])

  return ref
}
