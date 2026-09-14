-- No backfill: existing authored words, evidence and activity remain unchanged.
CREATE OR REPLACE FUNCTION public.intel_valid_invalidation(p_text text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT coalesce(length(btrim(p_text))>=12 AND p_text ~ '[[:alpha:]]'
   AND btrim(p_text) !~* '^(tbd|todo|none|n/?a|not (sure|applicable|known)|to be (decided|determined))([[:space:][:punct:]]|$)',false)
$$;
REVOKE ALL ON FUNCTION public.intel_valid_invalidation(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_valid_invalidation(text) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.intel_guard_thesis_activation()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE must_check boolean:=false;
BEGIN
 IF NEW.status NOT IN ('active','strengthening','weakening','needs_review') THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN must_check:=true;
 ELSE
   must_check:=OLD.status IN ('draft','closed','archived','invalidated','confirmed','partially_confirmed')
     OR (NEW.status='active' AND NEW.status IS DISTINCT FROM OLD.status)
     OR ROW(NEW.title,NEW.stance,NEW.conviction,NEW.bull_thesis,NEW.bear_thesis,NEW.neutral_thesis,NEW.authored_draft,NEW.what_would_invalidate,NEW.what_would_confirm,NEW.subject_canonical_key,NEW.entity_id)
       IS DISTINCT FROM ROW(OLD.title,OLD.stance,OLD.conviction,OLD.bull_thesis,OLD.bear_thesis,OLD.neutral_thesis,OLD.authored_draft,OLD.what_would_invalidate,OLD.what_would_confirm,OLD.subject_canonical_key,OLD.entity_id);
 END IF;
 IF must_check AND NOT public.intel_valid_invalidation(NEW.what_would_invalidate) THEN
   RAISE EXCEPTION 'Invalidated if: describe a specific condition (at least 12 characters) before activating or editing an active thesis. Incomplete work can be saved as a draft.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_guard_thesis_activation() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_guard_thesis_activation BEFORE INSERT OR UPDATE ON public.intel_theses
 FOR EACH ROW EXECUTE FUNCTION app_private.intel_guard_thesis_activation();
