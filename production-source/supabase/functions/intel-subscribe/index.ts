// intel-subscribe — authenticated card checkout for Investor Intel tiers.
//
// An Intel buyer ALREADY has an org (created by start_intel_trial), so this
// does NOT touch pending_signups / claim_pending_signup* (that path creates a
// brand-new org and its plan_id CHECK doesn't allow 'elite'). Instead it
// mirrors the two production-proven FluidPay flows:
//   * auth/org-membership/server-amount pattern from fluidpay-reactivate
//   * the 3-step FluidPay sequence from fluidpay-create-subscription:
//       1. POST /api/vault/customer            (create customer + attach token)
//       2. POST /api/transaction               (immediate first-month sale)
//       3. POST /api/recurring/subscription    (months 2+, next_bill_date +28d)
//     The recurring subscription bills ~28 days out, so the immediate sale is
//     the ONLY charge today — no double-charge path.
// then activates via the intel_activate_subscription RPC (migration 206),
// which is idempotent on the sale transaction id and fails closed.
//
// Body shape (PRICES ARE NEVER TRUSTED FROM THE CLIENT — base_amount_cents
// must equal the server's INTEL_PLAN_PRICING_CENTS for the tier):
//   {
//     org_id, tier ('starter'|'pro'|'elite'), attempt_id (uuid),
//     token, billing_address: { line1, line2, city, state, postal_code, country },
//     card_fee_acknowledged, disclosure_hash,
//     base_amount_cents, card_fee_amount_cents, total_amount_cents,
//     fee_disclosure, fluidpay_fee_snapshot
//   }
//
// attempt_id is generated once per checkout attempt by the frontend and seeds
// the deterministic FluidPay idempotency keys, so a network-level retry of the
// SAME submission dedupes inside FluidPay's idempotency window (same role the
// signup_token plays in fluidpay-create-subscription).
//
// Required env (server-only):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY        (auto)
//   FLUIDPAY_BASE_URL, FLUIDPAY_PRIVATE_API_KEY, FLUIDPAY_ENV
//   FLUIDPAY_PROCESSOR_ID                          (optional)
//   FLUIDPAY_PLAN_ID_INTEL_STARTER_MONTHLY
//   FLUIDPAY_PLAN_ID_INTEL_PRO_MONTHLY
//   FLUIDPAY_PLAN_ID_INTEL_ELITE_MONTHLY

import { createClient } from 'npm:@supabase/supabase-js@2'
import { checkAndIncrement, hashedIpKey } from '../_shared/rate-limit.ts'

const ALLOWED_ORIGINS = new Set<string>([
  'https://thecontentforge.io',
  'https://www.thecontentforge.io',
  'http://localhost:5173',
  'http://localhost:5174',
])

function corsHeadersFor(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://thecontentforge.io'
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Vary': 'Origin',
  }
}

function json(data: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })
}

// Structured payment-step logging. Greppable in Supabase logs as
// [intel-subscribe]. NEVER receives secrets, card tokens, or full addresses.
function slog(step: string, detail: Record<string, unknown> = {}) {
  console.log(`[intel-subscribe] ${JSON.stringify({ step, ...detail })}`)
}

