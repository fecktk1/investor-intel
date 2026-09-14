-- Delivery extends the canonical alert event. No scheduler or outbound delivery
-- is enabled here. Owner consent applies only to later firings, never a backlog.
CREATE TABLE public.intel_alert_delivery_preferences (
 rule_id uuid PRIMARY KEY REFERENCES public.intel_alert_rules(id) ON DELETE CASCADE,
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 telegram_enabled boolean NOT NULL DEFAULT false,
 consent_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.intel_alert_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 event_id uuid NOT NULL REFERENCES public.intel_alert_events(id) ON DELETE CASCADE,
 rule_id uuid NOT NULL REFERENCES public.intel_alert_rules(id) ON DELETE CASCADE,
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 link_id uuid NOT NULL REFERENCES public.intel_telegram_links(id) ON DELETE CASCADE,
 channel text NOT NULL DEFAULT 'telegram_private' CHECK(channel='telegram_private'),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','provider_accepted','failed','expired','cancelled','unknown')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
 lease_id uuid, lease_until timestamptz, reason text,
 UNIQUE(event_id,channel,user_id)
);
CREATE INDEX intel_alert_deliveries_due ON public.intel_alert_deliveries(next_attempt_at,id) WHERE state='queued';
CREATE INDEX intel_alert_deliveries_owner ON public.intel_alert_deliveries(org_id,user_id,created_at DESC,id);
CREATE INDEX intel_alert_deliveries_rule ON public.intel_alert_deliveries(rule_id);
CREATE INDEX intel_alert_deliveries_link ON public.intel_alert_deliveries(link_id);
CREATE TABLE public.intel_alert_delivery_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), delivery_id uuid NOT NULL REFERENCES public.intel_alert_deliveries(id) ON DELETE CASCADE,
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3), lease_id uuid NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 outcome text NOT NULL DEFAULT 'sending' CHECK(outcome IN ('sending','provider_accepted','retry','failed','unknown','cancelled')),
 http_status integer, provider_message_id text, reason text,
 UNIQUE(delivery_id,attempt)
);
CREATE INDEX intel_alert_attempts_owner ON public.intel_alert_delivery_attempts(org_id,user_id,started_at DESC,id);
ALTER TABLE public.intel_alert_delivery_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intel_alert_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intel_alert_delivery_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON public.intel_alert_delivery_preferences FOR SELECT TO authenticated USING(user_id=auth.uid() AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_alert_delivery_preferences.org_id AND m.user_id=auth.uid()));
CREATE POLICY owner_read ON public.intel_alert_deliveries FOR SELECT TO authenticated USING(user_id=auth.uid() AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_alert_deliveries.org_id AND m.user_id=auth.uid()));
CREATE POLICY owner_read ON public.intel_alert_delivery_attempts FOR SELECT TO authenticated USING(user_id=auth.uid() AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_alert_delivery_attempts.org_id AND m.user_id=auth.uid()));
REVOKE ALL ON public.intel_alert_delivery_preferences,public.intel_alert_deliveries,public.intel_alert_delivery_attempts FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.intel_alert_delivery_preferences,public.intel_alert_deliveries,public.intel_alert_delivery_attempts TO authenticated;
GRANT ALL ON public.intel_alert_delivery_preferences,public.intel_alert_deliveries,public.intel_alert_delivery_attempts TO service_role;

CREATE FUNCTION public.intel_set_alert_delivery(p_org uuid,p_user uuid,p_rule uuid,p_enabled boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE linked boolean;BEGIN
 IF p_enabled IS NULL OR NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=p_org AND user_id=p_user) OR NOT EXISTS(SELECT 1 FROM intel_alert_rules WHERE id=p_rule AND org_id=p_org AND user_id=p_user) THEN RAISE EXCEPTION 'chart_alert_not_found';END IF;
 SELECT EXISTS(SELECT 1 FROM intel_telegram_links WHERE org_id=p_org AND user_id=p_user AND status='active' AND allows_private_alerts) INTO linked;
 IF p_enabled AND (NOT linked OR NOT can_access_intel(p_user,p_org)) THEN RAISE EXCEPTION 'chart_alert_private_telegram_unavailable';END IF;
 INSERT INTO intel_alert_delivery_preferences(rule_id,org_id,user_id,telegram_enabled,consent_at) VALUES(p_rule,p_org,p_user,p_enabled,CASE WHEN p_enabled THEN now() END)
 ON CONFLICT(rule_id) DO UPDATE SET telegram_enabled=p_enabled,consent_at=CASE WHEN p_enabled AND NOT intel_alert_delivery_preferences.telegram_enabled THEN now() ELSE intel_alert_delivery_preferences.consent_at END,updated_at=now();
 IF NOT p_enabled THEN UPDATE intel_alert_deliveries SET state='cancelled',reason='owner_opted_out' WHERE rule_id=p_rule AND state='queued';END IF;
 RETURN jsonb_build_object('enabled',p_enabled,'linked',linked);
