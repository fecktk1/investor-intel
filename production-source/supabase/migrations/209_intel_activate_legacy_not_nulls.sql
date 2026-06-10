-- ============================================================
-- 209: intel_activate_subscription — clear the legacy Helio-era landmines
-- ============================================================
-- Second live card attempt (2026-06-10, after 208) charged and then failed:
--   null value in column "moonpay_status" of relation "billing_transactions"
--     violates not-null constraint
--
-- Two distinct problems, both rooted in the Helio-only legacy schema:
--
-- 1) billing_transactions.moonpay_status is NOT NULL DEFAULT 'pending' (055).
--    206/208 insert it explicitly as CASE WHEN crypto THEN 'completed' END,
--    which is an EXPLICIT NULL for card rows — and an explicit NULL overrides
--    the column default. The proven FluidPay RPCs (100/106) omit the column
--    entirely so the default fills it; their fluidpay rows carry 'pending'.
--    Fix: card rows now write 'pending' to match that convention.
--
-- 2) billing_transactions.fee_source CHECK (099, expanded by 107) allows only
--    fluidpay_tokenizer / fluidpay_transaction_response / fluidpay_webhook /
--    fluidpay_reactivate. The RPC records fee_source = 'intel_subscribe' for
--    audit distinguishability — same story as 107 (reactivate shipped a value
--    the CHECK didn't know). Fix: extend the CHECK with 'intel_subscribe'.
--
-- Also COALESCE the two NOT NULL jsonb columns (metadata, provider_meta) so a
-- null p_sanitized_payload can never reproduce this class of failure.
--
-- Same signature — no edge function redeploys. Card and crypto both covered.

-- ── 2) fee_source CHECK: add 'intel_subscribe' (mirrors 107) ──
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'billing_tx_fee_source_check'
  ) THEN
    ALTER TABLE billing_transactions
      DROP CONSTRAINT billing_tx_fee_source_check;
  END IF;

  ALTER TABLE billing_transactions
    ADD CONSTRAINT billing_tx_fee_source_check
    CHECK (fee_source IS NULL OR fee_source IN
      ('fluidpay_tokenizer',
       'fluidpay_transaction_response',
       'fluidpay_webhook',
       'fluidpay_reactivate',
       'intel_subscribe'));
END $$;

