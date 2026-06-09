# Investor Intel Portfolio Tracker — Rebuild (deploy runbook + final output)

Branch: `feat/investor-intel`. Read-only tracker. Server-side keys only. Built and verified
locally (54 Deno unit tests pass, edge/worker typecheck, frontend `vite build` passes). **Not yet
deployed / DB-applied.**

## 1. Files changed / added

**Migrations (new):** `supabase/migrations/183_investor_intel_canonical_key.sql` →
`191_investor_intel_data_preservation.sql` (9 files).

**New shared backend modules**
- `supabase/functions/_shared/investor-portfolio/canonical.ts` (+ `canonical.test.ts`) — canonical asset key.
- `supabase/functions/_shared/investor-portfolio/classify/` — `types.ts`, `registry.ts`, `group.ts`, `solana.ts`, `evm.ts`, `index.ts` (+ `classify.test.ts`) — deterministic classifier.
- `supabase/functions/_shared/investor-portfolio/metadata-resolver.ts` (+ `metadata-resolver.test.ts`).
- `supabase/functions/_shared/investor-portfolio/assemble-txns.ts` — cost-basis tx assembler (no double-count).
- `supabase/functions/_shared/portfolio-providers/` — `types.ts`, `config.ts`, `http.ts`, `cache.ts`, `registry.ts`, `helius.ts`, `alchemy.ts`, `etherscan.ts`, `index.ts`, `capability-probe.ts` (+ `adapters.test.ts`).

**Edited backend**
- `_shared/chains.ts` + `src/intel/lib/chains.js` — chain registry evolved (all Alchemy chains, support levels, explorer URLs, helpers).
- `_shared/investor-portfolio/{types.ts,holdings.ts}` — canonical-key dedupe, overrides, balance-only P&L withholding, new fields.
- `_shared/wallet-balance.ts` — `resolveSolanaRpcUrl` derives Helius URL from `HELIUS_API_KEY`.
- `supabase/functions/portfolio-sync/index.ts` — Alchemy EVM balances, canonical keys, support levels, overrides, `backfill_solana`/`backfill_evm` enqueue.
- `supabase/functions/intel-portfolio/index.ts` — normalized fact-pack + coverage disclosures + tightened guardrails.
- `worker/src/portfolio-sync-jobs.ts` — Helius/Alchemy/Etherscan transfer paging → group → classify → grouped tx + line items (preserves `user_corrected`) → recompute.

**New edge function:** `supabase/functions/portfolio-capability-probe/index.ts`.

**Frontend:** `src/intel/lib/{portfolio-api.js,chains.js,canonical.js}`, `src/intel/pages/PortfolioPage.jsx`, `src/intel/components/WalletSyncPanel.jsx`.

**Test-fixture fix:** `_shared/investor-portfolio/transactions.test.ts` (pre-existing 41-hex address typo → 40).

## 2. Migration order (apply 183 → 191, in order; 191 last)
183 canonical-key SQL fn · 184 chain_capabilities evolve + `investor_chain_capability_audit` · 185 holdings canonical columns + `iph_unique_holding_v2` (partial) · 186 grouped `investor_portfolio_tx` + line items + tx_id link + extended type CHECK · 187 `asset_metadata_cache` · 188 `asset_price_history` · 189 `investor_portfolio_cost_basis_overrides` · 190 `investor_portfolio_sync_cursors` + job-mode CHECK + `provider_api_usage_logs` · 191 backup-then-reset.

## 3. Migration 191 — data preservation + restore SQL
191 runs in one transaction: backs up re-derivable synced rows to `investor_portfolio_holdings_backup_191` and `investor_portfolio_transactions_backup_191`, deletes only synced (non-manual, non-`user_corrected`) flat txns + all holdings (a derived cache), backfills canonical keys, resets cursors/source status, and **asserts** manual txns + cost-basis overrides + AI memory counts are unchanged before COMMIT.

**Preserved (untouched):** manual transactions, manual holdings (re-derived from manual txns), `investor_portfolio_cost_basis_overrides`, `user_corrected` rows, holding alerts, `investor_portfolio_memory`.

