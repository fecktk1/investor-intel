// IntelUpgradePage — paid checkout for Investor Intel tiers.
//
// Mounted at /intel/upgrade OUTSIDE RequireAuth's payment gate (like
// /reactivate) so EXPIRED trial workspaces can reach it and pay. Works for
// active trials too (upgrade early), and is where every
// intel_limit_reached:* error sends people.
//
// Card path: FluidPay Tokenizer — the mount/submit mechanics are copied from
// ReactivatePage verbatim (cents at mount, dollars-string at submit(),
// submissionHandlerRef, single-use tokens, token_expired remount), then POSTs
// to the intel-subscribe edge function which validates the amount
// server-side, charges, and activates synchronously.
//
// Crypto path: Helio widget. The paylink id comes from intel-subscribe
// (intent: 'helio_config') so paylink IDs stay server-side; the widget embeds
// additionalJSON { intel_org_id } and the helio-webhook activates the org
// after validating paylink → tier, amount, and signature. The page polls the
// org row until the tier lands.
//
// Display prices here MUST stay in sync with intel-subscribe's
// INTEL_PLAN_PRICING_CENTS (server truth), InvestorLandingPage, and
// docs/reference/pricing.md.

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, Loader2, ShieldCheck, CreditCard, CheckCircle2, Coins, Star,
} from 'lucide-react'
import PublicNav from '../../components/PublicNav'
import SEO from '../../components/SEO'
import { useAuth } from '../../lib/auth-context'
import { useProfile } from '../../lib/profile-context'
import { createAuthenticatedClient } from '../../lib/supabase'

const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
const HELIO_NETWORK     = import.meta.env.VITE_HELIO_NETWORK || 'main'

const FLUIDPAY_ENABLED       = import.meta.env.VITE_FLUIDPAY_ENABLED === 'true'
const FLUIDPAY_PUBLIC_KEY    = import.meta.env.VITE_FLUIDPAY_PUBLIC_KEY || ''
const FLUIDPAY_BASE_URL      = import.meta.env.VITE_FLUIDPAY_BASE_URL || 'https://app.fluidpay.com'
const FLUIDPAY_TOKENIZER_SRC = import.meta.env.VITE_FLUIDPAY_TOKENIZER_SRC
  || 'https://app.fluidpay.com/tokenizer/tokenizer.js'

const HELIO_SCRIPT_SRC = 'https://embed.hel.io/assets/index-v1.js'

// Display copy of the server truth (intel-subscribe INTEL_PLAN_PRICING_CENTS).
const INTEL_TIERS = [
  {
    id: 'starter',
    label: 'Starter',
    priceCents: 999,
    popular: false,
    limits: { watchlist: 20, wallets: 3, breakdowns: 5, explains: 10, comparisons: 3, briefs: 1, alerts: 5, news: 5, portfolio: 1, follows: 5 },
  },
  {
    id: 'pro',
    label: 'Pro',
    priceCents: 2499,
    popular: true,
    limits: { watchlist: 100, wallets: 15, breakdowns: 25, explains: 50, comparisons: 15, briefs: 3, alerts: 50, news: 25, portfolio: 5, follows: 50 },
  },
  {
    id: 'elite',
    label: 'Elite',
    priceCents: 4999,
    popular: false,
    limits: { watchlist: 300, wallets: 50, breakdowns: 75, explains: 150, comparisons: 50, briefs: 10, alerts: 200, news: 100, portfolio: 20, follows: 200 },
  },
]

function loadTokenizerScript() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'))
  if (window.Tokenizer) return Promise.resolve()
  if (document.querySelector(`script[src="${FLUIDPAY_TOKENIZER_SRC}"]`)) {
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const tick = () => {
        if (window.Tokenizer) return resolve()
        if (Date.now() - start > 10000) return reject(new Error('tokenizer script timeout'))
        setTimeout(tick, 100)
      }
      tick()
    })
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = FLUIDPAY_TOKENIZER_SRC
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('failed to load secure card form'))
    document.body.appendChild(s)
  })
}

function loadHelioScript() {
  if (window.helioCheckout) return Promise.resolve()
  if (document.querySelector(`script[src="${HELIO_SCRIPT_SRC}"]`)) {
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const tick = () => {
        if (window.helioCheckout) return resolve()
        if (Date.now() - start > 10000) return reject(new Error('helio script timeout'))
        setTimeout(tick, 100)
      }
      tick()
    })
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.type = 'module'
    s.crossOrigin = ''
    s.src = HELIO_SCRIPT_SRC
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('failed to load helio script'))
    document.body.appendChild(s)
  })
}

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function formatCents(cents) {
  if (cents == null || Number.isNaN(Number(cents))) return '—'
  return `$${(Number(cents) / 100).toFixed(2)}`
}

