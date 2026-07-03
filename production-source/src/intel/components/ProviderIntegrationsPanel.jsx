import React, { useCallback, useEffect, useState } from 'react'
import { RefreshCw, CheckCircle2, XCircle, Clock3, Database, Loader2 } from 'lucide-react'
import {
  adminProviderOverview, adminProviderEndpoints, adminProviderRagCoverage,
  adminProviderFreshness, adminProviderMark, adminListFlags, adminSetFlag,
} from '../lib/admin-api'

// Provider Integrations — operational source of truth for every provider
// endpoint/job (registry from mig-363 seed + runtime status). Super-admin only
// (mounted inside IntelAdminPage; the RPCs also self-gate). Additive: if the
// migration hasn't been applied yet, we render a "not installed" hint instead
// of crashing the admin page.

function fmtDate(v) { return v ? new Date(v).toLocaleString() : 'never' }
function num(v) { return v == null ? '—' : Number(v).toLocaleString() }

function StatusChip({ ok, warn, label }) {
  const cls = ok ? 'chip chip--ok text-[10px]' : warn ? 'chip chip--info text-[10px]' : 'chip chip--err text-[10px]'
  const Icon = ok ? CheckCircle2 : warn ? Clock3 : XCircle
  return <span className={cls}><Icon className="h-3 w-3 mr-0.5 inline" />{label}</span>
}

