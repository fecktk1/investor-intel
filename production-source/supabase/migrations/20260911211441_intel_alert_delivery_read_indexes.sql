CREATE INDEX intel_alert_deliveries_user ON public.intel_alert_deliveries(user_id);
CREATE INDEX intel_alert_attempts_user ON public.intel_alert_delivery_attempts(user_id);
CREATE INDEX intel_alert_preferences_org ON public.intel_alert_delivery_preferences(org_id);
CREATE INDEX intel_alert_preferences_user ON public.intel_alert_delivery_preferences(user_id);
ALTER POLICY owner_read ON public.intel_alert_delivery_preferences USING(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_alert_delivery_preferences.org_id AND m.user_id=(SELECT auth.uid())));
ALTER POLICY owner_read ON public.intel_alert_deliveries USING(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_alert_deliveries.org_id AND m.user_id=(SELECT auth.uid())));
ALTER POLICY owner_read ON public.intel_alert_delivery_attempts USING(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_alert_delivery_attempts.org_id AND m.user_id=(SELECT auth.uid())));
