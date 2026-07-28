-- ============================================================
-- Realty vertical — State/County/Town Local Intelligence Adapter Track
-- ============================================================
-- Extends the Pack-2 county adapter engine (data_connector_sources +
-- _shared/realty/registry.ts + adapters.ts) with a richer, config-driven local
-- registry and a general normalization model that covers the categories the
-- parcel pack does not: code enforcement, planning cases, recorder documents,
-- tax detail, rental/STR registries, jurisdiction overlays (flood/wildfire/
-- school/utility districts), and building footprints.
--
-- Six tables: a registry (realty_local_adapters, DB override of compiled seeds),
-- run telemetry (realty_local_runs), and four normalized targets
-- (property_local_records / _overlays / _documents / _cases).
--
-- HARD RULES honored: NO PostGIS — geometry is jsonb GeoJSON, distances via
-- haversine in code, btree indexes only. NO scraping — html_scrape / pdf_extract
-- / paid sources are registered as metadata-only SEAMS (ingest_status), never
-- executed as scrapers; users can upload the document instead (is_user_supplied).
-- Every stored row carries source_url + confidence + match basis + freshness so
-- the UI can show provenance. National baseline first, local override second
-- (overlays carry authority_level + supersedes).
-- ============================================================

-- 1) Registry — DB override of the compiled seed catalog (local/seeds.ts).
--    adapter_key is the stable logical id (like data_connector_sources.source_key);
--    runs + normalized rows reference it by key (code-seeded adapters need no row).
CREATE TABLE IF NOT EXISTS realty_local_adapters (
  adapter_key       text PRIMARY KEY,
  active            boolean NOT NULL DEFAULT true,
  provider          text NOT NULL CHECK (provider IN ('arcgis_feature','arcgis_map','socrata','ckan','wfs','ogc_api_features','csv_zip','html_scrape','pdf_extract')),
  category          text NOT NULL CHECK (category IN ('parcel','assessor','permit','zoning','code_enforcement','planning','recorder','tax','building_footprints','flood','wildfire','rental_registry','str_license','utility_district','crime','school_district')),
  jurisdiction_type text NOT NULL CHECK (jurisdiction_type IN ('city','town','county','state','special_district','national')),
  jurisdiction_name text NOT NULL,
  state_code        text,
  county_fips       text,          -- 5-digit state+county
  place_fips        text,
  source_name       text NOT NULL,
  source_url        text,          -- machine endpoint
  landing_url       text,          -- human page / metadata
  auth_type         text NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none','api_key','cookie','header')),
  -- ingest_status: what the engine may actually do with this source.
  --   active        = keyless machine endpoint, executed
  --   metadata_only = registered seam; store availability + link, do not fetch rows
  --   manual        = user upload path only
  --   paid          = gated behind payment; not executed
  --   restricted    = terms/license forbid automated download
  ingest_status     text NOT NULL DEFAULT 'active' CHECK (ingest_status IN ('active','metadata_only','manual','paid','restricted')),
  query_modes       text[] NOT NULL DEFAULT '{}',
  refresh_strategy  text NOT NULL DEFAULT 'manual' CHECK (refresh_strategy IN ('cron','webhook','manual')),
  refresh_cron      text,
  requires_terms_ack boolean NOT NULL DEFAULT false,
  terms_url         text,
  informational_only boolean NOT NULL DEFAULT false,   -- source warns it is not authoritative → confidence cap
  parse_config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_map         jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_rules  jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence_weights jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rla_lookup ON realty_local_adapters(active, state_code, county_fips, place_fips, category);

-- 2) Run telemetry — one row per adapter execution (no FK; code-seeded adapters
--    have no registry row).
CREATE TABLE IF NOT EXISTS realty_local_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adapter_key     text NOT NULL,
  org_id          uuid REFERENCES orgs(id) ON DELETE CASCADE,
  property_id     uuid REFERENCES properties(id) ON DELETE CASCADE,
  run_mode        text NOT NULL DEFAULT 'discovery' CHECK (run_mode IN ('discovery','refresh','backfill')),
  status          text NOT NULL CHECK (status IN ('success','warning','error','skipped')),
  error_code      text,   -- TEMPORARY_OUTAGE | RATE_LIMITED | SCHEMA_DRIFT | NO_MATCH | AMBIGUOUS_MATCH | AUTH_REQUIRED | TERMS_RESTRICTED | CAPTCHA_OR_HUMAN_FLOW | PAID_ACCESS_ONLY | PARSER_ERROR | VALIDATION_FAILED
  error_message   text,
  http_status     int,
  records_fetched int NOT NULL DEFAULT 0,
  records_written int NOT NULL DEFAULT 0,
  request_hash    text,
  trace           jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX IF NOT EXISTS rlr_adapter_idx  ON realty_local_runs(adapter_key, started_at DESC);
