// Investor Intel — Comment King (copy-only social drafts).
// Generates short replies/reactions informed by token/narrative context. Still
// passes the non-financial-advice guardrails. No posting — copy to clipboard.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { validateSafeLanguage, SAFE_LANGUAGE_RULES } from '../_shared/intel-guardrails.ts'
import { recordIntelEvent } from '../_shared/intel-events.ts'
import { recordAIUsage } from '../_shared/usage.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

async function callText(model: string, system: string, user: string, apiKey: string) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], reasoning_effort: 'low' }),
  })
  if (!res.ok) throw new Error(`openai_${res.status}: ${(await res.text()).slice(0, 200)}`)
  const d = await res.json()
  return { text: d.choices?.[0]?.message?.content || '', usage: d.usage }
}

const STYLES: Record<string, string> = {
  smart: 'insightful and measured', skeptical: 'skeptical and probing', bullish: 'optimistic but grounded',
  question: 'a thoughtful question', contrarian: 'a contrarian take', degen: 'playful degen tone (still no advice)',
  founder: 'a founder-style builder reply', quote_tweet: 'a quote-tweet idea', reaction: 'a short reaction post',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'No authorization header' }, 401)
    const { orgId, context = '', replyType = 'smart' } = await req.json() || {}
    if (!orgId || !context.trim()) return json({ error: 'orgId and context required' }, 400)

    const apiKey = Deno.env.get('OPENAI_API_KEY')
    if (!apiKey) return json({ error: 'OPENAI_API_KEY not configured' }, 500)
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
    const { data: auth } = await supabase.auth.getUser()

    const { data: gate } = await supabase.rpc('intel_generation_allowed')
    if (gate && gate.allowed === false) return json({ error: 'generation_not_allowed', reason: gate.reason }, 402)
    const { data: rate } = await supabase.rpc('intel_rate_check', { p_limit_key: 'comment_king_per_day' })
    if (rate && rate.allowed === false) return json({ error: 'rate_limited', reason: 'comment_king_per_day', used: rate.used, limit: rate.limit }, 429)

    const style = STYLES[replyType] || STYLES.smart
    const system = `You draft a short crypto social reply for an investor — ${style}. Keep it under 280 characters, natural, no hashtags spam. ${SAFE_LANGUAGE_RULES} Output ONLY the reply text.`
    let { text, usage } = await callText('gpt-5.6-luna', system, `Context (an X post or token note):\n${context.slice(0, 2000)}\n\nWrite the reply.`, apiKey)

    let v = validateSafeLanguage(text)
    let outcome: 'pass' | 'rewrite' | 'block' = 'pass'
    if (!v.ok) {
      const retry = await callText('gpt-5.6-luna', `${system}\nYour previous draft used advice language. Rewrite as research/opinion only.`, `${context.slice(0, 2000)}\n\nPrevious: ${text}`, apiKey)
      text = retry.text; usage = retry.usage; v = validateSafeLanguage(text)
      outcome = v.ok ? 'rewrite' : 'block'
    }
    await recordIntelEvent(supabase, { orgId, userId: auth?.user?.id || null, eventType: 'comment_king', subjectKind: 'general', model: 'gpt-5.6-luna', tokensIn: usage?.prompt_tokens, tokensOut: usage?.completion_tokens, validatorOutcome: outcome, metadata: { replyType } })
    void recordAIUsage(supabase, { orgId, userId: auth?.user?.id || null, provider: 'openai', model: 'gpt-5.6-luna', surface: 'investor_intel', subMode: 'comment_king', providerUsage: usage, status: 'success' })

    if (!v.ok) return json({ blocked: true, reason: 'safety_validation_failed' })
    return json({ reply: text })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'comment_failed' }, 400)
  }
})
