# Built for the hackathon

This is the per-file record behind [the build timeline](build-timeline.md). It lists the Investor Intel product files in `production-source/` that belong to the CoinMarketCap integration or to the RWA and DEX lanes. For each one it gives what git history records: when the file was first committed, whether it existed before the event, and how much of it changed during the event.

Nothing in it is typed by hand. `production-source/scripts/intel-built-list.mjs` writes it, and its machine-readable twin [`built-for-the-hackathon.json`](built-for-the-hackathon.json), every time the package is built. The package test recomputes both from git and fails if any row or total differs. The commands below recompute them from this repository's history.

## Totals

**660 files are in scope: 612 were first committed during the event, 45 existed before it and were changed during it, and 3 existed before it and are unchanged.**

The event opened for submissions on 2026-09-09 at 00:00 UTC. Dates are git author dates as recorded, shown in UTC.

| Area | New | Pre-existing, changed | Pre-existing, unchanged | Total |
|---|---:|---:|---:|---:|
| CoinMarketCap modules (`_shared/market-assets/`) | 38 | 6 | 3 | 47 |
| Intel shared modules (`_shared/intel/` and other `_shared/`) | 337 | 7 | 0 | 344 |
| Edge Functions (`supabase/functions/intel-*`) | 24 | 6 | 0 | 30 |
| Migrations (`supabase/migrations/`) | 92 | 0 | 0 | 92 |
| Frontend (`src/intel/`) | 121 | 18 | 0 | 139 |
| Translations (`src/i18n/locales/*/intel.json`) | 0 | 8 | 0 | 8 |
| **All** | **612** | **45** | **3** | **660** |

No new file was created by moving or copying a file that existed before the event. This was checked with git's rename and copy detection (`-M -C --find-copies-harder`) on the commit that added each one.

## What existed before the event

These in-scope files existed before 2026-09-09, oldest first.

Before the event, only these of them mentioned CoinMarketCap at all, some only in a comment or a label: `src/intel/components/ProfilePanel.jsx`, `src/intel/lib/markets-api.js`, `src/intel/pages/MarketsPage.jsx`, `supabase/functions/_shared/market-assets/coingecko-provider.ts`, `supabase/functions/_shared/market-assets/coinmarketcap-provider.ts`, `supabase/functions/_shared/market-assets/http.ts`, `supabase/functions/_shared/market-assets/provider-registry.ts`, `supabase/functions/_shared/market-assets/types.ts`, `supabase/functions/_shared/market-assets/market-macro-c5a.test.ts`, `supabase/functions/_shared/market-assets/market-macro.ts`. The CoinMarketCap client among them is `coinmarketcap-provider.ts`, the narrow v1 listings and global-metrics adapter. The rest are in scope for another reason, given in the last column: they mention CoinMarketCap now but did not before the event, or they are market-data modules or part of the standalone subset.

| File | First commit (UTC) | Mentioned CMC before the event | Lines added | Lines removed | Commits since 2026-09-09 | In scope by |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `src/intel/pages/AssetBreakdownPage.jsx` | 2026-06-08 20:30 | no | 137 | 121 | 4 | mentions CMC |
| `src/intel/pages/MarketPulsePage.jsx` | 2026-06-08 20:47 | no | 172 | 118 | 3 | mentions CMC |
| `src/i18n/locales/de/intel.json` | 2026-06-09 21:03 | no | 4356 | 283 | 78 + 7 later | mentions CMC |
| `src/i18n/locales/en/intel.json` | 2026-06-09 21:03 | no | 4058 | 77 | 84 + 7 later | mentions CMC |
| `src/i18n/locales/es/intel.json` | 2026-06-09 21:03 | no | 4365 | 292 | 78 + 7 later | mentions CMC |
| `src/i18n/locales/fr/intel.json` | 2026-06-09 21:03 | no | 4378 | 305 | 78 + 7 later | mentions CMC |
| `src/i18n/locales/it/intel.json` | 2026-06-09 21:03 | no | 4365 | 292 | 78 + 7 later | mentions CMC |
| `src/i18n/locales/nl/intel.json` | 2026-06-09 21:03 | no | 4349 | 276 | 78 + 7 later | mentions CMC |
| `src/i18n/locales/pt-BR/intel.json` | 2026-06-09 21:03 | no | 4371 | 298 | 78 + 7 later | mentions CMC |
| `src/i18n/locales/sq/intel.json` | 2026-06-09 21:03 | no | 4373 | 300 | 78 + 7 later | mentions CMC |
| `src/intel/IntelApp.jsx` | 2026-06-09 21:03 | no | 110 | 48 | 9 | mentions CMC |
| `src/intel/components/IntelModeShell.jsx` | 2026-06-09 21:03 | no | 128 | 40 | 7 + 2 later | mentions CMC |
| `src/intel/components/MultiTokenChart.jsx` | 2026-06-09 21:03 | no | 69 | 39 | 2 | mentions CMC |
| `src/intel/components/ProfilePanel.jsx` | 2026-06-09 21:03 | yes | 72 | 72 | 1 + 1 later | mentions CMC |
| `src/intel/components/TokenChart.jsx` | 2026-06-09 21:03 | no | 340 | 103 | 12 + 1 later | mentions CMC |
| `src/intel/lib/artifact-api.js` | 2026-06-09 21:03 | no | 21 | 3 | 1 | mentions CMC |
| `src/intel/lib/chains.js` | 2026-06-09 21:03 | no | 73 | 3 | 3 | mentions CMC |
| `src/intel/lib/markets-api.js` | 2026-06-09 21:03 | yes | 372 | 74 | 12 | mentions CMC |
| `src/intel/pages/AlertsPage.jsx` | 2026-06-09 21:03 | no | 229 | 48 | 7 | mentions CMC |
| `src/intel/pages/ComparePage.jsx` | 2026-06-09 21:03 | no | 158 | 68 | 3 | mentions CMC |
| `src/intel/pages/MarketAssetPage.jsx` | 2026-06-09 21:03 | no | 342 | 79 | 24 + 3 later | mentions CMC |
| `src/intel/pages/MarketsPage.jsx` | 2026-06-09 21:03 | yes | 372 | 171 | 14 + 4 later | mentions CMC |
| `src/intel/pages/PortfolioAssetPage.jsx` | 2026-06-09 21:03 | no | 129 | 91 | 3 | mentions CMC |
| `src/intel/pages/PortfolioPage.jsx` | 2026-06-09 21:03 | no | 327 | 328 | 6 | mentions CMC |
| `supabase/functions/_shared/chains.ts` | 2026-06-09 21:03 † | no | 13 | 4 | 3, not published | standalone subset |
| `supabase/functions/_shared/market-assets/cex-match.test.ts` | 2026-06-09 21:03 | no | 0 | 0 | 0 | market-assets |
| `supabase/functions/_shared/market-assets/cex-match.ts` | 2026-06-09 21:03 | no | 0 | 0 | 0 | market-assets |
| `supabase/functions/_shared/market-assets/coingecko-provider.ts` | 2026-06-09 21:03 | yes | 86 | 0 | 2 | market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/coinmarketcap-provider.ts` | 2026-06-09 21:03 | yes | 136 | 25 | 4 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/http.ts` | 2026-06-09 21:03 | yes | 3 | 0 | 2 | market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/provider-registry.ts` | 2026-06-09 21:03 | yes | 9 | 0 | 2 | market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/types.ts` | 2026-06-09 21:03 | yes | 52 | 1 | 5 + 1 later | market-assets, mentions CMC, standalone subset |
| `supabase/functions/intel-alerts-eval/index.ts` | 2026-06-09 21:03 | no | 74 | 215 | 2 | mentions CMC |
| `supabase/functions/intel-generate/index.ts` | 2026-06-09 21:03 | no | 239 | 79 | 5 | mentions CMC |
| `supabase/functions/intel-markets/index.ts` | 2026-06-09 21:03 | no | 325 | 327 | 14 + 1 later | mentions CMC |
| `supabase/functions/intel-portfolio/index.ts` | 2026-06-09 21:03 | no | 149 | 107 | 4 | mentions CMC |
| `supabase/functions/intel-token-chart/index.ts` | 2026-06-09 21:03 | no | 69 | 20 | 3 | mentions CMC |
| `supabase/functions/intel-brief-cron/index.ts` | 2026-06-10 04:14 | no | 56 | 89 | 2 | mentions CMC |
| `supabase/functions/_shared/provider-budget.ts` | 2026-06-16 01:59 † | no | 6 | 4 | 2, not published | standalone subset |
| `supabase/functions/_shared/market-assets/market-macro-c5a.test.ts` | 2026-06-16 04:23 | yes | 0 | 0 | 0 | market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/market-macro.ts` | 2026-06-16 04:23 | yes | 21 | 5 | 2 | market-assets, mentions CMC |
| `supabase/functions/_shared/intel/asset-evidence-pack.test.ts` | 2026-06-16 04:54 | no | 275 | 4 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/asset-evidence-pack.ts` | 2026-06-16 04:54 | no | 250 | 171 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/asset-mini-pack.ts` | 2026-06-16 05:30 | no | 12 | 3 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/narrative-evidence-pack.test.ts` | 2026-06-16 05:38 | no | 68 | 9 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/narrative-evidence-pack.ts` | 2026-06-16 05:38 | no | 57 | 69 | 2 | mentions CMC |
| `src/intel/components/RankMovers.jsx` | 2026-06-17 23:37 | no | 17 | 8 | 1 | mentions CMC |
| `src/intel/pages/ThesisBuilderPage.jsx` | 2026-06-18 02:42 | no | 51 | 33 | 5 | mentions CMC |

## Scope rule

A file is in scope when it is Investor Intel product code in `production-source/` (under `src/` or `supabase/`) and at least one rule holds. The packaging scripts in `production-source/scripts/` are not product code and are left out. The rules are mechanical: `intel-built-list.mjs` applies them to the published tree.

- **name**: a path segment below `src/intel/`, `supabase/functions/_shared/` or `supabase/functions/` starts with a lane word (`cmc`, `coinmarketcap`, `rwa`, `capture`, `mcp`, `dex`). Examples are `cmc-transport.ts`, `capture-rwa-depth.ts`, `rwa-sources/gleif.ts`, `intel-mcp-demo/` and `RwaDepth.jsx`. For a migration, one of those words must be a token of its name, as in `intel_rwa_depth`.
- **market-assets**: the file is in `supabase/functions/_shared/market-assets/`, the market-data provider layer that carries the CoinMarketCap integration.
- **mentions CMC**: the file's text mentions CoinMarketCap, or CMC at the start of a word. This is the widest rule. It catches every module that calls, stores, labels or tests CoinMarketCap data, older ones included. To list these files: `git grep -l -i -E 'coinmarketcap|(^|[^[:alnum:]_])cmc' HEAD -- production-source/src production-source/supabase`.
- **standalone subset**: the RWA lane and the CMC transport as the package ships and tests them on their own, closed under imports. `SOURCE-MANIFEST.json` lists them as the `production-source/` files without the `full-source` role.

The name rule is switched off for `supabase/migrations/20260911063342_intel_comparison_capture_retention.sql` (chart snapshot retention: "capture" here names a saved chart comparison, not a capture lane). The other rules still apply to it. Only a file first committed during the event may be listed here, so this can lower the count of new files and never hide an older one. The package test enforces that.

## How each column is computed

Every figure for a file whose history was published (all but the files marked `†`) can be recomputed from this repository's history. In bash (Git Bash on Windows), from the repository root:

```bash
CUT=a21cc62^1   # where the published history ends: the first parent of the merge that published it
B=$(git rev-list -1 --first-parent --before=2026-09-09T00:00:00Z $CUT)   # the main line when the event opened
F=production-source/supabase/functions/_shared/market-assets/coinmarketcap-provider.ts

