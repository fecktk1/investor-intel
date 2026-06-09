-- ============================================================
-- 133: Investor Intel — entities, research artifacts, coverage, events
-- ============================================================
-- The intelligence spine for Investor Intel. All org-scoped tables follow
-- the app's canonical RLS pattern (get_my_org_id / get_my_role). Service-role
-- edge functions bypass RLS for writes; users read their own workspace rows.
--
--   - entities            : canonical identity for every tracked asset /
--                           wallet / market / protocol / narrative across all
--                           launch chains (never assume chain:address).
--   - research_artifacts  : unified store for every generated AI output, with
--                           confidence/evidence/source traceability + lineage
--                           + caching contract.
--   - chain_capabilities  : GLOBAL runtime coverage registry. Code config
--                           (chains.ts) is canonical; rows here override at
--                           runtime. Defaults to 'unverified' until the P0
--                           provider-coverage report confirms a capability.
--   - intel_ai_events     : product analytics + safety-validator outcomes
--                           (cost stays in ai_usage / recordAIUsage).
-- ============================================================

-- ── entities ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  entity_kind       text NOT NULL CHECK (entity_kind IN ('asset','wallet','market','protocol','narrative')),
  chain_namespace   text,                 -- CAIP-2 namespace (eip155|solana|bip122|sui|...); null for chain-agnostic narratives
  chain_id          text,                 -- CAIP-2 reference (e.g. '1', 'mainnet')
  asset_type        text,                 -- native|erc20|spl|sui_coin|trc20|jetton|xrpl_iou|market|account|protocol|narrative
  asset_id          text,                 -- contract|mint|object|market id|issuer.currency|account|slug|'native'
  native_symbol     text,
  contract_address  text,                 -- nullable (native coins, markets, narratives have none)
  issuer            text,                 -- XRPL / issued assets
  market_id         text,
  wallet_address    text,
  protocol_id       text,
  display_symbol    text,
  canonical_ref_key text NOT NULL,        -- stable, URL-safe canonical identity (CAIP-19-like, extended)
  provider_ids      jsonb NOT NULL DEFAULT '{}',
  provider_metadata jsonb NOT NULL DEFAULT '{}',
  privacy_limited   boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, canonical_ref_key)
);
CREATE INDEX IF NOT EXISTS entities_org_kind ON entities(org_id, entity_kind);
CREATE INDEX IF NOT EXISTS entities_org_chain ON entities(org_id, chain_namespace, chain_id);

-- ── research_artifacts ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS research_artifacts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id                   uuid REFERENCES profiles(id) ON DELETE SET NULL,
  artifact_type             text NOT NULL,   -- token_breakdown|risk_panel|explain|wallet_summary|narrative_report|alert_explanation|token_comparison|daily_brief|defi_report|execution_report|thesis_review
  entity_id                 uuid REFERENCES entities(id) ON DELETE SET NULL,  -- null for market-wide briefs
  subject_kind              text,            -- token|wallet|narrative|ecosystem|protocol|defi_vault|market|general
  title                     text,
  body_md                   text,
  structured                jsonb NOT NULL DEFAULT '{}',   -- full AI output contract
  confidence                text CHECK (confidence IN ('high','medium','low') OR confidence IS NULL),
  evidence                  jsonb NOT NULL DEFAULT '[]',
  missing_context           jsonb NOT NULL DEFAULT '[]',
  data_freshness            jsonb NOT NULL DEFAULT '{}',
  sources                   jsonb NOT NULL DEFAULT '[]',
  -- lineage + caching + safe evolution
  schema_version            integer NOT NULL DEFAULT 1,
  artifact_version          integer NOT NULL DEFAULT 1,
  input_hash                text,
  source_snapshot_ids       jsonb NOT NULL DEFAULT '[]',
  parent_artifact_id        uuid REFERENCES research_artifacts(id) ON DELETE SET NULL,
  cache_key                 text,
  regeneration_policy       text,           -- on_demand|on_material_change|scheduled|idempotent_per_period
  provider_coverage_snapshot jsonb NOT NULL DEFAULT '{}',
  model                     text,
  generation_job_id         uuid,
  validation_status         text NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending','passed','rewritten','blocked')),
  validator_outcome         jsonb NOT NULL DEFAULT '{}',
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed','blocked')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  stale_after               timestamptz,
  expires_at                timestamptz
);
CREATE INDEX IF NOT EXISTS ra_org_type_entity ON research_artifacts(org_id, artifact_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ra_org_cache_key   ON research_artifacts(org_id, cache_key);
CREATE INDEX IF NOT EXISTS ra_org_input_hash  ON research_artifacts(org_id, input_hash);

-- ── chain_capabilities (GLOBAL coverage registry) ────────────
-- Code config (supabase/functions/_shared/chains.ts) is canonical. These rows
-- override at runtime per the P0 provider-coverage report. Absence => unverified.
CREATE TABLE IF NOT EXISTS chain_capabilities (
  chain        text NOT NULL,
  capability   text NOT NULL,
  status       text NOT NULL DEFAULT 'unverified' CHECK (status IN ('live','limited','unavailable','unverified')),
  note_key     text,                 -- i18n key for the unsupported-state message
  verified_at  timestamptz,
  updated_by   uuid REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, capability)
);

