-- ============================================================
-- 257: Investor Intel Telegram bot
-- ============================================================
-- Separate bot identity and settings surface for Investor Intel. The Content
-- Telegram bot remains isolated on allowlist_chats / TELEGRAM_BOT_TOKEN.
--
-- Privacy model:
--   - Private Telegram DMs are linked to one authenticated app user via a
--     short-lived, hashed link code.
--   - Group chats are org-scoped and explicitly permissioned. Portfolio data
--     is disabled by default and the webhook enforces that groups cannot read
--     per-user portfolio rows.
--   - Chart artifacts and event logs are service-role writes; app users can
--     read only rows for their active org, with user-specific filters where
--     rows carry user_id.
-- ============================================================

CREATE TABLE IF NOT EXISTS intel_telegram_links (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  telegram_user_id      text NOT NULL UNIQUE,
  telegram_username     text,
  telegram_first_name   text,
  telegram_last_name    text,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  allows_private_alerts boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  linked_at             timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz
);
CREATE INDEX IF NOT EXISTS itl_org_user ON intel_telegram_links(org_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS itl_one_active_per_user
  ON intel_telegram_links(org_id, user_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS intel_telegram_link_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  code_hash   text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','used','expired','revoked')),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS itlc_owner_status ON intel_telegram_link_codes(org_id, user_id, status, expires_at DESC);

CREATE TABLE IF NOT EXISTS intel_telegram_chats (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  chat_id             text NOT NULL UNIQUE,
  chat_title          text,
  chat_type           text NOT NULL DEFAULT 'group' CHECK (chat_type IN ('group','supergroup','channel')),
  added_by            uuid REFERENCES profiles(id) ON DELETE SET NULL,
  enabled             boolean NOT NULL DEFAULT true,
  permissions         jsonb NOT NULL DEFAULT '{"briefs":true,"alerts":true,"token_lookup":true,"charts":true,"ask":true,"portfolio":false}',
  quiet_hours         jsonb NOT NULL DEFAULT '{}',
  min_alert_severity  text NOT NULL DEFAULT 'low' CHECK (min_alert_severity IN ('low','medium','high','critical')),
  default_timeframe   text NOT NULL DEFAULT '1D' CHECK (default_timeframe IN ('1H','4H','1D','1W')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS itc_org_enabled ON intel_telegram_chats(org_id, enabled);

CREATE TABLE IF NOT EXISTS intel_telegram_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid REFERENCES orgs(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES profiles(id) ON DELETE SET NULL,
  chat_id          text NOT NULL,
  telegram_user_id text,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ite_org_created ON intel_telegram_events(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ite_chat_created ON intel_telegram_events(chat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS intel_telegram_chart_artifacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  chat_id      text NOT NULL,
  query        text NOT NULL,
  ref          text NOT NULL,
  timeframe    text NOT NULL DEFAULT '1D' CHECK (timeframe IN ('1H','4H','1D','1W')),
  storage_path text NOT NULL,
  source       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS itca_org_created ON intel_telegram_chart_artifacts(org_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intel_telegram_links','intel_telegram_chats'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$s FOR EACH ROW EXECUTE FUNCTION update_updated_at()', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION protect_intel_telegram_link_identity()
RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     AND auth.uid() IS NOT NULL
     AND (
       NEW.org_id IS DISTINCT FROM OLD.org_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.telegram_user_id IS DISTINCT FROM OLD.telegram_user_id
     )
  THEN
    RAISE EXCEPTION 'telegram_link_identity_fields_are_immutable';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_intel_telegram_link_identity ON intel_telegram_links;
CREATE TRIGGER trg_intel_telegram_link_identity
  BEFORE UPDATE ON intel_telegram_links
  FOR EACH ROW EXECUTE FUNCTION protect_intel_telegram_link_identity();

ALTER TABLE intel_telegram_links           ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_telegram_link_codes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_telegram_chats           ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_telegram_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_telegram_chart_artifacts ENABLE ROW LEVEL SECURITY;

-- One authenticated app user can see/manage only their linked private Telegram identity.
DROP POLICY IF EXISTS "intel_telegram_links_select" ON intel_telegram_links;
CREATE POLICY "intel_telegram_links_select" ON intel_telegram_links FOR SELECT
  USING (org_id = get_my_org_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS "intel_telegram_links_update" ON intel_telegram_links;
CREATE POLICY "intel_telegram_links_update" ON intel_telegram_links FOR UPDATE
  USING (org_id = get_my_org_id() AND user_id = auth.uid())
  WITH CHECK (org_id = get_my_org_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS "intel_telegram_links_delete" ON intel_telegram_links;
CREATE POLICY "intel_telegram_links_delete" ON intel_telegram_links FOR DELETE
  USING (org_id = get_my_org_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS "intel_telegram_link_codes_delete" ON intel_telegram_link_codes;
CREATE POLICY "intel_telegram_link_codes_delete" ON intel_telegram_link_codes FOR DELETE
  USING (org_id = get_my_org_id() AND user_id = auth.uid() AND status = 'pending');

-- Group chats are org settings. Owners/admins/editors can add/remove/update.
DROP POLICY IF EXISTS "intel_telegram_chats_select" ON intel_telegram_chats;
CREATE POLICY "intel_telegram_chats_select" ON intel_telegram_chats FOR SELECT
  USING (org_id = get_my_org_id());

DROP POLICY IF EXISTS "intel_telegram_chats_insert" ON intel_telegram_chats;
CREATE POLICY "intel_telegram_chats_insert" ON intel_telegram_chats FOR INSERT
  WITH CHECK (org_id = get_my_org_id() AND get_my_role() IN ('owner','admin','editor'));

DROP POLICY IF EXISTS "intel_telegram_chats_update" ON intel_telegram_chats;
CREATE POLICY "intel_telegram_chats_update" ON intel_telegram_chats FOR UPDATE
  USING (org_id = get_my_org_id() AND get_my_role() IN ('owner','admin','editor'))
  WITH CHECK (org_id = get_my_org_id() AND get_my_role() IN ('owner','admin','editor'));

DROP POLICY IF EXISTS "intel_telegram_chats_delete" ON intel_telegram_chats;
CREATE POLICY "intel_telegram_chats_delete" ON intel_telegram_chats FOR DELETE
  USING (org_id = get_my_org_id() AND get_my_role() IN ('owner','admin'));

-- Event and chart rows are written by the webhook. Members can read org-shared
-- rows, and user-specific rows only when they own them.
DROP POLICY IF EXISTS "intel_telegram_events_select" ON intel_telegram_events;
CREATE POLICY "intel_telegram_events_select" ON intel_telegram_events FOR SELECT
  USING (org_id = get_my_org_id() AND (user_id IS NULL OR user_id = auth.uid()));

DROP POLICY IF EXISTS "intel_telegram_chart_artifacts_select" ON intel_telegram_chart_artifacts;
CREATE POLICY "intel_telegram_chart_artifacts_select" ON intel_telegram_chart_artifacts FOR SELECT
  USING (org_id = get_my_org_id() AND (user_id IS NULL OR user_id = auth.uid()));

CREATE OR REPLACE FUNCTION create_intel_telegram_link_code()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org  uuid := get_my_org_id();
  v_code text;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF v_org IS NULL THEN RAISE EXCEPTION 'org_not_found'; END IF;

  UPDATE intel_telegram_link_codes
     SET status = 'expired'
   WHERE org_id = v_org
     AND user_id = v_user
     AND status = 'pending';

  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  INSERT INTO intel_telegram_link_codes (org_id, user_id, code_hash, expires_at)
  VALUES (v_org, v_user, md5('intel-telegram:' || v_code), now() + interval '15 minutes');

  RETURN v_code;
END $$;

REVOKE EXECUTE ON FUNCTION create_intel_telegram_link_code() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_intel_telegram_link_code() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION consume_intel_telegram_link_code(
  p_code text,
  p_telegram_user_id text,
  p_username text DEFAULT NULL,
  p_first_name text DEFAULT NULL,
  p_last_name text DEFAULT NULL
)
RETURNS TABLE(ok boolean, org_id uuid, user_id uuid, error text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_row  intel_telegram_link_codes%ROWTYPE;
BEGIN
  IF v_code = '' OR p_telegram_user_id IS NULL OR btrim(p_telegram_user_id) = '' THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'missing_code_or_telegram_user';
    RETURN;
  END IF;

  UPDATE intel_telegram_link_codes
     SET status = 'expired'
   WHERE status = 'pending'
     AND expires_at < now();

  SELECT * INTO v_row
    FROM intel_telegram_link_codes
   WHERE code_hash = md5('intel-telegram:' || v_code)
     AND status = 'pending'
     AND expires_at >= now()
   ORDER BY created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'invalid_or_expired_code';
    RETURN;
  END IF;

  UPDATE intel_telegram_link_codes
     SET status = 'used', used_at = now()
   WHERE id = v_row.id;

  UPDATE intel_telegram_links
     SET status = 'revoked',
         revoked_at = now(),
         updated_at = now()
   WHERE org_id = v_row.org_id
     AND user_id = v_row.user_id
     AND status = 'active'
     AND telegram_user_id <> btrim(p_telegram_user_id);

  INSERT INTO intel_telegram_links (
    org_id, user_id, telegram_user_id, telegram_username,
    telegram_first_name, telegram_last_name, status, linked_at, revoked_at
  ) VALUES (
    v_row.org_id, v_row.user_id, btrim(p_telegram_user_id), nullif(p_username, ''),
    nullif(p_first_name, ''), nullif(p_last_name, ''), 'active', now(), NULL
  )
  ON CONFLICT (telegram_user_id) DO UPDATE SET
    org_id = excluded.org_id,
    user_id = excluded.user_id,
    telegram_username = excluded.telegram_username,
    telegram_first_name = excluded.telegram_first_name,
    telegram_last_name = excluded.telegram_last_name,
    status = 'active',
    linked_at = now(),
    revoked_at = NULL,
    updated_at = now();

  RETURN QUERY SELECT true, v_row.org_id, v_row.user_id, NULL::text;
END $$;

REVOKE EXECUTE ON FUNCTION consume_intel_telegram_link_code(text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_intel_telegram_link_code(text, text, text, text, text) TO service_role;
