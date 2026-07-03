-- ============================================================
-- Batch 3 activation (v3.1): DB-backed runtime feature flags
-- ============================================================
-- Operator-toggleable kill switches for the provider-capacity features, read by
-- edge functions via _shared/intel/runtime-flags.ts (env override > DB > default).
-- Lets us enable/kill a feature via SQL or the Super Admin panel with no secret
-- redeploy. Additive + idempotent.

CREATE TABLE IF NOT EXISTS intel_runtime_flags (
  flag       text PRIMARY KEY,
  enabled    boolean NOT NULL DEFAULT false,
  note       text,
  updated_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE intel_runtime_flags ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE intel_runtime_flags TO service_role;

-- Super-admin: list + set flags (self-gated).
CREATE OR REPLACE FUNCTION intel_admin_list_flags()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT coalesce(jsonb_agg(row_to_json(f) ORDER BY f.flag), '[]'::jsonb) INTO v FROM intel_runtime_flags f;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION intel_admin_set_flag(p_flag text, p_enabled boolean, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  INSERT INTO intel_runtime_flags (flag, enabled, note, updated_by, updated_at)
  VALUES (p_flag, p_enabled, p_note, auth.uid(), now())
  ON CONFLICT (flag) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    note = coalesce(EXCLUDED.note, intel_runtime_flags.note),
    updated_by = auth.uid(), updated_at = now();
END $$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['intel_admin_list_flags()', 'intel_admin_set_flag(text,boolean,text)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
  END LOOP;
END $$;

-- Seed the v3.1 feature flags (all OFF; enable per rollout).
INSERT INTO intel_runtime_flags (flag, enabled, note) VALUES
  ('ALERT_UNIFICATION_ENABLED', false, 'Batch 3: bridge onchain/unlock/supply/holder/metadata → intel_alert_events'),
  ('METADATA_DRIFT_ENABLED',    false, 'Batch 3: CoinGecko poll-based metadata/contract-migration drift (CP-3: no webhooks)'),
  ('BIRDEYE_SECURITY_ENABLED',  false, 'Batch 5: Birdeye token_security snapshots'),
  ('BIRDEYE_HOLDER_ENABLED',    false, 'Batch 5: Birdeye token holder snapshots'),
  ('SMART_MONEY_ENABLED',       false, 'Batch 5/6: Birdeye Top Traders smart-money feed'),
  ('COINGECKO_ONCHAIN_ENABLED', false, 'Batch 5/6: CoinGecko on-chain GT score/honeypot cross-check'),
  ('RISK_SCORE_ENABLED',        false, 'Batch 6: token risk + holder concentration scores'),
  ('HELIUS_DAS_SHADOW',         false, 'Batch 4: Helius DAS shadow-compare vs QuickNode+Birdeye')
ON CONFLICT (flag) DO NOTHING;
