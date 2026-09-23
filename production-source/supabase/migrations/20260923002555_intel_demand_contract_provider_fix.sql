-- Wallet holding demands were recorded with provider 'coinmarketcap' and a
-- contract id ('<chain>:0x...'). intel_recently_discovered looks a coinmarketcap
-- demand up by its numeric CMC id, so every such row showed as a bare address.
-- intel-portfolio-identity now records them as 'contract' (the resolver's own
-- form); this relabels the rows already written. Idempotent.
-- Applied with MCP apply_migration; the ledger version is 20260923002555.
UPDATE public.market_asset_demand
   SET provider = 'contract'
 WHERE provider = 'coinmarketcap'
   AND provider_id ~* '^[a-z0-9-]+:0x[0-9a-f]{6,}$';
