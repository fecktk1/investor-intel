// Investor Intel public demo: search and asset reads for ACTIVELY TRACKED assets.
// Wiring only; the handler and its protections are in ./handler.ts, the request
// vocabulary and the tracked-asset rule in ../_shared/intel/demo-read.ts, and the
// stored, cache-only market reads in ../_shared/intel/demo-market-read.ts.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { checkAndIncrement, hashedIpKey } from '../_shared/rate-limit.ts'
import { suggestMarketAssets } from '../_shared/intel/market-asset-suggest.ts'
import { marketScreenResponse } from '../_shared/intel/markets-screen.ts'
import { screenProvenance } from '../_shared/intel/market-provenance.ts'
import { readNativeChainPerformance } from '../_shared/intel/chain-performance-read.ts'
import { cacheOnlyCmc, demoMarketDetail, demoMarketHistory, resolveDemoAsset } from '../_shared/intel/demo-market-read.ts'
import { deltas, deployments, listingAge, listingCohorts, noticeState, supplyTrust } from '../_shared/intel/asset-facts.ts'
import { readCmcProfile } from '../_shared/token-profile/cmc-profile.ts'
import { profileTtlMs, resolveProfileRow } from '../_shared/token-profile/profile.ts'
import { captureReadEnvelope } from '../_shared/intel/capture-read-envelope.ts'
import { readAssetVenueContext } from '../_shared/intel/asset-venue-service.ts'
import { marketCanonicalIdentity, marketIdentityChoices } from '../_shared/intel/market-read-quality.ts'
import { resolveAsset } from '../_shared/intel/asset-resolver.ts'
import { investigationIdentity, readInvestigationHistory } from '../_shared/intel/investigation-service.ts'
import { cmcHistoryPolicy } from '../_shared/intel/investigation-normalize.ts'
import { cmcPolicyEnvironment } from '../_shared/market-assets/cmc-operating-settings.ts'
import { loadCmcOperatingSettings } from '../_shared/market-assets/cmc-transport.ts'
import { cmcDexIdentity } from '../_shared/market-assets/cmc-dex.ts'
import type { DemoReadDeps, Identity } from '../_shared/intel/demo-read.ts'
import { handleDemoRead, type HandlerDeps } from './handler.ts'

// deno-lint-ignore no-explicit-any
type Any = any

