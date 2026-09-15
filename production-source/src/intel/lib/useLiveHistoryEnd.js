import { useEffect, useState } from 'react'

// Advance a currently visible timeline after a successful authored action. A
// fixed mount-time bound otherwise excludes actions made while the page is open.
export function useLiveHistoryEnd(orgId) {
  const [end, setEnd] = useState(Date.now)
  useEffect(() => {
    if (!orgId) return
    setEnd(Date.now())
    const changed = event => { if (event.detail?.orgId === orgId) setEnd(Date.now()) }
    const visible = () => { if(document.visibilityState==='visible')setEnd(Date.now()) }
    window.addEventListener('intel:thesis-activity-changed', changed)
    window.addEventListener('intel:portfolio-activity-changed', changed)
    document.addEventListener('visibilitychange', visible)
    const timer=setInterval(visible,60000)
    return () => { clearInterval(timer);window.removeEventListener('intel:thesis-activity-changed', changed);window.removeEventListener('intel:portfolio-activity-changed', changed);document.removeEventListener('visibilitychange',visible) }
  }, [orgId])
  return end
}
