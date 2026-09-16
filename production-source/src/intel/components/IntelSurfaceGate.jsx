import React from 'react'
import IntelLockedSurface from './IntelLockedSurface'
import { useIntelSurfaceLock } from '../context/IntelAccess'

// Renders a part of the product, or the locked panel that stands in its place.
//
// The member keeps the page they came for: the header, the controls and every
// surface their membership does open. Only the costly panel is replaced, in
// position, by the lock that names the plan which opens it.
//
// THE SECURITY PROPERTY THIS COMPONENT MUST NOT BREAK. When the surface is
// locked, `children` are NOT rendered and are NOT handed to IntelLockedSurface.
// That component deliberately accepts no data prop, so a withheld reading can
// never be blurred in the browser, and this gate must never become the way
// around that. It passes a surface name, a title and a tier: three labels the
// client already holds. It never passes a value, a row or a series.
export default function IntelSurfaceGate({ surface, title, className = '', children }) {
  const lock = useIntelSurfaceLock(surface)
  if (!lock) return children ?? null
  return <IntelLockedSurface surface={lock.surface} title={title} minTier={lock.minTier} className={className} />
}