export default function ProviderIntegrationsPanel({ supabase }) {
  const [overview, setOverview] = useState([])
  const [endpoints, setEndpoints] = useState([])
  const [rag, setRag] = useState([])
  const [fresh, setFresh] = useState([])
  const [flags, setFlags] = useState([])
  const [loading, setLoading] = useState(true)
  const [installed, setInstalled] = useState(true)
  const [err, setErr] = useState(null)
  const [savingKey, setSavingKey] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [ov, ep, rc, fr, fl] = await Promise.all([
        adminProviderOverview(supabase),
        adminProviderEndpoints(supabase),
        adminProviderRagCoverage(supabase).catch(() => []),
        adminProviderFreshness(supabase).catch(() => []),
        adminListFlags(supabase).catch(() => []),
      ])
      setOverview(ov || []); setEndpoints(ep || []); setRag(rc || []); setFresh(fr || []); setFlags(fl || [])
      setInstalled(true)
    } catch (e) {
      // Missing RPC/table (pre-migration) → surface a hint, don't throw.
      const msg = e?.message || String(e)
      if (/function .*does not exist|provider_integrations|schema cache/i.test(msg)) setInstalled(false)
      else setErr(msg)
    } finally { setLoading(false) }
  }, [supabase])

  useEffect(() => { load() }, [load])

  const mark = useCallback(async (row, patch) => {
    const key = `${row.provider}:${row.endpoint}`
    setSavingKey(key)
    try {
      await adminProviderMark(supabase, { provider: row.provider, endpoint: row.endpoint, ...patch })
      await load()
    } catch (e) { setErr(e?.message || 'update failed') } finally { setSavingKey(null) }
  }, [supabase, load])

  const toggleFlag = useCallback(async (flag, next) => {
    setSavingKey(`flag:${flag}`)
    try { await adminSetFlag(supabase, flag, next); await load() }
    catch (e) { setErr(e?.message || 'flag update failed') } finally { setSavingKey(null) }
  }, [supabase, load])

  if (!installed) {
    return (
      <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-1)] p-4">
        <h3 className="text-[13px] font-semibold text-[var(--fg-1)] flex items-center gap-2"><Database className="h-4 w-4" /> Provider Integrations</h3>
        <p className="mt-2 text-[12px] text-[var(--fg-4)]">Registry not installed yet — apply migration <code>363_provider_integration_registry.sql</code> to enable the provider integration dashboard.</p>
      </section>
    )
  }

  return (
    <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-1)] p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-[13px] font-semibold text-[var(--fg-1)] flex items-center gap-2"><Database className="h-4 w-4" /> Provider Integrations</h3>
        <button onClick={load} disabled={loading} className="btn btn--ghost text-[11px] inline-flex items-center gap-1">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
        </button>
      </div>
      {err && <p className="text-[11px] text-red-400">{err}</p>}

      {/* Provider overview cards */}
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {overview.map((p) => (
          <div key={p.provider} className="rounded-md border border-[var(--border-subtle)] p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-[var(--fg-1)] capitalize">{p.provider}</span>
              <span className="chip text-[10px]">{num(p.endpoints)} endpoints</span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              <StatusChip ok={Number(p.real_verified) > 0} warn={Number(p.configured) > 0} label={`${num(p.real_verified)} verified`} />
              {Number(p.failing) > 0 && <span className="chip chip--err text-[10px]">{num(p.failing)} failing</span>}
              {Number(p.rag_endpoints) > 0 && <span className="chip chip--info text-[10px]">{num(p.rag_endpoints)} RAG</span>}
            </div>
            <div className="mt-1.5 text-[10px] text-[var(--fg-4)] leading-relaxed">
              24h: {num(p.calls_24h)} calls · {num(p.credits_24h)} CU/cr · <span className={Number(p.errors_24h) > 0 ? 'text-red-400' : ''}>{num(p.errors_24h)} err</span><br />
              MTD: {num(p.calls_used_mtd)} calls · {num(p.credits_used_mtd)} CU/cr
            </div>
          </div>
        ))}
        {overview.length === 0 && !loading && <p className="text-[11px] text-[var(--fg-5)]">No provider endpoints registered.</p>}
      </div>

      {/* Feature flags (kill switches) */}
      {flags.length > 0 && (
        <div className="rounded-md border border-[var(--border-subtle)] p-2.5">
          <div className="text-[11px] text-[var(--fg-4)] uppercase mb-1.5">Feature flags (kill switches)</div>
          <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
            {flags.map((f) => {
              const saving = savingKey === `flag:${f.flag}`
              return (
                <div key={f.flag} className="flex items-center justify-between gap-2 rounded border border-[var(--border-subtle)] px-2 py-1.5">
                  <div className="min-w-0">
                    <div className="font-mono text-[10px] text-[var(--fg-2)] truncate">{f.flag}</div>
                    {f.note && <div className="text-[9px] text-[var(--fg-5)] truncate" title={f.note}>{f.note}</div>}
                  </div>
                  <button
                    disabled={saving}
                    onClick={() => toggleFlag(f.flag, !f.enabled)}
                    className={`shrink-0 text-[10px] px-2 py-1 rounded ${f.enabled ? 'chip chip--ok' : 'chip'}`}
                    title={f.enabled ? 'Click to disable' : 'Click to enable'}
                  >{saving ? '…' : (f.enabled ? 'ON' : 'OFF')}</button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Endpoint registry */}
      <div className="overflow-x-auto rounded-md border border-[var(--border-subtle)]">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-[var(--fg-4)] text-left border-b border-[var(--border-subtle)]">
              <th className="p-1.5 font-medium">Endpoint</th>
              <th className="p-1.5 font-medium">Surface</th>
              <th className="p-1.5 font-medium">Cache</th>
              <th className="p-1.5 font-medium">Cost</th>
              <th className="p-1.5 font-medium">Flag</th>
              <th className="p-1.5 font-medium">Status</th>
              <th className="p-1.5 font-medium">Last success</th>
              <th className="p-1.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map((r) => {
              const key = `${r.provider}:${r.endpoint}`
              const saving = savingKey === key
              return (
                <tr key={key} className="border-b border-[var(--border-subtle)] align-top">
                  <td className="p-1.5">
                    <div className="font-mono text-[10px] text-[var(--fg-2)]">{r.endpoint}</div>
                    <div className="flex gap-1 mt-0.5">
                      <span className="chip text-[9px]">{r.push_or_poll}</span>
                      {r.rag_enabled && <span className="chip chip--info text-[9px]">RAG</span>}
                    </div>
                  </td>
                  <td className="p-1.5 text-[var(--fg-3)]">{r.product_use}</td>
                  <td className="p-1.5 font-mono text-[10px] text-[var(--fg-4)]">{r.cache_table}</td>
                  <td className="p-1.5 text-[var(--fg-4)]">{r.unit_cost}</td>
                  <td className="p-1.5 font-mono text-[10px] text-[var(--fg-4)]">{r.feature_flag || '—'}</td>
                  <td className="p-1.5">
                    <div className="flex flex-col gap-0.5">
                      <StatusChip ok={r.setup_status === 'verified'} warn={r.setup_status === 'configured'} label={r.setup_status} />
                      <StatusChip ok={r.test_status === 'passed'} warn={r.test_status === 'untested'} label={r.test_status} />
                      {r.real_call_verified && <span className="chip chip--ok text-[9px]">real ✓</span>}
                      {r.last_error && <span className="text-[9px] text-red-400 truncate max-w-[160px]" title={r.last_error}>{r.last_error}</span>}
                    </div>
                  </td>
                  <td className="p-1.5 text-[10px] text-[var(--fg-4)]">{fmtDate(r.last_success_at)}</td>
                  <td className="p-1.5">
                    <div className="flex flex-col gap-1">
                      <select
                        value={r.setup_status}
                        disabled={saving}
                        onChange={(e) => mark(r, { setupStatus: e.target.value })}
                        className="text-[10px] bg-[var(--bg-2)] border border-[var(--border-subtle)] rounded px-1 py-0.5"
                      >
                        <option value="unconfigured">unconfigured</option>
                        <option value="configured">configured</option>
                        <option value="verified">verified</option>
                      </select>
                      <button
                        disabled={saving}
                        onClick={() => mark(r, { realCallVerified: !r.real_call_verified })}
                        className="btn btn--ghost text-[9px]"
                      >{r.real_call_verified ? 'unverify call' : 'mark call ✓'}</button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Freshness + RAG coverage */}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-[var(--border-subtle)] p-2.5">
          <div className="text-[11px] text-[var(--fg-4)] uppercase mb-1.5">Data freshness</div>
          <div className="space-y-1">
            {fresh.map((f) => (
              <div key={f.table} className="flex items-center justify-between text-[10px]">
                <span className="font-mono text-[var(--fg-3)]">{f.table}</span>
                {f.missing ? <span className="chip text-[9px]">not created</span> : (
                  <span className="text-[var(--fg-4)]">{num(f.rows)} rows · {fmtDate(f.latest)}{Number(f.stale_1d) > 0 ? ` · ${num(f.stale_1d)} stale` : ''}</span>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-md border border-[var(--border-subtle)] p-2.5">
          <div className="text-[11px] text-[var(--fg-4)] uppercase mb-1.5">RAG coverage (intelligence_memory_embeddings)</div>
          <div className="space-y-1">
            {rag.length === 0 && <p className="text-[10px] text-[var(--fg-5)]">No RAG rows yet.</p>}
            {rag.map((c) => (
              <div key={c.source_table} className="flex items-center justify-between text-[10px]">
                <span className="font-mono text-[var(--fg-3)]">{c.source_table}</span>
                <span className="text-[var(--fg-4)]">{num(c.embedded)}/{num(c.rows)} embedded · {fmtDate(c.last_embedded_at)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