END $$;
REVOKE ALL ON FUNCTION public.intel_set_alert_delivery(uuid,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_set_alert_delivery(uuid,uuid,uuid,boolean) TO service_role;

CREATE FUNCTION app_private.intel_queue_alert_delivery() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO intel_alert_deliveries(event_id,rule_id,org_id,user_id,link_id,expires_at)
 SELECT NEW.id,r.id,r.org_id,r.user_id,l.id,least(NEW.fired_at+interval '24 hours',now()+interval '24 hours')
 FROM intel_alert_rules r JOIN intel_alert_delivery_preferences p ON p.rule_id=r.id AND p.org_id=r.org_id AND p.user_id=r.user_id
 JOIN intel_telegram_links l ON l.org_id=r.org_id AND l.user_id=r.user_id AND l.status='active' AND l.allows_private_alerts
 WHERE r.id=NEW.rule_id AND r.org_id=NEW.org_id AND p.telegram_enabled AND p.consent_at<=NEW.fired_at AND NEW.fired_at>now()-interval '5 minutes'
 AND (NEW.private_owner_id IS NULL OR NEW.private_owner_id=r.user_id)
 AND EXISTS(SELECT 1 FROM org_members m WHERE m.org_id=r.org_id AND m.user_id=r.user_id) AND can_access_intel(r.user_id,r.org_id)
 ON CONFLICT(event_id,channel,user_id) DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_queue_alert_delivery() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_queue_alert_delivery AFTER INSERT ON public.intel_alert_events FOR EACH ROW EXECUTE FUNCTION app_private.intel_queue_alert_delivery();

CREATE FUNCTION public.intel_claim_alert_deliveries(p_limit integer DEFAULT 10) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE d intel_alert_deliveries; token uuid; result jsonb:='[]';BEGIN
 -- An uncertain previous send is never automatically repeated: Telegram has no idempotency key.
 UPDATE intel_alert_delivery_attempts a SET outcome='unknown',finished_at=now(),reason='lease_expired_after_send_may_have_started'
 FROM (SELECT * FROM intel_alert_deliveries WHERE state='sending' AND lease_until<now() ORDER BY lease_until,id LIMIT 100) stale WHERE a.delivery_id=stale.id AND a.lease_id=stale.lease_id AND a.outcome='sending';
 UPDATE intel_alert_deliveries SET state='unknown',reason='lease_expired_after_send_may_have_started',lease_id=NULL,lease_until=NULL WHERE id IN (SELECT id FROM intel_alert_deliveries WHERE state='sending' AND lease_until<now() ORDER BY lease_until,id LIMIT 100);
 UPDATE intel_alert_deliveries SET state='expired',reason='delivery_window_expired' WHERE id IN (SELECT id FROM intel_alert_deliveries WHERE state='queued' AND expires_at<=now() ORDER BY expires_at,id LIMIT 100);
 FOR d IN SELECT * FROM intel_alert_deliveries WHERE state='queued' AND next_attempt_at<=now() AND expires_at>now() ORDER BY next_attempt_at,id LIMIT greatest(1,least(coalesce(p_limit,10),20)) FOR UPDATE SKIP LOCKED LOOP
  IF NOT EXISTS(SELECT 1 FROM intel_alert_delivery_preferences p JOIN intel_telegram_links l ON l.id=d.link_id AND l.org_id=d.org_id AND l.user_id=d.user_id WHERE p.rule_id=d.rule_id AND p.user_id=d.user_id AND p.org_id=d.org_id AND p.telegram_enabled AND l.status='active' AND l.allows_private_alerts)
   OR NOT EXISTS(SELECT 1 FROM org_members m WHERE m.org_id=d.org_id AND m.user_id=d.user_id) OR NOT can_access_intel(d.user_id,d.org_id) THEN
   UPDATE intel_alert_deliveries SET state='cancelled',reason='consent_link_or_access_revoked' WHERE id=d.id;CONTINUE;
  END IF;
  IF d.attempt_count>=3 THEN UPDATE intel_alert_deliveries SET state='failed',reason='retry_limit' WHERE id=d.id;CONTINUE;END IF;
  token:=gen_random_uuid();
  UPDATE intel_alert_deliveries SET state='sending',attempt_count=attempt_count+1,lease_id=token,lease_until=now()+interval '3 minutes' WHERE id=d.id;
  INSERT INTO intel_alert_delivery_attempts(delivery_id,org_id,user_id,attempt,lease_id) VALUES(d.id,d.org_id,d.user_id,d.attempt_count+1,token);
  result:=result||jsonb_build_array(jsonb_build_object('id',d.id,'lease',token));
 END LOOP;RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.intel_claim_alert_deliveries(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_claim_alert_deliveries(integer) TO service_role;

-- Recheck immediately before transport. Never expose a Telegram destination to product reads.
CREATE FUNCTION public.intel_alert_delivery_target(p_id uuid,p_lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;BEGIN
 SELECT jsonb_build_object('chatId',l.telegram_user_id,'eventId',e.id,'firedAt',e.fired_at,'trigger',r.trigger_type,'title',coalesce(e.payload->>'title',e.payload->'config'->>'title',r.trigger_type)) INTO result
 FROM intel_alert_deliveries d JOIN intel_alert_events e ON e.id=d.event_id JOIN intel_alert_rules r ON r.id=d.rule_id AND r.org_id=d.org_id AND r.user_id=d.user_id
 JOIN intel_alert_delivery_preferences p ON p.rule_id=d.rule_id AND p.user_id=d.user_id AND p.org_id=d.org_id
 JOIN intel_telegram_links l ON l.id=d.link_id AND l.org_id=d.org_id AND l.user_id=d.user_id
 WHERE d.id=p_id AND d.lease_id=p_lease AND d.state='sending' AND d.lease_until>now() AND d.expires_at>now() AND p.telegram_enabled AND l.status='active' AND l.allows_private_alerts
 AND (e.private_owner_id IS NULL OR e.private_owner_id=d.user_id)
 AND EXISTS(SELECT 1 FROM org_members m WHERE m.org_id=d.org_id AND m.user_id=d.user_id) AND can_access_intel(d.user_id,d.org_id);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.intel_alert_delivery_target(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_alert_delivery_target(uuid,uuid) TO service_role;

CREATE FUNCTION public.intel_finish_alert_delivery(p_id uuid,p_lease uuid,p_outcome text,p_http integer DEFAULT NULL,p_message text DEFAULT NULL,p_retry_seconds integer DEFAULT 60) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE d intel_alert_deliveries;v_outcome text;BEGIN
 IF p_outcome NOT IN ('provider_accepted','retry','failed','unknown','cancelled') OR p_http IS NOT NULL AND p_http NOT BETWEEN 100 AND 599 OR length(coalesce(p_message,''))>100 THEN RAISE EXCEPTION 'invalid_delivery_result';END IF;
 SELECT * INTO d FROM intel_alert_deliveries WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR d.lease_id IS DISTINCT FROM p_lease OR d.state<>'sending' THEN RETURN false;END IF;
 v_outcome:=CASE WHEN p_outcome='retry' AND d.attempt_count>=3 THEN 'failed' ELSE p_outcome END;
 UPDATE intel_alert_delivery_attempts SET outcome=v_outcome,finished_at=now(),http_status=p_http,provider_message_id=p_message WHERE delivery_id=p_id AND lease_id=p_lease AND finished_at IS NULL;
 UPDATE intel_alert_deliveries SET state=CASE WHEN v_outcome='retry' THEN 'queued' ELSE v_outcome END,
 next_attempt_at=now()+make_interval(secs=>greatest(60*power(2,d.attempt_count-1)::integer,least(coalesce(p_retry_seconds,60),3600))),lease_id=NULL,lease_until=NULL,
 reason=CASE WHEN v_outcome='unknown' THEN 'provider_outcome_unknown_no_automatic_retry' WHEN v_outcome='failed' THEN 'provider_rejected_or_retry_limit' WHEN v_outcome='cancelled' THEN 'consent_link_or_access_revoked' ELSE NULL END WHERE id=p_id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.intel_finish_alert_delivery(uuid,uuid,text,integer,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_finish_alert_delivery(uuid,uuid,text,integer,text,integer) TO service_role;
