import { useEffect, useState, useRef } from 'react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readCaptureView, captureUnavailable } from './capture-api'

// One stored RWA asset profile by rwa id, for a detail drawer.
//
// It reads the `rwa_asset_profile` capture view, which is a DATABASE READ of a row
// the scheduled lane already captured. It spends no provider credit and issues no
// provider call on a reader's behalf, which is what lets it sit on the free
// `capture_views` surface.
//
// `rwaId` may be null: the hook then idles in the 'idle' state and makes no
// request, so a drawer can mount before its asset is chosen.
//
// States, all four distinct on purpose:
//   idle        no rwa id yet
//   loading     a read is in flight
//   ready       the read succeeded. `profile` is null when this asset has not
//               been captured yet, which is NOT a failure and must be said in
//               words rather than shown as an error.
//   unavailable the read failed, and `reason` says why
export function useRwaAssetProfile(rwaId) {
  const { org } = useProfile()
  // The capture tables are service-role only, so the read travels on the reader's
  // own authenticated client, never the anonymous one.
  const { supabase } = useSupabase()
  // Held in a ref so a host that hands back a new client object on every render
  // cannot restart the read on every render.
  const client = useRef(supabase)
  client.current = supabase
  const orgId = org?.id || null
  const id = Number.isFinite(Number(rwaId)) && Number(rwaId) >= 1 ? Math.trunc(Number(rwaId)) : null
  const [state, setState] = useState({ status: id == null ? 'idle' : 'loading', profile: null, payload: null, reason: null })

  useEffect(() => {
    if (id == null) { setState({ status: 'idle', profile: null, payload: null, reason: null }); return undefined }
    const controller = new AbortController()
    let alive = true
    setState({ status: 'loading', profile: null, payload: null, reason: null })
    readCaptureView('rwa_asset_profile', { rwaId: id }, { orgId, signal: controller.signal, supabase: client.current })
      .then(payload => {
        if (!alive) return
        // A successful read that carries its own reason (one of the two tables was
        // unavailable) still delivers what loaded, with the reason attached.
        setState({ status: 'ready', profile: payload?.profile || null, payload: payload || null, reason: payload?.reason || null })
      })
      .catch(error => { if (alive) setState({ status: 'unavailable', profile: null, payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [id, orgId])

  return state
}

export default useRwaAssetProfile
