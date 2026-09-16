-- ============================================================
-- Investor Intel - repeat controls for wallet and unlock alerts
-- ============================================================
-- Hysteresis is the wrong tool for these two triggers, and 20260916093000
-- (lines 74-106) says why: a wallet_activity candidate is a DISTINCT transfer and
-- an unlock candidate is a dated calendar version, not a level that oscillates
-- across a threshold. A re-arm gate over a level would silence a genuine second
-- event rather than smooth a flapping number.
--
-- What CAN make these rules fire repeatedly on what a reader sees as the same
-- condition is different, and it is what this migration addresses:
--
--   * wallet_activity  one transaction often carries several transfer legs, and a
--                      large holder often splits one move into a burst of
--                      transfers. Each leg is a distinct source row, so each one
--                      fires once the cooldown allows it.
--   * unlock           a provider revising the schedule of ONE unlock writes a new
--                      calendar version, and every version is a new source row,
--                      so the same unlock alerts again after every revision.
--
-- Two optional config keys, both OPT-IN:
--
--   distinct_by            wallet_activity: 'transfer' (default, today's
--                          behaviour) | 'transaction' (one alert per tx_hash).
--                          unlock: 'version' (default, today's behaviour) |
--                          'event' (one alert per scheduled unlock, whatever
--                          its revisions).
--   repeat_window_minutes  0 (default, today's behaviour) to 10080.
--                          wallet_activity: a transfer of the same asset in the
--                          same direction whose SOURCE time is within this many
--                          minutes of an already alerted transfer is folded into
--                          that alert. Measured on the source clock, in both
--                          directions, so a burst is folded whatever order the
--                          bridge reads it in and a folded transfer never fires
--                          late when the window has passed.
--                          unlock: a revised schedule of an already alerted
--                          unlock alerts again only once this many minutes have
--                          passed since that alert.
--
-- A folded candidate is reported as 'duplicate', a result the bridge already
-- understands, so alert-bridge.ts and intel-alerts-bridge need no change. The
-- unification map is not written for it, so the permanent per-source dedupe is
-- unchanged. Only the two named triggers read these keys; any other trigger that
-- carries them is refused at write time rather than silently ignored.
--
-- NOTHING CHANGES FOR AN EXISTING RULE. Checked read-only before writing this:
-- no live rule carries either key, and with both keys absent the new check
-- returns NULL before it reads anything. A rule changes behaviour only when its
-- owner picks a different value in the alert editor.
--
-- SHIPPING ORDER. The emit function is patched by EXACT STRING MATCH against its
-- live definition and RAISES 'unexpected_emit_bridged_alert_definition' when the
-- reviewed line is not there exactly once. If another branch edits
-- public.intel_emit_bridged_alert first, re-derive the patch against the new
-- live text; do not relax the guard.
--
-- ROLLBACK
--   DROP TRIGGER intel_bridge_repeat_guard ON public.intel_alert_rules;
--   DROP FUNCTION app_private.intel_bridge_repeat_guard();
--   -- re-create public.intel_emit_bridged_alert from its live definition without
--   -- the one inserted line, then:
--   DROP FUNCTION app_private.intel_bridge_repeat_suppressed(uuid,text,jsonb,jsonb);
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION: the repeat check
-- NULL means "may fire". 'duplicate' means "folded into an earlier alert of this
-- rule". An unnamed asset, direction or transaction hash is never folded with
-- another unnamed one: an unknown key is not evidence that two events share it.
CREATE FUNCTION app_private.intel_bridge_repeat_suppressed(p_rule uuid,p_trigger text,p_config jsonb,p_payload jsonb)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $repeat$
DECLARE distinct_by text;window_minutes integer;observed timestamptz;
BEGIN
 IF p_trigger IS NULL OR p_trigger NOT IN('wallet_activity','unlock') OR p_config IS NULL OR jsonb_typeof(p_config)<>'object' OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN RETURN NULL;END IF;
 IF NOT (p_config ? 'distinct_by' OR p_config ? 'repeat_window_minutes') THEN RETURN NULL;END IF;
 distinct_by:=p_config->>'distinct_by';
 window_minutes:=CASE WHEN jsonb_typeof(p_config->'repeat_window_minutes')='number' THEN (p_config->>'repeat_window_minutes')::integer ELSE 0 END;
 IF p_trigger='unlock' THEN
  IF nullif(p_payload->>'calendar_event_id','') IS NULL THEN RETURN NULL;END IF;
  IF distinct_by='event' AND EXISTS(SELECT 1 FROM public.intel_alert_events e
    WHERE e.rule_id=p_rule AND e.payload->>'calendar_event_id'=p_payload->>'calendar_event_id') THEN RETURN 'duplicate';END IF;
  IF window_minutes>0 AND EXISTS(SELECT 1 FROM public.intel_alert_events e
    WHERE e.rule_id=p_rule AND e.payload->>'calendar_event_id'=p_payload->>'calendar_event_id'
     AND e.fired_at>clock_timestamp()-make_interval(mins=>window_minutes)) THEN RETURN 'duplicate';END IF;
  RETURN NULL;
 END IF;
 -- wallet_activity
 IF distinct_by='transaction' AND nullif(p_payload->>'tx_hash','') IS NOT NULL AND EXISTS(SELECT 1 FROM public.intel_alert_events e
   WHERE e.rule_id=p_rule AND e.payload->>'tx_hash'=p_payload->>'tx_hash') THEN RETURN 'duplicate';END IF;
 IF window_minutes>0 AND nullif(p_payload->>'ref','') IS NOT NULL AND nullif(p_payload->>'direction','') IS NOT NULL THEN
  BEGIN observed:=(p_payload->>'source_observed_at')::timestamptz;EXCEPTION WHEN others THEN observed:=NULL;END;
  IF observed IS NOT NULL AND EXISTS(SELECT 1 FROM public.intel_alert_events e
    WHERE e.rule_id=p_rule AND e.payload->>'ref'=p_payload->>'ref' AND e.payload->>'direction'=p_payload->>'direction'
     AND e.payload->>'source_observed_at' IS NOT NULL
     AND abs(extract(epoch FROM (e.payload->>'source_observed_at')::timestamptz-observed))<=window_minutes*60) THEN RETURN 'duplicate';END IF;
 END IF;
 RETURN NULL;
END $repeat$;
REVOKE ALL ON FUNCTION app_private.intel_bridge_repeat_suppressed(uuid,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app_private.intel_bridge_repeat_suppressed(uuid,text,jsonb,jsonb) TO service_role;

-- SECTION: the bridge consults it before the cooldown
-- Placed after the permanent source dedupe and before the cooldown, so a folded
-- candidate neither fires nor consumes the rule's cooldown.
DO $emit$ DECLARE original text;changed text;anchor text;occurrences integer;BEGIN
 original:=pg_get_functiondef('public.intel_emit_bridged_alert(uuid,uuid,integer,text,text,text,text,numeric,jsonb)'::regprocedure);
 anchor:=' IF EXISTS(SELECT 1 FROM public.alert_event_unification_map WHERE rule_id=r.id AND source_table=p_source_table AND source_ref=p_source_ref AND intel_alert_event_id IS NOT NULL) THEN RETURN ''duplicate'';END IF;';
 occurrences:=(length(original)-length(replace(original,anchor,'')))/length(anchor);
 IF occurrences<>1 THEN RAISE EXCEPTION 'unexpected_emit_bridged_alert_definition';END IF;
 changed:=replace(original,anchor,anchor||chr(10)||' IF app_private.intel_bridge_repeat_suppressed(r.id,r.trigger_type,r.config,p_payload) IS NOT NULL THEN RETURN ''duplicate'';END IF;');
 IF changed=original THEN RAISE EXCEPTION 'unexpected_emit_bridged_alert_definition';END IF;
 EXECUTE changed;
END $emit$;

-- SECTION: the keys are validated where the rule is written
-- A value outside the vocabulary, or either key on a trigger that does not read
-- it, is refused at write time instead of being discovered, or ignored, during an
-- evaluation. Rows without the keys pass untouched.
CREATE FUNCTION app_private.intel_bridge_repeat_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $guard$
BEGIN
 IF NEW.config IS NULL OR jsonb_typeof(NEW.config)<>'object' OR NOT (NEW.config ? 'distinct_by' OR NEW.config ? 'repeat_window_minutes') THEN RETURN NEW;END IF;
 IF NEW.trigger_type NOT IN('wallet_activity','unlock')
  OR (NEW.config ? 'distinct_by' AND (jsonb_typeof(NEW.config->'distinct_by') IS DISTINCT FROM 'string'
   OR NEW.config->>'distinct_by' NOT IN(CASE WHEN NEW.trigger_type='unlock' THEN 'version' ELSE 'transfer' END,CASE WHEN NEW.trigger_type='unlock' THEN 'event' ELSE 'transaction' END)))
  OR (NEW.config ? 'repeat_window_minutes' AND (jsonb_typeof(NEW.config->'repeat_window_minutes') IS DISTINCT FROM 'number'
   OR (NEW.config->>'repeat_window_minutes')::numeric NOT BETWEEN 0 AND 10080
   OR (NEW.config->>'repeat_window_minutes')::numeric<>trunc((NEW.config->>'repeat_window_minutes')::numeric)))
 THEN RAISE EXCEPTION 'bridge_repeat_config_invalid';END IF;
 RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION app_private.intel_bridge_repeat_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_bridge_repeat_guard BEFORE INSERT OR UPDATE OF config,trigger_type ON public.intel_alert_rules
 FOR EACH ROW EXECUTE FUNCTION app_private.intel_bridge_repeat_guard();
