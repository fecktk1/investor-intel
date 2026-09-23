import { useEffect } from 'react'
import { useLocation } from 'react-router'

// Bring the section named by the address hash into view (/intel/structure#intel-rwa-yield).
//
// React Router does not scroll to a hash, and the sections on the long pages
// each own their own read, so the target may not exist yet when the route
// mounts, and the panels above it grow as their reads land. The element is
// looked for every POLL_MS until it exists, then scrolled to once; the wait
// ends after WAIT_MS or as soon as the reader scrolls themselves (a person who
// has started reading is never pulled away). Only ids of the house form
// (letters, digits and dashes) are looked up.

export const HASH_POLL_MS = 150
export const HASH_WAIT_MS = 8000
const ID = /^[a-z][a-z0-9-]{0,79}$/i

export function hashTarget(hash) {
  const id = decodeURIComponent(String(hash || '').replace(/^#/, ''))
  return ID.test(id) ? id : null
}

export function useHashScroll() {
  const { hash, pathname } = useLocation()
  useEffect(() => {
    const id = hashTarget(hash)
    if (!id || typeof document === 'undefined') return undefined
    let done = false
    const started = Date.now()
    const stop = () => { done = true }
    const tick = () => {
      if (done) return
      const el = document.getElementById(id)
      if (el) {
        el.scrollIntoView?.({ block: 'start' })
        done = true
        return
      }
      if (Date.now() - started < HASH_WAIT_MS) timer = setTimeout(tick, HASH_POLL_MS)
    }
    let timer = setTimeout(tick, 0)
    window.addEventListener('wheel', stop, { passive: true, once: true })
    window.addEventListener('touchmove', stop, { passive: true, once: true })
    return () => {
      done = true
      clearTimeout(timer)
      window.removeEventListener('wheel', stop)
      window.removeEventListener('touchmove', stop)
    }
  }, [hash, pathname])
}

export default useHashScroll
