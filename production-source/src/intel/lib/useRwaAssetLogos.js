import { useEffect, useMemo, useRef, useState } from 'react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readCaptureView } from './capture-api'

// CoinMarketCap's own image for a PAGE of tokenised real-world assets, in one
// request.
//
// WHY A BATCH AND NOT A HOOK PER ROW. A list of 25 assets rendered with a
// per-row read would be 25 calls into `intel-capture` every time a reader turned
// a page, on a surface that is free precisely because it costs nothing per
// reader. This asks once, for the ids on screen, and hands back a map.
//
// It reads `rwa_asset_logos`, a database read of rows the profile lane already
// wrote. No provider is called on a reader's behalf and no credit is spent.
//
// A FAILED READ IS AN EMPTY MAP AND NOTHING ELSE. The only thing this hook can
// change on a page is whether an image or a monogram is drawn beside a name, so
// a failure must never produce an error line, a retry or a gap: the caller's
// TokenAvatar already draws the monogram when it is handed nothing. The reason
// is returned for a caller that wants it, and no caller has to use it.
//
// An id that has not been profiled yet, or whose profile carries no image, is
// simply ABSENT from the map.

/** Ids one read may ask for. Mirrors LOGO_BATCH_MAX in
 *  supabase/functions/_shared/intel/capture-rwa-underlyings-read.ts. */
export const LOGO_BATCH_MAX = 100

/** The ids actually worth asking for: positive integers, de-duplicated, capped,
 *  and sorted so two renders of the same page produce the same request key. */
export function logoIds(values) {
  const ids = new Set()
  for (const value of Array.isArray(values) ? values : []) {
    const n = Number(value)
    if (Number.isFinite(n) && n >= 1) ids.add(Math.trunc(n))
  }
  return [...ids].sort((a, b) => a - b).slice(0, LOGO_BATCH_MAX)
}

export function useRwaAssetLogos(rwaIds, enabled = true) {
  const { org } = useProfile()
  // The profile table is service-role only, so the read travels on the reader's
  // own authenticated client. Held in a ref so a host that hands back a new
  // client object every render cannot restart the read every render.
  const { supabase } = useSupabase()
  const client = useRef(supabase)
  client.current = supabase
  const orgId = org?.id || null
  const ids = useMemo(() => (enabled ? logoIds(rwaIds) : []), [rwaIds, enabled])
  // The request key, not the array: a new array of the same ids must not refetch.
  const key = ids.join(',')
  const [state, setState] = useState({ logos: {}, reason: null })

  useEffect(() => {
    if (!key) { setState({ logos: {}, reason: null }); return undefined }
    const controller = new AbortController()
    let alive = true
    readCaptureView('rwa_asset_logos', { rwaIds: key.split(',').map(Number) }, { orgId, signal: controller.signal, supabase: client.current })
      .then(payload => {
        if (alive) setState({ logos: payload?.logos && typeof payload.logos === 'object' ? payload.logos : {}, reason: payload?.reason || null })
      })
      // An image that did not arrive is a monogram, never an error on the page.
      .catch(error => { if (alive) setState({ logos: {}, reason: String(error?.code || error?.message || 'unavailable') }) })
    return () => { alive = false; controller.abort() }
  }, [key, orgId])

  return state
}

export default useRwaAssetLogos
