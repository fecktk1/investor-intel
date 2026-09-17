-- Investor Intel: trigram indexes so the Markets typeahead can match a symbol or
-- a project name without scanning the catalogue on every keystroke.
--
-- WHY. The new `op: 'suggest'` read on intel-markets answers typed text from
-- `market_assets` alone (no provider call, free `market_boards` surface). It runs
-- three bounded probes: an equality read on normalized_symbol, `symbol ILIKE
-- 'typed%'` and `name ILIKE '%typed%'`.
--
-- The catalogue already carries market_assets_norm (btree on normalized_symbol),
-- which serves the first probe, and market_assets_sym_search /
-- market_assets_name_search (btree on lower(symbol) / lower(name)). Those two
-- CANNOT serve the other probes: this database collates en_US.UTF-8, where a
-- plain btree supports neither LIKE 'x%' nor ILIKE at all. pg_trgm is already
-- installed (public schema), and a GIN trigram index is what ILIKE can actually
-- use, prefix and contains alike.
--
-- The btree function indexes are LEFT IN PLACE: they serve exact lower(symbol) /
-- lower(name) equality reads elsewhere and this migration does not claim to know
-- every caller. This is additive.
--
-- COST. market_assets is ~3.5k rows, so both indexes build in well under a
-- second and the table is not locked long enough for a reader to notice. The
-- lock_timeout is the guard for the case where something else holds the table.
--
-- Rollback:
--   DROP INDEX IF EXISTS public.market_assets_symbol_trgm;
--   DROP INDEX IF EXISTS public.market_assets_name_trgm;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- `symbol ILIKE 'typed%'` — the ticker half of the typeahead.
CREATE INDEX IF NOT EXISTS market_assets_symbol_trgm
  ON public.market_assets USING gin (symbol public.gin_trgm_ops);

-- `name ILIKE '%typed%'` — the project-name half, which is a contains match so
-- that "solana" finds "Solana" and "Wrapped Solana" alike.
CREATE INDEX IF NOT EXISTS market_assets_name_trgm
  ON public.market_assets USING gin (name public.gin_trgm_ops);

COMMENT ON INDEX public.market_assets_symbol_trgm IS
  'Trigram index for the Markets typeahead symbol probe (intel-markets op=suggest). ILIKE cannot use a btree under en_US.UTF-8.';
COMMENT ON INDEX public.market_assets_name_trgm IS
  'Trigram index for the Markets typeahead name probe (intel-markets op=suggest). Supports the contains match, not just a prefix.';

COMMIT;
