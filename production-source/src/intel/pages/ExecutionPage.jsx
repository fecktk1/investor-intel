import React, { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Zap, FileText, AlertTriangle, CheckCircle, Loader2, ArrowRight } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import IntelDisclaimer from '../components/IntelDisclaimer'
import { fmtVol } from '../lib/market-format'

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const WSOL_MINT = 'So11111111111111111111111111111111111111112'

const INPUT_TOKENS = [
  { id: 'usdc', label: 'USDC', mint: USDC_MINT, decimals: 6 },
  { id: 'sol',  label: 'SOL',  mint: WSOL_MINT, decimals: 9 },
]

const SLIPPAGE_OPTIONS = [
  { bps: 50,  label: '0.5%' },
  { bps: 100, label: '1%' },
  { bps: 200, label: '2%' },
  { bps: 500, label: '5%' },
]

const QUALITY_CFG = {
  strong:     { chipCls: 'chip--ok',  label: 'Strong',     impactThresh: 0 },
  reasonable: { chipCls: 'chip--info', label: 'Reasonable', impactThresh: 0.5 },
  thin:       { chipCls: 'bg-orange-500/20 text-orange-300 border border-orange-500/30', label: 'Thin', impactThresh: 2 },
  poor:       { chipCls: 'chip--err', label: 'Poor',       impactThresh: 5 },
  unknown:    { chipCls: 'chip text-[var(--fg-4)]', label: 'Unknown', impactThresh: null },
}

function QualityChip({ quality }) {
  const cfg = QUALITY_CFG[quality] || QUALITY_CFG.unknown
  return <span className={`chip ${cfg.chipCls}`}>{cfg.label}</span>
}

function impactClass(pct) {
  if (pct == null) return 'text-[var(--fg-4)]'
  if (pct > 2) return 'text-red-400'
  if (pct > 0.5) return 'text-amber-400'
  return 'text-[var(--ok)]'
}

