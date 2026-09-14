// Market Assets — cached HTTP choke point for market-cap providers.
//
// Modeled on _shared/exchange-market/http.ts but provider-generic (arbitrary
// host + optional auth headers, e.g. CoinMarketCap's X-CMC_PRO_API_KEY). Every
// call is: in-memory cache -> DB response cache -> live (single-flight) with
// timeout + capped retry on 429/5xx, usage logging, and a per-context budget.
// Returns null on suppression/failure so callers degrade to cached-or-empty.

import { logProviderCall } from '../provider-budget.ts'

// deno-lint-ignore no-explicit-any
const _glob = globalThis as any

function env(name: string): string | undefined {
  try { const v = _glob?.Deno?.env?.get?.(name); if (v != null) return v } catch { /* permission-gated */ }
  const pv = _glob?.process?.env?.[name]
  return pv != null ? String(pv) : undefined
}
function envFlag(name: string, dflt: boolean): boolean {
  const v = env(name)
  if (v == null || v === '') return dflt
  return /^(1|true|yes|on)$/i.test(v.trim())
}
function envNum(name: string, dflt: number): number {
  const v = Number(env(name))
  return Number.isFinite(v) && v >= 0 ? v : dflt
}

export function marketAssetsEnabled(): boolean {
  return envFlag('ENABLE_MARKET_ASSETS', true)
}

const TIMEOUT_MS = () => envNum('MARKET_ASSETS_REQUEST_TIMEOUT_MS', 12000)
const MAX_RETRIES = () => envNum('MARKET_ASSETS_MAX_RETRIES', 2)
const BACKOFF_MS = () => envNum('MARKET_ASSETS_BACKOFF_BASE_MS', 500)
const RESP_TTL_MS = () => envNum('MARKET_ASSETS_RESPONSE_TTL_SECONDS', 90) * 1000
// Negative-cache cap for non-429 4xx. Kept short: a 4xx is often a transient
// rollout/config error (e.g. a pro key briefly hitting the demo URL → 400/10010),
// and a long negative TTL would mask the fix long after it ships. Self-heals fast.
const NEG_TTL_MS = () => envNum('MARKET_ASSETS_NEGATIVE_TTL_SECONDS', 900) * 1000
const MAX_CALLS_PER_JOB = () => envNum('MARKET_ASSETS_MAX_CALLS_PER_JOB', 40)
const MAX_CALLS_PER_REQUEST = () => envNum('MARKET_ASSETS_MAX_CALLS_PER_REQUEST', 8)

// deno-lint-ignore no-explicit-any
type Ctx = { supabase?: any; jobName?: string; caller?: string; requestId?: string | null; kind?: 'job' | 'request' | 'render'; maxCalls?: number; _calls?: number }

// ── in-memory cache + single-flight ──────────────────────────────────────────
type MemEntry = { data: unknown; status: number; expiresAt: number; negative: boolean }
const _mem = new Map<string, MemEntry>()
const _inflight = new Map<string, Promise<unknown>>()
function memGet(key: string, now: number): MemEntry | null { const e = _mem.get(key); if (!e) return null; if (e.expiresAt <= now) { _mem.delete(key); return null }; return e }
function memSet(key: string, data: unknown, status: number, ttl: number, now: number, negative = false) { _mem.set(key, { data, status, expiresAt: now + ttl, negative }) }
function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const ex = _inflight.get(key); if (ex) return ex as Promise<T>
  const p = (async () => { try { return await fn() } finally { _inflight.delete(key) } })()
  _inflight.set(key, p); return p as Promise<T>
}

function ctxBudget(ctx?: Ctx): number {
  if (ctx?.maxCalls != null) return ctx.maxCalls
  if (ctx?.kind === 'request') return MAX_CALLS_PER_REQUEST()
  if (ctx?.kind === 'render') return 0
  return MAX_CALLS_PER_JOB()
}

