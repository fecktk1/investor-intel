-- Internal retry tombstones contain identifiers only. Explicit service policy
-- documents this access boundary without exposing them through the Data API.
CREATE POLICY chart_alert_operations_internal ON public.intel_chart_alert_operations
 FOR ALL TO service_role USING(true) WITH CHECK(true);