**Restore (idempotent):**
```sql
INSERT INTO investor_portfolio_holdings (org_id,user_id,portfolio_id,asset_symbol,normalized_symbol,
  canonical_asset_key,contract_address,mint_or_contract,chain,asset_class,name,logo_url,verified,decimals,
  support_level,provider,provider_network,cost_basis_status,quantity,average_cost,cost_basis_usd,current_price,
  current_value,price_source,price_status,last_priced_at,unrealized_pnl,unrealized_pnl_pct,realized_pnl,day_pnl,
  day_pnl_pct,allocation_pct,pnl_state,reconciliation_status,market_context,is_dust,last_synced_at,updated_at)
SELECT org_id,user_id,portfolio_id,asset_symbol,normalized_symbol,canonical_asset_key,contract_address,
  mint_or_contract,chain,asset_class,name,logo_url,verified,decimals,support_level,provider,provider_network,
  cost_basis_status,quantity,average_cost,cost_basis_usd,current_price,current_value,price_source,price_status,
  last_priced_at,unrealized_pnl,unrealized_pnl_pct,realized_pnl,day_pnl,day_pnl_pct,allocation_pct,pnl_state,
  reconciliation_status,market_context,is_dust,last_synced_at,updated_at
FROM investor_portfolio_holdings_backup_191
ON CONFLICT (portfolio_id, canonical_asset_key) WHERE canonical_asset_key IS NOT NULL DO NOTHING;

INSERT INTO investor_portfolio_transactions (id,org_id,user_id,portfolio_id,source_id,transaction_type,
  original_transaction_type,classification_status,confidence_score,direction,asset_symbol,normalized_symbol,
  canonical_asset_id,contract_address,chain,quantity,price_per_unit,quote_currency,total_value,fee_amount,
  fee_currency,external_tx_signature,external_tx_hash,"timestamp",notes,tags,raw_metadata,created_at,updated_at)
SELECT id,org_id,user_id,portfolio_id,source_id,transaction_type,original_transaction_type,classification_status,
  confidence_score,direction,asset_symbol,normalized_symbol,canonical_asset_id,contract_address,chain,quantity,
  price_per_unit,quote_currency,total_value,fee_amount,fee_currency,external_tx_signature,external_tx_hash,
  "timestamp",notes,tags,raw_metadata,created_at,updated_at
FROM investor_portfolio_transactions_backup_191
ON CONFLICT (id) DO NOTHING;
```
(Re-running is a no-op via `ON CONFLICT DO NOTHING`. Drop the `_backup_191` tables once the re-sync is confirmed good.)

## 4. Env vars + EXACTLY where to set them
Server-side only — **never** `VITE_`, never in the browser.

| Var | Where |
|---|---|
| `HELIUS_API_KEY` | Supabase secrets **and** Railway worker service |
| `ALCHEMY_API_KEY` | Supabase secrets **and** Railway worker service |
| `ETHERSCAN_API_KEY` | Supabase secrets **and** Railway worker service |

**Supabase secrets:**
```
supabase secrets set HELIUS_API_KEY=...   ALCHEMY_API_KEY=...   ETHERSCAN_API_KEY=...
```
(same key bodies used by `portfolio-sync`, `intel-portfolio`, `portfolio-capability-probe` — no per-function keys.)

**Railway worker variables** (the service that runs `worker/src/index.ts`): add `HELIUS_API_KEY`, `ALCHEMY_API_KEY`, `ETHERSCAN_API_KEY` (worker does transfer paging + DAS metadata + recompute).

**Netlify:** none. The frontend calls only Supabase; it never talks to a provider.

