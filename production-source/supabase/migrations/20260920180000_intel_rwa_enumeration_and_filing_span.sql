-- ============================================================
-- Investor Intel: honest RWA enumeration counts and honest EDGAR filing spans
-- ============================================================
-- Six nullable columns on two existing tables. No new table, no new grant, no new policy, no cron change. Every column
-- exists so a number this platform already prints can say what it does NOT establish.
--
-- WHY, AND BOTH REASONS WERE MEASURED IN PRODUCTION ON 2026-09-20.
--
-- 1. intel_rwa_asset_map_counts stored stock 1000, etf 1000, all 2004. Those are not counts: they are the page ceiling
--    of the enumeration (MAP_PAGES_PER_TYPE 4 x MAP_PAGE 250), and the provider's own `total_size` on the list endpoint
--    reports 4,812 stocks and 3,126 ETFs. A count pinned at a page ceiling and printed as a total is exactly the
--    failure this table was created to replace. The lane now pages to a 40-page safety ceiling, and where a type still
--    reaches it the row SAYS SO, so the board prints "at least N".
--      pages_read  how many pages the count was built from. A plain fact about the capture.
--      truncated   the type reached the page ceiling with a FULL last page, so the count is a floor. NULL on rows
--                  written before this column existed, because those rows cannot answer the question either way.
--
-- 2. intel_rwa_underlying_registrants stored BANK OF AMERICA CORP and JPMORGAN CHASE & CO with no annual and no
--    quarterly filing date at all, while filers that lodge few documents carried theirs. EDGAR's `filings.recent`
--    block holds about a thousand entries; a bank filing thousands of 424B2 prospectus supplements a year pushes its
--    own 10-K and 10-Q straight out of it. Sorted by "days since the last periodic filing", the two largest banks in
--    the United States would have led this board as its most delinquent filers. They are not late. We did not look far
--    enough back, and without the span below that distinction cannot be made from a stored row at all.
--      recent_filings_count  entries the `recent` block carried.
--      recent_oldest_date    the earliest filing date in it. A block that starts INSIDE a form's own filing window
--                            cannot be evidence that the form was never filed, and the read view turns that into the
--                            state `not_in_read_filings` rather than into lateness.
--      recent_newest_date    the latest filing date in it.
--      older_pages_read      how many of the older `CIK##########-submissions-NNN.json` pages were followed for this
--                            filer (at most 2, and only when the recent block was too short to settle the question).
--
-- NOTHING EXPIRES ON A CLOCK HERE. recent_oldest_date and recent_newest_date describe what a read COVERED; they are
-- not review dates, not deadlines and not validity windows, and no row becomes stale because of them.
--
-- SAFETY. Additive and idempotent: ADD COLUMN IF NOT EXISTS only, every column NULLABLE with no default, so no row is
-- rewritten and no existing SELECT, constraint, index or policy changes. The tables stay service-role only; the
-- existing REVOKE/GRANT already cover every column of each table and are not restated.
--
-- ORDER OF DEPLOY: this migration first, then the `intel-capture` Edge Function. The function writes these columns; a
-- function deployed first would fail its writes on the two tables until the columns exist.
--
-- ROLLBACK (manual, destructive to the new columns only):
--   ALTER TABLE public.intel_rwa_asset_map_counts DROP COLUMN IF EXISTS pages_read, DROP COLUMN IF EXISTS truncated;
--   ALTER TABLE public.intel_rwa_underlying_registrants
--     DROP COLUMN IF EXISTS recent_filings_count, DROP COLUMN IF EXISTS recent_oldest_date,
--     DROP COLUMN IF EXISTS recent_newest_date, DROP COLUMN IF EXISTS older_pages_read;

BEGIN;
SET LOCAL lock_timeout = '5s';

-- SECTION 1: the enumeration says whether it finished

ALTER TABLE public.intel_rwa_asset_map_counts
  ADD COLUMN IF NOT EXISTS pages_read integer,
  ADD COLUMN IF NOT EXISTS truncated boolean;

COMMENT ON COLUMN public.intel_rwa_asset_map_counts.pages_read IS
  'How many rwaMap pages this count was built from. A plain fact about the capture.';
COMMENT ON COLUMN public.intel_rwa_asset_map_counts.truncated IS
  'TRUE when this asset type reached the per-type page ceiling with a full last page, so asset_count is a FLOOR and must be read as "at least N" rather than as a total. NULL on a row written before this column existed.';

DO $counts$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.intel_rwa_asset_map_counts'::regclass
      AND conname = 'intel_rwa_asset_map_counts_pages_sane'
  ) THEN
    -- A page count is a count. Zero pages cannot have produced a row at all.
    ALTER TABLE public.intel_rwa_asset_map_counts
      ADD CONSTRAINT intel_rwa_asset_map_counts_pages_sane CHECK (pages_read IS NULL OR pages_read > 0);
  END IF;
END $counts$;

-- SECTION 2: an EDGAR read says how far back it looked

ALTER TABLE public.intel_rwa_underlying_registrants
  ADD COLUMN IF NOT EXISTS recent_filings_count integer,
  ADD COLUMN IF NOT EXISTS recent_oldest_date date,
  ADD COLUMN IF NOT EXISTS recent_newest_date date,
  ADD COLUMN IF NOT EXISTS older_pages_read integer;

COMMENT ON COLUMN public.intel_rwa_underlying_registrants.recent_filings_count IS
  'Entries the EDGAR filings.recent block carried for this filer.';
COMMENT ON COLUMN public.intel_rwa_underlying_registrants.recent_oldest_date IS
  'Earliest filing date in the block we read. A block that begins inside a form''s own filing window cannot be evidence that the form was never filed: the read view reports that as "not in the filings read", never as lateness. It is not a review date and nothing expires on it.';
COMMENT ON COLUMN public.intel_rwa_underlying_registrants.recent_newest_date IS
  'Latest filing date in the block we read. It is not a review date and nothing expires on it.';
COMMENT ON COLUMN public.intel_rwa_underlying_registrants.older_pages_read IS
  'How many older EDGAR submissions pages were followed for this filer, at most 2, and only when the recent block was too short to reach an annual or quarterly report.';

DO $registrants$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.intel_rwa_underlying_registrants'::regclass
      AND conname = 'intel_rwa_underlying_registrants_span_sane'
  ) THEN
    -- Counts are counts, and a span cannot run backwards.
    ALTER TABLE public.intel_rwa_underlying_registrants
      ADD CONSTRAINT intel_rwa_underlying_registrants_span_sane CHECK (
        (recent_filings_count IS NULL OR recent_filings_count >= 0)
        AND (older_pages_read IS NULL OR older_pages_read BETWEEN 0 AND 10)
        AND (recent_oldest_date IS NULL OR recent_newest_date IS NULL OR recent_oldest_date <= recent_newest_date)
      );
  END IF;
END $registrants$;

COMMIT;
