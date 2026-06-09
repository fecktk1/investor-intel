-- ============================================================
-- 199: Seed high-confidence chains at full_history_pnl
-- ============================================================
-- Migration 184 seeded EVERY chain at balance_only / inconclusive, pending the
-- portfolio-capability-probe. But the probe has no cron (must be triggered by
-- hand) and, until the fix shipped alongside this migration, structurally could
-- not promote Solana (it required a historical-price API that Solana doesn't use
-- — Solana cost basis is derived from on-chain swap legs). Net effect: every
-- chain stayed balance_only, so holdings.ts withheld P&L for ALL chains.
--
-- These chains have verified full support in our stack — Helius (Solana) and
-- Alchemy + Etherscan V2 (the EVM majors) — so we seed them at full_history_pnl
-- per the original plan's high-confidence list. This is a deliberate, auditable
-- seed (not a silent probe promotion); the probe can still DEGRADE any of them
-- at runtime if a provider call later fails. Holdings pick up the new level on
-- the next sync / worker recompute (which read this table).
-- ============================================================

-- EVM majors (Alchemy balances+metadata+prices+transfers+historical, Etherscan fallback)
UPDATE investor_chain_capability_audit SET
  support_level = 'full_history_pnl', probe_status = 'verified', provider_checked = 'alchemy',
  balance_supported = true, metadata_supported = true, current_price_supported = true,
  tx_history_supported = true, historical_price_supported = true, cost_basis_supported = true,
  caveat = 'seeded high-confidence (Alchemy + Etherscan verified in stack)', last_checked_at = now()
WHERE chain IN ('ethereum','base','arbitrum','optimism','polygon','avalanche','bnb');

-- Solana (Helius balances+DAS metadata+transfers; cost basis from on-chain swap
-- legs, so the historical-price API is N/A rather than a failure).
UPDATE investor_chain_capability_audit SET
  support_level = 'full_history_pnl', probe_status = 'verified', provider_checked = 'helius',
  balance_supported = true, metadata_supported = true, current_price_supported = true,
  tx_history_supported = true, historical_price_supported = null, cost_basis_supported = true,
  caveat = 'seeded high-confidence (Helius; cost basis from on-chain swaps)', last_checked_at = now()
WHERE chain = 'solana';
