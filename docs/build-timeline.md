# Build timeline

This public repository is a single-commit extract of a private product, so its own history cannot show when the work was done. This page records it instead. Dates and commit counts come from the private repository's `main` branch. Counts cover commits touching the Investor Intel frontend, its Edge Functions and the shared CoinMarketCap and Intel modules.

Submissions opened on 2026-09-09. The first CoinMarketCap-specific commit in the product is dated 2026-09-14.

| Date | Commits | What landed |
|---|---|---|
| Before 2026-09-09 | | Investor Intel existed from June 2026 (narrative radar, signals). Its only CoinMarketCap use was a narrow v1 listings and global-metrics adapter and v2 price helpers. |
| 2026-09-11 | 1 | Hackathon extraction started (the runnable demo). |
| 2026-09-14 | 34 | CoinMarketCap foundations: the capability registry, the governed transport, credit reservation, the v3 and v5 consumers, the DEX validators, new-listing checks and the issuer review cycles. |
| 2026-09-15 | 58 | First release: candles for every asset, DEX price carry-forward, launchpad lanes, and bounds on provider paging. |
| 2026-09-16 | 68 | The RWA core: the issuer legitimacy graph from GLEIF, EDGAR and OFAC; the yield provenance engine and NAV integrity monitor; the CMC call receipt on every figure; and the recorded evidence artefact. |
| 2026-09-17 | 35 | Launchpad and meme lanes asked per documented request, and a 403 kept as a plan refusal. |
| 2026-09-20 | 51 | The RWA workspace: wrapper premiums and dispersion, the two-endpoint reconciliation, on-chain depth with the recognised-pool rule, underlying SEC registrants from the CMC filer number, logos and source lines, and the workspace opened to free members. |
| 2026-09-21 | 4 | Fixes. |
| 2026-09-22 | 1 | Public repository packaged. |

`SOURCE-MANIFEST.json` lists every file here with its path in the private repository and its SHA-256.
