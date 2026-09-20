-- Nightly retention for the hosted MCP audit trail (owner decision 2026-09-20).
-- intel_mcp_audit_sweep(90) deletes call-audit rows older than 90 days and daily usage counters older than 90 days.
-- Pure database maintenance: no Edge Function, no provider call, zero credits. Idempotent: unscheduled by name first.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT cron.unschedule('intel-mcp-audit-sweep-nightly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-mcp-audit-sweep-nightly');
SELECT cron.schedule('intel-mcp-audit-sweep-nightly', '23 4 * * *', $$SELECT public.intel_mcp_audit_sweep(90);$$);
COMMIT;