CREATE INDEX IF NOT EXISTS rlr_property_idx ON realty_local_runs(property_id, started_at DESC);
CREATE INDEX IF NOT EXISTS rlr_status_idx   ON realty_local_runs(status, started_at DESC);

-- 3) Normalized parcel / assessor / tax / registry / reference rows.
CREATE TABLE IF NOT EXISTS property_local_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  adapter_key       text NOT NULL,
  category          text NOT NULL,
  subtype           text,
  source_record_id  text NOT NULL DEFAULT '',
  source_url        text,
  source_updated_at timestamptz,
  effective_date    date,
  status            text,
  parcel_id         text,
  assessor_parcel_id text,
  address_full      text,
  owner_name        text,
  value_land        numeric,
  value_improvement numeric,
  value_total       numeric,
  tax_year          int,
  tax_amount        numeric,
  title             text,
  summary           text,
  geom              jsonb,                  -- GeoJSON (no PostGIS)
  match_basis       text,                   -- exact_parcel | exact_address | spatial | fuzzy
  confidence_score  numeric(5,2) NOT NULL DEFAULT 0,
  validation_status text NOT NULL DEFAULT 'ok' CHECK (validation_status IN ('ok','warning','manual_review')),
  raw_payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, adapter_key, source_record_id)
);
CREATE INDEX IF NOT EXISTS plr_lookup ON property_local_records(org_id, property_id, category);
CREATE INDEX IF NOT EXISTS plr_apn    ON property_local_records(assessor_parcel_id);

-- 4) Overlays that apply to a parcel (zoning/flood/wildfire/school/utility …).
--    authority_level + supersedes encode "national baseline first, local override".
CREATE TABLE IF NOT EXISTS property_local_overlays (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  property_id      uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  adapter_key      text NOT NULL,
  overlay_type     text NOT NULL,           -- zoning | flood | wildfire | school_district | utility_district | historic | special
  overlay_code     text,
  overlay_name     text,
  source_record_id text NOT NULL DEFAULT '',
  authority_level  text NOT NULL DEFAULT 'national' CHECK (authority_level IN ('national','state','county','city','special_district')),
  supersedes       text,                    -- adapter_key of a baseline this overrides
  effective_date   date,
  expires_at       date,
  geom             jsonb,
  coverage_pct     numeric,
  source_url       text,
  confidence_score numeric(5,2) NOT NULL DEFAULT 0,
  raw_payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, adapter_key, overlay_type, source_record_id)
);
CREATE INDEX IF NOT EXISTS plo_lookup ON property_local_overlays(org_id, property_id, overlay_type);

-- 5) Recorder docs, permit PDFs, plans, maps (metadata + optional user upload).
CREATE TABLE IF NOT EXISTS property_local_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  property_id      uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  adapter_key      text NOT NULL,
  document_type    text NOT NULL,           -- deed | mortgage | plat | permit_pdf | plan | tax_statement | other
  doc_number       text,
  recorded_at      timestamptz,
  title            text,
  source_url       text,
  download_url     text,
  file_object_path text,                     -- set only when a user uploads
  page_count       int,
  ocr_status       text,
  is_user_supplied boolean NOT NULL DEFAULT false,
  confidence_score numeric(5,2) NOT NULL DEFAULT 0,
  raw_payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pld_lookup ON property_local_documents(org_id, property_id, document_type);
