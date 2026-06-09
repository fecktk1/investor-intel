import React, { useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Gauge, Mail, Lock, User, Eye, EyeOff, ArrowRight, CheckCircle2, Check } from 'lucide-react'
import { useAuth } from '../../lib/auth-context'
import PublicNav from '../../components/PublicNav'
import SEO from '../../components/SEO'
import IntelDisclaimer from '../components/IntelDisclaimer'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

// Display copy of the server truth (intel-subscribe INTEL_PLAN_PRICING_CENTS);
// must stay in sync with InvestorLandingPage and IntelUpgradePage.
const PAID_PLANS = {
  starter: { label: 'Starter', price: '$9.99' },
  pro: { label: 'Pro', price: '$24.99' },
  elite: { label: 'Elite', price: '$49.99' },
}

// Public account creation for the Investor Intel retail funnel. The marketing
// CTAs ("Start 7-day free trial") land here; existing users cross over to
// /login?next=/intel/start instead. Uses GoTrue's native email signup — the
// project requires email confirmation (mailer_autoconfirm off), so the normal
// path is: create account → confirmation email → link lands on
// /login?next=/intel/start with a session hash → auth-context stores the
// session → LoginPage forwards to /intel/start → start_intel_trial().
//
// Paid intent (?plan=starter|pro|elite from the pricing cards): same account
// flow, but the post-auth destination carries the plan so /intel/start
// bootstraps the workspace and forwards straight to /intel/upgrade checkout.
export default function IntelSignupPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { user, loading } = useAuth()
  const [searchParams] = useSearchParams()

  const planId = Object.prototype.hasOwnProperty.call(PAID_PLANS, searchParams.get('plan'))
    ? searchParams.get('plan')
    : null
  const plan = planId ? PAID_PLANS[planId] : null
  // Where a freshly authenticated account should land: the trial bootstrapper,
  // carrying the paid-plan intent when present.
  const postAuthNext = planId ? `/intel/start?plan=${planId}` : '/intel/start'

  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-500" />
      </div>
    )
  }

  // Already signed in (e.g. an existing customer clicked the landing CTA) —
  // account creation is done; go straight to the trial bootstrapper.
  if (user) return <Navigate to={postAuthNext} replace />

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (password.length < 8) {
      setError(t('signup.password_too_short', { defaultValue: 'Password must be at least 8 characters.' }))
      return
    }
    setSubmitting(true)
    try {
      // Same-device fallback: if the confirmation link's redirect_to is not in
      // the GoTrue allow-list, the user lands on the site root instead of
      // /login?next=…. ConsumePostAuthNext (App.jsx) reads this stash after the
      // session is established and forwards them to /intel/start anyway.
      try {
        localStorage.setItem('post_auth_next', JSON.stringify({ next: postAuthNext, exp: Date.now() + 60 * 60 * 1000 }))
      } catch { /* storage unavailable — non-fatal */ }

      const siteUrl = import.meta.env.VITE_SITE_URL || window.location.origin
      const redirectTo = `${siteUrl}/login?next=${encodeURIComponent(postAuthNext)}`
      const res = await fetch(`${SUPABASE_URL}/auth/v1/signup?redirect_to=${encodeURIComponent(redirectTo)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
        body: JSON.stringify({
          email: email.trim(),
          password,
          data: { full_name: fullName.trim() },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(
          data.msg || data.error_description || data.message
            || t('signup.error', { defaultValue: 'Could not create your account. Please try again.' }),
        )
      }

      // If the project ever enables autoconfirm, signup returns a session
      // directly — store it the same way wallet sign-in does and go start the
      // trial without an email round-trip.
      if (data.access_token && data.user) {
        localStorage.setItem('supabase_session', JSON.stringify({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          user: data.user,
        }))
        window.location.href = (import.meta.env.BASE_URL || '/') + 'intel/start'
        return
      }

      // Confirmation required (normal path). For an email that already has a
      // confirmed account GoTrue returns the same 200 shape and sends nothing
      // (anti-enumeration) — the hint below covers that case.
      setSent(true)
    } catch (err) {
      setError(err.message || t('signup.error', { defaultValue: 'Could not create your account. Please try again.' }))
    } finally {
      setSubmitting(false)
    }
  }

  const signInHref = `/login?next=${encodeURIComponent(postAuthNext)}`

  return (
    <div className="min-h-screen bg-black text-[var(--fg-1)]">
      <SEO title={t('signup.seo_title', { defaultValue: 'Create your Investor Intel account' })} path="/intel/signup" noindex />
      <PublicNav />

      <div className="max-w-md mx-auto px-6 py-14">
        <div className="card--raised p-7 space-y-5">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl grid place-items-center" style={{ background: 'var(--accent-tint)' }}>
              <Gauge className="h-6 w-6" style={{ color: 'var(--accent)' }} />
            </div>
            <div>
              <div className="eyebrow">{t('brand.name', { defaultValue: 'Investor Intel' })}</div>
              <h1 className="text-lg font-bold text-[var(--fg-1)]">
                {sent
                  ? t('signup.sent_title', { defaultValue: 'Check your email' })
                  : t('signup.title', { defaultValue: 'Create your account' })}
              </h1>
            </div>
          </div>

          {sent ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="h-5 w-5 mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
                <p className="text-[13px] text-[var(--fg-3)] leading-relaxed">
                  {t('signup.sent_body_prefix', { defaultValue: 'We sent a confirmation link to ' })}
                  <span className="text-[var(--fg-1)] font-medium">{email}</span>
                  {plan
                    ? t('signup.sent_body_suffix_plan', { defaultValue: '. Click it to activate your account and continue to checkout.' })
                    : t('signup.sent_body_suffix', { defaultValue: '. Click it to activate your account and start your 7-day free trial.' })}
                </p>
              </div>
              <p className="text-[12px] text-[var(--fg-4)] leading-relaxed">
                {t('signup.sent_hint', { defaultValue: 'Nothing arrived? Check your spam folder, or submit the form again to resend. If you already have an account, just sign in instead.' })}
              </p>
              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  onClick={() => { setSent(false); setError('') }}
                  className="text-xs text-[var(--fg-4)] hover:text-[var(--fg-2)] transition-colors"
                >
                  {t('signup.back', { defaultValue: 'Back' })}
                </button>
                <Link to={signInHref} className="text-xs text-brand-400 hover:text-brand-300 transition-colors">
                  {t('signup.sign_in', { defaultValue: 'Sign in' })}
                </Link>
              </div>
            </div>
          ) : (
            <>
              <p className="text-[13px] text-[var(--fg-3)] leading-relaxed">
                {plan
                  ? t('signup.plan_body', {
                      defaultValue: 'Create your account, then complete checkout to activate {{tier}} at {{price}}/mo. Pay by card or crypto.',
                      tier: plan.label,
                      price: plan.price,
                    })
                  : t('signup.body', { defaultValue: 'Your account unlocks the 7-day free trial of Investor Intel — full access, no card required.' })}
              </p>

              {error && <div className="card--flat p-3 text-[13px] text-red-400">{error}</div>}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-[var(--fg-3)] mb-1.5">{t('signup.name_label', { defaultValue: 'Name' })}</label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
                    <input
                      type="text"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      required
                      autoFocus
                      className="w-full pl-10 pr-4 py-2.5 card--flat text-sm text-[var(--fg-1)] placeholder-gray-500 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
                      placeholder={t('signup.name_placeholder', { defaultValue: 'Your name' })}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--fg-3)] mb-1.5">{t('signup.email_label', { defaultValue: 'Email' })}</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="w-full pl-10 pr-4 py-2.5 card--flat text-sm text-[var(--fg-1)] placeholder-gray-500 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
                      placeholder={t('signup.email_placeholder', { defaultValue: 'you@example.com' })}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--fg-3)] mb-1.5">{t('signup.password_label', { defaultValue: 'Password' })}</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
                    <input
                      type={showPw ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={8}
                      className="w-full pl-10 pr-10 py-2.5 card--flat text-sm text-[var(--fg-1)] placeholder-gray-500 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
                      placeholder={t('signup.password_placeholder', { defaultValue: 'Min. 8 characters' })}
                    />
                    <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                      {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <button type="submit" disabled={submitting} className="btn btn--primary w-full justify-center disabled:opacity-50">
                  {submitting
                    ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" />
                    : <>
                        {plan
                          ? t('signup.plan_cta', { defaultValue: 'Create account & continue to checkout' })
                          : t('signup.cta', { defaultValue: 'Create account & start free trial' })}
                        {' '}<ArrowRight className="h-4 w-4" />
                      </>}
                </button>
              </form>

              <div className="flex items-center justify-center gap-x-4 gap-y-1 flex-wrap text-[11px] text-[var(--fg-4)]">
                {(plan
                  ? [
                      `${plan.label} · ${plan.price}/mo`,
                      t('signup.trust_pay', { defaultValue: 'Pay by card or crypto' }),
                      t('signup.trust_cancel', { defaultValue: 'Cancel anytime' }),
                    ]
                  : [
                      t('signup.trust_trial', { defaultValue: '7-day free trial' }),
                      t('signup.trust_card', { defaultValue: 'No card required' }),
                      t('signup.trust_cancel', { defaultValue: 'Cancel anytime' }),
                    ]).map((x) => (
                  <span key={x} className="flex items-center gap-1">
                    <Check className="h-3 w-3" style={{ color: 'var(--accent)' }} /> {x}
                  </span>
                ))}
              </div>

              <p className="text-center text-xs text-[var(--fg-4)]">
                {t('signup.have_account', { defaultValue: 'Already have an account?' })}{' '}
                <Link to={signInHref} className="text-brand-400 hover:text-brand-300 transition-colors">
                  {t('signup.sign_in', { defaultValue: 'Sign in' })}
                </Link>
              </p>
            </>
          )}

          <IntelDisclaimer variant="block" />
        </div>
      </div>
    </div>
  )
}
