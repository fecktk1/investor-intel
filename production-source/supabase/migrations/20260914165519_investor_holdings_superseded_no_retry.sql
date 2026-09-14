-- investor_replace_holdings raised portfolio_calculation_superseded with SQLSTATE
-- 40001 (serialization_failure). PostgREST retries a transaction that fails with
-- 40001, and a superseded calculation can never succeed on retry, so one
-- portfolio-sync request retried continuously from about 2026-09-12 23:00 UTC:
-- roughly 100 rolled-back transactions a second, 96% of all transactions.
-- PT409 is not retried; PostgREST returns it as HTTP 409. The current definition
-- is re-created with only this code replaced, so the body and grants are unchanged.
DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.investor_replace_holdings(uuid,timestamptz,jsonb,jsonb)'::regprocedure);
  retryable constant text := $code$ERRCODE='40001'$code$;
BEGIN
  IF (length(definition) - length(replace(definition, retryable, ''))) / length(retryable) <> 1 THEN
    RAISE EXCEPTION 'investor_replace_holdings no longer has exactly one retryable superseded error';
  END IF;
  EXECUTE replace(definition, retryable, $code$ERRCODE='PT409'$code$);
END
$migration$;
