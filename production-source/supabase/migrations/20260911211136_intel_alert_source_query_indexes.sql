CREATE INDEX intel_supply_alert_identity_time ON public.stablecoin_supply_snapshots((raw_response->>'gecko_id'),chain,ts DESC) WHERE provider='defillama';
CREATE INDEX intel_wallet_alert_owner_time ON public.large_transfer_events(org_id,user_id,chain,wallet_address,observed_at DESC,id);
CREATE INDEX intel_metadata_alert_identity_time ON public.metadata_drift_events(canonical_ref_key,occurred_at DESC,id);