function isHexSha256(s: unknown): boolean {
  return typeof s === 'string' && /^[a-f0-9]{64}$/i.test(s)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// SERVER-SIDE PRICE TRUTH for Investor Intel (monthly only).
// Mirrored for display in src/intel/pages/IntelUpgradePage.jsx and
// src/pages/InvestorLandingPage.jsx — a price change must touch all three
// plus docs/reference/pricing.md.
const INTEL_PLAN_PRICING_CENTS: Record<string, { monthly: number }> = {
  starter: { monthly: 999 },   // $9.99
  pro:     { monthly: 2499 },  // $24.99
  elite:   { monthly: 4999 },  // $49.99
}

const INTEL_PLAN_ID_ENV: Record<string, string> = {
  starter: 'FLUIDPAY_PLAN_ID_INTEL_STARTER_MONTHLY',
  pro:     'FLUIDPAY_PLAN_ID_INTEL_PRO_MONTHLY',
  elite:   'FLUIDPAY_PLAN_ID_INTEL_ELITE_MONTHLY',
}

// Helio paylink resolution mirrors start-checkout's resolvePaylinkId:
// HELIO_NETWORK='test' prefers the *_TEST paylink and falls back to prod.
// Paylink IDs stay server-side; the page fetches them via intent='helio_config'.
function resolveIntelPaylinkId(tier: string, network: string): string | null {
  const isTest = network === 'test'
  const names: Record<string, [string, string]> = {
    starter: ['HELIO_PAYLINK_INTEL_STARTER_TEST', 'HELIO_PAYLINK_INTEL_STARTER'],
    pro:     ['HELIO_PAYLINK_INTEL_PRO_TEST',     'HELIO_PAYLINK_INTEL_PRO'],
    elite:   ['HELIO_PAYLINK_INTEL_ELITE_TEST',   'HELIO_PAYLINK_INTEL_ELITE'],
  }
  const pair = names[tier]
  if (!pair) return null
  return (isTest ? Deno.env.get(pair[0]) : null) ?? Deno.env.get(pair[1]) ?? null
}

// Same UUID-shaped deterministic key builder the existing FluidPay callers
// use (FluidPay validates idempotency_key strictly as a UUID).
function deterministicIdempotencyKey(seed: string, step: string): string {
  let stepHash = 5381
  for (let i = 0; i < step.length; i++) {
    stepHash = ((stepHash * 33) ^ step.charCodeAt(i)) >>> 0
  }
  const stepHex = stepHash.toString(16).padStart(12, '0').slice(0, 12)
  const tok = seed.replace(/-/g, '').padEnd(32, '0').slice(0, 32)
  const buf = tok.slice(0, 20) + stepHex
  return `${buf.slice(0, 8)}-${buf.slice(8, 12)}-${buf.slice(12, 16)}-${buf.slice(16, 20)}-${buf.slice(20, 32)}`
}

function ymdPlusDays(offsetDays: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offsetDays)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function billingDayOfMonth(): number {
  const day = new Date().getUTCDate()
  return Math.min(28, Math.max(1, day))
}

type AnyObj = Record<string, unknown>

function pickString(obj: AnyObj | null | undefined, ...paths: string[]): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  for (const path of paths) {
    let cur: unknown = obj
    for (const part of path.split('.')) {
      if (cur && typeof cur === 'object' && part in (cur as AnyObj)) {
        cur = (cur as AnyObj)[part]
      } else {
        cur = undefined
        break
      }
    }
    if (typeof cur === 'string' && cur.length) return cur
  }
  return undefined
}

type FluidPayResponse = {
  ok: boolean
  status: number
  data: Record<string, unknown> | null
  correlationId: string | null
  errorMsg: string | null
}

