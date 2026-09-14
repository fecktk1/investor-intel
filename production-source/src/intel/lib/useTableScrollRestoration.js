import { useLayoutEffect, useRef } from 'react'
const positions = new Map()
let activeScope = null

// Table scroll is separate from page scroll. Keep it bounded and owner scoped.
export function useTableScrollRestoration(scope, route) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !scope) return
    if (activeScope !== scope) { positions.clear(); activeScope = scope }
    const key = `${scope}:${route}`
    const saved = positions.get(key)
    element.scrollTop = saved?.top || 0
    element.scrollLeft = saved?.left || 0
    const save = () => {
      positions.set(key, { top: element.scrollTop, left: element.scrollLeft })
      if (positions.size > 40) positions.delete(positions.keys().next().value)
    }
    element.addEventListener('scroll', save, { passive: true })
    return () => { save(); element.removeEventListener('scroll', save) }
  }, [scope, route])
  return ref
}
