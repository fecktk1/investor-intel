-- ============================================================
-- 141: Investor Intel — 14-day trial when a payment method is added
-- ============================================================
-- Call intel_add_payment_method_bonus() once the user adds a card (FluidPay
-- card-on-file flow). Extends the trial by 7 days (7→14), once per workspace.
-- Paid conversion itself needs no special path: a trial workspace is already
-- product_mode='intel', so a normal subscription clears the paywall.
-- ============================================================

CREATE OR REPLACE FUNCTION intel_add_payment_method_bonus()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := get_my_org_id(); v_over jsonb; v_end timestamptz;
BEGIN
  IF v_org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_org'); END IF;
  SELECT plan_overrides, trial_ends_at INTO v_over, v_end FROM orgs WHERE id = v_org AND product_mode = 'intel';
  IF v_end IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_in_trial'); END IF;
  IF coalesce((v_over->>'intel_pm_bonus')::boolean, false) THEN RETURN jsonb_build_object('ok', true, 'already', true); END IF;
  v_end := v_end + interval '7 days';
  UPDATE orgs SET trial_ends_at = v_end, payment_required_since = v_end,
    plan_overrides = coalesce(plan_overrides, '{}'::jsonb) || jsonb_build_object('intel_pm_bonus', true), updated_at = now()
    WHERE id = v_org;
  RETURN jsonb_build_object('ok', true, 'trial_ends_at', v_end);
END $$;
REVOKE EXECUTE ON FUNCTION intel_add_payment_method_bonus() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION intel_add_payment_method_bonus() TO authenticated, service_role;