-- ── 1) + jsonb hardening: re-create the function ──
CREATE OR REPLACE FUNCTION intel_activate_subscription(
  p_org_id                   uuid,
  p_tier                     text,
  p_provider                 text,
  p_provider_transaction_id  text,
  p_provider_subscription_id text,
  p_provider_customer_id     text,
  p_amount_usd               numeric,
  p_base_amount_cents        int,
  p_card_fee_amount_cents    int,
  p_total_amount_cents       int,
  p_currency_code            text,
  p_billing_cycle            text DEFAULT 'monthly',
  p_helio_paylink_id         text DEFAULT NULL,
  p_tx_hash                  text DEFAULT NULL,
  p_wallet                   text DEFAULT NULL,
  p_next_charge_url          text DEFAULT NULL,
  p_charge_token             text DEFAULT NULL,
  p_next_bill_date           date DEFAULT NULL,
  p_renewal_at               timestamptz DEFAULT NULL,
  p_fraud_status             text DEFAULT NULL,
  p_card_brand               text DEFAULT NULL,
  p_card_last4               text DEFAULT NULL,
  p_provider_correlation_id  text DEFAULT NULL,
  p_sanitized_payload        jsonb DEFAULT '{}'::jsonb,
  p_provider_status          text DEFAULT 'authorized'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org        orgs%ROWTYPE;
  v_tier       plan_tier;
  v_provider   payment_provider;
  v_existing   uuid;
  v_paylink_id text;
  v_payload    jsonb;
BEGIN
  -- ── validation (fail closed) ──────────────────────────────
  IF p_tier IS NULL OR p_tier NOT IN ('starter','pro','elite') THEN
    RAISE EXCEPTION 'intel_activate: invalid tier %', COALESCE(p_tier, 'null');
  END IF;
  v_tier := p_tier::plan_tier;  -- text param → enum; safe after the allowlist check

  IF p_provider IS NULL OR p_provider NOT IN ('fluidpay','crypto_helio') THEN
    RAISE EXCEPTION 'intel_activate: invalid provider %', COALESCE(p_provider, 'null');
  END IF;
  v_provider := p_provider::payment_provider;  -- 208: text param → enum

  IF p_provider_transaction_id IS NULL OR length(btrim(p_provider_transaction_id)) = 0 THEN
    RAISE EXCEPTION 'intel_activate: missing provider_transaction_id';
  END IF;

  v_payload := COALESCE(p_sanitized_payload, '{}'::jsonb);  -- 209: NOT NULL jsonb targets

  -- ── idempotency: same provider transaction → no-op ────────
  IF p_provider = 'fluidpay' THEN
    SELECT org_id INTO v_existing FROM billing_transactions
      WHERE provider = 'fluidpay' AND provider_transaction_id = p_provider_transaction_id
      LIMIT 1;
  ELSE
    SELECT org_id INTO v_existing FROM billing_transactions
      WHERE moonpay_transaction_id = p_provider_transaction_id
      LIMIT 1;
  END IF;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- ── org checks ────────────────────────────────────────────
  SELECT * INTO v_org FROM orgs WHERE id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'intel_activate: org not found %', p_org_id;
  END IF;
  IF v_org.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'intel_activate: org deleted %', p_org_id;
  END IF;
  IF v_org.product_mode IS DISTINCT FROM 'intel' THEN
    RAISE EXCEPTION 'intel_activate: org % is not an intel workspace', p_org_id;
  END IF;

  -- ── fraud gate (defense in depth, mirrors reactivate_org_fluidpay) ──
  IF p_fraud_status IS NULL OR p_fraud_status NOT IN ('cleared','cleared_by_admin') THEN
    INSERT INTO billing_audit_log
      (org_id, provider, provider_subscription_id, provider_transaction_id, action, actor, reason)
      VALUES (p_org_id, v_provider, p_provider_subscription_id, p_provider_transaction_id,
              'intel_activate_fraud_gate', 'service_role',
              concat('refused; fraud_status=', COALESCE(p_fraud_status, 'null')));
    RAISE EXCEPTION 'intel_activate: fraud not cleared (%)', COALESCE(p_fraud_status, 'null');
  END IF;

  -- helio_paylink_id is NOT NULL in the legacy schema; synthesize for card rows.
  v_paylink_id := COALESCE(
    NULLIF(p_helio_paylink_id, ''),
    concat('fluidpay:intel:', COALESCE(NULLIF(p_provider_subscription_id, ''), p_provider_transaction_id))
  );

  -- ── ledger row (the idempotency anchor) ───────────────────
  -- billing_transactions.plan_id is text — record the intel tier as text.
  -- moonpay_status is NOT NULL (055): card rows take 'pending', matching what
  -- the column default gives the existing FluidPay reactivate/checkout rows.
  INSERT INTO billing_transactions
    (org_id, plan_id, billing_cycle, amount_usd, currency_code, metadata,
     provider, provider_customer_id, provider_subscription_id, provider_transaction_id,
     provider_correlation_id, provider_status, provider_meta,
     moonpay_transaction_id, moonpay_status, tx_hash, wallet_address,
     fraud_status, card_brand, card_last4,
     base_amount_cents, card_fee_amount_cents, total_amount_cents,
     fee_status, fee_source)
    VALUES (p_org_id, p_tier, COALESCE(p_billing_cycle, 'monthly'), p_amount_usd,
            COALESCE(p_currency_code, CASE WHEN p_provider = 'fluidpay' THEN 'usd' ELSE 'usdc' END),
            v_payload,
            v_provider, p_provider_customer_id, NULLIF(p_provider_subscription_id, ''), p_provider_transaction_id,
            p_provider_correlation_id, p_provider_status, v_payload,
            CASE WHEN p_provider = 'crypto_helio' THEN p_provider_transaction_id END,
            CASE WHEN p_provider = 'crypto_helio' THEN 'completed' ELSE 'pending' END,
            p_tx_hash, p_wallet,
            p_fraud_status, p_card_brand, p_card_last4,
            p_base_amount_cents, p_card_fee_amount_cents, p_total_amount_cents,
            'applied', 'intel_subscribe');

  -- ── subscription row (renewals/cancellations route here) ──
  -- org_subscriptions.plan_id is plan_tier — use the enum value, no ::text.
  UPDATE org_subscriptions
     SET status                     = 'active',
         plan_id                    = v_tier,
         billing_cycle              = COALESCE(p_billing_cycle, 'monthly'),
         helio_subscription_id      = CASE WHEN p_provider = 'crypto_helio'
                                           THEN COALESCE(NULLIF(p_provider_subscription_id, ''), helio_subscription_id)
                                           ELSE helio_subscription_id END,
         provider_customer_id       = COALESCE(p_provider_customer_id, provider_customer_id),
         provider_subscription_id   = COALESCE(NULLIF(p_provider_subscription_id, ''), provider_subscription_id),
         raw_payload                = v_payload,
         provider_meta              = v_payload,
         card_brand                 = COALESCE(p_card_brand, card_brand),
         card_last4                 = COALESCE(p_card_last4, card_last4),
         fraud_status               = p_fraud_status,
         next_bill_date             = COALESCE(p_next_bill_date, next_bill_date),
         renewal_at                 = COALESCE(p_renewal_at, renewal_at),
         next_charge_url            = COALESCE(p_next_charge_url, next_charge_url),
         charge_token               = COALESCE(p_charge_token, charge_token),
         base_amount_cents          = COALESCE(p_base_amount_cents, base_amount_cents),
         card_fee_amount_cents      = COALESCE(p_card_fee_amount_cents, card_fee_amount_cents),
         total_amount_cents         = COALESCE(p_total_amount_cents, total_amount_cents),
         fee_status                 = 'applied',
         grace_until                = NULL,
         latest_webhook_event_type  = concat('intel_subscribe_', p_provider),
         latest_webhook_received_at = now(),
         updated_at                 = now()
   WHERE org_id = p_org_id AND provider = v_provider;

  IF NOT FOUND THEN
    INSERT INTO org_subscriptions
      (org_id, helio_paylink_id, helio_subscription_id, plan_id, billing_cycle,
       status, raw_payload,
       provider, provider_customer_id, provider_subscription_id,
       provider_meta, next_bill_date, renewal_at, next_charge_url, charge_token,
       card_brand, card_last4, fraud_status,
       latest_webhook_event_type, latest_webhook_received_at,
       base_amount_cents, card_fee_amount_cents, total_amount_cents, fee_status)
      VALUES (p_org_id, v_paylink_id,
              CASE WHEN p_provider = 'crypto_helio' THEN NULLIF(p_provider_subscription_id, '') END,
              v_tier, COALESCE(p_billing_cycle, 'monthly'),
              'active', v_payload,
              v_provider, p_provider_customer_id, NULLIF(p_provider_subscription_id, ''),
              v_payload, p_next_bill_date, p_renewal_at, p_next_charge_url, p_charge_token,
              p_card_brand, p_card_last4, p_fraud_status,
              concat('intel_subscribe_', p_provider), now(),
              p_base_amount_cents, p_card_fee_amount_cents, p_total_amount_cents, 'applied');
  END IF;

  -- ── flip the org to paid intel tier ────────────────────────
  -- intel_tier drives intel_limit()/intel_limit_for(). orgs.plan untouched
  -- (see 206 header). Clearing trial_ends_at AND payment_required_since
  -- releases both gates in profile-context's paymentStatus.
  UPDATE orgs
     SET plan_overrides         = COALESCE(plan_overrides, '{}'::jsonb)
                                  || jsonb_build_object('intel_tier', p_tier),
         trial_ends_at          = NULL,
         payment_required_since = NULL,
         is_active              = true,
         updated_at             = now()
   WHERE id = p_org_id;

  INSERT INTO billing_audit_log
    (org_id, provider, provider_subscription_id, provider_transaction_id,
     action, actor, before_status, after_status, reason)
    VALUES (p_org_id, v_provider, NULLIF(p_provider_subscription_id, ''), p_provider_transaction_id,
            'intel_activate_subscription', 'service_role',
            CASE WHEN v_org.trial_ends_at IS NOT NULL THEN 'trial' ELSE 'expired' END, 'active',
            concat('intel tier=', p_tier, ' provider_status=', COALESCE(p_provider_status, 'null')));

  RETURN p_org_id;
END $$;

REVOKE EXECUTE ON FUNCTION intel_activate_subscription(
  uuid,text,text,text,text,text,numeric,int,int,int,text,text,text,text,text,text,text,date,timestamptz,text,text,text,text,jsonb,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION intel_activate_subscription(
  uuid,text,text,text,text,text,numeric,int,int,int,text,text,text,text,text,text,text,date,timestamptz,text,text,text,text,jsonb,text
) TO service_role;
