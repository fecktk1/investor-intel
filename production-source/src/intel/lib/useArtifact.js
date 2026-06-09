import { useState, useCallback } from 'react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { generateArtifact } from './artifact-api'

// Drives a single research-artifact generation: call intel-generate, hold the
// result (incl. the safety-block flag), expose loading/error.
export function useArtifact() {
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const generate = useCallback(async (params) => {
    if (!org?.id) return
    setLoading(true); setError(null)
    try {
      const res = await generateArtifact(supabase, { orgId: org.id, ...params })
      setResult(res)
      return res
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [org?.id, supabase])

  return { result, setResult, loading, error, generate }
}