async function logUsage(provider: string, endpoint: string, ctx: Ctx | undefined, row: { symbolCount?: number | null; cacheStatus: string; statusCode?: number | null; durationMs?: number | null; retryCount?: number | null; blocked?: boolean; error?: string | null }) {
  await logProviderCall(ctx?.supabase, {
    provider,
    dataType: 'market_assets',
    endpoint,
    subjectRef: row.symbolCount ? `symbols:${row.symbolCount}` : null,
    cacheStatus: row.cacheStatus,
    calls: row.cacheStatus === 'miss' || (row.cacheStatus === 'rate_capped' && row.statusCode != null) ? 1 : 0,
    latencyMs: row.durationMs ?? null,
    statusCode: row.statusCode ?? null,
    suppressionReason: row.blocked ? row.error ?? row.cacheStatus : null,
    caller: ctx?.caller ?? ctx?.jobName ?? null,
    jobName: ctx?.jobName ?? null,
    requestId: ctx?.requestId ?? null,
    environment: env('APP_ENV') ?? null,
    errorMessage: row.error ?? null,
  })
  try {
    if (!ctx?.supabase) return
    await ctx.supabase.from('market_data_api_usage_logs').insert({
      provider, endpoint, symbol_count: row.symbolCount ?? null, job_name: ctx.jobName ?? null,
      caller: ctx.caller ?? ctx.jobName ?? null, request_id: ctx.requestId ?? null,
      environment: env('APP_ENV') ?? null, cache_status: row.cacheStatus, status_code: row.statusCode ?? null,
      duration_ms: row.durationMs ?? null, retry_count: row.retryCount ?? null, blocked_by_limit: !!row.blocked, error_message: row.error ?? null,
    })
  } catch { /* table absent / unreachable */ }
}

async function recordHealth(provider: string, ctx: Ctx | undefined, patch: { ok: boolean; status?: number | null; rateLimitedUntil?: number | null; error?: string | null }) {
  try {
    if (!ctx?.supabase) return
    const nowIso = new Date().toISOString()
    const row: Record<string, unknown> = { provider, last_status: patch.status ?? null, updated_at: nowIso }
    if (patch.ok) { row.last_ok_at = nowIso; row.consecutive_failures = 0 } else { row.last_error_at = nowIso; row.last_error = patch.error ?? null }
    if (patch.rateLimitedUntil) row.rate_limited_until = new Date(patch.rateLimitedUntil).toISOString()
    await ctx.supabase.from('market_data_providers').upsert(row, { onConflict: 'provider' })
  } catch { /* ignore */ }
}

async function dbReadResponse(supabase: unknown, provider: string, cacheKey: string, now: number): Promise<{ data: unknown; status: number; negative: boolean } | null> {
  try {
    // deno-lint-ignore no-explicit-any
    const sb = supabase as any; if (!sb) return null
    const { data } = await sb.from('market_data_response_cache').select('response_json, status_code, negative_cache, expires_at').eq('provider', provider).eq('cache_key', cacheKey).maybeSingle()
    if (!data) return null
    if (new Date(data.expires_at).getTime() <= now) return null
    return { data: data.response_json, status: data.status_code, negative: !!data.negative_cache }
  } catch { return null }
}
async function dbWriteResponse(supabase: unknown, row: { provider: string; cacheKey: string; endpoint: string; data: unknown; status: number; negative: boolean; ttlMs: number }, now: number) {
  try {
    // deno-lint-ignore no-explicit-any
    const sb = supabase as any; if (!sb) return
    await sb.from('market_data_response_cache').upsert({
      provider: row.provider, cache_key: row.cacheKey, endpoint: row.endpoint, response_json: row.negative ? null : row.data,
      status_code: row.status, cache_status: row.negative ? 'negative' : 'miss', negative_cache: row.negative,
      expires_at: new Date(now + row.ttlMs).toISOString(), updated_at: new Date(now).toISOString(),
    }, { onConflict: 'provider,cache_key' })
  } catch { /* best-effort */ }
}

