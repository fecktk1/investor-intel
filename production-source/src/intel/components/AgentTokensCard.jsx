// Bring your own agent: the surface where a member grants, inspects and revokes
// access, and approves anything an agent wants to write.
//
// Two things on this card are load-bearing and are stated to the member rather
// than assumed. A token is shown exactly once and is not recoverable. And an
// approval is a signature over one exact request: if the agent changes what it
// asked for, the approval stops applying and it has to ask again.

import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Check, Copy, KeyRound, ShieldCheck, Trash2 } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import {
  AGENT_READ_SCOPES, AGENT_WRITE_SCOPES, READ_SCOPE_FOR_WRITE,
  approveAgentPlan, createAgentToken, listAgentPlans, listAgentTokens,
  rejectAgentPlan, revokeAgentToken, tokenState,
} from '../lib/agent-token-api'

const scopeKey = (scope) => scope.replace(':', '_')

export default function AgentTokensCard() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [tokens, setTokens] = useState([])
  const [plans, setPlans] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [created, setCreated] = useState(null)
  const [copied, setCopied] = useState(false)
  const [draft, setDraft] = useState({ name: '', scopes: ['read:portfolio'], days: 90 })

  const context = { supabase, orgId: org?.id }

  const load = useCallback(async () => {
    if (!org?.id) return
    setLoading(true)
    setError(null)
    try {
      const [tokenResult, planResult] = await Promise.all([
        listAgentTokens({ supabase, orgId: org.id }),
        listAgentPlans({ supabase, orgId: org.id }, 'proposed'),
      ])
      setTokens(tokenResult?.tokens || [])
      setPlans(planResult?.plans || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [org?.id, supabase])

  useEffect(() => { load() }, [load])

  // Selecting a write scope selects the read scope it needs, because the server
  // refuses the pair otherwise and a form that lets you build a refused request
  // is a form that wastes your time.
  const toggleScope = (scope) => setDraft((state) => {
    const has = state.scopes.includes(scope)
    let scopes = has ? state.scopes.filter((s) => s !== scope) : [...state.scopes, scope]
    if (!has && READ_SCOPE_FOR_WRITE[scope] && !scopes.includes(READ_SCOPE_FOR_WRITE[scope])) {
      scopes = [...scopes, READ_SCOPE_FOR_WRITE[scope]]
    }
    if (has) {
      const orphaned = Object.entries(READ_SCOPE_FOR_WRITE).filter(([, read]) => read === scope).map(([write]) => write)
      scopes = scopes.filter((s) => !orphaned.includes(s))
    }
    return { ...state, scopes }
  })

  const create = useCallback(async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    setCopied(false)
    try {
      const result = await createAgentToken(context, { name: draft.name.trim(), scopes: draft.scopes, expiresInDays: Number(draft.days) })
      setCreated(result)
      setDraft({ name: '', scopes: ['read:portfolio'], days: 90 })
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [context, draft, load])

  const revoke = useCallback(async (id) => {
    setBusy(true)
    setError(null)
    try {
      await revokeAgentToken(context, id)
      setNotice(t('settings.agent_revoked', { defaultValue: 'Revoked. It stops working on its next request.' }))
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [context, load, t])

  const decide = useCallback(async (planId, approve) => {
    setBusy(true)
    setError(null)
    try {
      if (approve) await approveAgentPlan(context, planId)
      else await rejectAgentPlan(context, planId)
      setNotice(approve
        ? t('settings.agent_approved', { defaultValue: 'Approved. The agent can run exactly this request, and nothing else.' })
        : t('settings.agent_rejected', { defaultValue: 'Rejected. The agent cannot run it.' }))
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [context, load, t])

  const copy = useCallback(async () => {
    if (!created?.token) return
    try {
      await navigator.clipboard.writeText(created.token)
      setCopied(true)
    } catch {
      setError(t('settings.agent_copy_failed', { defaultValue: 'Copy failed. Select the token and copy it manually before leaving this page.' }))
    }
  }, [created, t])

  if (!org?.id) return null

  return (
    <div className="card p-4 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-medium text-[var(--fg-1)] flex items-center gap-2">
            <Bot className="h-4 w-4 text-[var(--accent)]" />
            {t('settings.agent_heading', { defaultValue: 'Your own agent' })}
          </div>
          <p className="text-[13px] text-[var(--fg-3)] max-w-2xl">
            {t('settings.agent_intro', { defaultValue: 'Give software you trust a scoped, revocable key to your Investor Intel data. A token can only do what you tick below, and anything that would change your data has to be approved by you first.' })}
          </p>
        </div>
        <button type="button" onClick={load} disabled={loading || busy} className="btn btn--quiet btn--sm disabled:opacity-50">
          {t('settings.agent_refresh', { defaultValue: 'Refresh' })}
        </button>
      </div>

      {plans.length > 0 && (
        <section className="rounded-md border border-[var(--accent)] p-3 space-y-3">
          <div className="text-[13px] font-medium text-[var(--fg-1)] flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-[var(--accent)]" />
            {t('settings.agent_pending_heading', { count: plans.length, defaultValue: 'Waiting for your approval ({{count}})' })}
          </div>
          <p className="text-[12px] text-[var(--fg-3)]">
            {t('settings.agent_pending_note', { defaultValue: 'Your approval covers this exact request. If the agent changes it, the approval stops applying and it has to ask again.' })}
          </p>
          {plans.map((plan) => (
            <div key={plan.id} className="rounded-md border border-[var(--border)] p-3 space-y-2">
              <div className="text-[13px] text-[var(--fg-1)]">{plan.summary}</div>
              <div className="text-[12px] text-[var(--fg-3)]">
                {t('settings.agent_risk', { level: plan.risk_level, defaultValue: 'Risk level {{level}}' })}
                {' · '}
                {plan.tool_key}
              </div>
              <pre className="text-[11px] text-[var(--fg-4)] overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(plan.payload, null, 1).slice(0, 1200)}</pre>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => decide(plan.id, true)} disabled={busy} className="btn btn--primary btn--sm disabled:opacity-50">
                  {t('settings.agent_approve', { defaultValue: 'Approve this request' })}
                </button>
                <button type="button" onClick={() => decide(plan.id, false)} disabled={busy} className="btn btn--quiet btn--sm disabled:opacity-50">
                  {t('settings.agent_reject', { defaultValue: 'Reject' })}
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {created?.token && (
        <div role="status" className="rounded-md border border-[var(--accent)] bg-[var(--bg-2)] p-3 space-y-2">
          <div className="text-[12px] uppercase tracking-wide text-[var(--fg-3)]">
            {t('settings.agent_shown_once', { defaultValue: 'Copy this now. It is shown once and cannot be shown again.' })}
          </div>
          <div className="flex items-center justify-between gap-2">
            <code className="text-[13px] text-[var(--fg-1)] break-all">{created.token}</code>
            <button type="button" onClick={copy} className="btn btn--quiet btn--sm" aria-label={t('settings.agent_copy', { defaultValue: 'Copy token' })}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
        </div>
      )}

      <section className="rounded-md border border-[var(--border)] p-3 space-y-3">
        <div className="text-[13px] font-medium text-[var(--fg-1)] flex items-center gap-2">
          <KeyRound className="h-4 w-4" />
          {t('settings.agent_create', { defaultValue: 'Create a token' })}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-2">
          <label className="text-[12px] text-[var(--fg-3)]">
            {t('settings.agent_name_label', { defaultValue: 'What is it for' })}
            <input
              className="input mt-1 text-[13px]"
              value={draft.name}
              maxLength={80}
              placeholder={t('settings.agent_name_placeholder', { defaultValue: 'Laptop agent' })}
              onChange={(e) => setDraft((s) => ({ ...s, name: e.target.value }))}
            />
          </label>
          <label className="text-[12px] text-[var(--fg-3)]">
            {t('settings.agent_days_label', { defaultValue: 'Expires after (days)' })}
            <input
              className="input mt-1 text-[13px]"
              type="number"
              min={1}
              max={365}
              value={draft.days}
              onChange={(e) => setDraft((s) => ({ ...s, days: e.target.value }))}
            />
          </label>
        </div>

        <div className="space-y-2">
          <div className="text-[12px] text-[var(--fg-3)]">{t('settings.agent_scopes_read', { defaultValue: 'What it may read' })}</div>
          <div className="flex flex-wrap gap-2">
            {AGENT_READ_SCOPES.map((scope) => (
              <button key={scope} type="button" onClick={() => toggleScope(scope)} className={draft.scopes.includes(scope) ? 'chip chip--accent' : 'chip'}>
                {t(`settings.agent_scope.${scopeKey(scope)}`, { defaultValue: scope })}
              </button>
            ))}
          </div>
          <div className="text-[12px] text-[var(--fg-3)]">{t('settings.agent_scopes_write', { defaultValue: 'What it may ask to change, with your approval each time' })}</div>
          <div className="flex flex-wrap gap-2">
            {AGENT_WRITE_SCOPES.map((scope) => (
              <button key={scope} type="button" onClick={() => toggleScope(scope)} className={draft.scopes.includes(scope) ? 'chip chip--accent' : 'chip'}>
                {t(`settings.agent_scope.${scopeKey(scope)}`, { defaultValue: scope })}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={create}
          disabled={busy || !draft.name.trim() || !draft.scopes.length}
          className="btn btn--primary btn--sm disabled:opacity-50"
        >
          {busy ? t('settings.agent_creating', { defaultValue: 'Creating...' }) : t('settings.agent_create_button', { defaultValue: 'Create token' })}
        </button>
      </section>

      <section className="space-y-2">
        {loading ? (
          <div className="text-[13px] text-[var(--fg-3)]">{t('settings.agent_loading', { defaultValue: 'Loading agent access...' })}</div>
        ) : tokens.length ? tokens.map((token) => {
          const state = tokenState(token)
          return (
            <div key={token.id} className="rounded-md border border-[var(--border)] p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[13px] font-medium text-[var(--fg-1)]">
                    {token.name} <span className="text-[var(--fg-4)]">...{token.token_hint}</span>
                  </div>
                  <div className="text-[12px] text-[var(--fg-3)]">
                    {t(`settings.agent_state_${state}`, { defaultValue: state })}
                    {' · '}
                    {t('settings.agent_expires', { date: new Date(token.expires_at).toLocaleDateString(), defaultValue: 'expires {{date}}' })}
                    {' · '}
                    {token.last_used_at
                      ? t('settings.agent_last_used', { date: new Date(token.last_used_at).toLocaleString(), defaultValue: 'last used {{date}}' })
                      : t('settings.agent_never_used', { defaultValue: 'never used' })}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(token.scopes || []).map((scope) => (
                      <span key={scope} className="text-[11px] text-[var(--fg-3)] border border-[var(--border)] rounded px-1.5 py-0.5">
                        {t(`settings.agent_scope.${scopeKey(scope)}`, { defaultValue: scope })}
                      </span>
                    ))}
                  </div>
                </div>
                {state === 'live' && (
                  <button type="button" onClick={() => revoke(token.id)} disabled={busy} className="btn btn--quiet btn--sm disabled:opacity-50" aria-label={t('settings.agent_revoke', { defaultValue: 'Revoke token' })}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          )
        }) : (
          <div className="rounded-md border border-dashed border-[var(--border)] p-3 text-[13px] text-[var(--fg-3)]">
            {t('settings.agent_none', { defaultValue: 'No agent has access yet.' })}
          </div>
        )}
      </section>

      {notice && <div role="status" className="text-[12px] text-[var(--fg-2)]">{notice}</div>}
      {error && <div role="alert" className="text-[12px] text-red-400">{error}</div>}
    </div>
  )
}