# First commit (UTC)
TZ=UTC git log --full-history --diff-filter=A --date='format-local:%Y-%m-%d %H:%M' --format=%ad $CUT -- $F | sort | head -n 1
# Existed before the event? Prints "existed" or "new".
git cat-file -e "$B:$F" 2>/dev/null && echo existed || echo new
# Lines added and removed since the event. No output means unchanged.
git diff --numstat "$B" HEAD -- $F
# Commits since the event
TZ=UTC git log --no-merges --full-history --date='format-local:%Y-%m-%d %H:%M' --format=%ad $CUT -- $F | awk '$0 >= "2026-09-09"' | wc -l
```

To recompute every row and total and compare them with `built-for-the-hackathon.json`, run `node production-source/scripts/intel-built-list.mjs --check` (Node.js 24, in a full clone rather than a `--depth 1` one). It prints each difference and exits with an error if there is one.

- **Status.** New: absent from the main line as it stood when the event opened (`$B`). Pre-existing and changed: present then, different now. Pre-existing and unchanged: byte for byte the same.
- **First commit.** The earliest author date of a commit that added the file at this path.
- **Mentioned CMC before the event.** Whether the file as it stood at `$B` matches the mentions pattern above.
- **Lines added and removed.** The net difference between the file when the event opened (nothing, for a new file) and the file now. Changes made and later undone are not counted.
- **Commits since 2026-09-09.** Commits that changed the file and were authored on or after 2026-09-09, merge commits aside. The first figure counts those in the published history, which is what the command prints. "+ N later" adds the commits made after the history was published.

## What the public history shows differently

This repository's history was published on 2026-09-23 and ends at `a21cc62^1`. Later work reaches it in package commits, and each package commit bundles several commits of the private repository. So for work after that point, this repository shows fewer, later commits than this record:

- **First commit.** Some files were first committed after the history was published (the JSON gives the count as `firstCommittedAfterPublishedHistory`). Their dates are marked `*` and come from the private repository. Here, each first appears in the package commit that shipped it, which is later. Each of them is new during the event either way. To see that package commit, run the first-commit command with `HEAD` in place of `$CUT`. For every other file, the date here is exactly what the command prints.
- **Commits.** The count includes commits made after the history was published, which arrive here inside package commits. The command above counts the commits in the published history. The JSON gives that count as `commitsSinceEventInPublishedHistory`, and `intel-built-list.mjs --check` compares it.
- **Status, lines and scope** do not depend on this. They compare file contents, which are the same in both repositories.
- **Files without published history.** `supabase/functions/_shared/chains.ts` (first committed 2026-06-09, existed before the event), `supabase/functions/_shared/memecoin/degen-gate.ts` (first committed 2026-09-15, new during the event), `supabase/functions/_shared/provider-budget.ts` (first committed 2026-06-16, existed before the event) are parent-platform modules outside the Investor Intel paths. The RWA lane imports them, so they ship in the standalone subset, but their history was not published. Here each first appears in a package commit and so looks new. This record keeps their private history instead, marked `†`, because that is the less favourable reading: 2 of them existed before the event. `--check` can only confirm their scope and that they arrived after the published history.
- **`http.ts`.** Its commit count here is 1 lower: a commit on 2026-09-22 only reworded a code comment. When the history was published, that comment's earlier wording was replaced with the new one in every earlier version (see build-timeline.md), so here the commit leaves the file unchanged and is not counted. `--check` allows for exactly this.

## New during the event

| File | First commit (UTC) | Lines added | Lines removed | Commits since 2026-09-09 | In scope by |
| --- | --- | ---: | ---: | ---: | --- |
| `src/intel/components/AirdropCalendar.jsx` | 2026-09-15 02:34 | 423 | 0 | 1 | mentions CMC |
| `src/intel/components/AssetHistoryFigure.jsx` | 2026-09-15 01:14 | 305 | 0 | 3 + 2 later | mentions CMC |
| `src/intel/components/AssetPortfolioPosition.jsx` | 2026-09-14 13:06 | 60 | 0 | 1 | mentions CMC |
| `src/intel/components/AssetProvenance.jsx` | 2026-09-15 04:24 | 316 | 0 | 3 | mentions CMC |
| `src/intel/components/AssetResolveResult.jsx` | 2026-09-15 00:01 | 260 | 0 | 4 | mentions CMC |
| `src/intel/components/AssetVenueWorkspace.jsx` | 2026-09-14 13:06 | 47 | 0 | 2 | mentions CMC |
| `src/intel/components/AttentionPersistence.jsx` | 2026-09-15 02:34 | 286 | 0 | 1 | mentions CMC |
| `src/intel/components/BenchmarkEvidence.jsx` | 2026-09-14 13:06 | 19 | 0 | 1 | mentions CMC |
| `src/intel/components/CaptureReceipts.jsx` | 2026-09-16 20:57 | 89 | 0 | 3 + 1 later | name, mentions CMC |
| `src/intel/components/CategoryBoard.jsx` | 2026-09-15 02:34 | 231 | 0 | 3 | mentions CMC |
| `src/intel/components/CategoryDisagreement.jsx` | 2026-09-15 02:34 | 197 | 0 | 1 | mentions CMC |
| `src/intel/components/ChartAssetNavigator.jsx` | 2026-09-14 13:06 | 60 | 0 | 2 | mentions CMC |
| `src/intel/components/ChartShareCard.jsx` | 2026-09-15 14:59 | 29 | 0 | 1 | mentions CMC |
| `src/intel/components/CmcAssetPosition.jsx` | 2026-09-14 13:06 | 32 | 0 | 1 | name, mentions CMC |
| `src/intel/components/ConnectedAssetSourceReader.jsx` | 2026-09-14 13:06 | 13 | 0 | 1 | mentions CMC |
| `src/intel/components/ConnectedAssetSources.jsx` | 2026-09-14 13:06 | 13 | 0 | 1 | mentions CMC |
| `src/intel/components/ContractResearchWorkspace.jsx` | 2026-09-14 13:06 | 78 | 0 | 4 | mentions CMC |
| `src/intel/components/DataBudgetFigures.jsx` | 2026-09-15 01:14 | 595 | 0 | 6 | mentions CMC |
| `src/intel/components/DexCohortCapture.jsx` | 2026-09-14 13:06 | 33 | 0 | 1 | name |
| `src/intel/components/DexDiscoveryTable.jsx` | 2026-09-14 13:06 | 27 | 0 | 2 | name, mentions CMC |
| `src/intel/components/ExchangeDisclosures.jsx` | 2026-09-14 13:06 | 60 | 0 | 1 | mentions CMC |
| `src/intel/components/ExchangeReserves.jsx` | 2026-09-15 02:34 | 323 | 0 | 3 | mentions CMC |
| `src/intel/components/GraduationCells.jsx` | 2026-09-17 15:21 | 201 | 0 | 2 | mentions CMC |
| `src/intel/components/GraduationFunnel.jsx` | 2026-09-15 04:24 | 609 | 0 | 8 | mentions CMC |
| `src/intel/components/HolderTagBoard.jsx` | 2026-09-15 04:24 | 314 | 0 | 3 | mentions CMC |
| `src/intel/components/IndexConstituents.jsx` | 2026-09-15 01:14 | 169 | 0 | 1 | mentions CMC |
| `src/intel/components/InvestigationLenses.jsx` | 2026-09-14 13:06 | 133 | 0 | 2 | mentions CMC |
| `src/intel/components/LiquidationClock.jsx` | 2026-09-15 02:34 | 205 | 0 | 2 | mentions CMC |
| `src/intel/components/LiquidationHeat.jsx` | 2026-09-15 01:14 | 221 | 0 | 3 | mentions CMC |
| `src/intel/components/LiveTape.jsx` | 2026-09-15 04:24 | 140 | 0 | 2 | mentions CMC |
| `src/intel/components/MarketContextHistory.jsx` | 2026-09-14 13:06 | 13 | 0 | 2 | mentions CMC |
| `src/intel/components/MarketPairsEvidence.jsx` | 2026-09-14 13:06 | 15 | 0 | 1 | mentions CMC |
| `src/intel/components/MarketSourceHistory.jsx` | 2026-09-14 13:06 | 51 | 0 | 1 | mentions CMC |
| `src/intel/components/MarketsCharts.jsx` | 2026-09-15 00:01 | 176 | 0 | 3 | mentions CMC |
| `src/intel/components/NarrativeMembers.jsx` | 2026-09-14 13:06 | 57 | 0 | 1 | mentions CMC |
| `src/intel/components/NetworkHealthStrip.jsx` | 2026-09-15 02:34 | 166 | 0 | 2 | mentions CMC |
| `src/intel/components/NewListingsBoard.jsx` | 2026-09-15 04:24 | 812 | 0 | 9 | mentions CMC |
| `src/intel/components/PortfolioBenchmarkExposure.jsx` | 2026-09-14 13:06 | 17 | 0 | 1 | mentions CMC |
| `src/intel/components/PortfolioCashflowBenchmark.jsx` | 2026-09-14 13:06 | 26 | 0 | 1 | mentions CMC |
| `src/intel/components/PortfolioHoldingsSection.jsx` | 2026-09-14 13:06 | 70 | 0 | 2 | mentions CMC |
| `src/intel/components/PortfolioIdentityCoverage.jsx` | 2026-09-15 04:24 | 626 | 0 | 5 | mentions CMC |
| `src/intel/components/PriceWorkstation.jsx` | 2026-09-14 13:06 | 586 | 0 | 19 | mentions CMC |
| `src/intel/components/RankMap.jsx` | 2026-09-15 01:14 | 147 | 0 | 1 | mentions CMC |
| `src/intel/components/RecentlyDiscovered.jsx` | 2026-09-15 01:14 | 173 | 0 | 3 | mentions CMC |
| `src/intel/components/RegimeRibbon.jsx` | 2026-09-15 01:14 | 341 | 0 | 2 | mentions CMC |
| `src/intel/components/ResearchEvidence.jsx` | 2026-09-14 13:06 | 53 | 0 | 3 + 2 later | mentions CMC |
| `src/intel/components/RwaAssetProfile.jsx` | 2026-09-20 14:53 | 161 | 0 | 1 + 2 later | name, mentions CMC |
| `src/intel/components/RwaConcentration.jsx` | 2026-09-22 21:55 | 198 | 0 | 1 | name, mentions CMC |
| `src/intel/components/RwaCoverage.jsx` | 2026-09-22 21:55 | 166 | 0 | 1 | name, mentions CMC |
| `src/intel/components/RwaDepth.jsx` | 2026-09-20 14:57 | 381 | 0 | 4 | name, mentions CMC |
| `src/intel/components/RwaExitInputs.jsx` | 2026-09-22 21:55 | 106 | 0 | 1 | name, mentions CMC |
| `src/intel/components/RwaIssuerLegitimacy.jsx` | 2026-09-16 13:55 | 365 | 0 | 5 | name |
| `src/intel/components/RwaLookup.jsx` | 2026-09-23 01:00 | 283 | 0 | 2 + 5 later | name, mentions CMC |
| `src/intel/components/RwaPairsFallback.jsx` | 2026-09-23 23:06 * | 111 | 0 | 0 + 1 later | name, mentions CMC |
| `src/intel/components/RwaPortfolioExposure.jsx` | 2026-09-14 13:06 | 21 | 0 | 1 | name, mentions CMC |
| `src/intel/components/RwaRelationships.jsx` | 2026-09-14 13:06 | 61 | 0 | 2 | name, mentions CMC |
| `src/intel/components/RwaSelectedPosition.jsx` | 2026-09-14 13:06 | 14 | 0 | 1 | name, mentions CMC |
| `src/intel/components/RwaSessions.jsx` | 2026-09-14 13:06 | 49 | 0 | 2 | name, mentions CMC |
| `src/intel/components/RwaTerms.jsx` | 2026-09-14 13:06 | 25 | 0 | 3 | name, mentions CMC |
| `src/intel/components/RwaTokenDepth.jsx` | 2026-09-20 14:57 | 246 | 0 | 3 | name, mentions CMC |
| `src/intel/components/RwaUnderlyingRegistrants.jsx` | 2026-09-20 14:53 | 362 | 0 | 3 | name, mentions CMC |
| `src/intel/components/RwaUniverse.jsx` | 2026-09-15 01:14 | 325 | 0 | 7 | name, mentions CMC |
| `src/intel/components/RwaUniverseChanges.jsx` | 2026-09-22 21:55 | 152 | 0 | 1 | name, mentions CMC |
| `src/intel/components/RwaWrapperHistory.jsx` | 2026-09-22 21:55 | 303 | 0 | 1 | name |
| `src/intel/components/RwaWrapperSpread.jsx` | 2026-09-20 15:02 | 1215 | 0 | 5 + 4 later | name, mentions CMC |
| `src/intel/components/RwaYieldProvenance.jsx` | 2026-09-16 13:42 | 316 | 0 | 3 + 1 later | name, mentions CMC |
| `src/intel/components/SavedComparisonChart.jsx` | 2026-09-14 13:06 | 9 | 0 | 1 | mentions CMC |
| `src/intel/components/SourceCallReceipt.jsx` | 2026-09-16 13:21 | 161 | 0 | 4 + 3 later | mentions CMC |
| `src/intel/components/SourceResearchNotes.jsx` | 2026-09-14 13:06 | 40 | 0 | 1 | mentions CMC |
| `src/intel/components/SwapClock.jsx` | 2026-09-15 04:24 | 95 | 0 | 1 | mentions CMC |
| `src/intel/components/SwapFlowBoard.jsx` | 2026-09-16 13:35 | 310 | 0 | 1 | mentions CMC |
| `src/intel/components/UnusualForThisAsset.jsx` | 2026-09-20 15:09 | 350 | 0 | 2 | mentions CMC |
| `src/intel/components/VenueShare.jsx` | 2026-09-15 02:34 | 344 | 0 | 3 | mentions CMC |
| `src/intel/components/thesis/SpecialistEvidenceDetails.jsx` | 2026-09-14 13:06 | 57 | 0 | 1 | mentions CMC |
| `src/intel/components/thesis/ThesisConditions.jsx` | 2026-09-14 13:06 | 47 | 0 | 4 | mentions CMC |
| `src/intel/demo/IntelDemoBanner.jsx` | 2026-09-22 21:55 | 73 | 0 | 2 + 1 later | mentions CMC |
| `src/intel/demo/demo-fetch.js` | 2026-09-22 21:55 | 721 | 0 | 3 + 5 later | mentions CMC |
| `src/intel/dev/ScreenVerification.jsx` | 2026-09-14 13:06 | 20 | 0 | 1 | mentions CMC |
| `src/intel/lib/__tests__/intelDemoFetch.test.js` | 2026-09-22 21:55 | 534 | 0 | 3 + 5 later | mentions CMC |
| `src/intel/lib/__tests__/intelDemoMarkets.test.jsx` | 2026-09-23 01:00 | 209 | 0 | 1 + 2 later | mentions CMC |
| `src/intel/lib/__tests__/intelDemoSearch.test.jsx` | 2026-09-23 11:38 * | 152 | 0 | 0 + 1 later | mentions CMC |
| `src/intel/lib/__tests__/table-csv.test.js` | 2026-09-22 21:55 | 101 | 0 | 1 | mentions CMC |
| `src/intel/lib/asset-identity.js` | 2026-09-14 13:06 | 106 | 0 | 1 | mentions CMC |
| `src/intel/lib/capture-api.js` | 2026-09-15 01:14 | 148 | 0 | 13 | name, mentions CMC |
| `src/intel/lib/chart-source-label.js` | 2026-09-15 04:24 | 29 | 0 | 1 + 1 later | mentions CMC |
| `src/intel/lib/cohort-evidence.js` | 2026-09-14 13:06 | 50 | 0 | 1 | mentions CMC |
| `src/intel/lib/data-budget-api.js` | 2026-09-15 01:14 | 49 | 0 | 1 | mentions CMC |
| `src/intel/lib/dex-evidence-markers.js` | 2026-09-14 13:06 | 43 | 0 | 2 | name, mentions CMC |
| `src/intel/lib/dex-evidence-projection.js` | 2026-09-14 13:06 | 2 | 0 | 1 | name, mentions CMC |
| `src/intel/lib/display-currency.jsx` | 2026-09-15 01:46 | 257 | 0 | 1 | mentions CMC |
| `src/intel/lib/entity-display.js` | 2026-09-21 16:13 | 106 | 0 | 2 | mentions CMC |
| `src/intel/lib/launchpads.js` | 2026-09-17 15:21 | 105 | 0 | 2 | mentions CMC |
| `src/intel/lib/live-tape-api.js` | 2026-09-15 04:24 | 95 | 0 | 1 | mentions CMC |
| `src/intel/lib/narrative-members.js` | 2026-09-14 13:06 | 39 | 0 | 1 | mentions CMC |
| `src/intel/lib/provider-text.js` | 2026-09-23 11:38 * | 92 | 0 | 0 + 1 later | mentions CMC |
| `src/intel/lib/receipt-parameters.js` | 2026-09-24 03:09 * | 75 | 0 | 0 + 1 later | mentions CMC |
| `src/intel/lib/rwa-depth-csv.js` | 2026-09-22 21:55 | 85 | 0 | 1 | name, mentions CMC |
| `src/intel/lib/rwa-depth-format.js` | 2026-09-20 14:57 | 139 | 0 | 2 | name, mentions CMC |
| `src/intel/lib/rwa-exit-capacity.js` | 2026-09-22 21:55 | 169 | 0 | 1 | name, mentions CMC |
| `src/intel/lib/rwa-lookup-api.js` | 2026-09-23 01:00 | 63 | 0 | 1 + 1 later | name, mentions CMC |
| `src/intel/lib/rwa-lookup-read.js` | 2026-09-24 03:09 * | 96 | 0 | 0 + 1 later | name, mentions CMC |
| `src/intel/lib/rwa-wrapper-csv.js` | 2026-09-22 21:55 | 91 | 0 | 1 + 2 later | name, mentions CMC |
| `src/intel/lib/rwa-wrapper-read-cadence.js` | 2026-09-24 03:09 * | 104 | 0 | 0 + 1 later | name, mentions CMC |
| `src/intel/lib/source-receipt.js` | 2026-09-16 20:57 | 244 | 0 | 4 + 2 later | mentions CMC |
| `src/intel/lib/stored-series-caption.js` | 2026-09-23 14:13 * | 70 | 0 | 0 + 1 later | mentions CMC |
| `src/intel/lib/suggestion-prefetch.js` | 2026-09-23 23:06 * | 51 | 0 | 0 + 1 later | mentions CMC |
| `src/intel/lib/table-csv.js` | 2026-09-22 21:55 | 145 | 0 | 1 | mentions CMC |
| `src/intel/lib/useContractChartEvidence.js` | 2026-09-14 13:06 | 37 | 0 | 1 | mentions CMC |
| `src/intel/lib/useRwaAssetLogos.js` | 2026-09-20 16:26 | 71 | 0 | 1 | mentions CMC |
| `src/intel/lib/useTokenProfile.js` | 2026-09-14 13:06 | 37 | 0 | 1 | mentions CMC |
| `src/intel/lib/watchlist-chart-identity.js` | 2026-09-14 13:06 | 12 | 0 | 1 | mentions CMC |
| `src/intel/pages/AirdropsPage.jsx` | 2026-09-15 02:34 | 32 | 0 | 3 | mentions CMC |
| `src/intel/pages/CategoriesPage.jsx` | 2026-09-15 02:34 | 37 | 0 | 2 | mentions CMC |
| `src/intel/pages/DataBudgetPage.jsx` | 2026-09-15 01:14 | 195 | 0 | 2 | mentions CMC |
| `src/intel/pages/GraduationPage.jsx` | 2026-09-15 04:24 | 48 | 0 | 4 | mentions CMC |
| `src/intel/pages/InvestigationPage.jsx` | 2026-09-14 13:06 | 223 | 0 | 4 | mentions CMC |
| `src/intel/pages/ListingsPage.jsx` | 2026-09-15 04:24 | 35 | 0 | 3 | mentions CMC |
| `src/intel/pages/MarketResearchPage.jsx` | 2026-09-14 13:06 | 315 | 0 | 8 + 1 later | mentions CMC |
| `src/intel/pages/MarketStructurePage.jsx` | 2026-09-15 01:14 | 119 | 0 | 10 + 1 later | mentions CMC |
| `src/intel/pages/RwaWrapperPage.jsx` | 2026-09-20 15:02 | 60 | 0 | 3 | name, mentions CMC |
| `src/intel/pages/SharedChartPage.jsx` | 2026-09-14 13:06 | 56 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/accrual-multiplier.test.ts` | 2026-09-23 23:06 * | 471 | 0 | 0 + 2 later | mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/accrual-multiplier.ts` | 2026-09-23 23:06 * | 673 | 0 | 0 + 2 later | mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/adoption-attention.test.ts` | 2026-09-14 13:06 | 25 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/adoption-attention.ts` | 2026-09-14 13:06 | 50 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/agent-forged-fields.test.ts` | 2026-09-16 20:41 | 291 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/agent-projection.ts` | 2026-09-16 13:31 | 94 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/ai-source-policy.test.ts` | 2026-09-14 13:06 | 37 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/ai-source-policy.ts` | 2026-09-14 13:06 | 35 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/alert-explanation-receipt.test.ts` | 2026-09-14 13:06 | 37 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/alert-explanation-receipt.ts` | 2026-09-14 13:06 | 41 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/alert-metric-agreement.test.ts` | 2026-09-16 13:34 | 243 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/asset-benchmark-evidence.ts` | 2026-09-14 13:06 | 26 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/asset-facts.test.ts` | 2026-09-15 00:39 | 332 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/asset-facts.ts` | 2026-09-15 00:39 | 302 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/asset-history.test.ts` | 2026-09-15 00:39 | 80 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/asset-history.ts` | 2026-09-15 00:39 | 107 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/asset-identifier.test.ts` | 2026-09-15 00:01 | 120 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/asset-identifier.ts` | 2026-09-15 00:01 | 213 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/asset-resolver.test.ts` | 2026-09-15 00:01 | 612 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/asset-resolver.ts` | 2026-09-15 00:01 | 890 | 0 | 4 | mentions CMC |
| `supabase/functions/_shared/intel/asset-specialist-evidence.test.ts` | 2026-09-14 13:06 | 33 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/asset-specialist-evidence.ts` | 2026-09-14 13:06 | 62 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/asset-venue-service.ts` | 2026-09-14 13:06 | 42 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/benchmark-comparison.test.ts` | 2026-09-14 13:06 | 37 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/benchmark-comparison.ts` | 2026-09-14 13:06 | 27 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/benchmark-receipt.ts` | 2026-09-14 13:06 | 14 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/bounded-request.ts` | 2026-09-14 13:06 | 21 | 0 | 2 | standalone subset |
| `supabase/functions/_shared/intel/breadth-spread.ts` | 2026-09-16 21:05 | 91 | 0 | 1 | standalone subset |
| `supabase/functions/_shared/intel/budget-calibration.test.ts` | 2026-09-16 13:51 | 209 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/budget-calibration.ts` | 2026-09-16 13:51 | 249 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/cached-asset-quote.test.ts` | 2026-09-14 13:06 | 31 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/cached-asset-quote.ts` | 2026-09-14 13:06 | 25 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/candle-archive.ts` | 2026-09-15 14:52 | 193 | 0 | 4 | mentions CMC |
| `supabase/functions/_shared/intel/candle-ladder.test.ts` | 2026-09-15 14:52 | 556 | 0 | 4 | mentions CMC |
| `supabase/functions/_shared/intel/candle-ladder.ts` | 2026-09-15 14:52 | 295 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/capture-candles-read.ts` | 2026-09-15 15:07 | 104 | 0 | 2 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-candles.test.ts` | 2026-09-15 15:07 | 656 | 0 | 4 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-candles.ts` | 2026-09-15 15:07 | 740 | 0 | 4 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-categories-read.test.ts` | 2026-09-15 01:46 | 381 | 0 | 2 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-categories-read.ts` | 2026-09-15 01:46 | 307 | 0 | 2 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-categories.test.ts` | 2026-09-15 01:46 | 303 | 0 | 1 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-categories.ts` | 2026-09-15 01:46 | 266 | 0 | 1 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-fx-read.test.ts` | 2026-09-15 01:46 | 123 | 0 | 1 | name |
| `supabase/functions/_shared/intel/capture-fx-read.ts` | 2026-09-15 01:46 | 152 | 0 | 1 | name |
| `supabase/functions/_shared/intel/capture-fx.test.ts` | 2026-09-15 01:46 | 170 | 0 | 1 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-fx.ts` | 2026-09-15 01:46 | 184 | 0 | 1 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-jobs.test.ts` | 2026-09-15 00:39 | 439 | 0 | 3 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-jobs.ts` | 2026-09-15 00:39 | 574 | 0 | 4 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-launchpads-read.test.ts` | 2026-09-17 14:00 | 253 | 0 | 2 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-launchpads.test.ts` | 2026-09-17 14:00 | 790 | 0 | 3 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-launchpads.ts` | 2026-09-17 14:00 | 1004 | 0 | 2 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-listings-read.test.ts` | 2026-09-15 03:39 | 428 | 0 | 5 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-listings-read.ts` | 2026-09-15 03:39 | 317 | 0 | 5 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-listings.test.ts` | 2026-09-15 03:39 | 406 | 0 | 2 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-listings.ts` | 2026-09-15 03:39 | 368 | 0 | 2 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-meme-read.test.ts` | 2026-09-15 03:39 | 276 | 0 | 3 | name |
| `supabase/functions/_shared/intel/capture-meme-read.ts` | 2026-09-15 03:39 | 427 | 0 | 4 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-meme.test.ts` | 2026-09-15 03:39 | 462 | 0 | 5 + 1 later | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-meme.ts` | 2026-09-15 03:39 | 531 | 0 | 6 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-read-envelope.ts` | 2026-09-22 21:55 | 84 | 0 | 1 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-read.test.ts` | 2026-09-15 00:39 | 392 | 0 | 4 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-read.ts` | 2026-09-15 00:39 | 441 | 0 | 4 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-coverage-read.test.ts` | 2026-09-22 21:55 | 152 | 0 | 1 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-coverage-read.ts` | 2026-09-22 21:55 | 313 | 0 | 1 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-coverage.fixtures.ts` | 2026-09-22 21:55 | 92 | 0 | 1 | name, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-coverage.test.ts` | 2026-09-22 21:55 | 193 | 0 | 1 + 1 later | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-coverage.ts` | 2026-09-22 21:55 | 366 | 0 | 1 + 1 later | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-depth-read.test.ts` | 2026-09-20 14:57 | 544 | 0 | 3 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-depth-read.ts` | 2026-09-20 14:57 | 603 | 0 | 4 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-depth.test.ts` | 2026-09-20 14:57 | 586 | 0 | 3 + 1 later | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-depth.ts` | 2026-09-20 14:57 | 981 | 0 | 4 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-issuer-read.test.ts` | 2026-09-16 14:07 | 252 | 0 | 4 | name, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-issuer-read.ts` | 2026-09-16 13:55 | 292 | 0 | 5 | name, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-issuer.test.ts` | 2026-09-16 14:07 | 268 | 0 | 2 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-issuer.ts` | 2026-09-16 13:55 | 346 | 0 | 5 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-quote-warm.test.ts` | 2026-09-23 17:38 * | 267 | 0 | 0 + 1 later | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-rwa-quote-warm.ts` | 2026-09-23 17:38 * | 346 | 0 | 0 + 1 later | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-rwa-schedule.test.ts` | 2026-09-16 20:55 | 52 | 0 | 1 | name |
| `supabase/functions/_shared/intel/capture-rwa-underlyings-read.test.ts` | 2026-09-20 14:53 | 353 | 0 | 3 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-underlyings-read.ts` | 2026-09-20 14:53 | 501 | 0 | 3 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-underlyings.test.ts` | 2026-09-20 14:53 | 667 | 0 | 2 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-underlyings.ts` | 2026-09-20 14:53 | 783 | 0 | 3 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-wrapper-backfill.test.ts` | 2026-09-22 21:55 | 298 | 0 | 2 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-wrapper-backfill.ts` | 2026-09-22 21:55 | 463 | 0 | 2 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-wrapper-history-read.test.ts` | 2026-09-22 21:55 | 179 | 0 | 1 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-wrapper-history-read.ts` | 2026-09-22 21:55 | 259 | 0 | 1 | name, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-wrappers-read.test.ts` | 2026-09-22 21:55 | 173 | 0 | 1 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-wrappers-read.ts` | 2026-09-20 15:02 | 607 | 0 | 3 + 3 later | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-wrappers.test.ts` | 2026-09-20 15:02 | 1057 | 0 | 2 + 4 later | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-wrappers.ts` | 2026-09-20 15:02 | 932 | 0 | 1 + 4 later | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-yield-read.test.ts` | 2026-09-16 13:42 | 275 | 0 | 2 | name, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-yield-read.ts` | 2026-09-16 13:42 | 308 | 0 | 3 | name, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-yield.test.ts` | 2026-09-16 13:42 | 327 | 0 | 2 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-rwa-yield.ts` | 2026-09-16 13:42 | 395 | 0 | 3 + 1 later | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/capture-sunpump.test.ts` | 2026-09-17 14:37 | 886 | 0 | 2 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-sunpump.ts` | 2026-09-17 14:37 | 1274 | 0 | 2 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-unusual-read.test.ts` | 2026-09-20 15:09 | 262 | 0 | 2 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-unusual-read.ts` | 2026-09-20 15:09 | 268 | 0 | 2 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-unusual.test.ts` | 2026-09-20 15:09 | 411 | 0 | 1 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-unusual.ts` | 2026-09-20 15:09 | 383 | 0 | 1 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-venues-read.test.ts` | 2026-09-15 01:46 | 270 | 0 | 1 | name |
| `supabase/functions/_shared/intel/capture-venues-read.ts` | 2026-09-15 01:46 | 347 | 0 | 1 | name |
| `supabase/functions/_shared/intel/capture-venues.test.ts` | 2026-09-15 01:46 | 359 | 0 | 3 | name, mentions CMC |
| `supabase/functions/_shared/intel/capture-venues.ts` | 2026-09-15 01:46 | 417 | 0 | 3 | name, mentions CMC |
| `supabase/functions/_shared/intel/chain-performance-read.test.ts` | 2026-09-14 13:06 | 7 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/chain-performance-read.ts` | 2026-09-14 13:06 | 18 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/chain-performance.test.ts` | 2026-09-14 13:06 | 6 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/chain-performance.ts` | 2026-09-14 13:06 | 13 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/chainlink-nav.test.ts` | 2026-09-16 13:42 | 167 | 0 | 1 | standalone subset |
| `supabase/functions/_shared/intel/chainlink-nav.ts` | 2026-09-16 13:42 | 300 | 0 | 1 + 1 later | standalone subset |
| `supabase/functions/_shared/intel/chart-alert-service.ts` | 2026-09-14 13:06 | 99 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/chart-alert.test.ts` | 2026-09-14 13:06 | 46 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/chart-analysis.ts` | 2026-09-14 13:06 | 198 | 0 | 3 | standalone subset |
| `supabase/functions/_shared/intel/chart-capture-proof.test.ts` | 2026-09-14 13:06 | 23 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/chart-capture-proof.ts` | 2026-09-14 13:06 | 57 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/chart-comparison-capture.test.ts` | 2026-09-14 13:06 | 22 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/chart-comparison-image.ts` | 2026-09-14 13:06 | 34 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/chart-link-preview.test.ts` | 2026-09-14 13:06 | 13 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/chart-read.test.ts` | 2026-09-14 13:06 | 40 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/chart-review.test.ts` | 2026-09-14 13:06 | 19 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/chart-series-contract.ts` | 2026-09-14 13:06 | 16 | 0 | 3 + 1 later | mentions CMC |
| `supabase/functions/_shared/intel/chart-share-service.ts` | 2026-09-14 13:06 | 85 | 0 | 4 | mentions CMC |
| `supabase/functions/_shared/intel/chart-share.test.ts` | 2026-09-14 13:06 | 93 | 0 | 4 | mentions CMC |
| `supabase/functions/_shared/intel/chart-snapshot-service.ts` | 2026-09-14 13:06 | 68 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/chart-snapshot.test.ts` | 2026-09-14 13:06 | 62 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/chart-timeframes.test.ts` | 2026-09-14 13:06 | 16 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/chart-workspace-contract.ts` | 2026-09-14 13:06 | 127 | 0 | 7 | mentions CMC |
| `supabase/functions/_shared/intel/chart-workspace.test.ts` | 2026-09-14 13:06 | 159 | 0 | 8 | mentions CMC |
| `supabase/functions/_shared/intel/cmc-asset-identity.ts` | 2026-09-14 13:06 | 48 | 0 | 3 | name, mentions CMC |
| `supabase/functions/_shared/intel/cmc-chart.test.ts` | 2026-09-14 13:06 | 27 | 0 | 4 | name, mentions CMC |
| `supabase/functions/_shared/intel/cmc-chart.ts` | 2026-09-14 13:06 | 102 | 0 | 7 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/cmc-connected.test.ts` | 2026-09-14 13:06 | 75 | 0 | 3 | name, mentions CMC |
| `supabase/functions/_shared/intel/cmc-contract-chart.test.ts` | 2026-09-14 13:06 | 35 | 0 | 2 | name, mentions CMC |
| `supabase/functions/_shared/intel/cmc-contract-chart.ts` | 2026-09-14 13:06 | 35 | 0 | 2 | name, mentions CMC |
| `supabase/functions/_shared/intel/cmc-contract-evidence.ts` | 2026-09-14 13:06 | 45 | 0 | 3 | name, mentions CMC |
| `supabase/functions/_shared/intel/cmc-contract-projection.ts` | 2026-09-14 13:06 | 24 | 0 | 2 | name, mentions CMC |
| `supabase/functions/_shared/intel/cmc-dex-evidence.test.ts` | 2026-09-15 03:39 | 145 | 0 | 2 | name, mentions CMC |
| `supabase/functions/_shared/intel/cmc-dex-evidence.ts` | 2026-09-14 13:06 | 93 | 0 | 4 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/cmc-kline-chart.test.ts` | 2026-09-15 03:39 | 288 | 0 | 3 | name, mentions CMC |
| `supabase/functions/_shared/intel/cmc-kline-chart.ts` | 2026-09-15 03:39 | 322 | 0 | 4 | name, mentions CMC |
| `supabase/functions/_shared/intel/comparison-prompt-context.test.ts` | 2026-09-14 13:06 | 64 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/comparison-prompt-context.ts` | 2026-09-14 13:06 | 86 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/comparison-quote-evidence.test.ts` | 2026-09-14 13:06 | 26 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/comparison-quote-evidence.ts` | 2026-09-14 13:06 | 37 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/comparison-subjects.test.ts` | 2026-09-14 13:06 | 20 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/comparison-subjects.ts` | 2026-09-14 13:06 | 26 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/condition-source.ts` | 2026-09-14 13:06 | 60 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/connected-asset-identity.ts` | 2026-09-14 13:06 | 27 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/contract-holding-price.ts` | 2026-09-21 17:36 | 185 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/contract-identity-route.test.ts` | 2026-09-21 17:36 | 199 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/contract-identity-route.ts` | 2026-09-21 17:36 | 58 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/contract-market-asset.ts` | 2026-09-15 00:01 | 240 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/contract-research.test.ts` | 2026-09-15 03:39 | 321 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/contract-research.ts` | 2026-09-14 13:06 | 201 | 0 | 5 | mentions CMC |
| `supabase/functions/_shared/intel/dashboard-core.ts` | 2026-09-22 21:55 | 332 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/dashboard-reads.ts` | 2026-09-14 13:06 | 133 | 0 | 4 | mentions CMC |
| `supabase/functions/_shared/intel/demo-capture-views.ts` | 2026-09-23 20:07 * | 206 | 0 | 0 + 1 later | mentions CMC |
| `supabase/functions/_shared/intel/demo-market-read.test.ts` | 2026-09-23 20:07 * | 87 | 0 | 0 + 1 later | mentions CMC |
| `supabase/functions/_shared/intel/demo-market-read.ts` | 2026-09-23 11:38 * | 591 | 0 | 0 + 4 later | mentions CMC |
| `supabase/functions/_shared/intel/demo-read.test.ts` | 2026-09-23 11:38 * | 253 | 0 | 0 + 3 later | mentions CMC |
| `supabase/functions/_shared/intel/demo-read.ts` | 2026-09-23 11:38 * | 429 | 0 | 0 + 2 later | mentions CMC |
| `supabase/functions/_shared/intel/demo-snapshot-builder.test.ts` | 2026-09-22 21:55 | 480 | 0 | 1 + 2 later | mentions CMC |
| `supabase/functions/_shared/intel/demo-snapshot-markets.test.ts` | 2026-09-23 01:00 | 206 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/demo-snapshot-requests.ts` | 2026-09-22 21:55 | 219 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/demo-snapshot-shared.ts` | 2026-09-22 21:55 | 214 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/dex-cohort-service.test.ts` | 2026-09-14 13:06 | 91 | 0 | 4 | name, mentions CMC |
| `supabase/functions/_shared/intel/dex-cohort-service.ts` | 2026-09-14 13:06 | 114 | 0 | 5 | name, mentions CMC |
| `supabase/functions/_shared/intel/evidence-prompt-budget.ts` | 2026-09-14 13:06 | 40 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/exchange-candles.ts` | 2026-09-15 14:52 | 191 | 0 | 4 | mentions CMC |
| `supabase/functions/_shared/intel/exchange-disclosure.test.ts` | 2026-09-14 13:06 | 61 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/exchange-disclosure.ts` | 2026-09-14 13:06 | 64 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/exchange-history.ts` | 2026-09-15 15:07 | 123 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/fragility-history.test.ts` | 2026-09-14 13:06 | 69 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/fragility-history.ts` | 2026-09-14 13:06 | 70 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/global-cohort-prices.test.ts` | 2026-09-14 13:06 | 18 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/global-cohort-prices.ts` | 2026-09-14 13:06 | 15 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/history-condition-sources.test.ts` | 2026-09-15 00:39 | 102 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/holder-tags-read.ts` | 2026-09-15 03:39 | 301 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/holder-tags.test.ts` | 2026-09-15 03:39 | 284 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/holder-tags.ts` | 2026-09-15 03:39 | 270 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/holding-identity.test.ts` | 2026-09-15 03:39 | 458 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/holding-identity.ts` | 2026-09-15 03:39 | 548 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/intel-rwa-free-sql.test.ts` | 2026-09-20 15:00 | 123 | 0 | 1 | name, mentions CMC |
| `supabase/functions/_shared/intel/investigation-depth.test.ts` | 2026-09-14 13:06 | 39 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/investigation-depth.ts` | 2026-09-14 13:06 | 25 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/investigation-evidence.ts` | 2026-09-14 13:06 | 189 | 0 | 2 | standalone subset |
| `supabase/functions/_shared/intel/investigation-live-focus.test.ts` | 2026-09-14 13:06 | 110 | 0 | 5 | mentions CMC |
| `supabase/functions/_shared/intel/investigation-normalize.ts` | 2026-09-14 13:06 | 110 | 0 | 4 | mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/investigation-policy.test.ts` | 2026-09-14 13:06 | 14 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/investigation-quote-identity.test.ts` | 2026-09-14 13:06 | 38 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/investigation-receipt.test.ts` | 2026-09-14 13:06 | 23 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/investigation-service.ts` | 2026-09-14 13:06 | 254 | 0 | 6 | mentions CMC |
| `supabase/functions/_shared/intel/investigation-sessions.ts` | 2026-09-14 13:06 | 135 | 0 | 3 + 1 later | standalone subset |
| `supabase/functions/_shared/intel/investigation-stress.test.ts` | 2026-09-14 13:06 | 9 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/investigation.test.ts` | 2026-09-14 13:06 | 133 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/liquidation-history.test.ts` | 2026-09-14 13:06 | 9 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/market-alert-evaluator.test.ts` | 2026-09-14 13:06 | 59 | 0 | 5 | mentions CMC |
| `supabase/functions/_shared/intel/market-alert-evidence.test.ts` | 2026-09-14 13:06 | 213 | 0 | 5 | mentions CMC |
| `supabase/functions/_shared/intel/market-alert-evidence.ts` | 2026-09-14 13:06 | 240 | 0 | 6 | mentions CMC |
| `supabase/functions/_shared/intel/market-asset-resolver.test.ts` | 2026-09-14 13:06 | 15 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/market-asset-resolver.ts` | 2026-09-14 13:06 | 29 | 0 | 4 | mentions CMC |
| `supabase/functions/_shared/intel/market-asset-source.test.ts` | 2026-09-14 13:06 | 18 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/market-asset-source.ts` | 2026-09-14 13:06 | 39 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/market-asset-suggest.test.ts` | 2026-09-17 12:55 | 265 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/market-asset-suggest.ts` | 2026-09-17 12:55 | 354 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/market-candle-read.ts` | 2026-09-15 14:52 | 256 | 0 | 4 + 1 later | mentions CMC |
| `supabase/functions/_shared/intel/market-coverage.test.ts` | 2026-09-15 00:01 | 69 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/market-coverage.ts` | 2026-09-15 00:01 | 83 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/market-field-selection.test.ts` | 2026-09-14 13:06 | 17 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/market-figure-scope.ts` | 2026-09-16 13:21 | 144 | 0 | 2 + 1 later | mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/market-provenance.ts` | 2026-09-16 20:47 | 158 | 0 | 2 + 1 later | mentions CMC |
| `supabase/functions/_shared/intel/market-read-quality.ts` | 2026-09-14 13:06 | 111 | 0 | 3 | mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/market-source-reference.ts` | 2026-09-14 13:06 | 12 | 0 | 2 | mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/market-source-versions.test.ts` | 2026-09-14 13:06 | 45 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/market-source-versions.ts` | 2026-09-14 13:06 | 105 | 0 | 2 | mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/markets-handler-auth.test.ts` | 2026-09-14 13:06 | 235 | 0 | 8 + 1 later | mentions CMC |
| `supabase/functions/_shared/intel/markets-screen.test.ts` | 2026-09-15 01:46 | 59 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/mcp-grounding.ts` | 2026-09-20 15:04 | 163 | 0 | 1 | name, mentions CMC |
| `supabase/functions/_shared/intel/mcp-handler.test.ts` | 2026-09-20 15:04 | 357 | 0 | 1 | name, mentions CMC |
| `supabase/functions/_shared/intel/mcp-protocol.test.ts` | 2026-09-20 15:04 | 195 | 0 | 2 | name |
| `supabase/functions/_shared/intel/mcp-protocol.ts` | 2026-09-20 15:04 | 238 | 0 | 2 | name |
| `supabase/functions/_shared/intel/mcp-quota.ts` | 2026-09-20 15:04 | 151 | 0 | 1 | name |
| `supabase/functions/_shared/intel/mcp-readings.test.ts` | 2026-09-22 21:55 | 539 | 0 | 1 | name, mentions CMC |
| `supabase/functions/_shared/intel/mcp-readings.ts` | 2026-09-22 21:55 | 743 | 0 | 1 | name, mentions CMC |
| `supabase/functions/_shared/intel/mcp-rwa-forward.ts` | 2026-09-20 15:04 | 180 | 0 | 3 + 2 later | name, mentions CMC |
| `supabase/functions/_shared/intel/mcp-schema.test.ts` | 2026-09-20 15:04 | 153 | 0 | 1 | name |
| `supabase/functions/_shared/intel/mcp-schema.ts` | 2026-09-20 15:04 | 161 | 0 | 1 | name |
| `supabase/functions/_shared/intel/mcp-size.ts` | 2026-09-22 21:55 | 119 | 0 | 1 | name |
| `supabase/functions/_shared/intel/mcp-time-labels.test.ts` | 2026-09-23 20:29 * | 53 | 0 | 0 + 1 later | name |
| `supabase/functions/_shared/intel/mcp-time-labels.ts` | 2026-09-23 20:29 * | 76 | 0 | 0 + 1 later | name |
| `supabase/functions/_shared/intel/mcp-tools.test.ts` | 2026-09-20 15:04 | 789 | 0 | 4 + 1 later | name, mentions CMC |
| `supabase/functions/_shared/intel/mcp-tools.ts` | 2026-09-20 15:04 | 1485 | 0 | 6 + 4 later | name, mentions CMC |
| `supabase/functions/_shared/intel/metric-agreement-read.ts` | 2026-09-16 13:34 | 191 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/narrative-claim-quality.test.ts` | 2026-09-14 13:06 | 17 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/narrative-input-replay.test.ts` | 2026-09-14 13:06 | 71 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/narrative-input-replay.ts` | 2026-09-14 13:06 | 97 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/narrative-model-grounding.test.ts` | 2026-09-14 13:06 | 39 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/narrative-prompt-context.test.ts` | 2026-09-14 13:06 | 69 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/narrative-prompt-context.ts` | 2026-09-14 13:06 | 64 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/on-demand-index.test.ts` | 2026-09-15 00:39 | 159 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/on-demand-index.ts` | 2026-09-15 00:39 | 174 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/portfolio-benchmark-exposure.test.ts` | 2026-09-14 13:06 | 20 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/portfolio-benchmark-exposure.ts` | 2026-09-14 13:06 | 29 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/portfolio-benchmark-performance.test.ts` | 2026-09-14 13:06 | 47 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/portfolio-benchmark-performance.ts` | 2026-09-14 13:06 | 71 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/portfolio-market-evidence.test.ts` | 2026-09-14 13:06 | 31 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/portfolio-market-evidence.ts` | 2026-09-14 13:06 | 22 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/portfolio-narrative-exposure.test.ts` | 2026-09-14 13:06 | 63 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/portfolio-narrative-exposure.ts` | 2026-09-14 13:06 | 91 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/portfolio-quote.test.ts` | 2026-09-14 13:06 | 18 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/portfolio-quote.ts` | 2026-09-14 13:06 | 14 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/portfolio-research.test.ts` | 2026-09-14 13:06 | 150 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/portfolio-research.ts` | 2026-09-14 13:06 | 131 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/position-depth.test.ts` | 2026-09-14 13:06 | 8 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/representation-review.test.ts` | 2026-09-14 13:06 | 50 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/representation-review.ts` | 2026-09-14 13:06 | 53 | 0 | 3 | standalone subset |
| `supabase/functions/_shared/intel/research-identity.test.ts` | 2026-09-14 13:06 | 35 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/research-identity.ts` | 2026-09-14 13:06 | 61 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/research-service.ts` | 2026-09-14 13:06 | 75 | 0 | 4 + 1 later | mentions CMC |
| `supabase/functions/_shared/intel/risk-metrics.ts` | 2026-09-15 00:39 | 118 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/rwa-admission-drift.test.ts` | 2026-09-16 13:55 | 118 | 0 | 1 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-admission-drift.ts` | 2026-09-16 13:55 | 197 | 0 | 1 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-benchmark-rates.test.ts` | 2026-09-16 13:42 | 178 | 0 | 3 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-benchmark-rates.ts` | 2026-09-16 13:42 | 287 | 0 | 3 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-counter-leg.test.ts` | 2026-09-20 17:35 | 273 | 0 | 1 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/rwa-counter-leg.ts` | 2026-09-20 17:35 | 366 | 0 | 1 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/rwa-coverage.test.ts` | 2026-09-22 21:55 | 159 | 0 | 1 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-coverage.ts` | 2026-09-22 21:55 | 331 | 0 | 1 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-exit-capacity.ts` | 2026-09-22 21:55 | 113 | 0 | 1 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-free-read.test.ts` | 2026-09-20 15:00 | 399 | 0 | 1 + 1 later | name, mentions CMC |
| `supabase/functions/_shared/intel/rwa-free-read.ts` | 2026-09-20 15:00 | 264 | 0 | 1 + 2 later | name, mentions CMC |
| `supabase/functions/_shared/intel/rwa-issuer-aliases.test.ts` | 2026-09-16 13:55 | 189 | 0 | 3 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/rwa-issuer-aliases.ts` | 2026-09-16 13:55 | 552 | 0 | 3 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/rwa-issuer-evidence.test.ts` | 2026-09-14 13:06 | 82 | 0 | 3 | name, mentions CMC |
| `supabase/functions/_shared/intel/rwa-issuer-evidence.ts` | 2026-09-14 13:06 | 205 | 0 | 6 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/rwa-issuer-review-cycles.test.ts` | 2026-09-14 16:39 | 106 | 0 | 3 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/rwa-legitimacy.test.ts` | 2026-09-16 13:55 | 179 | 0 | 3 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/rwa-legitimacy.ts` | 2026-09-16 13:55 | 219 | 0 | 3 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/rwa-lookup.test.ts` | 2026-09-23 01:00 | 883 | 0 | 2 + 4 later | name, mentions CMC |
| `supabase/functions/_shared/intel/rwa-lookup.ts` | 2026-09-23 01:00 | 934 | 0 | 2 + 4 later | name, mentions CMC |
| `supabase/functions/_shared/intel/rwa-nav-integrity.test.ts` | 2026-09-16 13:42 | 164 | 0 | 2 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-nav-integrity.ts` | 2026-09-16 13:42 | 215 | 0 | 1 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-portfolio-exposure.test.ts` | 2026-09-14 13:06 | 27 | 0 | 2 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/rwa-portfolio-exposure.ts` | 2026-09-14 13:06 | 25 | 0 | 2 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/rwa-sources/blockscout.test.ts` | 2026-09-16 13:55 | 154 | 0 | 2 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-sources/blockscout.ts` | 2026-09-16 13:55 | 252 | 0 | 2 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-sources/edgar-agent.test.ts` | 2026-09-16 20:44 | 65 | 0 | 1 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/rwa-sources/edgar-agent.ts` | 2026-09-16 20:44 | 127 | 0 | 1 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/rwa-sources/edgar.test.ts` | 2026-09-16 13:55 | 214 | 0 | 2 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-sources/edgar.ts` | 2026-09-16 13:55 | 406 | 0 | 3 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-sources/gleif.test.ts` | 2026-09-16 13:55 | 110 | 0 | 1 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-sources/gleif.ts` | 2026-09-16 13:55 | 190 | 0 | 1 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-sources/http.test.ts` | 2026-09-16 13:55 | 92 | 0 | 2 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-sources/http.ts` | 2026-09-16 13:55 | 260 | 0 | 3 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-sources/ofac.test.ts` | 2026-09-16 13:55 | 94 | 0 | 1 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-sources/ofac.ts` | 2026-09-16 13:55 | 183 | 0 | 1 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-sources/sourcify.test.ts` | 2026-09-16 13:55 | 85 | 0 | 1 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-sources/sourcify.ts` | 2026-09-16 13:55 | 137 | 0 | 1 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-sources/test-support.ts` | 2026-09-16 13:55 | 50 | 0 | 1 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-terms.test.ts` | 2026-09-14 13:06 | 36 | 0 | 3 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/rwa-terms.ts` | 2026-09-14 13:06 | 20 | 0 | 3 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-wrapper-picks.test.ts` | 2026-09-22 21:55 | 153 | 0 | 1 + 1 later | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-wrapper-picks.ts` | 2026-09-22 21:55 | 243 | 0 | 1 + 1 later | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/rwa-wrapper-spread.test.ts` | 2026-09-20 15:02 | 559 | 0 | 2 + 1 later | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/rwa-wrapper-spread.ts` | 2026-09-20 15:02 | 811 | 0 | 2 + 1 later | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/rwa-yield-realized.test.ts` | 2026-09-16 13:42 | 135 | 0 | 1 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-yield-realized.ts` | 2026-09-16 13:42 | 171 | 0 | 1 | name, standalone subset |
| `supabase/functions/_shared/intel/rwa-yield-register.test.ts` | 2026-09-16 13:42 | 158 | 0 | 2 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/rwa-yield-register.ts` | 2026-09-16 13:42 | 296 | 0 | 2 | name, mentions CMC, standalone subset |
| `supabase/functions/_shared/intel/schedule-policy.test.ts` | 2026-09-15 00:39 | 278 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/schedule-policy.ts` | 2026-09-15 00:39 | 403 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/sec-nmfp-yield.test.ts` | 2026-09-16 13:42 | 129 | 0 | 2 | standalone subset |
| `supabase/functions/_shared/intel/sec-nmfp-yield.ts` | 2026-09-16 13:42 | 196 | 0 | 2 | standalone subset |
| `supabase/functions/_shared/intel/source-history-service.test.ts` | 2026-09-14 13:06 | 35 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/source-history-service.ts` | 2026-09-14 13:06 | 13 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/source-receipt.test.ts` | 2026-09-16 20:47 | 157 | 0 | 3 + 2 later | mentions CMC |
| `supabase/functions/_shared/intel/source-receipt.ts` | 2026-09-16 20:47 | 253 | 0 | 4 + 2 later | mentions CMC |
| `supabase/functions/_shared/intel/stored-candles.test.ts` | 2026-09-23 14:13 * | 201 | 0 | 0 + 1 later | mentions CMC |
| `supabase/functions/_shared/intel/stored-candles.ts` | 2026-09-23 14:13 * | 450 | 0 | 0 + 1 later | mentions CMC |
| `supabase/functions/_shared/intel/stress-scenario-contract.ts` | 2026-09-14 13:06 | 36 | 0 | 2 | standalone subset |
| `supabase/functions/_shared/intel/stress-scenario.test.ts` | 2026-09-14 13:06 | 42 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/swap-flow-read.ts` | 2026-09-16 13:35 | 244 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/swap-flow.test.ts` | 2026-09-16 13:35 | 255 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/swap-flow.ts` | 2026-09-16 13:35 | 368 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/thesis-condition-sources.test.ts` | 2026-09-15 01:46 | 132 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/thesis-condition-sources.ts` | 2026-09-15 01:46 | 135 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/thesis-conditions.test.ts` | 2026-09-14 13:06 | 46 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/thesis-conditions.ts` | 2026-09-14 13:06 | 48 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/thesis-monitor.test.ts` | 2026-09-14 13:06 | 82 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/thesis-recorded-evidence.ts` | 2026-09-14 13:06 | 31 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/thesis-save-evidence.test.ts` | 2026-09-14 13:06 | 33 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/underlying-reference.test.ts` | 2026-09-23 20:07 * | 400 | 0 | 0 + 2 later | standalone subset |
| `supabase/functions/_shared/intel/underlying-reference.ts` | 2026-09-23 20:07 * | 549 | 0 | 0 + 3 later | standalone subset |
| `supabase/functions/_shared/intel/unusual-moves.ts` | 2026-09-20 15:09 | 510 | 0 | 1 | mentions CMC |
| `supabase/functions/_shared/intel/venue-condition-sources.ts` | 2026-09-14 13:06 | 96 | 0 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/venue-context.test.ts` | 2026-09-14 13:06 | 8 | 0 | 2 | mentions CMC |
| `supabase/functions/_shared/market-assets/cmc-cache-read-failure.test.ts` | 2026-09-14 13:06 | 15 | 0 | 2 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-capabilities.ts` | 2026-09-14 13:06 | 472 | 0 | 14 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-catalog.test.ts` | 2026-09-14 13:06 | 19 | 0 | 2 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-connected-dex.test.ts` | 2026-09-14 13:06 | 266 | 0 | 8 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-consumer-governance.test.ts` | 2026-09-14 13:06 | 26 | 0 | 7 | name, market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/cmc-demand-policy.test.ts` | 2026-09-14 13:06 | 52 | 0 | 5 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-demand-policy.ts` | 2026-09-14 13:06 | 33 | 0 | 3 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-dex-platforms.test.ts` | 2026-09-15 03:39 | 98 | 0 | 1 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-dex-platforms.ts` | 2026-09-15 03:39 | 147 | 0 | 1 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-dex.test.ts` | 2026-09-23 01:00 | 11 | 0 | 1 | name, market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/cmc-dex.ts` | 2026-09-14 13:06 | 442 | 0 | 13 + 1 later | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-evidence-shape.test.ts` | 2026-09-16 13:51 | 140 | 0 | 1 + 1 later | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-evidence-shape.ts` | 2026-09-16 13:51 | 181 | 0 | 1 + 1 later | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-expansion.test.ts` | 2026-09-14 13:06 | 66 | 0 | 2 | name, market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/cmc-live-focus.test.ts` | 2026-09-15 03:39 | 201 | 0 | 4 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-live-focus.ts` | 2026-09-14 13:06 | 209 | 0 | 7 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-operating-settings.test.ts` | 2026-09-14 13:06 | 40 | 0 | 3 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-operating-settings.ts` | 2026-09-14 13:06 | 51 | 0 | 4 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-price.test.ts` | 2026-09-14 13:06 | 38 | 0 | 2 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-price.ts` | 2026-09-14 13:06 | 30 | 0 | 3 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-quote-groups.test.ts` | 2026-09-14 13:06 | 10 | 0 | 2 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-quote-groups.ts` | 2026-09-14 13:06 | 54 | 0 | 3 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-receipt.test.ts` | 2026-09-16 13:21 | 131 | 0 | 1 + 1 later | name, market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/cmc-recording-policy.test.ts` | 2026-09-14 13:06 | 27 | 0 | 3 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-refresh-before.test.ts` | 2026-09-24 03:09 * | 77 | 0 | 0 + 1 later | name, market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/cmc-refresh-planner.test.ts` | 2026-09-15 00:39 | 154 | 0 | 1 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-refresh-planner.ts` | 2026-09-14 13:06 | 91 | 0 | 4 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-reproduce.test.ts` | 2026-09-22 21:55 | 219 | 0 | 1 + 1 later | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-reproduce.ts` | 2026-09-22 21:55 | 221 | 0 | 1 + 1 later | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc-stale-capture.test.ts` | 2026-09-24 03:09 * | 102 | 0 | 0 + 1 later | name, market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/cmc-transport.ts` | 2026-09-14 13:06 | 378 | 0 | 11 + 3 later | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/cmc.test.ts` | 2026-09-14 13:06 | 509 | 0 | 9 + 1 later | name, market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/content-image-price-pipeline.test.ts` | 2026-09-14 13:06 | 38 | 0 | 2 | market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/content-price-pipeline.test.ts` | 2026-09-14 13:06 | 38 | 0 | 2 | market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/issuer-identities.ts` | 2026-09-14 13:06 | 26 | 0 | 2 | market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/logo-cache.test.ts` | 2026-09-14 23:28 | 87 | 0 | 1 | market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/logo-cache.ts` | 2026-09-14 23:28 | 187 | 0 | 1 | market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/market-macro-policy.test.ts` | 2026-09-14 13:06 | 36 | 0 | 2 | market-assets, mentions CMC |
| `supabase/functions/_shared/memecoin/degen-gate.ts` | 2026-09-15 00:01 † | 327 | 0 | 1, not published | standalone subset |
| `supabase/functions/intel-asset-facts/index.ts` | 2026-09-15 00:39 | 65 | 0 | 1 | mentions CMC |
| `supabase/functions/intel-asset-resolve/index.ts` | 2026-09-15 00:01 | 70 | 0 | 1 | mentions CMC |
| `supabase/functions/intel-capture/index.ts` | 2026-09-15 00:39 | 210 | 0 | 18 + 1 later | name, mentions CMC |
| `supabase/functions/intel-chart-share/index.ts` | 2026-09-14 13:06 | 27 | 0 | 2 | mentions CMC |
| `supabase/functions/intel-chart-workspace/index.ts` | 2026-09-14 13:06 | 37 | 0 | 2 | mentions CMC |
| `supabase/functions/intel-data-budget/index.test.ts` | 2026-09-15 00:39 | 279 | 0 | 3 + 1 later | mentions CMC |
| `supabase/functions/intel-data-budget/index.ts` | 2026-09-15 00:39 | 330 | 0 | 5 | mentions CMC |
| `supabase/functions/intel-demo-read/index.ts` | 2026-09-23 11:38 * | 166 | 0 | 0 + 1 later | mentions CMC |
| `supabase/functions/intel-entity-identity/index.ts` | 2026-09-21 16:13 | 273 | 0 | 3 | mentions CMC |
| `supabase/functions/intel-health/health.test.ts` | 2026-09-16 20:52 | 196 | 0 | 3 | mentions CMC |
| `supabase/functions/intel-health/health.ts` | 2026-09-16 20:52 | 279 | 0 | 4 | mentions CMC |
| `supabase/functions/intel-mcp-demo/demo-tools.ts` | 2026-09-23 20:07 * | 487 | 0 | 0 + 2 later | name, mentions CMC |
| `supabase/functions/intel-mcp-demo/handler.test.ts` | 2026-09-23 20:07 * | 495 | 0 | 0 + 1 later | name, mentions CMC |
| `supabase/functions/intel-mcp-demo/handler.ts` | 2026-09-23 20:07 * | 243 | 0 | 0 + 1 later | name |
| `supabase/functions/intel-mcp-demo/index.ts` | 2026-09-23 20:07 * | 48 | 0 | 0 + 1 later | name |
| `supabase/functions/intel-mcp/index.ts` | 2026-09-20 15:04 | 227 | 0 | 2 | name |
| `supabase/functions/intel-portfolio-identity/index.test.ts` | 2026-09-15 03:39 | 734 | 0 | 4 | mentions CMC |
| `supabase/functions/intel-portfolio-identity/index.ts` | 2026-09-15 03:39 | 607 | 0 | 4 | mentions CMC |
| `supabase/functions/intel-portfolio/valuation-receipts.test.ts` | 2026-09-16 20:50 | 33 | 0 | 1 | mentions CMC |
| `supabase/functions/intel-portfolio/valuation-receipts.ts` | 2026-09-16 20:50 | 69 | 0 | 1 | mentions CMC |
| `supabase/functions/intel-research/index.test.ts` | 2026-09-16 13:52 | 81 | 0 | 2 | mentions CMC |
| `supabase/functions/intel-research/index.ts` | 2026-09-14 13:06 | 157 | 0 | 6 | mentions CMC |
| `supabase/functions/intel-rwa-lookup/handler.ts` | 2026-09-23 01:00 | 151 | 0 | 1 + 2 later | name, mentions CMC |
| `supabase/functions/intel-rwa-lookup/index.ts` | 2026-09-23 01:00 | 89 | 0 | 1 + 3 later | name, mentions CMC |
| `supabase/migrations/20260909142738_intel_thesis_activity_history.sql` | 2026-09-14 13:06 | 485 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260909142908_intel_cmc_governed_transport.sql` | 2026-09-14 13:06 | 150 | 0 | 2 | name, mentions CMC |
| `supabase/migrations/20260909151258_investor_markets_screen.sql` | 2026-09-14 13:06 | 215 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260910123057_intel_cmc_startup_rate.sql` | 2026-09-14 13:06 | 74 | 0 | 2 | name, mentions CMC |
| `supabase/migrations/20260910141759_intel_live_focus.sql` | 2026-09-14 13:06 | 45 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260910182342_intel_cmc_quote_groups.sql` | 2026-09-14 13:06 | 6 | 0 | 2 | name, mentions CMC |
| `supabase/migrations/20260910190640_intel_markets_authorized_screen.sql` | 2026-09-14 13:06 | 102 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260910203029_intel_journal_exit_integrity.sql` | 2026-09-14 13:06 | 254 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260910205100_intel_portfolio_exposure_identity.sql` | 2026-09-14 13:06 | 229 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260910212327_investor_surface_seen_context.sql` | 2026-09-14 13:06 | 130 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260910212747_intel_personal_signal_scope.sql` | 2026-09-14 13:06 | 90 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260911001126_intel_issuer_portfolio_identity.sql` | 2026-09-14 13:06 | 123 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260911002009_intel_issuer_legacy_provider_alias.sql` | 2026-09-14 13:06 | 11 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260911003222_intel_markets_provider_catalog.sql` | 2026-09-14 13:06 | 859 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260911004129_intel_market_native_cex_identity.sql` | 2026-09-14 13:06 | 759 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260911010104_intel_atomic_market_catalog.sql` | 2026-09-14 13:06 | 889 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260911034507_intel_portfolio_bounded_workspace.sql` | 2026-09-14 13:06 | 64 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260911035714_intel_selected_portfolio_signals.sql` | 2026-09-14 13:06 | 92 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260911045735_intel_chart_price_alerts.sql` | 2026-09-14 13:06 | 161 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260911052404_intel_chart_alert_holder_access.sql` | 2026-09-14 13:06 | 66 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260911065952_intel_chart_asset_navigation.sql` | 2026-09-14 13:06 | 41 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260911103034_intel_cmc_contract_chart_identity.sql` | 2026-09-14 13:06 | 28 | 0 | 2 | name, mentions CMC |
| `supabase/migrations/20260911191416_intel_desk_holdings_presentation.sql` | 2026-09-14 13:06 | 84 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260911193747_intel_unpriced_dust_coverage.sql` | 2026-09-14 13:06 | 85 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260911202239_intel_chart_alert_rehearsal.sql` | 2026-09-14 13:06 | 53 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260911213014_intel_market_alert_condition_evaluation.sql` | 2026-09-14 13:06 | 150 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260912133132_intel_market_source_versions.sql` | 2026-09-14 13:16 | 81 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260912133133_intel_dex_discovery_cohorts.sql` | 2026-09-14 13:16 | 35 | 0 | 2 | name, mentions CMC |
| `supabase/migrations/20260912133134_intel_global_cohort_quotes.sql` | 2026-09-14 13:16 | 33 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260912150306_intel_markets_compact_category_ranking.sql` | 2026-09-14 13:16 | 111 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260912162730_intel_portfolio_cached_valuation.sql` | 2026-09-14 13:16 | 382 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260912163822_intel_portfolio_shared_quote_observations.sql` | 2026-09-14 13:16 | 162 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260912194401_intel_market_history_retention.sql` | 2026-09-14 13:16 | 106 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260912203009_intel_markets_provider_scoped_projection.sql` | 2026-09-14 13:16 | 500 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260912214320_intel_live_focus_view_leases.sql` | 2026-09-14 13:16 | 45 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260914205704_intel_observation_cadence.sql` | 2026-09-14 21:00 | 183 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260914232100_intel_capture_tables.sql` | 2026-09-14 23:28 | 441 | 0 | 1 | name, mentions CMC |
| `supabase/migrations/20260914234442_intel_markets_sort_directions.sql` | 2026-09-15 00:01 | 672 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260915004534_intel_schedule_policy_apply.sql` | 2026-09-15 01:14 | 440 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260915004751_intel_on_demand_indexing.sql` | 2026-09-15 01:14 | 245 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260915010343_intel_capture_cron.sql` | 2026-09-15 01:14 | 77 | 0 | 1 | name, mentions CMC |
| `supabase/migrations/20260915013913_intel_venue_capture_cron.sql` | 2026-09-15 01:46 | 116 | 0 | 1 | name, mentions CMC |
| `supabase/migrations/20260915013940_intel_category_capture.sql` | 2026-09-15 01:46 | 173 | 0 | 1 | name, mentions CMC |
| `supabase/migrations/20260915014031_intel_liquidation_attention_alerts.sql` | 2026-09-15 01:46 | 124 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260915014302_intel_markets_drawdown.sql` | 2026-09-15 01:46 | 760 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260915014404_intel_display_currency.sql` | 2026-09-15 01:46 | 218 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260915034150_intel_new_listing_capture.sql` | 2026-09-15 03:44 | 306 | 0 | 1 | name, mentions CMC |
| `supabase/migrations/20260915034217_intel_live_tape_subjects.sql` | 2026-09-15 03:44 | 66 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260915034247_intel_long_tail_chains.sql` | 2026-09-15 03:44 | 123 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260915034255_intel_holding_identity.sql` | 2026-09-15 03:44 | 110 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260915034326_intel_holder_tags.sql` | 2026-09-15 03:44 | 244 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260915034403_intel_meme_graduation.sql` | 2026-09-15 03:44 | 188 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260915122705_intel_cardano_native_identity.sql` | 2026-09-15 12:32 | 162 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260915152118_intel_market_asset_candles.sql` | 2026-09-15 15:22 | 228 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260915155756_intel_candle_backfill_cmc_id.sql` | 2026-09-15 15:59 | 47 | 0 | 1 | name, mentions CMC |
| `supabase/migrations/20260916091500_intel_cmc_account_observations.sql` | 2026-09-16 14:17 | 81 | 0 | 2 | name, mentions CMC |
| `supabase/migrations/20260916093000_intel_evidence_standard_and_feed_caps.sql` | 2026-09-16 13:34 | 607 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260916104500_intel_swap_maker_flow.sql` | 2026-09-16 13:35 | 252 | 0 | 2 | mentions CMC |
| `supabase/migrations/20260916120000_intel_rwa_yield_provenance.sql` | 2026-09-16 13:42 | 281 | 0 | 2 | name, mentions CMC |
| `supabase/migrations/20260916150000_intel_rwa_issuer_legitimacy.sql` | 2026-09-16 13:55 | 339 | 0 | 3 | name, mentions CMC |
| `supabase/migrations/20260916202000_intel_rwa_capture_cron.sql` | 2026-09-16 20:55 | 107 | 0 | 2 | name, mentions CMC |
| `supabase/migrations/20260916205000_intel_rwa_issuer_jurisdiction_width.sql` | 2026-09-16 22:52 | 27 | 0 | 1 | name |
| `supabase/migrations/20260917140000_intel_new_listing_platform.sql` | 2026-09-17 13:38 | 162 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260917184100_intel_launchpad_sources.sql` | 2026-09-17 14:00 | 243 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260917210400_intel_sunpump_lane.sql` | 2026-09-17 14:37 | 93 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260920143000_intel_rwa_research_free_surface.sql` | 2026-09-20 15:00 | 190 | 0 | 2 | name, mentions CMC |
| `supabase/migrations/20260920150000_intel_rwa_wrapper_spread.sql` | 2026-09-20 15:02 | 373 | 0 | 1 | name, mentions CMC, standalone subset |
| `supabase/migrations/20260920151000_intel_rwa_depth.sql` | 2026-09-20 14:57 | 307 | 0 | 2 | name, mentions CMC, standalone subset |
| `supabase/migrations/20260920152000_intel_rwa_underlying_registrants.sql` | 2026-09-20 14:53 | 360 | 0 | 1 | name, mentions CMC, standalone subset |
| `supabase/migrations/20260920153000_intel_mcp_server.sql` | 2026-09-20 15:04 | 223 | 0 | 1 | name |
| `supabase/migrations/20260920154000_intel_data_budget_lane_cost.sql` | 2026-09-20 14:51 | 187 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260920155000_intel_unusual_move_scores.sql` | 2026-09-20 15:09 | 230 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260920160000_intel_rwa_universe_token_counts.sql` | 2026-09-20 14:54 | 75 | 0 | 1 | name |
| `supabase/migrations/20260920170000_intel_mcp_audit_sweep_schedule.sql` | 2026-09-20 15:19 | 8 | 0 | 1 | name |
| `supabase/migrations/20260920180000_intel_rwa_enumeration_and_filing_span.sql` | 2026-09-20 16:19 | 109 | 0 | 1 | name |
| `supabase/migrations/20260920190000_intel_rwa_depth_counter_leg.sql` | 2026-09-20 17:35 | 145 | 0 | 3 | name, mentions CMC |
| `supabase/migrations/20260922100000_intel_rwa_wrapper_premium_backfill.sql` | 2026-09-22 21:55 | 214 | 0 | 1 | name, mentions CMC, standalone subset |
| `supabase/migrations/20260922110000_intel_rwa_universe_coverage.sql` | 2026-09-22 21:55 | 220 | 0 | 1 | name, mentions CMC, standalone subset |
| `supabase/migrations/20260923002555_intel_demand_contract_provider_fix.sql` | 2026-09-23 01:00 | 10 | 0 | 1 | mentions CMC |
| `supabase/migrations/20260923002746_intel_rwa_lookup_last_good.sql` | 2026-09-23 01:00 | 69 | 0 | 1 | name |
| `supabase/migrations/20260923003517_intel_rwa_lookup_research_last_good.sql` | 2026-09-23 01:00 | 61 | 0 | 1 | name |
| `supabase/migrations/20260923011132_intel_rwa_wrapper_derivative_reference_state.sql` | 2026-09-23 01:13 | 10 | 0 | 1 | name, mentions CMC |
| `supabase/migrations/20260923120000_intel_cmc_call_proofs.sql` | 2026-09-23 11:38 * | 52 | 0 | 0 + 1 later | name, mentions CMC |
| `supabase/migrations/20260923120100_intel_demo_tracked_assets.sql` | 2026-09-23 11:38 * | 68 | 0 | 0 + 1 later | mentions CMC |
| `supabase/migrations/20260923140000_intel_stored_price_series.sql` | 2026-09-23 14:13 * | 357 | 0 | 0 + 1 later | mentions CMC |
| `supabase/migrations/20260923160000_intel_rwa_quote_warm.sql` | 2026-09-23 17:38 * | 120 | 0 | 0 + 1 later | name, mentions CMC |
| `supabase/migrations/20260923180000_intel_mcp_demo_usage.sql` | 2026-09-23 20:07 * | 111 | 0 | 0 + 1 later | name |
| `supabase/migrations/20260923193000_intel_rwa_underlying_reference.sql` | 2026-09-23 20:07 * | 175 | 0 | 0 + 1 later | name, mentions CMC |
| `supabase/migrations/20260923220000_intel_rwa_wrapper_accrual_multiplier.sql` | 2026-09-23 23:06 * | 103 | 0 | 0 + 1 later | name, mentions CMC |
| `supabase/migrations/20260923224137_intel_rwa_lookup_answers.sql` | 2026-09-23 23:06 * | 64 | 0 | 0 + 1 later | name |
| `supabase/migrations/20260924000000_intel_rwa_wrapper_xstocks_multiplier.sql` | 2026-09-24 00:12 * | 54 | 0 | 0 + 1 later | name, mentions CMC, standalone subset |
| `supabase/migrations/20260924020000_intel_rwa_lookup_live_allowance.sql` | 2026-09-24 03:09 * | 117 | 0 | 0 + 1 later | name, mentions CMC |