export interface MarketAssetsGetOpts {
  provider: string                    // 'coingecko' | 'coinmarketcap'
  url: string                         // full URL
  endpoint: string                    // stable label for cache/logs
  cacheKey?: string                   // defaults to endpoint
  headers?: Record<string, string>
  ttlMs?: number
  symbolCount?: number | null
  ctx?: Ctx
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Cached GET returning parsed JSON, or null on suppression/failure. */
export async function marketAssetsGet<T = unknown>(opts: MarketAssetsGetOpts): Promise<T | null> {
  // CMC may only use cmc-transport.ts; this generic retrying client cannot
  // atomically reserve account credits and must never provide a bypass.
  if (opts.provider === 'coinmarketcap' || /coinmarketcap\.com/i.test(opts.url)) return null
  const { provider, url, endpoint, ctx } = opts
  const cacheKey = opts.cacheKey || endpoint
  const ttl = opts.ttlMs ?? RESP_TTL_MS()
  const now0 = Date.now()
  const memKey = `${provider}:${cacheKey}`

  const mem = memGet(memKey, now0)
  if (mem) { await logUsage(provider, endpoint, ctx, { cacheStatus: mem.negative ? 'negative_hit' : 'hit', symbolCount: opts.symbolCount }); return mem.negative ? null : (mem.data as T) }

  if (!marketAssetsEnabled()) { await logUsage(provider, endpoint, ctx, { cacheStatus: 'disabled', symbolCount: opts.symbolCount, blocked: true }); return null }

  const db = await dbReadResponse(ctx?.supabase, provider, cacheKey, now0)
  if (db) { memSet(memKey, db.data, db.status, ttl, now0, db.negative); await logUsage(provider, endpoint, ctx, { cacheStatus: db.negative ? 'negative_hit' : 'db_hit', symbolCount: opts.symbolCount }); return db.negative ? null : (db.data as T) }

  if (opts.ctx?.kind === 'render') return null   // render paths never live-call

  if (ctx) { ctx._calls = (ctx._calls ?? 0) + 1; if (ctx._calls > ctxBudget(ctx)) { await logUsage(provider, endpoint, ctx, { cacheStatus: 'budget_exceeded', symbolCount: opts.symbolCount, blocked: true }); return null } }

  return singleFlight(memKey, async () => {
    const startedAt = Date.now()
    let retry = 0
    for (;;) {
      let status = 0
      try {
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), TIMEOUT_MS())
        let res
        try { res = await _glob.fetch(url, { headers: { accept: 'application/json', ...(opts.headers || {}) }, signal: ac.signal }) } finally { clearTimeout(timer) }
        status = res.status
        if (res.ok) {
          const data = await res.json().catch(() => null)
          memSet(memKey, data, status, ttl, Date.now())
          await dbWriteResponse(ctx?.supabase, { provider, cacheKey, endpoint, data, status, negative: false, ttlMs: ttl }, Date.now())
          await logUsage(provider, endpoint, ctx, { cacheStatus: 'miss', statusCode: status, durationMs: Date.now() - startedAt, retryCount: retry, symbolCount: opts.symbolCount })
          await recordHealth(provider, ctx, { ok: true, status })
          return data as T
        }
        if (status === 429 || status >= 500) {
          if (retry < MAX_RETRIES()) { retry++; const ra = Number(res.headers?.get?.('retry-after')); await sleep(Math.max(Number.isFinite(ra) ? ra * 1000 : 0, BACKOFF_MS() * Math.pow(2, retry - 1))); continue }
          await logUsage(provider, endpoint, ctx, { cacheStatus: status === 429 ? 'rate_capped' : 'miss', statusCode: status, durationMs: Date.now() - startedAt, retryCount: retry, symbolCount: opts.symbolCount })
          await recordHealth(provider, ctx, { ok: false, status, rateLimitedUntil: status === 429 ? Date.now() + 60_000 : null, error: `http_${status}` })
          return null
        }
        // other 4xx → negative-cache, no retry
        memSet(memKey, null, status, Math.min(ttl, NEG_TTL_MS()), Date.now(), true)
        await dbWriteResponse(ctx?.supabase, { provider, cacheKey, endpoint, data: null, status, negative: true, ttlMs: Math.min(ttl, NEG_TTL_MS()) }, Date.now())
        await logUsage(provider, endpoint, ctx, { cacheStatus: 'miss', statusCode: status, durationMs: Date.now() - startedAt, retryCount: retry, symbolCount: opts.symbolCount })
        await recordHealth(provider, ctx, { ok: false, status, error: `http_${status}` })
        return null
      } catch (err) {
        if (retry < MAX_RETRIES()) { retry++; await sleep(BACKOFF_MS() * Math.pow(2, retry - 1)); continue }
        await logUsage(provider, endpoint, ctx, { cacheStatus: 'miss', statusCode: status || null, durationMs: Date.now() - startedAt, retryCount: retry, error: (err as Error)?.message?.slice(0, 300), symbolCount: opts.symbolCount })
        await recordHealth(provider, ctx, { ok: false, status: status || null, error: (err as Error)?.message?.slice(0, 200) })
        return null
      }
    }
  })
}

export function __resetMarketAssetsHttpForTests() { _mem.clear(); _inflight.clear() }
