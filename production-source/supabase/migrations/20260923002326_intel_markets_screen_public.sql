-- Investor Intel public demo: the Markets screen for a visitor with nothing saved.
--
-- The demo snapshot builder (supabase/functions/intel-demo-snapshot) computes,
-- in-process with the service role, the body each real page receives. The
-- Markets screen reads public.intel_markets_screen_for_user, which refuses
-- anyone who is not a member with Intel access, and the builder has no member:
-- it never signs in as, or mints a session for, anyone.
--
-- This is the SAME screen with no workspace. Derived from the LIVE definition,
-- so every later change to the screen (drawdown, chain-capped movers, ...) is
-- carried over, and the edit is refused if the reviewed text moved:
--   * the member and access check is gone (there is no member);
--   * the workspace passed to the query is NULL, so no row is on a watchlist
--     and watchlistMovers is always empty;
--   * a watchlist-only screen is refused (22023): with no workspace it would be
--     an empty list that means "failed", not "nothing matches".
-- The catalogue it reads is the shared market catalogue; nothing here is
-- personal. service_role only, like the member version.

DO $markets_public$ DECLARE original text;changed text;step text;BEGIN
 original:=pg_get_functiondef('public.intel_markets_screen_for_user(uuid,uuid,jsonb)'::regprocedure);
 changed:=original;
 step:=replace(changed,
  'CREATE OR REPLACE FUNCTION public.intel_markets_screen_for_user(p_org_id uuid, p_user_id uuid, p_query jsonb)',
  'CREATE OR REPLACE FUNCTION public.intel_markets_screen_public(p_query jsonb)');
 IF step=changed THEN RAISE EXCEPTION 'unexpected_markets_screen_signature';END IF;
 changed:=step;
 step:=replace(changed,
  'IF p_user_id IS NULL OR p_org_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE user_id=p_user_id AND org_id=p_org_id)',
  'IF COALESCE((p_query->>''watchlistOnly'')::boolean,false)');
 IF step=changed THEN RAISE EXCEPTION 'unexpected_markets_screen_member_check';END IF;
 changed:=step;
 step:=replace(changed,'  OR NOT COALESCE(public.can_access_intel(p_user_id,p_org_id),false) THEN',' THEN');
 IF step=changed THEN RAISE EXCEPTION 'unexpected_markets_screen_access_check';END IF;
 changed:=step;
 step:=replace(changed,
  'RAISE EXCEPTION ''Investor Intel workspace access required'' USING ERRCODE=''42501'';',
  'RAISE EXCEPTION ''A watchlist screen needs a workspace'' USING ERRCODE=''22023'';');
 IF step=changed THEN RAISE EXCEPTION 'unexpected_markets_screen_refusal';END IF;
 changed:=step;
 step:=replace(changed,'USING p_org_id,v_search,','USING NULL::uuid,v_search,');
 IF step=changed THEN RAISE EXCEPTION 'unexpected_markets_screen_org_argument';END IF;
 changed:=step;
 -- No reference to a member or a workspace may survive.
 IF position('p_org_id' in changed)>0 OR position('p_user_id' in changed)>0 OR position('org_members' in changed)>0
  OR position('can_access_intel' in changed)>0 THEN
  RAISE EXCEPTION 'markets_screen_public_still_names_a_member';
 END IF;
 EXECUTE changed;
END $markets_public$;

REVOKE ALL ON FUNCTION public.intel_markets_screen_public(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_markets_screen_public(jsonb) TO service_role;
COMMENT ON FUNCTION public.intel_markets_screen_public(jsonb) IS
 'Investor Intel public demo: the Markets screen with no workspace (derived from intel_markets_screen_for_user). Refuses watchlistOnly. service_role only.';
