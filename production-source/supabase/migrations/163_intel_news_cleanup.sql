-- ============================================================
-- 161: Investor Intel — purge unusable news rows
-- ============================================================
-- Removes the Gemini-grounding junk that was surfacing on Market Pulse: rows
-- whose "title" is a bare publisher domain (e.g. "globenewswire.com") and rows
-- whose source/url is a search-cache redirect (vertexaisearch / grounding-api).
-- Safe + re-runnable: the curated/chain/org crawls repopulate with clean rows
-- (chain-news-cron now emits real headlines). Intel-only tables.
-- ============================================================

DELETE FROM intel_global_news
WHERE source_name ILIKE '%vertexaisearch%'
   OR source_name ILIKE '%grounding-api%'
   OR url ILIKE '%vertexaisearch%'
   OR url ILIKE '%grounding-api-redirect%'
   OR coalesce(title,'') ~* '^(www\.)?[a-z0-9-]+(\.[a-z0-9-]{2,})+/?$'
   OR length(coalesce(btrim(title),'')) < 12;

DELETE FROM news_items
WHERE source_name ILIKE '%vertexaisearch%'
   OR url ILIKE '%vertexaisearch%'
   OR coalesce(title,'') ~* '^(www\.)?[a-z0-9-]+(\.[a-z0-9-]{2,})+/?$';
