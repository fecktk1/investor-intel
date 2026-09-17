import React, { useEffect, useState, useCallback, useRef } from 'react'
import { Helmet } from 'react-helmet-async'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { Gauge, ArrowRight } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { startIntelTrial, startIntelFree } from '../lib/intel-api'
import IntelDisclaimer from '../components/IntelDisclaimer'
import { intelReturnPath } from '../lib/intel-return-path'

const PAID_PLANS = ['starter', 'pro', 'elite']

// Entry point for users who are NOT yet in an Investor Intel workspace. If they
// already have one, switch into it; otherwise offer the free trial. Rendered
// inside RequireAuth (but outside RequireIntelMode) so it can bootstrap the mode.
//
// Paid intent (?plan=starter|pro|elite, from the /investors pricing cards via
// /intel/signup): the workspace is bootstrapped automatically and the user is
// forwarded straight to /intel/upgrade with that tier preselected — payment
// activates the tier and clears the trial state.
export default function IntelStartPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { memberships, switchOrg, profileLoading } = useProfile()
  const { supabase } = useSupabase()
  const [searchParams] = useSearchParams()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const requestedPlan = searchParams.get('plan')
  const plan = PAID_PLANS.includes(requestedPlan) ? requestedPlan : null
  // Free intent (?plan=free, from /intel/signup?plan=free or from the free
  // action below). It opens a free membership and spends no trial.
  const wantsFree = requestedPlan === 'free'
  // Post-switch landing: checkout for paid intent, the workspace itself otherwise.
  const dest = plan ? `/intel/upgrade?plan=${plan}` : intelReturnPath(searchParams.get('next'))

  const existingIntel = (memberships || []).find((m) => m.org?.product_mode === 'intel')?.org

  useEffect(() => {
    if (!profileLoading && existingIntel) switchOrg(existingIntel.id, dest ? { to: dest } : undefined)
  }, [profileLoading, existingIntel, switchOrg, dest])

  const startTrial = useCallback(async () => {
    setBusy(true); setError(null)
    try {
      const orgId = await startIntelTrial(supabase, { trialDays: 7 })
      // Resolves true after it has started the reload into the new workspace.
      // A false answer means the switch was refused; the spinner must not
      // outlive that, or the page reads as stuck.
      const switched = await switchOrg(orgId, dest ? { to: dest } : undefined)
      if (switched === false) throw new Error('workspace_switch_failed')
    } catch (e) {
      setBusy(false)
      setError(
        e?.message === 'trial_already_used'
          ? t('start.already_used', { defaultValue: 'You have already used your Investor Intel trial.' })
          : t('start.error', { defaultValue: 'Could not start your trial. Please try again.' }),
      )
    }
  }, [supabase, switchOrg, dest, t])

  // The free membership. start_intel_free writes no trial guard and leaves no
  // payment deadline, so this neither spends the one 7-day trial nor creates a
  // workspace that can lapse. A user who already has an Investor Intel
  // workspace is handed that one back rather than given a second.
  const startFree = useCallback(async () => {
    setBusy(true); setError(null)
    try {
      const orgId = await startIntelFree(supabase)
      const switched = await switchOrg(orgId, dest ? { to: dest } : undefined)
      if (switched === false) throw new Error('workspace_switch_failed')
    } catch {
      setBusy(false)
      setError(t('start.free_error', { defaultValue: 'Could not open your free membership. Please try again.' }))
    }
  }, [supabase, switchOrg, dest, t])

  // Paid intent: no extra click — bootstrap the workspace as soon as we know
  // the user has none. Ref-guarded so StrictMode/re-renders can't double-fire
  // the one-per-identity trial RPC.
  const autoStartedRef = useRef(false)
  useEffect(() => {
    if (!plan || profileLoading || existingIntel || autoStartedRef.current) return
    autoStartedRef.current = true
    startTrial()
  }, [plan, profileLoading, existingIntel, startTrial])

  // Free intent: the same one-click bootstrap, guarded by the same ref so the
  // two paths can never both fire for one arrival.
  useEffect(() => {
    if (!wantsFree || profileLoading || existingIntel || autoStartedRef.current) return
    autoStartedRef.current = true
    startFree()
  }, [wantsFree, profileLoading, existingIntel, startFree])

  const loading = profileLoading || !!existingIntel || busy

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-6">
      <Helmet><title>{`${t('brand.name', { defaultValue: 'Investor Intel' })} · TheContentForge`}</title></Helmet>
      <div className="w-full max-w-md card--raised p-7 space-y-5">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl grid place-items-center" style={{ background: 'var(--accent-tint)' }}>
            <Gauge className="h-6 w-6" style={{ color: 'var(--accent)' }} />
          </div>
          <div>
            <div className="eyebrow">{t('brand.name', { defaultValue: 'Investor Intel' })}</div>
            <h1 className="text-lg font-bold text-[var(--fg-1)]">
              {plan
                ? t('start.plan_title', { defaultValue: 'Setting up your workspace' })
                : wantsFree
                  ? t('start.free_title', { defaultValue: 'Setting up your free workspace' })
                  : t('start.title', { defaultValue: 'Start your crypto intelligence workspace' })}
            </h1>
          </div>
        </div>

        <p className="text-[13px] text-[var(--fg-3)] leading-relaxed">
          {plan
            ? t('start.plan_body', { defaultValue: 'One moment. Creating your Investor Intel workspace and taking you to checkout.' })
            : t('start.body', { defaultValue: 'Research tokens, wallets, narratives, DeFi and execution quality, with clear, easy-to-understand explanations and risk context. 7-day free trial, no card required.' })}
        </p>

        {error && <div className="card--flat p-3 text-[13px] text-red-400">{error}</div>}

        {(plan || wantsFree) && !error ? (
          <div className="flex items-center justify-center py-1.5">
            <span className="animate-spin rounded-full h-5 w-5 border-b-2 border-[var(--accent)]" />
          </div>
        ) : (
          <div className="space-y-2">
            <button onClick={startTrial} disabled={loading} className="btn btn--primary w-full justify-center disabled:opacity-50">
              {loading
                ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" />
                : plan
                  ? <>{t('start.retry', { defaultValue: 'Try again' })} <ArrowRight className="h-4 w-4" /></>
                  : <>{t('start.cta', { defaultValue: 'Start 7-day free trial' })} <ArrowRight className="h-4 w-4" /></>}
            </button>
            {/* The free membership stands beside the trial, not behind it. It
                is also the way forward for someone who has already spent their
                one trial, which is the error this page reports just above. */}
            <button onClick={startFree} disabled={loading} className="btn btn--ghost w-full justify-center disabled:opacity-50">
              {t('start.free_cta', { defaultValue: 'Continue on the free tier' })}
            </button>
            <p className="text-[12px] text-[var(--fg-4)] leading-relaxed">
              {t('access.free_body', { defaultValue: 'Read the market boards, the regime figures and every recorded capture. No card, no trial clock.' })}
            </p>
          </div>
        )}

        <IntelDisclaimer variant="block" />
      </div>
    </div>
  )
}
