-- Thesis descriptions are existing authored records, not short generic names.
-- Preserve the complete condition and its trigger receipt without truncation.
DO $$ DECLARE original text;updated text;BEGIN
 original:=pg_get_functiondef('app_private.intel_market_rule_guard()'::regprocedure);
 updated:=replace(original,'length(coalesce(NEW.config->>''title'',''''))>120','(NEW.trigger_type<>''thesis_condition'' AND length(coalesce(NEW.config->>''title'',''''))>120)');
 IF updated=original THEN RAISE EXCEPTION 'unexpected_market_rule_text_guard';END IF;EXECUTE updated;
END $$;
