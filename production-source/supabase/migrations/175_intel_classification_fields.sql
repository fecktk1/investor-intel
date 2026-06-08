-- ============================================================
-- 175: Investor Intel — classification + analysis fields (Phase 4)
-- ============================================================
-- Adds the 14 primary news categories + signal bias to the Signal Layer
-- (signals) and the curated feed (intel_curated_news), plus the explainable
-- source-quality score, per-item analysis fields, user-relevance reason, and the
-- soft official-confirmation flag. Additive + idempotent. Separate from the
-- source-seed migration (174) by design.
--
-- Category model (rev 2): bullish/bearish are NOT categories — the event type is
-- news_category (14 values), the market direction is signal_bias (4 values).
-- ============================================================

-- ── Signal Layer signals: deterministic category/bias + carried authority ────
ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS news_category           text,
  ADD COLUMN IF NOT EXISTS signal_bias             text,
  ADD COLUMN IF NOT EXISTS bull_bear_reason        text,
  ADD COLUMN IF NOT EXISTS authority_level         text,
  ADD COLUMN IF NOT EXISTS source_quality_score    int,
  ADD COLUMN IF NOT EXISTS source_quality_breakdown jsonb;

-- ── Curated Notable News: category/bias + analysis + explainable quality ─────
ALTER TABLE intel_curated_news
  ADD COLUMN IF NOT EXISTS news_category            text,
  ADD COLUMN IF NOT EXISTS signal_bias              text,
  ADD COLUMN IF NOT EXISTS bull_bear_reason         text,
  ADD COLUMN IF NOT EXISTS what_happened            text,
  ADD COLUMN IF NOT EXISTS bull_case                text,
  ADD COLUMN IF NOT EXISTS bear_case                text,
  ADD COLUMN IF NOT EXISTS source_quality_score     int,
  ADD COLUMN IF NOT EXISTS source_quality_breakdown jsonb,
  ADD COLUMN IF NOT EXISTS user_relevance_reason    text,
  ADD COLUMN IF NOT EXISTS needs_confirmation       boolean NOT NULL DEFAULT false;

-- ── CHECK constraints (NOT VALID → VALIDATE; NULL allowed for pre-existing rows) ──
DO $$
DECLARE
  cat_list text := $cats$'official_update','technical_release','governance','ecosystem_growth','partnership','funding','tokenomics','market_structure','security','defi_activity','stablecoin_activity','wallet_activity','developer_activity','social_signal'$cats$;
  bias_list text := $bias$'bullish','bearish','mixed','neutral'$bias$;
BEGIN
  -- signals
  EXECUTE 'ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_news_category_chk';
  EXECUTE format('ALTER TABLE signals ADD CONSTRAINT signals_news_category_chk CHECK (news_category IS NULL OR news_category IN (%s)) NOT VALID', cat_list);
  EXECUTE 'ALTER TABLE signals VALIDATE CONSTRAINT signals_news_category_chk';
  EXECUTE 'ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_signal_bias_chk';
  EXECUTE format('ALTER TABLE signals ADD CONSTRAINT signals_signal_bias_chk CHECK (signal_bias IS NULL OR signal_bias IN (%s)) NOT VALID', bias_list);
  EXECUTE 'ALTER TABLE signals VALIDATE CONSTRAINT signals_signal_bias_chk';
  -- intel_curated_news
  EXECUTE 'ALTER TABLE intel_curated_news DROP CONSTRAINT IF EXISTS curated_news_category_chk';
  EXECUTE format('ALTER TABLE intel_curated_news ADD CONSTRAINT curated_news_category_chk CHECK (news_category IS NULL OR news_category IN (%s)) NOT VALID', cat_list);
  EXECUTE 'ALTER TABLE intel_curated_news VALIDATE CONSTRAINT curated_news_category_chk';
  EXECUTE 'ALTER TABLE intel_curated_news DROP CONSTRAINT IF EXISTS curated_signal_bias_chk';
  EXECUTE format('ALTER TABLE intel_curated_news ADD CONSTRAINT curated_signal_bias_chk CHECK (signal_bias IS NULL OR signal_bias IN (%s)) NOT VALID', bias_list);
  EXECUTE 'ALTER TABLE intel_curated_news VALIDATE CONSTRAINT curated_signal_bias_chk';
END $$;

-- Filter the curated feed by category + surface items awaiting confirmation.
CREATE INDEX IF NOT EXISTS curated_news_category_idx ON intel_curated_news(news_category) WHERE should_surface = true;
CREATE INDEX IF NOT EXISTS signals_news_category_idx ON signals(news_category);
