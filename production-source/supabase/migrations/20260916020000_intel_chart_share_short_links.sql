-- ============================================================
-- SECTION: chart share short links
-- ============================================================
-- WHY: a chart link is a 64 hex character capability in a URL fragment, so the
-- address a member actually hands to a reader is ~100 characters of opaque hex.
-- tcfqr.link already resolves any slug through resolve_qr_slug, so a chart link
-- becomes a short address the same way a published asset does: one qr_codes row
-- whose destination is the long address.
--
-- WHY NOT qr_create(): the same reasoning as 20260723150000_asset_short_links.
-- These are plumbing, not marketing codes. Through qr_create they would consume
-- the organization's max_dynamic_qr_codes cap (a member may hold up to 250 live
-- chart links) and sit in the Links & QR list next to real campaigns. They get
-- their own kind, skip the cap, and are hidden from qr_list.
--
-- THE FRAGMENT IS THE CAPABILITY. qr-redirect copies destination_url into
-- Location verbatim, and a fragment is never sent to the server, so the token
-- stays in the reader's browser and never reaches a redirect log. Nothing in
-- this file may normalize, re-parse or re-encode destination_url.
--
-- ANALYTICS NOTE: every open of a short chart link is a redirect and therefore
-- a recorded scan. Rows are tagged kind='chart_share' so reporting can exclude
-- them alongside kind='asset' before trusting any aggregate.
-- ============================================================

-- The slug belongs to the share, so share_list can hand back a short address
-- without a second lookup, and so revocation knows which code to archive.
ALTER TABLE public.intel_chart_shares ADD COLUMN IF NOT EXISTS short_slug text;
CREATE UNIQUE INDEX IF NOT EXISTS intel_chart_share_short_slug_uniq
  ON public.intel_chart_shares(short_slug) WHERE short_slug IS NOT NULL;
GRANT UPDATE(short_slug) ON public.intel_chart_shares TO service_role;

-- Same-destination reuse: a retried mint must not leak a second slug for one
-- share. Each share carries its own token, so this is per share in practice.
CREATE UNIQUE INDEX IF NOT EXISTS qr_codes_chart_share_dest_uniq
  ON qr_codes (org_id, destination_url)
  WHERE kind = 'chart_share' AND archived_at IS NULL;

-- Mint (or reuse) the short address for one live share.
--
-- The destination is built here from the stored token rather than taken from
-- the caller, so no edge request can point a tcfqr slug at an address of its
-- own choosing. Membership and Investor Intel access are re-checked exactly as
-- intel_create_chart_share checks them.
CREATE OR REPLACE FUNCTION public.intel_chart_share_short_link(p_org uuid, p_user uuid, p_share uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_share       public.intel_chart_shares;
  v_destination text;
  v_slug        text;
  v_tries       int := 0;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id = p_org AND user_id = p_user)
     OR public.can_access_intel(p_user, p_org) IS NOT TRUE THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_share FROM public.intel_chart_shares
   WHERE id = p_share AND org_id = p_org AND user_id = p_user;
  IF NOT FOUND OR v_share.revoked_at IS NOT NULL OR v_share.snapshot_id IS NULL
     OR v_share.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'chart_share_unavailable';
  END IF;
  IF v_share.short_slug IS NOT NULL THEN RETURN v_share.short_slug; END IF;

  v_destination := 'https://thecontentforge.io/intel/shared-chart#' || v_share.token;
  -- Same scheme and private-host validation every other destination gets.
  PERFORM qr_validate_destination(v_destination);

  SELECT slug INTO v_slug FROM qr_codes
   WHERE org_id = p_org AND kind = 'chart_share'
     AND destination_url = v_destination AND archived_at IS NULL
   LIMIT 1;

  -- Deliberately NOT cap- or entitlement-checked: see the header. The slug is
  -- the existing non-guessable eight character base62 helper; collision safety
  -- is the unique index plus this retry, never a uniqueness assumption.
  LOOP
    EXIT WHEN v_slug IS NOT NULL;
    v_tries := v_tries + 1;
    BEGIN
      INSERT INTO qr_codes (org_id, created_by, slug, name, destination_url, kind, is_dynamic)
      VALUES (p_org, (SELECT id FROM auth.users WHERE id = p_user), qr_gen_slug(8),
              'Shared chart link', v_destination, 'chart_share', true)
      RETURNING slug INTO v_slug;
    EXCEPTION WHEN unique_violation THEN
      -- Either a slug collision (retry) or a concurrent mint for this same
      -- destination (take theirs).
      SELECT slug INTO v_slug FROM qr_codes
       WHERE org_id = p_org AND kind = 'chart_share'
         AND destination_url = v_destination AND archived_at IS NULL
       LIMIT 1;
      IF v_slug IS NULL AND v_tries >= 5 THEN RAISE EXCEPTION 'chart_share_slug_unavailable'; END IF;
    END;
  END LOOP;

  UPDATE public.intel_chart_shares SET short_slug = v_slug WHERE id = p_share;
  RETURN v_slug;
END $$;

REVOKE ALL ON FUNCTION public.intel_chart_share_short_link(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_chart_share_short_link(uuid, uuid, uuid) TO service_role;

-- Revoking a link must close its short address too, or tcfqr.link would keep
-- carrying readers to a capability the member has withdrawn. An archived
-- qr_codes row resolves to NULL, which qr-redirect answers exactly as it
-- answers an unknown slug: no oracle for whether the link ever existed.
GRANT UPDATE(archived_at, updated_at) ON qr_codes TO service_role;

CREATE OR REPLACE FUNCTION public.intel_revoke_chart_share(p_org uuid, p_user uuid, p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE affected integer; v_slug text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=p_user) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 UPDATE public.intel_chart_shares SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE id=p_id AND org_id=p_org AND user_id=p_user RETURNING short_slug INTO v_slug;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected>0 AND v_slug IS NOT NULL THEN
  UPDATE public.qr_codes SET archived_at=coalesce(archived_at,now()), updated_at=now() WHERE slug=v_slug AND org_id=p_org AND kind='chart_share';
 END IF;
 RETURN affected>0;
END $$;
REVOKE ALL ON FUNCTION public.intel_revoke_chart_share(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_revoke_chart_share(uuid,uuid,uuid) TO service_role;

-- Keep chart plumbing out of the Links & QR list, which is for campaigns.
-- Byte-for-byte the body from 20260723150000_asset_short_links.sql plus the new
-- kind — the shape (q.*, scan_count, counter_last_scanned_at, ORDER BY
-- updated_at) is what the QR Manager UI reads, so it must not drift.
CREATE OR REPLACE FUNCTION qr_list(p_include_archived boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  v_org := get_my_org_id();
  IF v_org IS NULL THEN RETURN '[]'::jsonb; END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(x) ORDER BY x.updated_at DESC)
    FROM (
      SELECT q.*,
             COALESCE(c.scan_count, 0)  AS scan_count,
             c.last_scanned_at          AS counter_last_scanned_at
      FROM qr_codes q
      LEFT JOIN qr_scan_counters c ON c.qr_code_id = q.id
      WHERE q.org_id = v_org
        AND (p_include_archived OR q.archived_at IS NULL)
        AND q.kind NOT IN ('asset', 'chart_share')
    ) x
  ), '[]'::jsonb);
END $$;

NOTIFY pgrst, 'reload schema';