function fmtPrice(p) {
  if (p == null) return '—'
  if (p < 0.0001) return `$${p.toExponential(2)}`
  if (p < 1) return `$${p.toPrecision(4)}`
  return `$${p.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

// Fetches and renders the full AI-generated report from dflow_execution_intelligence_reports.
function ExecutionReportView({ reportId, orgId, supabase }) {
  const [row, setRow] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    supabase
      .from('dflow_execution_intelligence_reports')
      .select('sections, summary, execution_quality, confidence')
      .eq('id', reportId)
      .eq('org_id', orgId)
      .single()
      .then(({ data }) => { if (!cancelled) { setRow(data); setLoading(false) } })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [reportId, orgId, supabase])

  if (loading) return <div className="card p-6 grid place-items-center"><Loader2 className="h-5 w-5 animate-spin text-[var(--accent)]" /></div>
  if (!row) return null
  const s = row.sections || {}

  return (
    <div className="space-y-4">
      {s.summary && (
        <div className="card p-4">
          <p className="text-[14px] text-[var(--fg-1)] leading-relaxed">{s.summary}</p>
        </div>
      )}

      {(s.liquidity_notes || s.route_notes || s.slippage_notes || s.risk_notes) && (
        <div className="grid sm:grid-cols-2 gap-3">
          {[['liquidity_notes', 'Liquidity'], ['route_notes', 'Route'], ['slippage_notes', 'Slippage'], ['risk_notes', 'Risk']].filter(([k]) => s[k]).map(([k, label]) => (
            <div key={k} className="card p-3 space-y-1">
              <div className="eyebrow">{label}</div>
              <p className="text-[12px] text-[var(--fg-2)] leading-relaxed">{s[k]}</p>
            </div>
          ))}
        </div>
      )}

      {s.content_angle && (
        <div className="card p-4">
          <div className="eyebrow mb-1">Content angle</div>
          <p className="text-[13px] text-[var(--fg-1)] font-medium">{s.content_angle}</p>
        </div>
      )}

      {s.suggested_x_post && (
        <div className="card p-4">
          <div className="eyebrow mb-1">Suggested X post</div>
          <p className="text-[13px] text-[var(--fg-2)] whitespace-pre-wrap leading-relaxed">{s.suggested_x_post}</p>
        </div>
      )}

      {Array.isArray(s.suggested_thread) && s.suggested_thread.length > 0 && (
        <div className="card p-4 space-y-2">
          <div className="eyebrow">Suggested thread</div>
          {s.suggested_thread.map((tweet, i) => (
            <div key={i} className="card--flat p-2.5 text-[12px] text-[var(--fg-2)] leading-relaxed">
              <span className="text-[var(--fg-4)] mr-1.5">{i + 1}/</span>{tweet}
            </div>
          ))}
        </div>
      )}

      {s.suggested_newsletter_blurb && (
        <div className="card p-4">
          <div className="eyebrow mb-1">Newsletter blurb</div>
          <p className="text-[13px] text-[var(--fg-2)] whitespace-pre-wrap leading-relaxed">{s.suggested_newsletter_blurb}</p>
        </div>
      )}

      {Array.isArray(s.manual_verification) && s.manual_verification.length > 0 && (
        <div className="card p-4 space-y-1.5">
          <div className="eyebrow">Verify before publishing</div>
          <ul className="space-y-1">
            {s.manual_verification.map((item, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[12px] text-[var(--fg-3)]">
                <CheckCircle className="h-3.5 w-3.5 text-[var(--fg-4)] flex-shrink-0 mt-0.5" />{item}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export default function ExecutionPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()

  const [form, setForm] = useState({ outputMint: '', inputToken: 'usdc', amount: '1000', slippageBps: 50 })
  const [checking, setChecking]     = useState(false)
  const [checkResult, setCheckResult] = useState(null)
  const [checkErr, setCheckErr]     = useState(null)
  const [generating, setGenerating] = useState(false)
  const [reportId, setReportId]     = useState(null)
  const [reportErr, setReportErr]   = useState(null)

  const inputTok = INPUT_TOKENS.find(t => t.id === form.inputToken) || INPUT_TOKENS[0]
  const rawAmount = Math.round(parseFloat(form.amount || '0') * Math.pow(10, inputTok.decimals))
  const canRun = form.outputMint.trim().length > 20 && rawAmount > 0 && !!org?.id

  const runCheck = useCallback(async () => {
    if (!canRun) return
    setChecking(true); setCheckErr(null); setCheckResult(null); setReportId(null); setReportErr(null)
    try {
      const { data, error } = await supabase.functions.invoke('dflow-check-execution', {
        body: { orgId: org.id, inputMint: inputTok.mint, outputMint: form.outputMint.trim(), amount: rawAmount, slippageBps: form.slippageBps },
      })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)
      setCheckResult(data)
    } catch (ex) { setCheckErr(ex.message) }
    finally { setChecking(false) }
  }, [form, org?.id, inputTok, rawAmount, canRun, supabase])

  const runReport = useCallback(async () => {
    if (!checkResult || !org?.id) return
    setGenerating(true); setReportErr(null)
    try {
      const { data, error } = await supabase.functions.invoke('dflow-generate-execution-report', {
        body: { orgId: org.id, inputMint: inputTok.mint, outputMint: form.outputMint.trim(), amount: rawAmount, slippageBps: form.slippageBps, title: `Execution — ${form.outputMint.trim().slice(0, 8)}…` },
      })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)
      setReportId(data.reportId)
    } catch (ex) { setReportErr(ex.message) }
    finally { setGenerating(false) }
  }, [form, org?.id, inputTok, rawAmount, checkResult, supabase])

  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow">{t('brand.name', { defaultValue: 'Investor Intel' })}</div>
        <h1 className="page-title">{t('nav.execution', { defaultValue: 'Execution Intelligence' })}</h1>
        <p className="page-sub">{t('pages.execution_sub', { defaultValue: 'Can this trade clean? Slippage, price impact and route quality — not advice.' })}</p>
      </div>

      {/* Input form */}
      <div className="card p-4 space-y-4">
        <div className="grid sm:grid-cols-[1fr_auto_auto_auto] gap-3 items-end">
          <label className="block">
            <span className="text-[11px] text-[var(--fg-4)]">Output token mint (token to buy)</span>
            <input
              className="input w-full font-mono text-[13px]"
              placeholder="Token mint / contract address"
              value={form.outputMint}
              onChange={(e) => setForm(f => ({ ...f, outputMint: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') runCheck() }}
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-[var(--fg-4)]">Pay with</span>
            <select className="select" value={form.inputToken} onChange={(e) => setForm(f => ({ ...f, inputToken: e.target.value }))}>
              {INPUT_TOKENS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] text-[var(--fg-4)]">Amount ({inputTok.label})</span>
            <input
              className="input w-[90px]"
              type="number"
              min="0"
              step="any"
              placeholder="1000"
              value={form.amount}
              onChange={(e) => setForm(f => ({ ...f, amount: e.target.value }))}
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-[var(--fg-4)]">Slippage</span>
            <select className="select" value={form.slippageBps} onChange={(e) => setForm(f => ({ ...f, slippageBps: Number(e.target.value) }))}>
              {SLIPPAGE_OPTIONS.map(o => <option key={o.bps} value={o.bps}>{o.label}</option>)}
            </select>
          </label>
        </div>
        <div className="flex justify-end">
          <button onClick={runCheck} disabled={checking || !canRun} className="btn btn--primary disabled:opacity-50">
            {checking
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Checking…</>
              : <><Zap className="h-4 w-4" /> Check Execution</>}
          </button>
        </div>
      </div>

      {checkErr && <div className="card--flat p-3 text-[13px] text-red-400">{checkErr}</div>}

      {/* Quick metrics */}
      {checkResult && (
        <div className="space-y-4">
          <div className="card p-4 space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="eyebrow">Execution quality</div>
              <QualityChip quality={checkResult.quality} />
              {checkResult.symbol && <span className="chip">{checkResult.symbol}</span>}
              {!checkResult.success && <span className="chip chip--err text-[11px]">Quote unavailable</span>}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Metric label="Price impact" value={checkResult.price_impact_pct != null ? `${checkResult.price_impact_pct.toFixed(2)}%` : '—'} valueClass={impactClass(checkResult.price_impact_pct)} />
              <Metric label="Liquidity"    value={fmtVol(checkResult.liquidity_usd)} />
              <Metric label="Token price"  value={fmtPrice(checkResult.price_usd)} />
              <Metric label="Slippage tol." value={`${(form.slippageBps / 100).toFixed(1)}%`} />
            </div>

            {checkResult.route_venues?.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-[var(--fg-4)] mb-1.5">Route</div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {checkResult.route_venues.map((v, i) => (
                    <React.Fragment key={i}>
                      {i > 0 && <ArrowRight className="h-3 w-3 text-[var(--fg-4)]" />}
                      <span className="chip">{v}</span>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            )}

            {checkResult.notes?.length > 0 && (
              <div className="space-y-1">
                {checkResult.notes.map((n, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-[12px] text-[var(--fg-3)]">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-400 flex-shrink-0 mt-0.5" />{n}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Generate full AI content report */}
          {!reportId && !generating && (
            <div className="flex justify-end">
              <button onClick={runReport} disabled={generating} className="btn btn--quiet disabled:opacity-50">
                <FileText className="h-4 w-4" /> Generate content report
              </button>
            </div>
          )}
          {generating && (
            <div className="card p-4 flex items-center gap-2 text-[13px] text-[var(--fg-3)]">
              <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" /> Generating AI execution report…
            </div>
          )}
          {reportErr && <div className="card--flat p-3 text-[13px] text-red-400">{reportErr}</div>}
          {reportId && <ExecutionReportView reportId={reportId} orgId={org?.id} supabase={supabase} />}
        </div>
      )}

      {!checkResult && !checkErr && !checking && (
        <div className="card p-8 text-center text-[var(--fg-3)] text-sm">
          Enter a Solana token mint address above and hit Check Execution to see live slippage, price impact, and route quality via DFlow.
        </div>
      )}

      <IntelDisclaimer variant="block" />
    </div>
  )
}

function Metric({ label, value, valueClass = 'text-[var(--fg-1)]' }) {
  return (
    <div className="card--flat p-3 text-center">
      <div className="text-[10px] uppercase tracking-wide text-[var(--fg-4)] mb-1">{label}</div>
      <div className={`text-[18px] font-semibold ${valueClass}`}>{value ?? '—'}</div>
    </div>
  )
}
