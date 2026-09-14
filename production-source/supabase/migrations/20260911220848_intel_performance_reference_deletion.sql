-- Preserve immutable assessments while allowing an authorized parent deletion
-- to clear its foreign-key reference. User-authored words remain immutable.
DO $$ DECLARE original text;updated text;needle text;replacement text;BEGIN
 original:=pg_get_functiondef('app_private.intel_performance_review_guard()'::regprocedure);
 needle:='IF OLD.performance_evaluation IS NOT NULL OR NEW.performance_evaluation IS NOT NULL THEN RAISE EXCEPTION ''performance_review_immutable_create_new_version'';END IF;RETURN NEW;';
 replacement:=$patch$IF OLD.performance_evaluation IS NOT NULL OR NEW.performance_evaluation IS NOT NULL THEN
   IF pg_trigger_depth()>1
    AND (NEW.ai_artifact_id IS NOT DISTINCT FROM OLD.ai_artifact_id OR NEW.ai_artifact_id IS NULL)
    AND (NEW.snapshot_id IS NOT DISTINCT FROM OLD.snapshot_id OR NEW.snapshot_id IS NULL)
    AND (NEW.ai_artifact_id IS DISTINCT FROM OLD.ai_artifact_id OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id)
    AND (to_jsonb(NEW)-ARRAY['ai_artifact_id','snapshot_id','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['ai_artifact_id','snapshot_id','updated_at']) THEN RETURN NEW;END IF;
   RAISE EXCEPTION 'performance_review_immutable_create_new_version';
  END IF;RETURN NEW;$patch$;
 updated:=replace(original,needle,replacement);
 IF updated=original THEN RAISE EXCEPTION 'unexpected_performance_review_guard';END IF;EXECUTE updated;
END $$;
