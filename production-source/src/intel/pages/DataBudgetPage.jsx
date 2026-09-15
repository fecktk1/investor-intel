import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Navigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Gauge } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { IntelPageHeader, IntelPageShell } from '../components/IntelPrimitives'
import DataBudgetFigures from '../components/DataBudgetFigures'
import { readDataBudget, applyDataBudget } from '../lib/data-budget-api'

// Route: /intel/admin/data-budget. Super admin only — the page redirects and
// the `intel-data-budget` function answers 403 independently, so neither side
// relies on the other.
//
// The page has exactly one write: "Apply plan cadences". It always runs a dry
// run first and shows the diff that came back; only then does a second,
// separate control offer to apply the same change for real. There is no way to
// reach `dryRun: false` in one click, and a real apply clears the dry run so
// the next real apply needs its own fresh diff.

const planRow = entry => [entry?.feature, entry?.action, entry?.from, entry?.to, entry?.minPlan]
const cronRow = entry => [entry?.feature, entry?.jobname, entry?.action, entry?.from, entry?.schedule, entry?.active]

export default function DataBudgetPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { isSuperAdmin } = useProfile()
  const { supabase } = useSupabase()
  const [budget, setBudget] = useState(null)
  const [failure, setFailure] = useState(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dryRun, setDryRun] = useState(null)
  const [applied, setApplied] = useState(null)
  const [applyFailure, setApplyFailure] = useState(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(async signal => {
    setLoading(true)
    const result = await readDataBudget(supabase, { signal })
    if (!alive.current || signal?.aborted) return
    setLoading(false)
    if (result.state === 'unavailable') { setFailure(result.reason); return }
    setFailure(null)
    setBudget(result)
  }, [supabase])

  useEffect(() => {
    if (!isSuperAdmin) return undefined
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [isSuperAdmin, load])

  const runApply = async real => {
    setBusy(true)
    setApplyFailure(null)
    const result = await applyDataBudget(supabase, { dryRun: !real })
    if (!alive.current) return
    setBusy(false)
    if (result.state === 'unavailable') { setApplyFailure(result.reason); return }
    if (real) { setApplied(result); setDryRun(null); await load() } else { setDryRun(result); setApplied(null) }
  }

  if (!isSuperAdmin) return <Navigate to="/intel" replace />

  const diff = applied || dryRun
  const policyEntries = Array.isArray(diff?.policy?.entries) ? diff.policy.entries : []
  const cronEntries = Array.isArray(diff?.cron?.jobs) ? diff.cron.jobs : []
  const counts = diff?.policy?.counts || {}

  return (
    <IntelPageShell className="intel-data-budget-page">
      <IntelPageHeader
        icon={Gauge}
        eyebrow={t('data_budget.eyebrow', { defaultValue: 'Internal' })}
        title={t('data_budget.title', { defaultValue: 'Data budget' })}
        subtitle={t('data_budget.sub', { defaultValue: 'What the CoinMarketCap plan allows, what the schedule projects against it, and what has actually been captured. Super admin only. Reading this page spends nothing.' })}
        actions={
          <button type="button" className="btn btn--quiet btn--sm" disabled={loading} onClick={() => load()}>
            {loading ? t('data_budget.refreshing', { defaultValue: 'Reading…' }) : t('data_budget.refresh', { defaultValue: 'Refresh read' })}
          </button>
        }
      />

      {failure ? (
        <p role="alert">
          {t('data_budget.read_failed', { defaultValue: 'The data budget could not be read.' })}{' '}
          {failure}
        </p>
      ) : null}

      <DataBudgetFigures budget={budget} />

      <section aria-label={t('data_budget.apply_label', { defaultValue: 'Apply plan cadences' })} className="space-y-2">
        <h2 className="intel-section-title">{t('data_budget.apply_title', { defaultValue: 'Apply plan cadences' })}</h2>
        <p className="intel-analysis-caption">
          {t('data_budget.apply_sub', { defaultValue: 'Writes the effective plan’s target cadences onto the schedule policy and moves the matching cron jobs. Rows a person set by hand are skipped. The first control only ever runs a dry run; nothing changes until the second control is used.' })}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn--sm" disabled={busy} onClick={() => runApply(false)}>
            {busy && !dryRun ? t('data_budget.apply_running', { defaultValue: 'Running…' }) : t('data_budget.apply_dry_run', { defaultValue: 'Preview plan cadences (dry run)' })}
          </button>
          {dryRun ? (
            <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => runApply(true)}>
              {t('data_budget.apply_for_real', { defaultValue: 'Apply for real' })}
            </button>
          ) : null}
        </div>

        {applyFailure ? (
          <p role="alert">
            {t('data_budget.apply_failed', { defaultValue: 'The apply call failed.' })} {applyFailure}
          </p>
        ) : null}

        {diff ? (
          <div className="space-y-2" data-testid="data-budget-diff" data-dry-run={diff.dryRun === true ? 'true' : 'false'}>
            <p role="status">
              {diff.dryRun === true
                ? t('data_budget.diff_dry_run', { plan: String(diff.plan ?? '—'), defaultValue: 'Dry run for plan {{plan}}. Nothing has been written.' })
                : t('data_budget.diff_applied', { plan: String(diff.plan ?? '—'), date: String(diff.appliedAt ?? '—'), defaultValue: 'Applied for plan {{plan}} at {{date}}.' })}
              {' '}
              {t('data_budget.diff_counts', {
                updated: Number(counts.updated ?? 0), unchanged: Number(counts.unchanged ?? 0),
                skipped: Number(counts.skipped_manual ?? 0), missing: Number(counts.missing_row ?? 0),
                defaultValue: '{{updated}} updated · {{unchanged}} unchanged · {{skipped}} skipped as hand-set · {{missing}} with no row',
              })}
            </p>
            {diff.cronError ? (
              <p role="alert">{t('data_budget.cron_failed', { reason: String(diff.cronError), defaultValue: 'The cron half reported: {{reason}}' })}</p>
            ) : null}

            <div className="intel-table-scroll">
              <table data-testid="data-budget-policy-diff">
                <caption className="sr-only">{t('data_budget.policy_diff_title', { defaultValue: 'Schedule policy changes' })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('data_budget.col_feature', { defaultValue: 'Feature' })}</th>
                    <th scope="col">{t('data_budget.col_action', { defaultValue: 'Action' })}</th>
                    <th scope="col" className="intel-number">{t('data_budget.col_from', { defaultValue: 'From' })}</th>
                    <th scope="col" className="intel-number">{t('data_budget.col_to', { defaultValue: 'To' })}</th>
                    <th scope="col">{t('data_budget.col_min_plan', { defaultValue: 'Minimum plan' })}</th>
                  </tr>
                </thead>
                <tbody>
                  {policyEntries.length === 0 ? (
                    <tr><th scope="row">{t('data_budget.diff_no_policy', { defaultValue: 'No schedule policy row would change.' })}</th><td /><td /><td /><td /></tr>
                  ) : policyEntries.map((entry, i) => {
                    const cells = planRow(entry)
                    return (
                      <tr key={`${entry?.feature ?? 'row'}-${i}`}>
                        <th scope="row">{String(cells[0] ?? '—')}</th>
                        {cells.slice(1).map((cell, j) => <td key={j} className={j >= 1 && j <= 2 ? 'intel-number' : undefined}>{cell == null ? '—' : String(cell)}</td>)}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="intel-table-scroll">
              <table data-testid="data-budget-cron-diff">
                <caption className="sr-only">{t('data_budget.cron_diff_title', { defaultValue: 'Cron job changes' })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('data_budget.col_feature', { defaultValue: 'Feature' })}</th>
                    <th scope="col">{t('data_budget.col_job', { defaultValue: 'Job' })}</th>
                    <th scope="col">{t('data_budget.col_action', { defaultValue: 'Action' })}</th>
                    <th scope="col">{t('data_budget.col_from', { defaultValue: 'From' })}</th>
                    <th scope="col">{t('data_budget.col_schedule', { defaultValue: 'Schedule' })}</th>
                    <th scope="col">{t('data_budget.col_active', { defaultValue: 'Active' })}</th>
                  </tr>
                </thead>
                <tbody>
                  {cronEntries.length === 0 ? (
                    <tr><th scope="row">{t('data_budget.diff_no_cron', { defaultValue: 'No cron job would change.' })}</th><td /><td /><td /><td /><td /></tr>
                  ) : cronEntries.map((entry, i) => {
                    const cells = cronRow(entry)
                    return (
                      <tr key={`${entry?.jobname ?? 'job'}-${i}`}>
                        <th scope="row">{String(cells[0] ?? '—')}</th>
                        {cells.slice(1).map((cell, j) => <td key={j}>{cell == null ? '—' : typeof cell === 'boolean' ? (cell ? t('data_budget.job_active', { defaultValue: 'Active' }) : t('data_budget.job_paused', { defaultValue: 'Paused' })) : String(cell)}</td>)}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </section>
    </IntelPageShell>
  )
}