**Optional config (defaults shown; not required):** `PORTFOLIO_SOLANA_PROVIDER=helius`, `PORTFOLIO_EVM_PROVIDER=alchemy`, `PORTFOLIO_EVM_FALLBACK_PROVIDER=etherscan`, `PORTFOLIO_SYNC_MAX_HISTORY_PAGES=10`, `PORTFOLIO_SYNC_CACHE_TTL_SECONDS=300`, `PORTFOLIO_ENABLE_FULL_SOLANA_BACKFILL=false`, `HELIUS_DAS_MAX_PER_SEC=8`, `HELIUS_RPC_MAX_PER_SEC=40`, `ETHERSCAN_MAX_PER_SEC=4`, `ALCHEMY_MAX_CU_PER_MIN=30000`, `ENABLE_{HELIUS,ALCHEMY,ETHERSCAN}_PORTFOLIO=true`, `PORTFOLIO_PROBE_ADDR_<CHAIN>=<addr>` (override probe wallets). Placeholders added to `supabase/.env.example` / `worker/.env.example` (see §10 TODO).

## 5. DB-first + which actions hit providers
- **Page load is DB-first.** `portfolio-api.js` reads Supabase tables only; `intel-portfolio` reads DB only. **No provider call ever happens on render.** Stale data shows `last_synced_at` + a manual-sync button.
- **Only two paths call Helius/Alchemy/Etherscan:** (a) manual "Sync now" (`portfolio-sync`, 15-min cooldown, balances + enqueue), (b) the scheduled Railway worker (transfer history + metadata + recompute). Plus the capability probe (deploy + daily).

## 6. Provider endpoints implemented
- **Helius** (`mainnet.helius-rpc.com/?api-key=`): `getBalance`, `getTokenAccountsByOwner` (balances); `getTransfersByAddress` (solMode merged, paginationToken); `getTransactionsForAddress` (full, gated — program hints); DAS `getAssetBatch` (metadata).
- **Alchemy**: Tokens-By-Wallet `POST /data/v1/{key}/assets/tokens/by-address` (balances+metadata+prices, pageKey); `alchemy_getAssetTransfers` (dual from/to, pageKey, category-gated); `alchemy_getTokenMetadata`; Prices `by-address` + `historical`.
- **Etherscan V2** (`api.etherscan.io/v2/api?chainid=`): `account.balance` (native only — `addresstokenbalance` is PRO, not used on Lite), `txlist`, `tokentx`, `txlistinternal` (block-range windowing). Fallback/verifier.

## 7. Provider usage logging
`provider_api_usage_logs` (migration 190): provider, redacted endpoint, chain, source_id, portfolio_id, org_id, job_name, **wallet_hash** (salted sha256, never raw), request_count, est_credits_or_cu, cache_status, error_or_suppression_reason. **No API keys or full URLs are ever stored** (redaction in `http.ts`). Per-context call+credit budgets and per-provider sliding-window rate buckets enforce caps with graceful degradation.

## 8. Supported chains by support level (per-chain reasoning)
The `portfolio-capability-probe` sets levels at runtime in `investor_chain_capability_audit` from real probe results; migration 184 seeds conservative starting levels. **No silent promotion** — `full_history_pnl` only when balances + metadata + current price + tx history + historical price all verify. Buckets reported by the probe:
- **full-history-P&L verified** (target): Solana (Helius), Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, BNB (Alchemy + Etherscan). Extended EVM (HyperEVM, Sei-EVM, Sonic, Metis, Linea, Scroll, Mantle, Gnosis, Celo, zkSync, Blast, opBNB) promote here when the probe confirms them, else degrade to beta/balance-only.
- **balance-only / beta verified:** Sui, Aptos, Bitcoin, Tron (Alchemy balances; no parsed tx in stack → no P&L).
- **coming-soon / unsupported:** Stellar, Injective, NEAR, TON, XRPL, Zcash, Taiko, XDC, Moonbeam, Moonriver (no provider in stack for portfolio balances, or no Lite token-balance source).
- **probe inconclusive:** any chain whose probe wallet returns thin data — holds its starting level (never wrongly downgraded). The probe's `summary` lists final counts per bucket.

UI clarifications: **HyperEVM** = EVM wallet support only (HyperCore trading needs a later adapter); **Sei** = EVM-style, not Cosmos-native Sei.

