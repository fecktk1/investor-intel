import React, { createContext, useContext, useMemo } from 'react'
import { useProfile } from '../../lib/profile-context'

// Investor Intel mode context. Thin for now — exposes the active personal
// workspace + a place to hang cross-page state (watchlist cache, unread-alert
// count, Beginner Protection) as later phases land.
const IntelContext = createContext(null)

export function IntelProvider({ children }) {
  const { org, role, profileLoading, memberships } = useProfile()

  // A content workspace the user can switch back to (if any), used by the
  // shell's "Switch to a team workspace" affordance.
  const contentOrg = useMemo(() => {
    const m = (memberships || []).find((x) => x.org && x.org.product_mode !== 'intel')
    return m?.org || null
  }, [memberships])

  // Trial countdown (full access until trial_ends_at).
  const trialDaysRemaining = useMemo(() => {
    if (!org?.trial_ends_at) return null
    const ms = new Date(org.trial_ends_at).getTime() - Date.now()
    return ms > 0 ? Math.ceil(ms / 86_400_000) : 0
  }, [org?.trial_ends_at])

  const value = useMemo(() => ({
    org,
    role,
    profileLoading,
    contentOrg,
    trialDaysRemaining,
    // Placeholder until intel_user_profiles lands (P1). Beginner Protection
    // defaults ON so safety is the default, not opt-in.
    beginnerProtection: true,
  }), [org, role, profileLoading, contentOrg, trialDaysRemaining])

  return <IntelContext.Provider value={value}>{children}</IntelContext.Provider>
}

export function useIntel() {
  const ctx = useContext(IntelContext)
  if (!ctx) throw new Error('useIntel must be used within an IntelProvider')
  return ctx
}