-- ── intel_ai_events (analytics + validator outcomes) ─────────
CREATE TABLE IF NOT EXISTS intel_ai_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid REFERENCES orgs(id) ON DELETE CASCADE,
  user_id           uuid REFERENCES profiles(id) ON DELETE SET NULL,
  event_type        text NOT NULL,   -- explain|compare|brief_view|alert_why|risk_panel|token_breakdown|...
  subject_kind      text,
  subject_key       text,
  artifact_id       uuid REFERENCES research_artifacts(id) ON DELETE SET NULL,
  model             text,
  tokens_in         integer,
  tokens_out        integer,
  validator_outcome text,            -- pass|rewrite|block
  validator_reason  text,
  metadata          jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS iae_org_type_time ON intel_ai_events(org_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS iae_validator     ON intel_ai_events(validator_outcome, created_at DESC) WHERE validator_outcome IS NOT NULL;

-- ── updated_at triggers ──────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['entities'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$s FOR EACH ROW EXECUTE FUNCTION update_updated_at()', t);
  END LOOP;
END $$;

-- ── RLS: org-scoped tables (canonical pattern) ───────────────
ALTER TABLE entities          ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_ai_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain_capabilities ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text; prefix text;
BEGIN
  FOREACH t IN ARRAY ARRAY['entities','research_artifacts'] LOOP
    prefix := 'intel_' || left(replace(t, '_', ''), 20);
    EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON %s', prefix, t);
    EXECUTE format('CREATE POLICY "%s_select" ON %s FOR SELECT USING (org_id = get_my_org_id())', prefix, t);

    EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON %s', prefix, t);
    EXECUTE format($p$CREATE POLICY "%s_insert" ON %s FOR INSERT WITH CHECK (org_id = get_my_org_id() AND get_my_role() IN ('owner','admin','editor'))$p$, prefix, t);

    EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON %s', prefix, t);
    EXECUTE format($p$CREATE POLICY "%s_update" ON %s FOR UPDATE USING (org_id = get_my_org_id() AND get_my_role() IN ('owner','admin','editor'))$p$, prefix, t);

    EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON %s', prefix, t);
    EXECUTE format($p$CREATE POLICY "%s_delete" ON %s FOR DELETE USING (org_id = get_my_org_id() AND get_my_role() IN ('owner','admin'))$p$, prefix, t);
  END LOOP;
END $$;

-- intel_ai_events: service-role writes (edge functions), org reads.
DROP POLICY IF EXISTS "intel_ai_events_select" ON intel_ai_events;
CREATE POLICY "intel_ai_events_select" ON intel_ai_events FOR SELECT
  USING (org_id = get_my_org_id());

-- chain_capabilities: GLOBAL read for any authenticated user; service-role writes.
DROP POLICY IF EXISTS "chain_capabilities_select" ON chain_capabilities;
CREATE POLICY "chain_capabilities_select" ON chain_capabilities FOR SELECT
  USING (true);
