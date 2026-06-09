-- ============================================================
-- 158: Investor Intel — global market regime (shared, cached)
-- ============================================================
-- ONE global regime classification, computed a few times/day by a shared cron
-- and read by every workspace (Market Pulse + Briefs). Near-zero per-user cost.
-- Intel-only read surface; nothing org-side touched.
-- ============================================================

CREATE TABLE IF NOT EXISTS intel_market_regime (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regime           text NOT NULL,              -- risk_on|risk_off|btc_led|altcoin_rotation|chop|...
  flavor           text,                        -- eth_led|sol_led|meme|defi|ai|...
  confidence       text,                        -- high|medium|low
  rationale        text,
  majors           jsonb NOT NULL DEFAULT '{}', -- {btc, eth, sol, btc_dominance, total_mcap_change}
  hot_narratives   text[] NOT NULL DEFAULT '{}',
  what_confirms    text,
  what_invalidates text,
  computed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intel_regime_time ON intel_market_regime(computed_at DESC);

ALTER TABLE intel_market_regime ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intel_regime_read ON intel_market_regime;
CREATE POLICY intel_regime_read ON intel_market_regime FOR SELECT USING (auth.uid() IS NOT NULL);

-- latest regime helper (so the client doesn't need order/limit logic)
CREATE OR REPLACE FUNCTION intel_current_regime()
RETURNS SETOF intel_market_regime LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM intel_market_regime ORDER BY computed_at DESC LIMIT 1;
$$;
DO $$ BEGIN
  EXECUTE 'REVOKE EXECUTE ON FUNCTION intel_current_regime() FROM PUBLIC, anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION intel_current_regime() TO authenticated, service_role';
END $$;