export default function IntelUpgradePage() {
  const { t } = useTranslation('checkout')
  useEffect(() => { window.scrollTo(0, 0) }, [])

  const navigate = useNavigate()
  const { session } = useAuth() ?? {}
  const { org, profileLoading, paymentStatus, refreshProfile } = useProfile() ?? {}
  const [searchParams] = useSearchParams()

  // ?plan= preselects a tier (paid-intent funnel from /investors → /intel/signup).
  const [tierId, setTierId] = useState(() => {
    const p = searchParams.get('plan')
    return INTEL_TIERS.some((t2) => t2.id === p) ? p : 'pro'
  })
  const [method, setMethod] = useState('card') // 'card' | 'crypto'
  // 'form' → 'tokenizing' → 'paying' → 'success' (card)
  // 'form' → 'crypto_paying' → 'crypto_confirming' → 'success' (crypto)
  const [step, setStep] = useState('form')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [networkMismatch, setNetworkMismatch] = useState(false)

  const [billing, setBilling] = useState({
    line1: '', line2: '', city: '', state: '', postal_code: '', country: 'US',
  })

  // Tokenizer state — same machine as ReactivatePage.
  const [tokenizerReady, setTokenizerReady] = useState(false)
  const [tokenizerStatus, setTokenizerStatus] = useState('idle')
  const [feeSnapshot, setFeeSnapshot] = useState(null)
  const [feeStatus, setFeeStatus] = useState('idle')
  const [cardFeeAck, setCardFeeAck] = useState(false)
  const tokenizerRef = useRef(null)
  const tokenizerInstanceRef = useRef(null)
  const submissionHandlerRef = useRef(null)
  // One attempt id per submit click. Seeds the server's deterministic
  // FluidPay idempotency keys so transport-level duplicates of the SAME
  // submission dedupe, while a fresh click (e.g. retry after a decline) is a
  // fresh attempt.
  const attemptIdRef = useRef(null)

  const helioWidgetRef = useRef(null)
  const pollTimerRef = useRef(null)

  const tier = INTEL_TIERS.find((p) => p.id === tierId) ?? INTEL_TIERS[1]
  const baseAmountCents = tier.priceCents
  const currentTier = org?.plan_overrides?.intel_tier ?? null
  const isIntelOrg = org?.product_mode === 'intel'

  // ── Tokenizer mount (copied from ReactivatePage; amount = tier price) ──
  const mountTokenizer = useCallback(async () => {
    if (!FLUIDPAY_ENABLED || !FLUIDPAY_PUBLIC_KEY || !isIntelOrg) return
    if (!tokenizerRef.current) return

    setTokenizerStatus('loading')
    setTokenizerReady(false)
    setCardFeeAck(false)
    setError(null)
    try {
      await loadTokenizerScript()
    } catch (e) {
      setTokenizerStatus('idle')
      setError(`Could not load secure card form: ${e?.message || 'unknown error'}`)
      return
    }
    if (!window.Tokenizer) {
      setTokenizerStatus('idle')
      setError('Secure card form failed to initialize.')
      return
    }

    if (tokenizerInstanceRef.current?.destroy) {
      try { tokenizerInstanceRef.current.destroy() } catch (_) { /* ignore */ }
    }
    tokenizerRef.current.innerHTML = ''

    setFeeStatus('calculating')
    setFeeSnapshot(null)

    try {
      const settings = {
        billing: { show: false },
        payment: {
          calculateFees: true,
          types: ['card'],
        },
      }
      const instance = new window.Tokenizer({
        apikey: FLUIDPAY_PUBLIC_KEY,
        container: tokenizerRef.current,
        url: FLUIDPAY_BASE_URL,
        amount: baseAmountCents,
        settings,
        onLoad: () => { setTokenizerReady(true); setTokenizerStatus('ready') },
        validCard: (card) => {
          if (!card) return
          const requested  = Number(card.RequestedAmount ?? card.requested_amount ?? baseAmountCents)
          const serviceFee = Number(card.ServiceFee      ?? card.service_fee     ?? 0)
          const surcharge  = Number(card.Surcharge       ?? card.surcharge       ?? 0)
          const adjustment = card.PaymentAdjustment ?? card.payment_adjustment ?? null
          const disclosure = card.Disclosure ?? card.disclosure ?? ''
          const cardFee = surcharge > 0 ? surcharge : serviceFee
          const total = requested + cardFee
          setFeeSnapshot({
            requested_cents: requested,
            card_fee_cents: cardFee,
            service_fee_cents: serviceFee,
            surcharge_cents: surcharge,
            total_cents: total,
            disclosure,
            payment_adjustment: adjustment,
            raw: card,
          })
          setFeeStatus('calculated')
        },
        submission: (resp) => {
          const handler = submissionHandlerRef.current
          if (!handler) {
            setError('Card form not ready — please refresh and try again.')
            setStep('form')
            setSubmitting(false)
            return
          }
          handler(resp).catch((err) => {
            setError(err?.message || 'Tokenization failed')
            setStep('form')
            setSubmitting(false)
          })
        },
      })
      tokenizerInstanceRef.current = instance
    } catch (e) {
      setTokenizerStatus('idle')
      setError(`Tokenizer init failed: ${e?.message || 'unknown error'}`)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isIntelOrg, baseAmountCents])

  // Remount when the org is known, the card tab is active, or the tier
  // (and therefore the amount) changes.
  useEffect(() => {
    if (!profileLoading && org && isIntelOrg && method === 'card' && step === 'form') {
      mountTokenizer()
    }
  }, [profileLoading, org, isIntelOrg, method, tierId, step, mountTokenizer])

  useEffect(() => {
    submissionHandlerRef.current = handleTokenizerSubmission
  })

  useEffect(() => () => { if (pollTimerRef.current) clearInterval(pollTimerRef.current) }, [])

  // ── card: tokenized → POST intel-subscribe ─────────────────
  async function handleTokenizerSubmission(resp) {
    if (!resp || resp.status !== 'success' || !resp.token) {
      const msg = resp?.message || resp?.error || 'Card validation failed'
      setError(typeof msg === 'string' ? msg : 'Card validation failed')
      setTokenizerStatus('ready')
      setStep('form')
      setSubmitting(false)
      return
    }

    setStep('paying')
    setTokenizerStatus('submitting')

    const disclosure = feeSnapshot?.disclosure ?? ''
    const disclosureHash = await sha256Hex(disclosure)

    const baseCents  = baseAmountCents
    const feeCents   = Number(feeSnapshot?.card_fee_cents ?? 0)
    const totalCents = Number(feeSnapshot?.total_cents ?? (baseCents + feeCents))

    const accessToken = session?.access_token
    if (!accessToken) {
      setError('Your session expired. Sign back in and try again.')
      setStep('form')
      setSubmitting(false)
      return
    }

    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/intel-subscribe`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          org_id: org.id,
          tier: tier.id,
          attempt_id: attemptIdRef.current,
          token: resp.token,
          billing_address: {
            line1: billing.line1.trim(),
            line2: billing.line2.trim(),
            city: billing.city.trim(),
            state: billing.state.trim(),
            postal_code: billing.postal_code.trim(),
            country: billing.country.trim().toUpperCase(),
          },
          card_fee_acknowledged: true,
          disclosure_hash: disclosureHash,
          base_amount_cents: baseCents,
          card_fee_amount_cents: feeCents,
          total_amount_cents: totalCents,
          fee_disclosure: disclosure || null,
          fluidpay_fee_snapshot: {
            requested_amount: feeSnapshot?.requested_cents ?? null,
            service_fee: feeSnapshot?.service_fee_cents ?? null,
            surcharge: feeSnapshot?.surcharge_cents ?? null,
            total_amount: feeSnapshot?.total_cents ?? null,
            payment_adjustment: feeSnapshot?.payment_adjustment ?? null,
          },
        }),
      })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        if (data?.error === 'token_expired') {
          setError('Your card session timed out. Please re-enter your card details.')
          setTokenizerStatus('retrying')
          setStep('form')
          setSubmitting(false)
          await mountTokenizer()
          return
        }
        const msg = data?.error || data?.msg || `Payment failed (${res.status})`
        throw new Error(typeof msg === 'string' ? msg : 'Payment failed')
      }

      setStep('success')
      setSubmitting(false)
      try { refreshProfile?.() } catch { /* best effort */ }
      setTimeout(() => navigate('/intel', { replace: true }), 1800)
    } catch (err) {
      setError(err?.message || 'Something went wrong')
      setStep('form')
      setSubmitting(false)
      setTokenizerStatus('ready')
    }
  }

  async function handleCardSubmit(e) {
    e.preventDefault()
    setError(null)
    if (!FLUIDPAY_ENABLED) {
      setError('Card payment is not enabled in this environment.')
      return
    }
    if (!cardFeeAck) {
      setError('Please acknowledge the card processing fee before continuing.')
      return
    }
    if (feeStatus !== 'calculated' || !feeSnapshot) {
      setError('Please complete the card details so we can confirm the fee.')
      return
    }
    if (!billing.line1 || !billing.city || !billing.state || !billing.postal_code || !billing.country) {
      setError('Please complete your billing address (used for fraud protection).')
      return
    }
    if (!tokenizerInstanceRef.current || !tokenizerReady) {
      setError('Card form is still loading — try again in a moment.')
      return
    }

    attemptIdRef.current = crypto.randomUUID()
    setSubmitting(true)
    setStep('tokenizing')
    try {
      const dollarStr = (baseAmountCents / 100).toFixed(2)
      tokenizerInstanceRef.current.submit(dollarStr)
    } catch (err) {
      setError(err?.message || 'Could not submit card details')
      setStep('form')
      setSubmitting(false)
    }
  }

  // ── crypto: fetch paylink config → mount Helio widget ──────
  async function handleCryptoStart() {
    setError(null)
    setSubmitting(true)
    const accessToken = session?.access_token
    if (!accessToken) {
      setError('Your session expired. Sign back in and try again.')
      setSubmitting(false)
      return
    }
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/intel-subscribe`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ org_id: org.id, tier: tier.id, intent: 'helio_config' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data?.error || `Could not load crypto checkout (${res.status})`)
      }
      if (data.network !== HELIO_NETWORK) {
        setNetworkMismatch(true)
        setSubmitting(false)
        return
      }

      setStep('crypto_paying')
      await loadHelioScript()
      requestAnimationFrame(() => {
        if (!helioWidgetRef.current || !window.helioCheckout) {
          setError('Could not load checkout widget. Please refresh and try again.')
          setStep('form')
          setSubmitting(false)
          return
        }
        try {
          window.helioCheckout(helioWidgetRef.current, {
            paylinkId: data.paylink_id,
            network: HELIO_NETWORK,
            primaryPaymentMethod: 'crypto',
            showPayWithCard: false,
            theme: { themeMode: 'dark' },
            primaryColor: '#e6b04b',
            neutralColor: '#a3a3a3',
            display: 'inline',
            additionalJSON: {
              // Routing key for helio-webhook's Intel branch. The TIER is
              // derived server-side from the paid paylink, never from here.
              intel_org_id: org.id,
            },
            onStartPayment: () => { /* UI already in crypto_paying */ },
            onSuccess: () => { startActivationPoll() },
            onPending: () => { /* on-chain confirmation in flight; stay here */ },
            onError: (ev) => {
              const msg = (ev && (ev.message || ev.errorMessage)) || 'Payment failed'
              setError(typeof msg === 'string' ? msg : 'Payment failed')
              setStep('form')
              setSubmitting(false)
            },
            onCancel: () => {
              setStep('form')
              setSubmitting(false)
            },
          })
        } catch (err) {
          setError(err?.message || 'Could not initialize checkout')
          setStep('form')
          setSubmitting(false)
        }
      })
    } catch (err) {
      setError(err?.message || 'Something went wrong')
      setStep('form')
      setSubmitting(false)
    }
  }

  // After Helio reports success, the webhook activates the org. Poll the org
  // row (same org_members join RLS path profile-context uses) until
  // plan_overrides.intel_tier lands, then enter the app.
  function startActivationPoll() {
    setStep('crypto_confirming')
    const accessToken = session?.access_token
    const userId = session?.user?.id
    if (!accessToken || !userId || !org?.id) return
    const db = createAuthenticatedClient(accessToken)
    const startedAt = Date.now()
    if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    pollTimerRef.current = setInterval(async () => {
      try {
        const { data } = await db
          .from('org_members')
          .select('org:orgs(plan_overrides, trial_ends_at, payment_required_since)')
          .eq('user_id', userId)
          .eq('org_id', org.id)
          .maybeSingle()
        const activatedTier = data?.org?.plan_overrides?.intel_tier
        if (activatedTier && !data?.org?.trial_ends_at && !data?.org?.payment_required_since) {
          clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
          setStep('success')
          try { refreshProfile?.() } catch { /* best effort */ }
          setTimeout(() => navigate('/intel', { replace: true }), 1800)
        }
      } catch { /* keep polling */ }
      // Webhook lag is normally seconds. Past 2 minutes, stop burning
      // requests — the payment hint below tells them to refresh.
      if (Date.now() - startedAt > 120000 && pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }, 2500)
  }

  const sharedFieldsFilled =
    !!billing.line1 && !!billing.city && !!billing.state && !!billing.postal_code && !!billing.country
  const canSubmitCard =
    !submitting &&
    sharedFieldsFilled &&
    cardFeeAck &&
    tokenizerReady &&
    feeStatus === 'calculated'

  // ── guards (session before profileLoading — see ReactivatePage note) ──
  if (!session?.user) {
    return (
      <div className="min-h-screen bg-black text-white">
        <PublicNav />
        <div className="max-w-xl mx-auto px-6 py-24 text-center">
          <h1 className="text-2xl font-bold mb-3">
            {t('reactivate.signin_required.title', { defaultValue: 'Sign in required' })}
          </h1>
          <p className="text-sm text-gray-400 mb-6">
            {t('intel_upgrade.signin_body', { defaultValue: 'Please sign in to manage your Investor Intel plan.' })}
          </p>
          <Link
            to={`/login?next=${encodeURIComponent(`/intel/upgrade${tierId !== 'pro' ? `?plan=${tierId}` : ''}`)}`}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--accent)] text-[oklch(22%_0.02_80)] text-sm font-semibold hover:bg-[var(--accent-hi)]"
          >
            {t('completed.sign_in', { defaultValue: 'Sign in' })}
          </Link>
        </div>
      </div>
    )
  }

  if (profileLoading) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[var(--accent)]" />
      </div>
    )
  }

  if (!org) {
    return (
      <div className="min-h-screen bg-black text-white">
        <PublicNav />
        <div className="max-w-xl mx-auto px-6 py-24 text-center">
          <h1 className="text-2xl font-bold mb-3">
            {t('intel_upgrade.no_org_title', { defaultValue: 'No workspace on file' })}
          </h1>
          <p className="text-sm text-gray-400 mb-6">
            {t('intel_upgrade.no_org_body', { defaultValue: "We couldn't find an Investor Intel workspace for your account. Start with the free trial." })}
          </p>
          <Link to="/intel/start" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--accent)] text-[oklch(22%_0.02_80)] text-sm font-semibold hover:bg-[var(--accent-hi)]">
            {t('intel_upgrade.no_org_cta', { defaultValue: 'Start free trial' })}
          </Link>
        </div>
      </div>
    )
  }

  // Content-app orgs belong on the content reactivation path.
  if (!isIntelOrg) {
    return <NavigateToReactivate />
  }

  if (step === 'success') {
    return (
      <div className="min-h-screen bg-black text-white">
        <SEO title={t('intel_upgrade.seo_title', { defaultValue: 'Upgrade Investor Intel' })} path="/intel/upgrade" noindex />
        <PublicNav />
        <div className="max-w-lg mx-auto px-6 py-20 text-center">
          <CheckCircle2 className="h-12 w-12 mx-auto text-[var(--accent)] mb-5" />
          <h1 className="text-3xl font-black tracking-tight mb-3">
            {t('intel_upgrade.success_title', { defaultValue: 'Welcome to {{tier}}', tier: tier.label })}
          </h1>
          <p className="text-sm text-gray-400 mb-2">
            {t('intel_upgrade.success_body', { defaultValue: 'Payment received and your workspace is unlocked. Taking you to Market Pulse…' })}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <SEO title={t('intel_upgrade.seo_title', { defaultValue: 'Upgrade Investor Intel' })} path="/intel/upgrade" noindex />
      <PublicNav />
      <div className="max-w-3xl mx-auto px-6 py-12">
        {paymentStatus === 'trial' && (
          <Link
            to="/intel"
            className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 mb-6 transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('intel_upgrade.back_to_app', { defaultValue: 'Back to app' })}
          </Link>
        )}

        <div className="mb-8">
          <p className="text-xs font-semibold text-[var(--accent)] uppercase tracking-[0.2em] mb-2">
            {t('intel_upgrade.eyebrow', { defaultValue: 'Investor Intel' })}
          </p>
          <h1 className="text-3xl font-black text-white mb-1.5 tracking-tight leading-[1.1]">
            {t('intel_upgrade.title', { defaultValue: 'Choose your plan' })}
          </h1>
          <p className="text-sm text-gray-400">
            {paymentStatus === 'trial'
              ? t('intel_upgrade.subtitle_trial', { defaultValue: 'Upgrade any time. Everything you set up in your trial carries over.' })
              : t('intel_upgrade.subtitle_expired', { defaultValue: 'Your trial has ended. Your data is preserved. Pick a plan to get back in.' })}
          </p>
          {currentTier && currentTier !== 'trial' && (
            <p className="text-xs text-gray-500 mt-2">
              {t('intel_upgrade.current_tier', { defaultValue: 'Current tier: {{tier}}', tier: currentTier })}
            </p>
          )}
        </div>

        {/* tier cards */}
        <div className="grid sm:grid-cols-3 gap-3 mb-8">
          {INTEL_TIERS.map((p) => {
            const active = p.id === tierId
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => { setTierId(p.id); setError(null) }}
                disabled={step !== 'form'}
                className={`relative text-left rounded-2xl border p-4 transition-colors ${
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent)]/5'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-1)] hover:border-gray-600'
                } disabled:opacity-60`}
              >
                {p.popular && (
                  <span className="absolute -top-2.5 left-4 inline-flex items-center gap-1 rounded-full bg-[var(--accent)] px-2 py-0.5 text-[10px] font-bold text-[oklch(22%_0.02_80)]">
                    <Star className="h-2.5 w-2.5" />
                    {t('intel_upgrade.popular', { defaultValue: 'Most popular' })}
                  </span>
                )}
                <p className="text-sm font-bold text-white mb-1">{p.label}</p>
                <p className="text-2xl font-black text-white mb-3">
                  {formatCents(p.priceCents)}
                  <span className="text-xs font-medium text-gray-500">{t('intel_upgrade.per_month', { defaultValue: '/mo' })}</span>
                </p>
                <ul className="space-y-1 text-[11px] text-gray-400">
                  <li>{t('intel_upgrade.feat_breakdowns', { defaultValue: '{{n}} AI breakdowns / day', n: p.limits.breakdowns })}</li>
                  <li>{t('intel_upgrade.feat_explains', { defaultValue: '{{n}} Explain This answers / day', n: p.limits.explains })}</li>
                  <li>{t('intel_upgrade.feat_briefs', { defaultValue: '{{n}} daily briefs / day', n: p.limits.briefs })}</li>
                  <li>{t('intel_upgrade.feat_alerts', { defaultValue: '{{n}} active alerts', n: p.limits.alerts })}</li>
                  <li>{t('intel_upgrade.feat_watchlist', { defaultValue: '{{n}} watchlist items', n: p.limits.watchlist })}</li>
                  <li>{t('intel_upgrade.feat_portfolio', { defaultValue: '{{n}} synced portfolio wallets', n: p.limits.portfolio })}</li>
                  <li>{t('intel_upgrade.feat_comparisons', { defaultValue: '{{n}} compares / day', n: p.limits.comparisons })}</li>
                  <li>{t('intel_upgrade.feat_follows', { defaultValue: '{{n}} narrative follows', n: p.limits.follows })}</li>
                </ul>
              </button>
            )
          })}
        </div>

        <p className="text-center text-xs text-gray-500 -mt-5 mb-8">
          {t('intel_upgrade.included_products', { defaultValue: 'Every plan includes Narrative Radar, the Markets terminal, Thesis Journal, Compare, DeFi, Wallet Watch, Daily Brief, and explainable AI — these limits just scale with your tier.' })}
        </p>

        {/* payment method tabs */}
        <div className="flex items-center gap-2 mb-5">
          <button
            type="button"
            onClick={() => { setMethod('card'); setStep('form'); setError(null); setSubmitting(false) }}
            disabled={step !== 'form' && method !== 'card'}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold border transition-colors ${
              method === 'card'
                ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10'
                : 'border-gray-700 text-gray-400 hover:border-gray-500'
            }`}
          >
            <CreditCard className="h-3.5 w-3.5" />
            {t('intel_upgrade.pay_card', { defaultValue: 'Pay by card' })}
          </button>
          <button
            type="button"
            onClick={() => { setMethod('crypto'); setStep('form'); setError(null); setSubmitting(false) }}
            disabled={step !== 'form' && method !== 'crypto'}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold border transition-colors ${
              method === 'crypto'
                ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10'
                : 'border-gray-700 text-gray-400 hover:border-gray-500'
            }`}
          >
            <Coins className="h-3.5 w-3.5" />
            {t('intel_upgrade.pay_crypto', { defaultValue: 'Pay with crypto' })}
          </button>
        </div>

        <p className="text-[11px] text-gray-500 mb-5 -mt-2">
          {t('intel_upgrade.crypto_fee_note', { defaultValue: 'Paying by card adds a processing fee. Pay with crypto (USDC, ETH, or SOL) to skip it.' })}
        </p>

        {networkMismatch && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300 mb-5">
            {t('intel_upgrade.network_mismatch', {
              defaultValue: 'The checkout server and the storefront are on different payment networks. Please contact support@thecontentforge.io.',
            })}
          </div>
        )}

        {/* ── card branch ── */}
        {method === 'card' && (step === 'form' || step === 'tokenizing' || step === 'paying') && (
          <form
            onSubmit={handleCardSubmit}
            className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-1)] p-6 space-y-5"
          >
            <div className="space-y-4 rounded-xl border border-gray-800/80 bg-black/30 p-4">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-[var(--accent)]" />
                <p className="text-xs font-semibold text-gray-300">
                  {t('reactivate.form.card_payment_heading', { defaultValue: 'Card payment' })}
                </p>
                <span className="text-[10px] text-gray-600">
                  {t('reactivate.form.pci_note', { defaultValue: 'PCI-secure card iframe' })}
                </span>
              </div>

              <div className="space-y-3">
                <p className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold">
                  {t('reactivate.form.billing_heading', { defaultValue: 'Billing address' })}
                </p>
                <div>
                  <label className="block text-[11px] text-gray-500 mb-1">
                    {t('reactivate.form.address_line1', { defaultValue: 'Address line 1' })}
                  </label>
                  <input
                    type="text" required
                    value={billing.line1}
                    onChange={(e) => setBilling((b) => ({ ...b, line1: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-black border border-gray-700 focus:border-[var(--accent)] focus:outline-none text-sm text-white"
                    placeholder="123 Main St"
                    autoComplete="address-line1"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-gray-500 mb-1">
                    {t('reactivate.form.address_line2', { defaultValue: 'Address line 2 (optional)' })}
                  </label>
                  <input
                    type="text"
                    value={billing.line2}
                    onChange={(e) => setBilling((b) => ({ ...b, line2: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-black border border-gray-700 focus:border-[var(--accent)] focus:outline-none text-sm text-white"
                    placeholder={t('reactivate.form.address_line2_placeholder', { defaultValue: 'Apt, suite, etc.' })}
                    autoComplete="address-line2"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-gray-500 mb-1">
                      {t('reactivate.form.city', { defaultValue: 'City' })}
                    </label>
                    <input
                      type="text" required
                      value={billing.city}
                      onChange={(e) => setBilling((b) => ({ ...b, city: e.target.value }))}
                      className="w-full px-3 py-2 rounded-lg bg-black border border-gray-700 focus:border-[var(--accent)] focus:outline-none text-sm text-white"
                      autoComplete="address-level2"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-gray-500 mb-1">
                      {t('reactivate.form.state', { defaultValue: 'State / Region' })}
                    </label>
                    <input
                      type="text" required
                      value={billing.state}
                      onChange={(e) => setBilling((b) => ({ ...b, state: e.target.value }))}
                      className="w-full px-3 py-2 rounded-lg bg-black border border-gray-700 focus:border-[var(--accent)] focus:outline-none text-sm text-white"
                      autoComplete="address-level1"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-gray-500 mb-1">
                      {t('reactivate.form.postal_code', { defaultValue: 'Postal code' })}
                    </label>
                    <input
                      type="text" required
                      value={billing.postal_code}
                      onChange={(e) => setBilling((b) => ({ ...b, postal_code: e.target.value }))}
                      className="w-full px-3 py-2 rounded-lg bg-black border border-gray-700 focus:border-[var(--accent)] focus:outline-none text-sm text-white"
                      autoComplete="postal-code"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-gray-500 mb-1">
                      {t('reactivate.form.country', { defaultValue: 'Country' })}
                    </label>
                    <input
                      type="text" required maxLength={2}
                      value={billing.country}
                      onChange={(e) => setBilling((b) => ({ ...b, country: e.target.value.toUpperCase() }))}
                      className="w-full px-3 py-2 rounded-lg bg-black border border-gray-700 focus:border-[var(--accent)] focus:outline-none text-sm text-white uppercase"
                      placeholder="US"
                      autoComplete="country"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold">
                  {t('reactivate.form.card_details_heading', { defaultValue: 'Card details' })}
                </p>
                <div
                  ref={tokenizerRef}
                  id="fluidpay-cc-container"
                  className="min-h-[200px] rounded-lg border border-gray-700 bg-black p-3"
                />
                {tokenizerStatus === 'loading' && (
                  <p className="text-[11px] text-gray-500 flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" />{' '}
                    {t('reactivate.form.tokenizer_loading', { defaultValue: 'Loading secure card form…' })}
                  </p>
                )}
                {tokenizerStatus === 'retrying' && (
                  <p className="text-[11px] text-yellow-400">
                    {t('reactivate.form.tokenizer_retrying', {
                      defaultValue: 'Card session refreshed — please re-enter card details.',
                    })}
                  </p>
                )}
              </div>

              <FeeSummary baseCents={baseAmountCents} feeStatus={feeStatus} feeSnapshot={feeSnapshot} />

              <label className="flex items-start gap-2.5 cursor-pointer text-xs text-gray-400 leading-relaxed">
                <input
                  type="checkbox"
                  checked={cardFeeAck}
                  onChange={(e) => setCardFeeAck(e.target.checked)}
                  disabled={feeStatus !== 'calculated'}
                  className="mt-0.5 h-4 w-4 rounded border-gray-600 bg-black text-[var(--accent)] focus:ring-[var(--accent)]"
                />
                <span>
                  {t('reactivate.form.card_fee_ack', {
                    defaultValue: 'I understand a card processing fee is added when paying by card.',
                  })}
                  {feeSnapshot?.disclosure && (
                    <span className="block mt-1 text-[11px] text-gray-500 italic">{feeSnapshot.disclosure}</span>
                  )}
                </span>
              </label>
            </div>

            {error && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={!canSubmitCard}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold bg-[var(--accent)] hover:bg-[var(--accent-hi)] text-[oklch(22%_0.02_80)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {step === 'tokenizing'
                    ? t('reactivate.submit.securing', { defaultValue: 'Securing your card…' })
                    : t('intel_upgrade.submit_processing', { defaultValue: 'Processing payment…' })}
                </>
              ) : (
                <>
                  <CreditCard className="h-4 w-4" />
                  {(() => {
                    const rawTotal = feeSnapshot?.total_cents
                    if (rawTotal == null) {
                      return t('intel_upgrade.submit_idle', {
                        defaultValue: 'Subscribe to {{tier}}',
                        tier: tier.label,
                      })
                    }
                    return t('intel_upgrade.submit_pay', {
                      defaultValue: 'Pay {{amount}} and unlock {{tier}}',
                      amount: formatCents(rawTotal),
                      tier: tier.label,
                    })
                  })()}
                </>
              )}
            </button>
          </form>
        )}

        {/* ── crypto branch ── */}
        {method === 'crypto' && (
          <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-1)] p-6 space-y-4">
            {step === 'form' && (
              <>
                <p className="text-sm text-gray-400">
                  {t('intel_upgrade.crypto_note', {
                    defaultValue: 'Pay {{amount}}/month with USDC, ETH, or SOL via Helio. Non-refundable.',
                    amount: formatCents(baseAmountCents),
                  })}
                </p>
                {error && (
                  <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
                    {error}
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleCryptoStart}
                  disabled={submitting}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold bg-[var(--accent)] hover:bg-[var(--accent-hi)] text-[oklch(22%_0.02_80)] transition-colors disabled:opacity-50"
                >
                  {submitting
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Coins className="h-4 w-4" />}
                  {t('intel_upgrade.crypto_cta', {
                    defaultValue: 'Pay {{amount}} with crypto',
                    amount: formatCents(baseAmountCents),
                  })}
                </button>
              </>
            )}

            {(step === 'crypto_paying' || step === 'crypto_confirming') && (
              <>
                {step === 'crypto_confirming' && (
                  <div className="rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/10 p-3 text-xs text-[var(--accent)] flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('intel_upgrade.crypto_confirming', {
                      defaultValue: 'Payment received. Confirming and unlocking your plan…',
                    })}
                  </div>
                )}
                <div ref={helioWidgetRef} id="helioCheckoutContainer" className="min-h-[600px] p-3" />
                <p className="text-[11px] text-gray-600">
                  {t('intel_upgrade.crypto_hint', {
                    defaultValue: 'If you just paid, this page unlocks automatically within a few seconds. If nothing happens after a minute, refresh the page.',
                  })}
                </p>
              </>
            )}
          </div>
        )}

        <p className="text-[11px] text-gray-600 mt-6">
          {t('intel_upgrade.disclaimer', {
            defaultValue: 'Investor Intel is research software. It does not provide financial advice, and signals are not recommendations to buy or sell anything.',
          })}
        </p>
      </div>
    </div>
  )
}