## 9. Preserved existing actions (verified)
Manual Add Transaction (flat table), CSV export (holdings + activity), readable manual/imported entries, holding alerts (untouched by 191), delete portfolio/source (FK cascades extend to the new tables), Portfolio Intelligence (now grounded only in normalized data) — all retained. Cost basis reads synced line items (non-mirror) + manual flat rows (disjoint sets) so a manual entry counts exactly once.

## 10. Deploy steps
1. Add placeholders to `supabase/.env.example` + `worker/.env.example` (TODO if not yet present); set real values locally in your env file.
2. `supabase secrets set HELIUS_API_KEY=… ALCHEMY_API_KEY=… ETHERSCAN_API_KEY=…`
3. Railway worker service vars: add the same three.
4. Netlify: nothing.
5. Apply migrations 183→191 (`supabase db push`).
6. `supabase functions deploy portfolio-sync intel-portfolio portfolio-capability-probe`
7. Redeploy/restart the Railway worker.
8. `npm run build` + deploy the frontend.
9. Invoke the probe once: `POST /functions/v1/portfolio-capability-probe` with `x-cron-secret: $CRON_SECRET`; optionally add a daily pg_cron for it.
10. Trigger a recompute for existing portfolios (next user "Sync now" or a one-off `portfolio-sync` recompute) so wiped holdings repopulate with canonical keys.
**Canary on DirtyDegens first, then bulk.**

## 11. Local test steps
- `deno test --allow-env supabase/functions/_shared/investor-portfolio/ supabase/functions/_shared/portfolio-providers/` → 54 pass.
- `deno check` on `portfolio-sync`, `intel-portfolio`, `portfolio-capability-probe`, and (with `--config worker/deno.json`) `worker/src/portfolio-sync-jobs.ts`.
- `npm run build` (frontend) · `npm run i18n:check` (locale coverage).
- localhost:5173 → `/intel/portfolio`: add a real Solana + EVM wallet, Sync, confirm one SOL row, named SPL tokens, grouped swaps, no permanent "Classify…", balance-only chains show value but no P&L.

## 12. Known limitations / follow-ups
- **Needs a later chain-specific adapter:** HyperCore (Hyperliquid spot/perps), Cosmos-native Sei, Stellar, Injective, and parsed tx history for Sui/Aptos/Bitcoin/Tron (balance-only today, shown honestly).
- **Historical price backfill** for `price_usd_at_tx` is not yet populated by the worker (line items insert with null price → swaps without a price show "cost basis incomplete", honestly). Wiring Alchemy historical into the worker is a clean follow-up (`asset_price_history` + `fetchHistoricalPrice` already exist).
- **Paid tiers later:** Etherscan `addresstokenbalance` (PRO) would give EVM token balances without Alchemy; higher Alchemy/Helius tiers if CU/credit usage grows (watch `provider_api_usage_logs`). Etherscan free record cap drops 10k→1k on 2026-07-01 (Lite retains 10k; block-range windowing built regardless).
- **Demo showroom + i18n:** the live tracker renders the new UX; new `portfolio.*` strings use in-code English defaults (i18next falls back for untranslated locales, matching the repo's existing partial coverage). Lifting them into the 8 locale files + upgrading the `/demo` PortfolioSection fixtures to the new normalized shape are remaining polish (the demo is not broken — it renders the prior layout).
- **Webhooks** (Alchemy/Helius) intentionally deferred; manual + scheduled worker sync is sufficient.

## 13. Improved UX (summary)
Holdings: one row per asset (native SOL + WSOL + multi-wallet + multi-account merged via canonical key), logo + full name + chain + support badge, price/24h/value/allocation, cost-basis status, P&L only when reliable (never fake $0). Transactions: one clean row per signature/hash, readable type + title with real asset names, expandable line items (in/out amounts, value@tx) + explorer link; no permanent "Classify…" — only Processing / Unknown (named) / Needs-review, with an in-row "Set type". Wallet import: chains grouped by Full / Beta / Balance-only / Coming-soon with honest notes (incl. HyperEVM/Sei).
