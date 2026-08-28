import React from 'react'
import { Navigate } from 'react-router'
import { useProfile } from '../../lib/profile-context'
import { workspaceModeGateDecision } from '../../lib/active-org'
import { pendingSessionIdentityOrgId } from '../../lib/session-identity-guard'

// Gate for the Investor Intel mode. Access is data-driven, NOT slug-gated to
// any customer. Launch: the active workspace must be product_mode === 'intel'.
// A later phase layers entitlement (`get_effective_limit(org_id,'intel.enabled')`)
// so a content org can also be granted Intel by plan/override.
export default function RequireIntelMode({ children }) {
  const { productMode, profileLoading } = useProfile()
  const gateDecision = workspaceModeGateDecision({
    pendingOrgId: pendingSessionIdentityOrgId(),
    productMode,
    routeMode: 'intel',
  })

  if (profileLoading || gateDecision === 'hold') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent)]" />
      </div>
    )
  }

  if (gateDecision === 'redirect') {
    // Not in an Intel workspace yet — send them to the trial-start entry, which
    // either switches into an existing Intel workspace or offers the free trial.
    return <Navigate to="/intel/start" replace />
  }

  return children
}