const NEWS_SELECT: Record<string, string> = {
  // src/intel/lib/asset-news.js, column for column.
  intel_curated_news: 'id,title,cleaned_title,summary,why_it_matters,signal,confidence,primary_url,published_at,source_count,chains,tokens',
  intel_global_news: 'id,title,url,summary,source_name,sentiment,published_at,chains,entity_symbol',
}
const NEWS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function readers(db: Any): DemoReadDeps {
  const canonicalKeys = (asset: Any): string[] => [
    marketCanonicalIdentity(asset).canonicalAssetKey,
    ...marketIdentityChoices(asset).map((choice) => choice.canonicalAssetKey),
    asset?.source_provider && asset?.provider_id != null ? `market:${asset.source_provider}:${asset.provider_id}` : null,
  ].filter((value): value is string => typeof value === 'string' && !!value)
  return {
    async tracked(identities: Identity[]) {
      const { data, error } = await db.rpc('intel_demo_tracked_assets', { p_identities: identities.slice(0, 200) })
      if (error) throw new Error('tracked_read_failed')
      return new Set((Array.isArray(data) ? data : []).map((row: Any) => `${row.source_provider}:${row.provider_id}`))
    },
    suggest: (q, limit) => suggestMarketAssets(db, q, limit),
    async screen(query) {
      const [{ data: screen, error }, nativeChains] = await Promise.all([
        db.rpc('intel_markets_screen_public', { p_query: query }),
        readNativeChainPerformance(db, cacheOnlyCmc).catch(() => ({ rows: [], unavailable: true })),
      ])
      if (error || !screen) return null
      const formatted = marketScreenResponse(screen)
      const { receipt, figureProvenance } = screenProvenance(formatted)
      return { ...formatted, receipt, figureProvenance, nativeChains: nativeChains.rows, nativeChainsUnavailable: nativeChains.unavailable }
    },
    resolve: (symbol, identity) => resolveDemoAsset(db, symbol, identity?.sourceProvider, identity?.providerId),
    detail: (read, asset) => demoMarketDetail(db, {
      symbol: read.symbol, sourceProvider: read.identity?.sourceProvider, providerId: read.identity?.providerId,
      timeframe: read.timeframe, interval: read.interval, lookbackBars: read.lookbackBars,
      candlesOnly: read.mode === 'candles', quotesOnly: read.mode === 'quote',
    }, asset),
    history: (read, asset) => demoMarketHistory(db, { symbol: read.symbol, sourceProvider: read.identity?.sourceProvider, providerId: read.identity?.providerId, range: read.range }, asset),
    // intel-asset-facts op 'asset', read for read: rows the capture jobs wrote.
    async facts(identity, days) {
      const { data: row, error } = await db.from('market_assets')
        .select('source_provider,provider_id,symbol,name,primary_chain,platforms,circulating_supply,total_supply,max_supply,market_cap,num_market_pairs,facts,facts_at')
        .eq('source_provider', identity.sourceProvider).eq('provider_id', identity.providerId).maybeSingle()
      if (error) return { status: 503, body: { error: 'asset_facts_unavailable' } }
      if (!row) return { status: 404, body: { error: 'asset_not_found' } }
      return {
        status: 200,
        body: {
          asset: { sourceProvider: row.source_provider, providerId: String(row.provider_id), symbol: row.symbol ?? null, name: row.name ?? null, numMarketPairs: row.num_market_pairs ?? null },
          supply: supplyTrust(row), age: listingAge(row), deployments: deployments(row), notice: noticeState(row),
          deltas: await deltas(db, identity.sourceProvider, identity.providerId, days),
          factsAt: row.facts_at ?? null,
          attribution: identity.sourceProvider === 'coinmarketcap' ? 'Data via CoinMarketCap' : 'Data via CoinGecko',
        },
      }
    },
    cohorts: (provider) => listingCohorts(db, provider),
    // token-profile-get, without its refresh: the CMC metadata cache (render),
    // or the stored CoinGecko profile row. Nothing is enqueued.
    async profile(identity) {
      if (identity.sourceProvider === 'coinmarketcap') return readCmcProfile(db, identity.providerId, {}, false, cacheOnlyCmc)
      const existing = await resolveProfileRow(db, { sourceProvider: identity.sourceProvider, providerId: identity.providerId })
      if (!existing) return { profile: null, state: 'unavailable', reason: 'missing_coverage' }
      const fresh = existing.last_enriched_at && (Date.now() - new Date(existing.last_enriched_at as string).getTime() < profileTtlMs())
      return { profile: existing, state: fresh ? 'fresh' : 'stale' }
    },
    capture: (body) => captureReadEnvelope(db, body, { now: Date.now(), startedAt: Date.now(), env: () => undefined }),
    // Retained evidence only: with no refresh function the service never asks a source.
    venue: (canonicalKey) => readAssetVenueContext(db, { canonicalKey, refresh: false }),
    canonicalKeys,
    evidenceSubjects: (asset) => canonicalKeys(asset).map((key) => cmcDexIdentity(key)?.subject).filter((value): value is string => !!value),
    // intel-investigate 'history' for the liquidity lens, as a member reads it:
    // retained observations only, under the same historical-retention policy.
    async evidence(read) {
      const now = Date.now()
      try {
        const env = cmcPolicyEnvironment(await loadCmcOperatingSettings(db), (key) => Deno.env.get(key), now)
        const policy = cmcHistoryPolicy(now, new Date(now + 21_600_000).toISOString(), env)
        const input = { from: read.from, to: read.to, limit: read.limit, ...(read.metrics ? { metrics: read.metrics } : {}), ...(read.cursor ? { cursor: read.cursor } : {}) }
        return { status: 200, body: await readInvestigationHistory(db, [investigationIdentity(read.subject).subject], input, now, policy.historical) }
      } catch (e) {
        const message = e instanceof Error ? e.message : ''
        if (/^(invalid_|unsupported_)/.test(message)) return { status: 400, body: { error: message } }
        throw e
      }
    },
    async news(table, terms) {
      const now = Date.now()
      let query = db.from(table).select(NEWS_SELECT[table])
      if (table === 'intel_curated_news') query = query.eq('should_surface', true)
      const { data, error } = await query.or(terms.join(','))
        .gte('published_at', new Date(now - NEWS_WINDOW_MS).toISOString()).lte('published_at', new Date(now).toISOString())
        .order('published_at', { ascending: false }).limit(40)
      if (error || !Array.isArray(data)) return null
      return data
    },
    // intel-asset-resolve for 'cmc:<id>', with every step held to stored or
    // cached data: the CoinMarketCap steps read the shared cache only, the DEX,
    // Birdeye and chain steps are refused, nothing is indexed, and the demand
    // stamp (the one RPC the ladder makes) is refused, so nothing is bought later.
    async resolveIdentity(cmcId) {
      const started = Date.now()
      const refuse = () => Promise.reject(new Error('demo_stored_only'))
      const readOnly = new Proxy(db, {
        get(target, prop) {
          if (prop === 'rpc') return () => Promise.resolve({ data: null, error: { message: 'demo_read_only' } })
          const value = target[prop]
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const result = await resolveAsset(readOnly, {
        query: `cmc:${cmcId}`, chain: null, orgId: null, userId: null, ctx: { supabase: db },
        deps: {
          requestCmc: cacheOnlyCmc, searchTokens: refuse, getTokenPairs: refuse, getTokenInfo: refuse, getTokenMetadata: refuse,
          rpcCall: refuse, env: () => undefined,
          indexAsset: () => Promise.resolve({ indexed: false, demanded: false, reasons: ['demo_read_only'] }),
        } as Any,
      })
      return { ...result, ms: Date.now() - started }
    },
  }
}

function productionDeps(): HandlerDeps {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
  return {
    reads: readers(db),
    limit: (key, limit, windowSeconds) => checkAndIncrement(db, key, limit, windowSeconds),
    ipKey: hashedIpKey,
    secrets: () => [Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), Deno.env.get('COINMARKETCAP_API_KEY'), Deno.env.get('CMC_API_KEY')],
  }
}

if (import.meta.main) {
  let deps: HandlerDeps | null = null
  Deno.serve((req) => handleDemoRead(req, deps ??= productionDeps()))
}