// Content-app orgs land on the content reactivation flow instead.
function NavigateToReactivate() {
  const navigate = useNavigate()
  useEffect(() => { navigate('/reactivate', { replace: true }) }, [navigate])
  return null
}

function FeeSummary({ baseCents, feeStatus, feeSnapshot }) {
  const { t } = useTranslation('checkout')

  if (feeStatus === 'idle') {
    return (
      <div className="rounded-lg border border-gray-800 bg-black/40 p-3 text-[11px] text-gray-500">
        {t('reactivate.fee.idle', {
          defaultValue:
            'Subtotal: {{subtotal}}. Card processing fee will be calculated once you enter your card details.',
          subtotal: formatCents(baseCents),
        })}
      </div>
    )
  }
  if (feeStatus === 'calculating') {
    return (
      <div className="rounded-lg border border-gray-800 bg-black/40 p-3 text-[11px] text-gray-400 flex items-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin" />{' '}
        {t('reactivate.fee.calculating', { defaultValue: 'Calculating card processing fee…' })}
      </div>
    )
  }
  if (feeStatus === 'unavailable') {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-[11px] text-red-300">
        {t('reactivate.fee.unavailable', {
          defaultValue: 'Card processing fee unavailable. Please try a different card or contact support.',
        })}
      </div>
    )
  }
  const total = feeSnapshot?.total_cents ?? baseCents
  const fee = feeSnapshot?.card_fee_cents ?? 0

  return (
    <div className="rounded-lg border border-gray-800 bg-black/40 p-3 space-y-1.5 text-xs">
      <Row label={t('reactivate.fee.plan_subtotal', { defaultValue: 'Plan subtotal' })} value={formatCents(baseCents)} />
      <Row label={t('reactivate.fee.card_fee', { defaultValue: 'Card processing fee' })} value={formatCents(fee)} />
      <div className="h-px bg-gray-800 my-1" />
      <Row label={t('reactivate.fee.total_due', { defaultValue: 'Total due today' })} value={formatCents(total)} bold />
      <p className="text-[10px] text-gray-600 pt-1">
        {t('reactivate.fee.recurring', {
          defaultValue: 'Recurring: {{total}} per month until cancelled.',
          total: formatCents(total),
        })}
      </p>
    </div>
  )
}

function Row({ label, value, bold }) {
  return (
    <div className="flex items-center justify-between">
      <span className={bold ? 'text-white font-semibold' : 'text-gray-400'}>{label}</span>
      <span className={bold ? 'text-white font-semibold' : 'text-gray-300'}>{value}</span>
    </div>
  )
}