## Pre-existing, changed during the event

| File | First commit (UTC) | Lines added | Lines removed | Commits since 2026-09-09 | In scope by |
| --- | --- | ---: | ---: | ---: | --- |
| `src/i18n/locales/de/intel.json` | 2026-06-09 21:03 | 4356 | 283 | 78 + 7 later | mentions CMC |
| `src/i18n/locales/en/intel.json` | 2026-06-09 21:03 | 4058 | 77 | 84 + 7 later | mentions CMC |
| `src/i18n/locales/es/intel.json` | 2026-06-09 21:03 | 4365 | 292 | 78 + 7 later | mentions CMC |
| `src/i18n/locales/fr/intel.json` | 2026-06-09 21:03 | 4378 | 305 | 78 + 7 later | mentions CMC |
| `src/i18n/locales/it/intel.json` | 2026-06-09 21:03 | 4365 | 292 | 78 + 7 later | mentions CMC |
| `src/i18n/locales/nl/intel.json` | 2026-06-09 21:03 | 4349 | 276 | 78 + 7 later | mentions CMC |
| `src/i18n/locales/pt-BR/intel.json` | 2026-06-09 21:03 | 4371 | 298 | 78 + 7 later | mentions CMC |
| `src/i18n/locales/sq/intel.json` | 2026-06-09 21:03 | 4373 | 300 | 78 + 7 later | mentions CMC |
| `src/intel/IntelApp.jsx` | 2026-06-09 21:03 | 110 | 48 | 9 | mentions CMC |
| `src/intel/components/IntelModeShell.jsx` | 2026-06-09 21:03 | 128 | 40 | 7 + 2 later | mentions CMC |
| `src/intel/components/MultiTokenChart.jsx` | 2026-06-09 21:03 | 69 | 39 | 2 | mentions CMC |
| `src/intel/components/ProfilePanel.jsx` | 2026-06-09 21:03 | 72 | 72 | 1 + 1 later | mentions CMC |
| `src/intel/components/RankMovers.jsx` | 2026-06-17 23:37 | 17 | 8 | 1 | mentions CMC |
| `src/intel/components/TokenChart.jsx` | 2026-06-09 21:03 | 340 | 103 | 12 + 1 later | mentions CMC |
| `src/intel/lib/artifact-api.js` | 2026-06-09 21:03 | 21 | 3 | 1 | mentions CMC |
| `src/intel/lib/chains.js` | 2026-06-09 21:03 | 73 | 3 | 3 | mentions CMC |
| `src/intel/lib/markets-api.js` | 2026-06-09 21:03 | 372 | 74 | 12 | mentions CMC |
| `src/intel/pages/AlertsPage.jsx` | 2026-06-09 21:03 | 229 | 48 | 7 | mentions CMC |
| `src/intel/pages/AssetBreakdownPage.jsx` | 2026-06-08 20:30 | 137 | 121 | 4 | mentions CMC |
| `src/intel/pages/ComparePage.jsx` | 2026-06-09 21:03 | 158 | 68 | 3 | mentions CMC |
| `src/intel/pages/MarketAssetPage.jsx` | 2026-06-09 21:03 | 342 | 79 | 24 + 3 later | mentions CMC |
| `src/intel/pages/MarketPulsePage.jsx` | 2026-06-08 20:47 | 172 | 118 | 3 | mentions CMC |
| `src/intel/pages/MarketsPage.jsx` | 2026-06-09 21:03 | 372 | 171 | 14 + 4 later | mentions CMC |
| `src/intel/pages/PortfolioAssetPage.jsx` | 2026-06-09 21:03 | 129 | 91 | 3 | mentions CMC |
| `src/intel/pages/PortfolioPage.jsx` | 2026-06-09 21:03 | 327 | 328 | 6 | mentions CMC |
| `src/intel/pages/ThesisBuilderPage.jsx` | 2026-06-18 02:42 | 51 | 33 | 5 | mentions CMC |
| `supabase/functions/_shared/chains.ts` | 2026-06-09 21:03 † | 13 | 4 | 3, not published | standalone subset |
| `supabase/functions/_shared/intel/asset-evidence-pack.test.ts` | 2026-06-16 04:54 | 275 | 4 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/asset-evidence-pack.ts` | 2026-06-16 04:54 | 250 | 171 | 3 | mentions CMC |
| `supabase/functions/_shared/intel/asset-mini-pack.ts` | 2026-06-16 05:30 | 12 | 3 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/narrative-evidence-pack.test.ts` | 2026-06-16 05:38 | 68 | 9 | 2 | mentions CMC |
| `supabase/functions/_shared/intel/narrative-evidence-pack.ts` | 2026-06-16 05:38 | 57 | 69 | 2 | mentions CMC |
| `supabase/functions/_shared/market-assets/coingecko-provider.ts` | 2026-06-09 21:03 | 86 | 0 | 2 | market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/coinmarketcap-provider.ts` | 2026-06-09 21:03 | 136 | 25 | 4 | name, market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/market-assets/http.ts` | 2026-06-09 21:03 | 3 | 0 | 2 | market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/market-macro.ts` | 2026-06-16 04:23 | 21 | 5 | 2 | market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/provider-registry.ts` | 2026-06-09 21:03 | 9 | 0 | 2 | market-assets, mentions CMC |
| `supabase/functions/_shared/market-assets/types.ts` | 2026-06-09 21:03 | 52 | 1 | 5 + 1 later | market-assets, mentions CMC, standalone subset |
| `supabase/functions/_shared/provider-budget.ts` | 2026-06-16 01:59 † | 6 | 4 | 2, not published | standalone subset |
| `supabase/functions/intel-alerts-eval/index.ts` | 2026-06-09 21:03 | 74 | 215 | 2 | mentions CMC |
| `supabase/functions/intel-brief-cron/index.ts` | 2026-06-10 04:14 | 56 | 89 | 2 | mentions CMC |
| `supabase/functions/intel-generate/index.ts` | 2026-06-09 21:03 | 239 | 79 | 5 | mentions CMC |
| `supabase/functions/intel-markets/index.ts` | 2026-06-09 21:03 | 325 | 327 | 14 + 1 later | mentions CMC |
| `supabase/functions/intel-portfolio/index.ts` | 2026-06-09 21:03 | 149 | 107 | 4 | mentions CMC |
| `supabase/functions/intel-token-chart/index.ts` | 2026-06-09 21:03 | 69 | 20 | 3 | mentions CMC |

## Pre-existing, unchanged

| File | First commit (UTC) | Lines added | Lines removed | Commits since 2026-09-09 | In scope by |
| --- | --- | ---: | ---: | ---: | --- |
| `supabase/functions/_shared/market-assets/cex-match.test.ts` | 2026-06-09 21:03 | 0 | 0 | 0 | market-assets |
| `supabase/functions/_shared/market-assets/cex-match.ts` | 2026-06-09 21:03 | 0 | 0 | 0 | market-assets |
| `supabase/functions/_shared/market-assets/market-macro-c5a.test.ts` | 2026-06-16 04:23 | 0 | 0 | 0 | market-assets, mentions CMC |
