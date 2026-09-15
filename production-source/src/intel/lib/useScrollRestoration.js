import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router'
const positions = new Map()
export function useScrollRestoration(keyPrefix = 'intel') {
  const ref = useRef(null)
  const location = useLocation()
  const key = `${keyPrefix}:${location.pathname}${location.search}`
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const target = positions.get(key) || 0
    let restoring = true, raf = 0
    const restore = () => { if (restoring) { el.scrollTop = target; if (el.scrollHeight - el.clientHeight >= target) restoring = false } }
    const cancel = () => { restoring = false }
    const save = () => { if (!restoring) positions.set(key, el.scrollTop) }
    const observer = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(restore) })
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    raf = requestAnimationFrame(restore)
    const deadline = setTimeout(cancel, 15000)
    el.addEventListener('scroll', save, { passive: true }); el.addEventListener('wheel', cancel, { passive: true }); el.addEventListener('touchstart', cancel, { passive: true }); el.addEventListener('keydown', cancel)
    return () => {
      save(); clearTimeout(deadline); cancelAnimationFrame(raf); observer.disconnect()
      el.removeEventListener('scroll', save); el.removeEventListener('wheel', cancel); el.removeEventListener('touchstart', cancel); el.removeEventListener('keydown', cancel)
      if (positions.size > 100) positions.delete(positions.keys().next().value)
    }
  }, [key])
  return ref
}