async function callFluidPay(opts: {
  baseUrl: string
  apiKey: string
  method: 'POST' | 'GET' | 'PUT' | 'DELETE'
  path: string
  body?: Record<string, unknown>
  idempotencyKey?: string
}): Promise<FluidPayResponse> {
  const headers: Record<string, string> = {
    'Authorization': opts.apiKey,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey

  const url = `${opts.baseUrl.replace(/\/$/, '')}${opts.path}`
  let res: Response
  try {
    res = await fetch(url, {
      method: opts.method,
      headers,
      body: opts.body
        ? JSON.stringify({ ...opts.body, idempotency_key: opts.idempotencyKey })
        : undefined,
    })
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: null,
      correlationId: null,
      errorMsg: `network_error: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  const correlationId = res.headers.get('x-correlation-id')
  let data: Record<string, unknown> | null = null
  try { data = await res.json() as Record<string, unknown> } catch { /* non-JSON */ }
  if (!res.ok) {
    const errorMsg = (data && (data as { msg?: string }).msg)
      ?? (data && (data as { error?: string }).error)
      ?? `http_${res.status}`
    return { ok: false, status: res.status, data, correlationId, errorMsg }
  }
  return { ok: true, status: res.status, data, correlationId, errorMsg: null }
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin')
  const headers = corsHeadersFor(origin)

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, headers)

  slog('request_received')

  // ── auth: real user JWT required ──────────────────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  if (!token) return json({ error: 'unauthorized' }, 401, headers)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

  const { data: userResult, error: userErr } = await supabase.auth.getUser(token)
  if (userErr || !userResult?.user?.id) {
    slog('auth_failed')
    return json({ error: 'invalid_token' }, 401, headers)
  }
  const userId = userResult.user.id

  const baseUrl = Deno.env.get('FLUIDPAY_BASE_URL') ?? ''
  const apiKey  = Deno.env.get('FLUIDPAY_PRIVATE_API_KEY') ?? ''
  if (!baseUrl || !apiKey) return json({ error: 'fluidpay_not_configured' }, 500, headers)

  const env = Deno.env.get('FLUIDPAY_ENV') ?? 'sandbox'
  if (env === 'sandbox' && !baseUrl.includes('sandbox.fluidpay.com')) {
    return json({ error: 'env_url_mismatch', env, baseUrl }, 500, headers)
  }
  if (env === 'production' && baseUrl.includes('sandbox.fluidpay.com')) {
    return json({ error: 'env_url_mismatch', env, baseUrl }, 500, headers)
  }

  // ── rate-limit ────────────────────────────────────────────
  try {
    const key = await hashedIpKey(req, 'intel-subscribe')
    const rl = await checkAndIncrement(supabase, key, 10, 60)
    if (!rl.ok) {
      return json({ error: 'rate_limited', retry_after: rl.retryAfter }, 429,
        { ...headers, 'Retry-After': String(rl.retryAfter) })
    }
  } catch (e) {
    console.warn('[intel-subscribe] rate-limit unavailable:', (e as Error)?.message ?? e)
  }

  let payload: Record<string, unknown>
  try {
    payload = await req.json() as Record<string, unknown>
  } catch {
    return json({ error: 'invalid_json' }, 400, headers)
  }

  // ── shape validation ──────────────────────────────────────
  const orgId = String(payload?.org_id ?? '').trim()
  if (!orgId || !UUID_RE.test(orgId)) return json({ error: 'invalid_org_id' }, 400, headers)

  const tier = String(payload?.tier ?? '').trim().toLowerCase()
  if (!INTEL_PLAN_PRICING_CENTS[tier]) return json({ error: 'invalid_tier' }, 400, headers)

  // ── intent: 'helio_config' — return the crypto paylink for this tier ──
  // (auth + membership + intel-org checks still apply, below the card-only
  // validation is skipped). The Helio WEBHOOK re-derives the tier from the
  // paylink the payment actually landed on, so this response is display/embed
  // config, not a trust boundary.
  const intent = String(payload?.intent ?? 'subscribe').trim().toLowerCase()

  const attemptId = String(payload?.attempt_id ?? '').trim()
  if (intent === 'subscribe' && !UUID_RE.test(attemptId)) return json({ error: 'invalid_attempt_id' }, 400, headers)

  // ── org + membership checks (both intents) ────────────────
  const { data: membership } = await supabase
    .from('org_members')
    .select('user_id, role')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!membership) return json({ error: 'not_a_member' }, 403, headers)

  const { data: orgRow } = await supabase
    .from('orgs')
    .select('id, product_mode, deleted_at, plan_overrides')
    .eq('id', orgId)
    .maybeSingle()
  if (!orgRow) return json({ error: 'org_not_found' }, 404, headers)
  if (orgRow.deleted_at) return json({ error: 'org_deleted' }, 409, headers)
  if (orgRow.product_mode !== 'intel') return json({ error: 'not_an_intel_org' }, 400, headers)

  slog('org_verified', { org_id: orgId, tier, intent })

  if (intent === 'helio_config') {
    const network = Deno.env.get('HELIO_NETWORK') ?? 'main'
    const paylinkId = resolveIntelPaylinkId(tier, network)
    if (!paylinkId) {
      return json({ error: 'paylink_not_configured', network, tier }, 500, headers)
    }
    slog('helio_config_served', { tier, network })
    return json({ paylink_id: paylinkId, network, tier }, 200, headers)
  }
  if (intent !== 'subscribe') return json({ error: 'invalid_intent' }, 400, headers)

  const cardToken = String(payload?.token ?? '').trim()
  if (!cardToken) return json({ error: 'missing_token' }, 400, headers)

  const billing = (payload?.billing_address ?? {}) as Record<string, unknown>
  const billingLine1   = String(billing?.line1 ?? '').trim()
  const billingLine2   = String(billing?.line2 ?? '').trim()
  const billingCity    = String(billing?.city ?? '').trim()
  const billingState   = String(billing?.state ?? '').trim()
  const billingPostal  = String(billing?.postal_code ?? '').trim()
  const billingCountry = String(billing?.country ?? '').trim().toUpperCase()
  if (!billingLine1)    return json({ error: 'missing_billing_line1' }, 400, headers)
  if (!billingCity)     return json({ error: 'missing_billing_city' }, 400, headers)
  if (!billingState)    return json({ error: 'missing_billing_state' }, 400, headers)
  if (!billingPostal)   return json({ error: 'missing_billing_postal' }, 400, headers)
  if (!billingCountry || billingCountry.length !== 2)
    return json({ error: 'invalid_billing_country' }, 400, headers)

  const cardFeeAck     = payload?.card_fee_acknowledged === true
  const disclosureHash = String(payload?.disclosure_hash ?? '').trim()
  if (!cardFeeAck) return json({ error: 'fee_acknowledgement_missing' }, 400, headers)
  if (!isHexSha256(disclosureHash)) return json({ error: 'invalid_disclosure_hash' }, 400, headers)

  // ── server-side amount resolution (never trust the client) ──
  const baseAmtIn  = Number(payload?.base_amount_cents)
  const feeAmtIn   = Number(payload?.card_fee_amount_cents)
  const totalAmtIn = Number(payload?.total_amount_cents)
  const expected   = INTEL_PLAN_PRICING_CENTS[tier].monthly
  if (!Number.isInteger(baseAmtIn) || baseAmtIn !== expected)
    return json({ error: 'base_amount_mismatch', expected }, 400, headers)
  if (!Number.isInteger(feeAmtIn) || feeAmtIn < 0)
    return json({ error: 'invalid_card_fee_amount_cents' }, 400, headers)
  if (!Number.isInteger(totalAmtIn) || totalAmtIn < baseAmtIn || totalAmtIn !== baseAmtIn + feeAmtIn)
    return json({ error: 'invalid_total_amount_cents' }, 400, headers)

  slog('amount_resolved', { tier, expected_base_cents: expected, fee_cents: feeAmtIn, total_cents: totalAmtIn })

  const fluidpayPlanIdEnv = INTEL_PLAN_ID_ENV[tier]
  const fluidpayPlanId = Deno.env.get(fluidpayPlanIdEnv) ?? ''
  if (!fluidpayPlanId) {
    return json({ error: 'fluidpay_plan_id_not_configured', envvar: fluidpayPlanIdEnv }, 500, headers)
  }

  // ── FluidPay step 1: vault customer (creates + attaches token) ──
  const customerBody: Record<string, unknown> = {
    first_name: userResult.user.user_metadata?.first_name ?? '',
    last_name:  userResult.user.user_metadata?.last_name ?? '',
    email:      userResult.user.email ?? '',
    default_billing_address: {
      line_1: billingLine1,
      line_2: billingLine2 || undefined,
      city: billingCity,
      state: billingState,
      postal_code: billingPostal,
      country: billingCountry,
    },
    default_payment: { type: 'card', token: cardToken },
  }
  const customerResp = await callFluidPay({
    baseUrl, apiKey,
    method: 'POST',
    path: '/api/vault/customer',
    body: customerBody,
    idempotencyKey: deterministicIdempotencyKey(attemptId, 'vault_customer'),
  })
  if (!customerResp.ok) {
    slog('vault_customer_failed', { status: customerResp.status, msg: customerResp.errorMsg, correlation_id: customerResp.correlationId })
    return json({
      error: 'fluidpay_rejected',
      step: 'vault_customer',
      msg: customerResp.errorMsg,
    }, customerResp.status === 0 ? 502 : 400, headers)
  }
  const customerId = pickString(customerResp.data, 'data.id', 'id', 'data.customer.id')
  if (!customerId) {
    slog('vault_customer_no_id', { correlation_id: customerResp.correlationId })
    return json({ error: 'fluidpay_unexpected_response', step: 'vault_customer' }, 502, headers)
  }
  slog('vault_customer_ok', { customer_id: customerId })

  // ── FluidPay step 2: immediate first-month sale ───────────
  const processorId = Deno.env.get('FLUIDPAY_PROCESSOR_ID') ?? ''
  const saleBody: Record<string, unknown> = {
    type: 'sale',
    amount: totalAmtIn,
    currency: 'USD',
    payment_method: { customer: { id: customerId } },
    billing_method: 'initial_recurring',
    initiated_by: 'customer',
    description: `intel ${tier} initial monthly charge`,
  }
  if (processorId) saleBody.processor_id = processorId

  const saleResp = await callFluidPay({
    baseUrl, apiKey,
    method: 'POST',
    path: '/api/transaction',
    body: saleBody,
    idempotencyKey: deterministicIdempotencyKey(attemptId, 'sale'),
  })
  if (!saleResp.ok) {
    slog('sale_failed', { status: saleResp.status, msg: saleResp.errorMsg, correlation_id: saleResp.correlationId })
    return json({
      error: 'fluidpay_rejected',
      step: 'sale',
      msg: saleResp.errorMsg,
    }, saleResp.status === 0 ? 502 : 400, headers)
  }
  const saleTxId = pickString(saleResp.data, 'data.id', 'data.transaction.id', 'transaction_id')
  if (!saleTxId) {
    slog('sale_no_tx_id', { correlation_id: saleResp.correlationId })
    return json({ error: 'fluidpay_unexpected_response', step: 'sale' }, 502, headers)
  }
  slog('sale_ok', { sale_tx_id: saleTxId })

  const saleData = (saleResp.data?.data ?? {}) as AnyObj
  const respBody = (saleData?.response_body as AnyObj | undefined) ?? {}
  const cardObj  = (respBody?.card as AnyObj | undefined) ?? {}

  // ── FluidPay step 3: recurring subscription for months 2+ ──
  const subscriptionBody: Record<string, unknown> = {
    plan_id: fluidpayPlanId,
    customer: { id: customerId },
    amount: totalAmtIn,
    billing_frequency: 'monthly',
    billing_cycle_interval: 1,
    billing_days: String(billingDayOfMonth()),
    duration: 0,
    next_bill_date: ymdPlusDays(28),
  }
  if (processorId) subscriptionBody.processor_id = processorId

  const subscriptionResp = await callFluidPay({
    baseUrl, apiKey,
    method: 'POST',
    path: '/api/recurring/subscription',
    body: subscriptionBody,
    idempotencyKey: deterministicIdempotencyKey(attemptId, 'subscription'),
  })

  let subscriptionId: string | null = null
  let subscriptionState: 'created' | 'failed_needs_operator' = 'created'
  if (subscriptionResp.ok) {
    subscriptionId = pickString(subscriptionResp.data, 'data.id', 'data.subscription.id', 'subscription_id') ?? null
    if (!subscriptionId) subscriptionState = 'failed_needs_operator'
  } else {
    subscriptionState = 'failed_needs_operator'
  }
  if (subscriptionState === 'failed_needs_operator') {
    // The first month IS already charged. Don't strand the customer — still
    // activate, log loudly, and surface in the audit log so the operator can
    // create the recurring subscription in the FluidPay dashboard.
    slog('subscription_create_failed_after_sale', {
      sale_tx_id: saleTxId,
      status: subscriptionResp.status,
      msg: subscriptionResp.errorMsg,
      correlation_id: subscriptionResp.correlationId,
    })
  } else {
    slog('subscription_ok', { subscription_id: subscriptionId })
  }

  // ── activation (idempotent, fails closed) ─────────────────
  slog('activation_rpc_call', { org_id: orgId, tier, sale_tx_id: saleTxId, idempotency_key: 'provider_transaction_id' })
  const { data: activatedOrgId, error: rpcErr } = await supabase.rpc('intel_activate_subscription', {
    p_org_id: orgId,
    p_tier: tier,
    p_provider: 'fluidpay',
    p_provider_transaction_id: saleTxId,
    p_provider_subscription_id: subscriptionId,
    p_provider_customer_id: customerId,
    p_amount_usd: totalAmtIn / 100,
    p_base_amount_cents: baseAmtIn,
    p_card_fee_amount_cents: feeAmtIn,
    p_total_amount_cents: totalAmtIn,
    p_currency_code: 'usd',
    p_billing_cycle: 'monthly',
    p_helio_paylink_id: null,
    p_tx_hash: null,
    p_wallet: null,
    p_next_charge_url: null,
    p_charge_token: null,
    p_next_bill_date: ymdPlusDays(28),
    p_renewal_at: new Date().toISOString(),
    // FluidPay approved the transaction; merchant Post Rules are the
    // authoritative gate (same stance as fluidpay-reactivate).
    p_fraud_status: 'cleared',
    p_card_brand: pickString(cardObj, 'card_type', 'brand') ?? null,
    p_card_last4: pickString(cardObj, 'last_four', 'last4') ?? null,
    p_provider_correlation_id: saleResp.correlationId ?? null,
    p_sanitized_payload: {
      saleData,
      subscription_state: subscriptionState,
      attempt_id: attemptId,
      fee_disclosure: (payload?.fee_disclosure ?? null) as string | null,
      fluidpay_fee_snapshot: (payload?.fluidpay_fee_snapshot ?? null),
    },
    p_provider_status: pickString(saleData, 'status') ?? 'authorized',
  })

  if (rpcErr) {
    slog('activation_failed', { org_id: orgId, sale_tx_id: saleTxId, msg: rpcErr.message })
    return json({
      error: 'activation_db_error',
      msg: rpcErr.message,
      sale_tx_id: saleTxId,
    }, 500, headers)
  }

  slog('activation_ok', { org_id: activatedOrgId ?? orgId, tier, subscription_state: subscriptionState })

  return json({
    status: 'active',
    org_id: activatedOrgId ?? orgId,
    tier,
    provider_transaction_id: saleTxId,
    recurring_subscription: subscriptionState,
  }, 200, headers)
})
