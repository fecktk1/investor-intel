import React, { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquare, Copy, Check } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import IntelDisclaimer from '../components/IntelDisclaimer'

const TYPES = ['smart', 'skeptical', 'bullish', 'question', 'contrarian', 'degen', 'quote_tweet', 'reaction']

// P14 — Comment King (copy-only). No posting; drafts informed by context.
export default function CommentKingPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [context, setContext] = useState('')
  const [busy, setBusy] = useState(null)
  const [results, setResults] = useState([])
  const [err, setErr] = useState(null)
  const [copied, setCopied] = useState(null)

  const gen = useCallback(async (replyType) => {
    if (!context.trim() || !org?.id) return
    setBusy(replyType); setErr(null)
    try {
      const { data, error } = await supabase.functions.invoke('intel-comment', { body: { orgId: org.id, context: context.trim(), replyType } })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)
      if (data?.blocked) { setResults((r) => [{ type: replyType, reply: t('comment.blocked', { defaultValue: 'That draft did not pass the safety check.' }), blocked: true }, ...r]) }
      else setResults((r) => [{ type: replyType, reply: data.reply }, ...r])
    } catch (e) { setErr(e.message) } finally { setBusy(null) }
  }, [context, org?.id, supabase, t])

  const copy = useCallback(async (text, i) => {
    try { await navigator.clipboard.writeText(text); setCopied(i); setTimeout(() => setCopied(null), 1500) } catch { /* ignore */ }
  }, [])

  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow flex items-center gap-1.5"><MessageSquare className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
        <h1 className="page-title">{t('nav.comment_king', { defaultValue: 'Comment King' })}</h1>
        <p className="page-sub">{t('pages.comment_king_sub', { defaultValue: 'Draft replies and reactions — copy to clipboard.' })}</p>
      </div>

      <div className="card p-4 space-y-3">
        <textarea className="textarea w-full" rows={4} placeholder={t('comment.placeholder', { defaultValue: 'Paste an X post or token context…' })} value={context} onChange={(e) => setContext(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          {TYPES.map((ty) => (
            <button key={ty} type="button" onClick={() => gen(ty)} disabled={!context.trim() || busy === ty} className="chip disabled:opacity-50">
              {busy === ty ? '…' : t(`comment.types.${ty}`, { defaultValue: ty.replace(/_/g, ' ') })}
            </button>
          ))}
        </div>
      </div>

      {err && <div className="card--flat p-3 text-[13px] text-red-400">{err}</div>}

      <div className="space-y-2">
        {results.map((r, i) => (
          <div key={i} className={`card p-3 ${r.blocked ? 'opacity-70' : ''}`}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="chip chip--accent text-[10px] uppercase">{t(`comment.types.${r.type}`, { defaultValue: r.type })}</span>
              {!r.blocked && (
                <button onClick={() => copy(r.reply, i)} className="p-1.5 rounded-lg text-[var(--fg-4)] hover:text-[var(--fg-1)] hover:bg-[var(--bg-2)]">
                  {copied === i ? <Check className="h-4 w-4 text-[var(--ok)]" /> : <Copy className="h-4 w-4" />}
                </button>
              )}
            </div>
            <p className="text-[13px] text-[var(--fg-2)] whitespace-pre-wrap">{r.reply}</p>
          </div>
        ))}
      </div>

      <IntelDisclaimer variant="block" />
    </div>
  )
}
