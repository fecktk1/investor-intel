import { useEffect } from 'react'
import { useLocation } from 'react-router'
import { exitIntelDemo, isDemoPath, isIntelDemoActive } from './demo-mode'

// Any route the demo does not serve (a marketing page, sign in, checkout, the
// content app) is reached with a full navigation after the flag is cleared, so
// it runs as the real product and never under the demo's network layer.
export default function IntelDemoRouteGuard() {
  const { pathname, search, hash } = useLocation()
  useEffect(() => {
    if (isIntelDemoActive() && !isDemoPath(pathname)) exitIntelDemo(`${pathname}${search}${hash}`)
  }, [pathname, search, hash])
  return null
}
