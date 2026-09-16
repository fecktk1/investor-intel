import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readIntelAccess } from '../lib/intel-api'
import { intelSurfaceLock } from '../lib/intel-surface-lock'

// Which Investor Intel surfaces this membership may open, read once per
// workspace so the product can render a locked panel in place of a costly one.
//
// THIS IS A LABEL, NEVER A BOUNDARY. Every gated read is refused again at the
// server (supabase/functions/_shared/intel/intel-surface-access.ts) and the
// withheld reading is never produced, let alone sent. Nothing here decides
// what a member may have; it decides what the page says about it.
//
// Because it is only a label, it fails OPEN on purpose. A workspace we have no
// answer for renders the ordinary product: the member then meets the server's
// own refusal, which is the honest one, instead of a lock this file guessed at.
// Locking on a failed read would invent a refusal that no gate actually made.

const IntelAccessContext = createContext(null)

const NO_ACCESS = { tier: null, rank: null, surfaces: {}, loading: false, error: null }

// The decision itself lives in ../lib/intel-surface-lock, with no dependencies,
// so it can be tested on its own. Re-exported here because this is where the
// rest of the product reaches for it.
export { intelSurfaceLock }

export function IntelAccessProvider({ children }) {
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const [state, setState] = useState({ ...NO_ACCESS, loading: true })

  useEffect(() => {
    if (!org?.id || !user?.id) { setState({ ...NO_ACCESS }); return undefined }
    let alive = true
    setState((previous) => ({ ...previous, loading: true, error: null }))
    readIntelAccess(supabase, org.id)
      .then((access) => {
        if (!alive) return
        setState({
          tier: access?.tier ?? null,
          rank: typeof access?.rank === 'number' ? access.rank : null,
          surfaces: access?.surfaces && typeof access.surfaces === 'object' ? access.surfaces : {},
          loading: false,
          // A valid answer with no surfaces stays an answer. It is not an error
          // and it is not a lock: nothing is claimed about any surface.
          error: null,
        })
      })
      .catch((e) => {
        if (!alive) return
        // Named reason, kept for anyone who asks. It never becomes a lock.
        setState({ ...NO_ACCESS, error: e?.message || 'intel_access_unavailable' })
      })
    return () => { alive = false }
  }, [supabase, org?.id, user?.id])

  const value = useMemo(() => ({
    ...state,
    lockFor: (surface) => intelSurfaceLock(state.surfaces, surface),
  }), [state])

  return <IntelAccessContext.Provider value={value}>{children}</IntelAccessContext.Provider>
}

/** The whole access record. Safe outside the provider: nothing is locked. */
export function useIntelAccess() {
  return useContext(IntelAccessContext) || { ...NO_ACCESS, lockFor: () => null }
}

/** The lock for one surface, or null when the member may open it. */
export function useIntelSurfaceLock(surface) {
  return useIntelAccess().lockFor(surface)
}
