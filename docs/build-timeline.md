# Build timeline

This repository carries the real development history of Investor Intel. Run `git log -- production-source` to see every commit that touched its source, with its original date and message. The table below summarises that history by day. Counts are commits in this repository's history, by author date as recorded (UTC-5).

Submissions opened on 2026-09-09. The first commit of the hackathon CoinMarketCap integration (the capability registry and the governed transport) is dated 2026-09-14. To see it, run `git log --reverse -- production-source/supabase/functions/_shared/market-assets/cmc-capabilities.ts`.

**Why that first commit is large (299 files).** It records work done during the event, but committed afterwards:
- **When the work was done.** The Investor Intel overhaul began on 2026-09-09 at 14:06 UTC, after submissions opened at 00:00 UTC, and ran to 2026-09-12. During it, the new backend was built and deployed to production from working copies.
- **What the commit is.** The 2026-09-14 commit puts that deployed backend into version control in one go. Its message says so: "Source of the 46 Edge Functions deployed during the overhaul".
- **What existed before the event.** The 106 commits before 2026-09-09 are Investor Intel as it was before the event. Their only CoinMarketCap client is the narrow v1 listings and global-metrics adapter (`coinmarketcap-provider.ts`, June 2026), with the modules that registered and called it. The v2 quote and v1 map price helpers belong to the parent platform's content tools, outside Investor Intel, and are not in this repository.

**File by file.** [`built-for-the-hackathon.md`](built-for-the-hackathon.md) is the per-file record behind this timeline. It lists every file of the CoinMarketCap integration and the RWA and DEX lanes, chosen by a mechanical scope rule, with its first commit and what changed since the event. 612 of its 660 files were first committed during the event. Of the 48 that existed before, only 10 mentioned CoinMarketCap at all. The record is generated from git, and `node production-source/scripts/intel-built-list.mjs --check` recomputes it from this repository's history.

| Date | Commits | What landed |
|---|---|---|
| 2026-05-08 to 2026-09-08 | 106 | Investor Intel before the event: wallet intelligence, then from June the narrative radar and signals. Its only CoinMarketCap use was a narrow v1 listings and global-metrics adapter and v2 price helpers. |
| 2026-09-11 | 1 | Hackathon extraction started (the runnable demo). |
| 2026-09-14 | 51 | CoinMarketCap foundations: the capability registry, the governed transport, credit reservation, the v3 and v5 consumers, the DEX validators, new-listing checks and the issuer review cycles. |
| 2026-09-15 | 72 | First release: candles for every asset, DEX price carry-forward, launchpad lanes, and bounds on provider paging. |
| 2026-09-16 | 73 | The RWA core: the issuer legitimacy graph from GLEIF, EDGAR and OFAC; the yield provenance engine and NAV integrity monitor; the CMC call receipt on every figure; and the recorded evidence artefact. |
| 2026-09-17 | 35 | Launchpad and meme lanes asked per documented request, and a 403 kept as a plan refusal. |
| 2026-09-20 | 56 | The RWA workspace: wrapper premiums and dispersion, the two-endpoint reconciliation, on-chain depth with the recognised-pool rule, underlying SEC registrants from the CMC filer number, logos and source lines, and the workspace opened to free members. |
| 2026-09-21 | 8 | Fixes. |
| 2026-09-22 | 14 | Public repository packaged. Best-wrapper picks, premium history with a one-off OHLCV reconstruction, exit capacity, the daily universe coverage lane with its changes feed and issuer concentration, CSV export, reproducible receipts, seven more MCP tools, and a no-account demo served from a daily snapshot. |

Work after 2026-09-22 appears as ordinary commits on top of this history.

## How this history was published

The history was published on 2026-09-23. Until then, this repository held only four packaged commits, made on 2026-09-22 and 2026-09-23.

- **How it was made.** It was made with `git filter-repo` from the private repository's `main` branch, and it joins this repository's own commits in a merge commit. The four earlier commits are kept.
- **What it includes.** Every path that makes up Investor Intel:
  - the frontend (`src/intel`);
  - every `intel-*` Edge Function;
  - the shared Intel and market-asset modules;
  - the Intel migrations and translations;
  - the packaging scripts;
  - the runnable demo in this folder.
- **Where it lives.** Those paths sit under `production-source/`, in the same layout as the private repository. The demo's own files sit at the top level, as they do here.
- **What was left out.** Everything else in the private repository, environment files, and seven private working documents used to prepare the filing.
- **What changed.** Author addresses were mapped to the owner's GitHub no-reply address, and one code comment's wording was changed in its historical versions (the current code already had the new wording). Dates, messages and all other content are as they were.
- **Commit hashes.** They differ from the private repository's, because filtering rewrites them.
- **Secret scan.** Before publication, every line added in the history was scanned for secret-shaped text, and none was found.
- **Test count in the merge message.** The merge commit's message gives 475 standalone tests, the count on 2026-09-23. Later commits raised it; the README gives the current count.

`SOURCE-MANIFEST.json` lists every file at the top of the tree, with its path in the private repository and its SHA-256.