CREATE INDEX IF NOT EXISTS pld_docnum ON property_local_documents(doc_number);

-- 6) Cases — permits, zoning/planning cases, code cases, STR/rental licenses.
CREATE TABLE IF NOT EXISTS property_local_cases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  property_id      uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  adapter_key      text NOT NULL,
  case_type        text NOT NULL,           -- permit | zoning_case | code_enforcement | planning_site_plan | str_license | rental_registration
  case_number      text NOT NULL DEFAULT '',
  status           text,
  filed_at         timestamptz,
  issued_at        timestamptz,
  closed_at        timestamptz,
  title            text,
  summary          text,
  address_full     text,
  declared_value   numeric,
  units            int,
  sqft             numeric,
  source_url       text,
  confidence_score numeric(5,2) NOT NULL DEFAULT 0,
  raw_payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, adapter_key, case_type, case_number)
);
CREATE INDEX IF NOT EXISTS plc_lookup ON property_local_cases(org_id, property_id, case_type);
CREATE INDEX IF NOT EXISTS plc_status ON property_local_cases(status);

-- ── touch triggers (registry + records + cases have updated_at) ──────────────
DROP TRIGGER IF EXISTS rla_touch ON realty_local_adapters;
CREATE TRIGGER rla_touch BEFORE UPDATE ON realty_local_adapters
  FOR EACH ROW EXECUTE FUNCTION realty_touch_updated_at();
DROP TRIGGER IF EXISTS plr_touch ON property_local_records;
CREATE TRIGGER plr_touch BEFORE UPDATE ON property_local_records
  FOR EACH ROW EXECUTE FUNCTION realty_touch_updated_at();
DROP TRIGGER IF EXISTS plc_touch ON property_local_cases;
CREATE TRIGGER plc_touch BEFORE UPDATE ON property_local_cases
  FOR EACH ROW EXECUTE FUNCTION realty_touch_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Registry: authenticated read (it is public source config), super-admin write.
ALTER TABLE realty_local_adapters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rla_select ON realty_local_adapters;
CREATE POLICY rla_select ON realty_local_adapters FOR SELECT USING (true);
DROP POLICY IF EXISTS rla_write ON realty_local_adapters;
CREATE POLICY rla_write ON realty_local_adapters FOR ALL USING (is_super_admin()) WITH CHECK (is_super_admin());

-- Runs: org members read their org's runs (+ super-admin); org owner/admin/editor write.
ALTER TABLE realty_local_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rlr_select ON realty_local_runs;
CREATE POLICY rlr_select ON realty_local_runs FOR SELECT USING (org_id IS NULL OR org_id = get_my_org_id() OR is_super_admin());
DROP POLICY IF EXISTS rlr_write ON realty_local_runs;
CREATE POLICY rlr_write ON realty_local_runs FOR ALL USING (org_id = get_my_org_id() AND get_my_role() IN ('owner','admin','editor')) WITH CHECK (org_id = get_my_org_id() AND get_my_role() IN ('owner','admin','editor'));

-- Normalized property rows: org-scoped read; owner/admin/editor write.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['property_local_records','property_local_overlays','property_local_documents','property_local_cases'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON %s', t, t);
    EXECUTE format('CREATE POLICY "%s_select" ON %s FOR SELECT USING (org_id = get_my_org_id() OR is_super_admin())', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_write" ON %s', t, t);
    EXECUTE format($p$CREATE POLICY "%s_write" ON %s FOR ALL USING (org_id = get_my_org_id() AND get_my_role() IN ('owner','admin','editor')) WITH CHECK (org_id = get_my_org_id() AND get_my_role() IN ('owner','admin','editor'))$p$, t, t);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
