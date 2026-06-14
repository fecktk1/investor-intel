// Investor Intel Telegram Bot Webhook
//
// Separate from the Content Forge bot. Supports linked private DMs and
// explicitly configured org group chats. Telegram receives an immediate 200 and
// the update is processed in the background to avoid retries/duplicate sends.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { checkAndIncrement, hashedEntityKey } from '../_shared/rate-limit.ts'
import { CHAINS, CHAIN_COINGECKO, getChain } from '../_shared/chains.ts'
import { searchTokens } from '../_shared/memecoin/dexscreener.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const TELEGRAM_API = 'https://api.telegram.org/bot'
const TIMEFRAMES = ['1H', '4H', '1D', '1W'] as const
const DEFAULT_PERMISSIONS = {
  briefs: true,
  alerts: true,
  token_lookup: true,
  charts: true,
  ask: true,
  portfolio: false,
}

type Timeframe = typeof TIMEFRAMES[number]
type ChartCandle = { t: number; o: number; h: number; l: number; c: number; v: number | null }

interface Env {
  TELEGRAM_BOT_TOKEN: string
  SUPABASE_URL: string
  SERVICE_ROLE_KEY: string
  PUBLIC_SITE_URL: string | null
}

interface BotContext {
  supabase: any
  env: Env
  chatId: string
  chatType: string
  chatTitle: string | null
  telegramUserId: string | null
  username: string | null
  firstName: string | null
  lastName: string | null
  orgId: string | null
  userId: string | null
  isPrivate: boolean
  permissions: Record<string, boolean>
  defaultTimeframe: Timeframe
  messageId?: number
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const TELEGRAM_BOT_TOKEN = Deno.env.get('INVESTOR_TELEGRAM_BOT_TOKEN') || Deno.env.get('TELEGRAM_INVESTOR_BOT_TOKEN') || ''
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
  const SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  const PUBLIC_SITE_URL = Deno.env.get('PUBLIC_SITE_URL') || Deno.env.get('SITE_URL') || Deno.env.get('APP_ORIGIN') || null

  if (!TELEGRAM_BOT_TOKEN || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: 'investor_telegram_env_missing' }, 500)
  }

  let update: any
  try {
    update = await req.json()
  } catch {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const chatId =
      update?.message?.chat?.id ??
      update?.callback_query?.message?.chat?.id ??
      update?.edited_message?.chat?.id
    if (chatId !== undefined && chatId !== null) {
      const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
      const key = await hashedEntityKey('intel-tg', String(chatId), 'intel-telegram-webhook')
      const rl = await checkAndIncrement(supabase, key, 140, 60)
      if (!rl.ok) return new Response('ok', { headers: corsHeaders })
    }
  } catch (e) {
    console.warn('[intel-telegram] rate limit unavailable:', (e as Error)?.message ?? e)
  }

  const env = { TELEGRAM_BOT_TOKEN, SUPABASE_URL, SERVICE_ROLE_KEY, PUBLIC_SITE_URL }
  const bg = processUpdate(update, env).catch((err) => console.error('[intel-telegram] bg error:', err))
  try {
    // @ts-ignore Supabase Edge Runtime global
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(bg)
    }
  } catch {
    // ignore
  }

  return new Response('ok', { headers: corsHeaders })
})

async function processUpdate(update: any, env: Env) {
  const supabase = createClient(env.SUPABASE_URL, env.SERVICE_ROLE_KEY)
  if (update?.callback_query) return handleCallback(update.callback_query, supabase, env)
  const message = update?.message || update?.edited_message
  if (!message?.chat) return
  const ctx = await resolveContext(message, supabase, env)
  const text = String(message.text || message.caption || '').trim()

  await logEvent(ctx, 'message_received', {
    update_id: update?.update_id ?? null,
    text: text.slice(0, 300),
  })

  if (!text) {
    if (!ctx.orgId) await sendMenu(ctx, 'Open the Investor Intel bot menu, then link your account or choose a command.')
    return
  }

  const parsed = parseCommand(text)
  if (!ctx.orgId && parsed?.name !== 'start' && parsed?.name !== 'link' && parsed?.name !== 'help') {
    if (ctx.isPrivate) {
      await sendMessage(ctx, [
        'This Telegram account is not linked yet.',
        'Open Investor Intel settings, generate a code, then send `/link CODE` here.',
      ].join('\n'), mainKeyboard(ctx))
    } else if (parsed || looksLikeTokenQuery(text)) {
      await sendMessage(ctx, 'This group is not connected to an Investor Intel workspace. Add the chat ID in Investor Intel settings before using commands.')
    }
    return
  }

  if (parsed) return handleCommand(ctx, parsed.name, parsed.args)

  if (ctx.orgId && looksLikeTokenQuery(text) && can(ctx, 'charts')) {
    return sendTokenChart(ctx, cleanTokenQuery(text), ctx.defaultTimeframe)
  }

  if (ctx.orgId && ctx.isPrivate && text.length > 8) {
    return handleAsk(ctx, text)
  }
}

async function resolveContext(message: any, supabase: any, env: Env): Promise<BotContext> {
  const chatId = String(message.chat.id)
  const chatType = String(message.chat.type || 'private')
  const isPrivate = chatType === 'private'
  const from = message.from || {}
  const telegramUserId = from?.id != null ? String(from.id) : null
  const base: BotContext = {
    supabase,
    env,
    chatId,
    chatType,
    chatTitle: message.chat.title || message.chat.username || null,
    telegramUserId,
    username: from.username || null,
    firstName: from.first_name || null,
    lastName: from.last_name || null,
    orgId: null,
    userId: null,
    isPrivate,
    permissions: { ...DEFAULT_PERMISSIONS },
    defaultTimeframe: '1D',
    messageId: message.message_id,
  }

  if (isPrivate && telegramUserId) {
    const { data: link } = await supabase
      .from('intel_telegram_links')
      .select('org_id, user_id, status, allows_private_alerts')
      .eq('telegram_user_id', telegramUserId)
      .eq('status', 'active')
      .maybeSingle()
    if (link?.org_id && link?.user_id) {
      base.orgId = link.org_id
      base.userId = link.user_id
      base.permissions = { ...DEFAULT_PERMISSIONS, portfolio: true, alerts: !!link.allows_private_alerts }
    }
    return base
  }

  const { data: chat } = await supabase
    .from('intel_telegram_chats')
    .select('org_id, enabled, permissions, default_timeframe, chat_title, chat_type')
    .eq('chat_id', chatId)
    .maybeSingle()
  if (chat?.enabled && chat?.org_id) {
    base.orgId = chat.org_id
    base.chatTitle = chat.chat_title || base.chatTitle
    base.permissions = { ...DEFAULT_PERMISSIONS, ...(chat.permissions || {}), portfolio: false }
    base.defaultTimeframe = normalizeTimeframe(chat.default_timeframe)
  }
  return base
}

function parseCommand(text: string): { name: string; args: string } | null {
  const match = text.match(/^\/([a-zA-Z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/)
  if (!match) return null
  return { name: match[1].toLowerCase(), args: (match[2] || '').trim() }
}

async function handleCommand(ctx: BotContext, name: string, args: string) {
  switch (name) {
    case 'start':
    case 'menu':
      return sendMenu(ctx)
    case 'help':
      return sendHelp(ctx)
    case 'link':
      return linkAccount(ctx, args)
    case 'unlink':
      return unlinkAccount(ctx)
    case 'brief':
    case 'briefs':
      return requireOrg(ctx, () => handleBrief(ctx), 'briefs')
    case 'alerts':
      return requireOrg(ctx, () => handleAlerts(ctx), 'alerts')
    case 'portfolio':
      return requireOrg(ctx, () => handlePortfolio(ctx), 'portfolio')
    case 'token':
    case 'chart':
    case 'price':
      return requireOrg(ctx, () => sendTokenChart(ctx, args, ctx.defaultTimeframe), 'charts')
    case 'overview':
      return requireOrg(ctx, () => sendTokenChart(ctx, args, ctx.defaultTimeframe, { overviewOnly: true }), 'token_lookup')
    case 'ask':
      return requireOrg(ctx, () => handleAsk(ctx, args), 'ask')
    case 'id':
      return sendMessage(ctx, `Chat ID: \`${escapeMd(ctx.chatId)}\``)
    default:
      return sendMessage(ctx, `Unknown command: /${escapeMd(name)}\nUse /help or the menu buttons.`, mainKeyboard(ctx))
  }
}

async function requireOrg(ctx: BotContext, run: () => Promise<void>, permission: string) {
  if (!ctx.orgId) {
    await sendMessage(ctx, ctx.isPrivate
      ? 'Link this Telegram account first with `/link CODE` from Investor Intel settings.'
      : 'This group is not connected. Add this chat ID in Investor Intel settings before using Investor Intel commands.')
    return
  }
  if (!can(ctx, permission)) {
    await sendMessage(ctx, 'That command is disabled for this chat in Investor Intel settings.')
    return
  }
  return run()
}

async function linkAccount(ctx: BotContext, code: string) {
  if (!ctx.isPrivate) {
    await sendMessage(ctx, 'For privacy, link your Telegram account in a private DM with the bot.')
    return
  }
  if (!ctx.telegramUserId) return
  const clean = code.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)
  if (!clean) {
    await sendMessage(ctx, 'Send `/link CODE` after generating a Telegram link code in Investor Intel settings.')
    return
  }

  const { data, error } = await ctx.supabase.rpc('consume_intel_telegram_link_code', {
    p_code: clean,
    p_telegram_user_id: ctx.telegramUserId,
    p_username: ctx.username,
    p_first_name: ctx.firstName,
    p_last_name: ctx.lastName,
  })
  const row = Array.isArray(data) ? data[0] : data
  if (error || !row?.ok) {
    await sendMessage(ctx, `Link failed: ${escapeMd(row?.error || error?.message || 'invalid_or_expired_code')}`)
    return
  }

  ctx.orgId = row.org_id
  ctx.userId = row.user_id
  ctx.permissions = { ...DEFAULT_PERMISSIONS, portfolio: true }
  await logEvent(ctx, 'account_linked', {})
  await sendMenu(ctx, 'Linked. You can now chat with Investor Intel here and receive private alerts/briefs.')
}

async function unlinkAccount(ctx: BotContext) {
  if (!ctx.isPrivate || !ctx.telegramUserId) return
  const { error } = await ctx.supabase
    .from('intel_telegram_links')
    .update({ status: 'revoked', revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('telegram_user_id', ctx.telegramUserId)
  if (error) {
    await sendMessage(ctx, `Unlink failed: ${escapeMd(error.message)}`)
    return
  }
  await logEvent(ctx, 'account_unlinked', {})
  ctx.orgId = null
  ctx.userId = null
  await sendMessage(ctx, 'Telegram is unlinked from Investor Intel.')
}

async function sendMenu(ctx: BotContext, intro = 'Investor Intel Telegram is ready.') {
  const privateNote = ctx.isPrivate
    ? 'Private commands can include portfolio-aware summaries after linking.'
    : 'Group commands only use org-shared briefs, alerts, and token data.'
  await sendMessage(ctx, `${intro}\n${privateNote}`, mainKeyboard(ctx))
}

async function sendHelp(ctx: BotContext) {
  await sendMessage(ctx, [
    '*Investor Intel commands*',
    '/menu - open buttons',
    '/brief - latest market brief',
    '/alerts - recent alerts',
    '/chart SOL or /chart ethereum:0x... - live chart',
    '/token BTC - token overview and chart',
    '/ask what changed today? - ask from recent intel',
    '/portfolio - private DM only',
    '/id - show this chat ID for group setup',
  ].join('\n'), mainKeyboard(ctx))
}

async function handleBrief(ctx: BotContext) {
  const { data, error } = await ctx.supabase
    .from('intel_briefs')
    .select('id, brief_type, period_date, assembled, created_at')
    .eq('org_id', ctx.orgId)
    .eq('status', 'ready')
    .order('period_date', { ascending: false })
    .limit(1)
  if (error) throw error
  const brief = data?.[0]
  if (!brief) {
    await sendMessage(ctx, 'No ready brief was found yet.')
    return
  }
  await sendMessage(ctx, formatBrief(brief, ctx.isPrivate), mainKeyboard(ctx))
  await logEvent(ctx, 'brief_sent', { brief_id: brief.id })
}

async function handleAlerts(ctx: BotContext) {
  const { data, error } = await ctx.supabase
    .from('intel_alert_events')
    .select('id, fired_at, payload, quality_score, artifact:research_artifacts(title, body_md)')
    .eq('org_id', ctx.orgId)
    .order('fired_at', { ascending: false })
    .limit(5)
  if (error) throw error
  if (!data?.length) {
    await sendMessage(ctx, 'No recent alerts.')
    return
  }
  await sendMessage(ctx, formatAlerts(data), mainKeyboard(ctx))
  await logEvent(ctx, 'alerts_sent', { count: data.length })
}

async function handlePortfolio(ctx: BotContext) {
  if (!ctx.isPrivate || !ctx.userId) {
    await sendMessage(ctx, 'Portfolio summaries are private. Open a DM with the bot and link your account.')
    return
  }
  const { data: portfolios, error: pErr } = await ctx.supabase
    .from('investor_portfolios')
    .select('id, name, total_value_usd, day_pnl_usd, day_pnl_pct, unrealized_pnl_usd, risk_score, last_snapshot_at')
    .eq('org_id', ctx.orgId)
    .eq('user_id', ctx.userId)
    .order('is_default', { ascending: false })
    .limit(1)
  if (pErr) throw pErr
  const portfolio = portfolios?.[0]
  if (!portfolio) {
    await sendMessage(ctx, 'No portfolio is connected yet.')
    return
  }
  const { data: holdings } = await ctx.supabase
    .from('investor_portfolio_holdings')
    .select('asset_symbol, normalized_symbol, current_value, day_pnl_pct, allocation_pct, price_status')
    .eq('org_id', ctx.orgId)
    .eq('user_id', ctx.userId)
    .eq('portfolio_id', portfolio.id)
    .order('current_value', { ascending: false, nullsFirst: false })
    .limit(6)

  await sendMessage(ctx, formatPortfolio(portfolio, holdings || []), mainKeyboard(ctx))
  await logEvent(ctx, 'portfolio_sent', { portfolio_id: portfolio.id })
}

async function handleAsk(ctx: BotContext, question: string) {
  if (!question?.trim()) {
    await sendMessage(ctx, 'Ask a question after /ask, for example `/ask what changed for SOL today?`')
    return
  }
  const terms = question.toLowerCase().split(/[^a-z0-9$]+/).filter((x) => x.length > 2).slice(0, 6)
  const [briefs, alerts, signals] = await Promise.all([
    ctx.supabase.from('intel_briefs').select('period_date, assembled').eq('org_id', ctx.orgId).eq('status', 'ready').order('period_date', { ascending: false }).limit(1),
    ctx.supabase.from('intel_alert_events').select('fired_at, payload').eq('org_id', ctx.orgId).order('fired_at', { ascending: false }).limit(5),
    ctx.supabase.from('intel_signal_state').select('signal_key, title, summary, score, observed_at').eq('org_id', ctx.orgId).order('observed_at', { ascending: false }).limit(10),
  ])
  const answer = buildAskAnswer(question, terms, briefs.data?.[0], alerts.data || [], signals.data || [])
  await sendMessage(ctx, answer, mainKeyboard(ctx))
  await logEvent(ctx, 'ask_answered', { question: question.slice(0, 200) })
}

async function sendTokenChart(ctx: BotContext, rawQuery: string, timeframe: Timeframe, opts: { overviewOnly?: boolean } = {}) {
  const query = cleanTokenQuery(rawQuery)
  if (!query) {
    await sendMessage(ctx, 'Send a ticker, contract address, or chain:address. Example: `/chart SOL` or `/chart base:0x...`')
    return
  }

  const resolved = await resolveTokenQuery(ctx, query)
  if (!resolved) {
    await sendMessage(ctx, `I could not resolve \`${escapeMd(query)}\` to a supported token.`)
    return
  }

  const chart = await fetchChartData(ctx, resolved.ref, timeframe)
  if (chart?.error) {
    await sendMessage(ctx, `Chart lookup failed: ${escapeMd(String(chart.error))}`)
    return
  }

  const caption = formatChartCaption(chart, query, timeframe)
  if (opts.overviewOnly) {
    await sendMessage(ctx, caption, chartKeyboard(null, query, timeframe, ctx.env.PUBLIC_SITE_URL))
    return
  }

  const svg = await renderChartSvg(chart, query, timeframe, ctx)
  const artifact = await uploadChart(ctx, svg, query, resolved.ref, timeframe, chart?.source || null)
  if (!artifact?.signedUrl) {
    await sendMessage(ctx, `${caption}\n\nChart render succeeded, but upload failed.`, mainKeyboard(ctx))
    return
  }

  await sendDocument(ctx, artifact.signedUrl, caption, chartKeyboard(artifact.id, query, timeframe, ctx.env.PUBLIC_SITE_URL))
  await logEvent(ctx, 'chart_sent', { query, ref: resolved.ref, timeframe, artifact_id: artifact.id })
}

async function resolveTokenQuery(ctx: BotContext, query: string): Promise<{ ref: string; label: string } | null> {
  const q = query.trim()
  const lower = q.toLowerCase()
  if (/^[a-z0-9_-]+:[^\s:]+$/i.test(q)) {
    const [chain, address] = q.split(':')
    if (chain === 'native' || getChain(chain)) return { ref: `${chain}:${address}`, label: q }
  }

  const native = nativeRef(lower.replace(/^\$/, ''))
  if (native) return { ref: native, label: q }

  const entityMatch = await lookupEntity(ctx, q)
  if (entityMatch?.canonical_ref_key) return { ref: entityMatch.canonical_ref_key, label: entityMatch.display_symbol || q }

  const chainAddress = detectChainAddress(q)
  if (chainAddress) return { ref: `${chainAddress.chain}:${chainAddress.address}`, label: q }

  const token = await searchBestToken(q, ctx)
  if (token) return { ref: `${token.chain}:${token.tokenAddress}`, label: token.symbol || q }
  return null
}

async function lookupEntity(ctx: BotContext, query: string) {
  const symbol = query.replace(/^\$/, '').trim()
  const like = `%${symbol}%`
  const { data: exact } = await ctx.supabase
    .from('entities')
    .select('id, display_symbol, canonical_ref_key, contract_address, chain_namespace, chain_id')
    .eq('org_id', ctx.orgId)
    .ilike('display_symbol', symbol)
    .limit(1)
  if (exact?.[0]) return exact[0]
  const { data: fuzzy } = await ctx.supabase
    .from('entities')
    .select('id, display_symbol, canonical_ref_key, contract_address, chain_namespace, chain_id')
    .eq('org_id', ctx.orgId)
    .or(`display_symbol.ilike.${like},canonical_ref_key.ilike.${like}`)
    .limit(1)
  return fuzzy?.[0] || null
}

async function searchBestToken(query: string, ctx: BotContext) {
  const degenCtx = {
    supabase: ctx.supabase,
    jobName: 'intel-telegram-webhook',
    kind: 'request' as const,
    orgId: ctx.orgId || undefined,
  }
  const rows = await searchTokens(query.replace(/^\$/, ''), degenCtx).catch(() => [])
  if (!rows.length) return null
  return rows.sort((a, b) => Number(b.liquidityUsd || 0) - Number(a.liquidityUsd || 0))[0]
}

async function fetchChartData(ctx: BotContext, ref: string, timeframe: Timeframe) {
  const res = await fetch(`${ctx.env.SUPABASE_URL}/functions/v1/intel-token-chart`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ctx.env.SERVICE_ROLE_KEY}`,
      apikey: ctx.env.SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({ orgId: ctx.orgId, ref, timeframe }),
    signal: AbortSignal.timeout(22000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return { error: body?.error || `http_${res.status}` }
  return body
}

async function uploadChart(ctx: BotContext, svg: string, query: string, ref: string, timeframe: Timeframe, source: string | null) {
  const path = `${ctx.orgId}/intel-telegram/charts/${crypto.randomUUID()}.svg`
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const { error: upErr } = await ctx.supabase.storage.from('assets').upload(path, blob, {
    contentType: 'image/svg+xml;charset=utf-8',
    upsert: false,
  })
  if (upErr) {
    console.warn('[intel-telegram] chart upload failed:', upErr.message)
    return null
  }
  const { data: artifact, error: insErr } = await ctx.supabase
    .from('intel_telegram_chart_artifacts')
    .insert({
      org_id: ctx.orgId,
      user_id: ctx.isPrivate ? ctx.userId : null,
      chat_id: ctx.chatId,
      query,
      ref,
      timeframe,
      storage_path: path,
      source,
    })
    .select('id, storage_path')
    .single()
  if (insErr) console.warn('[intel-telegram] artifact insert failed:', insErr.message)
  const { data: signed, error: signErr } = await ctx.supabase.storage.from('assets').createSignedUrl(path, 60 * 30)
  if (signErr) {
    console.warn('[intel-telegram] signed url failed:', signErr.message)
    return null
  }
  return { id: artifact?.id || null, storagePath: path, signedUrl: signed?.signedUrl || null }
}

async function handleCallback(callback: any, supabase: any, env: Env) {
  const message = callback.message
  const ctx = await resolveContext({ ...message, from: callback.from }, supabase, env)
  const data = String(callback.data || '')
  await answerCallback(ctx, callback.id)

  if (data === 'm:main') return sendMenu(ctx)
  if (data === 'm:brief') return requireOrg(ctx, () => handleBrief(ctx), 'briefs')
  if (data === 'm:alerts') return requireOrg(ctx, () => handleAlerts(ctx), 'alerts')
  if (data === 'm:portfolio') return requireOrg(ctx, () => handlePortfolio(ctx), 'portfolio')
  if (data === 'm:help') return sendHelp(ctx)
  if (data === 'm:token') return sendMessage(ctx, 'Send `/chart TICKER` or `/chart chain:contract` to get a live chart.')

  const chartMatch = data.match(/^ct:([0-9a-f-]{36}):([A-Z0-9]+)$/)
  if (chartMatch) {
    const artifactId = chartMatch[1]
    const tf = normalizeTimeframe(chartMatch[2])
    const { data: artifact } = await supabase
      .from('intel_telegram_chart_artifacts')
      .select('query, ref, org_id, user_id')
      .eq('id', artifactId)
      .maybeSingle()
    if (!artifact || artifact.org_id !== ctx.orgId) {
      await sendMessage(ctx, 'That chart is no longer available.')
      return
    }
    if (ctx.isPrivate && artifact.user_id && artifact.user_id !== ctx.userId) {
      await sendMessage(ctx, 'That chart belongs to another linked user.')
      return
    }
    return sendTokenChart(ctx, artifact.ref || artifact.query, tf)
  }
}

function mainKeyboard(ctx: BotContext) {
  const rows = [
    [
      { text: 'Brief', callback_data: 'm:brief' },
      { text: 'Alerts', callback_data: 'm:alerts' },
    ],
    [
      { text: 'Token chart', callback_data: 'm:token' },
      { text: 'Help', callback_data: 'm:help' },
    ],
  ]
  if (ctx.isPrivate) rows.splice(1, 0, [{ text: 'Portfolio', callback_data: 'm:portfolio' }])
  return { inline_keyboard: rows }
}

function chartKeyboard(artifactId: string | null, query: string, timeframe: Timeframe, publicSiteUrl: string | null) {
  const rows: any[] = []
  if (artifactId) {
    rows.push(TIMEFRAMES.map((tf) => ({
      text: tf === timeframe ? `${tf} *` : tf,
      callback_data: `ct:${artifactId}:${tf}`,
    })))
  }
  const second: any[] = [{ text: 'Menu', callback_data: 'm:main' }]
  if (publicSiteUrl) second.unshift({ text: 'Open Intel', url: `${publicSiteUrl.replace(/\/$/, '')}/intel` })
  rows.push(second)
  if (!artifactId) rows.push([{ text: `Chart ${query}`.slice(0, 60), callback_data: 'm:token' }])
  return { inline_keyboard: rows }
}

async function telegramApi(ctx: BotContext, method: string, payload: Record<string, unknown>) {
  const res = await fetch(`${TELEGRAM_API}${ctx.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.warn(`[intel-telegram] ${method} failed:`, res.status, body.slice(0, 400))
  }
  return res
}

async function sendMessage(ctx: BotContext, text: string, replyMarkup?: any) {
  await telegramApi(ctx, 'sendMessage', {
    chat_id: ctx.chatId,
    text: text.slice(0, 3900),
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_to_message_id: ctx.messageId,
    reply_markup: replyMarkup,
  })
}

async function sendDocument(ctx: BotContext, url: string, caption: string, replyMarkup?: any) {
  await telegramApi(ctx, 'sendDocument', {
    chat_id: ctx.chatId,
    document: url,
    caption: caption.slice(0, 950),
    parse_mode: 'Markdown',
    reply_to_message_id: ctx.messageId,
    reply_markup: replyMarkup,
  })
}

async function answerCallback(ctx: BotContext, callbackQueryId: string) {
  await telegramApi(ctx, 'answerCallbackQuery', { callback_query_id: callbackQueryId }).catch(() => {})
}

async function logEvent(ctx: BotContext, eventType: string, payload: Record<string, unknown>) {
  if (!ctx.orgId && eventType !== 'message_received') return
  await ctx.supabase.from('intel_telegram_events').insert({
    org_id: ctx.orgId,
    user_id: ctx.isPrivate ? ctx.userId : null,
    chat_id: ctx.chatId,
    telegram_user_id: ctx.telegramUserId,
    event_type: eventType,
    payload,
  }).then(() => {}, () => {})
}

function formatBrief(brief: any, includePrivate: boolean) {
  const assembled = brief?.assembled || {}
  const lines = [`*Investor Intel Brief*`, `Date: ${escapeMd(String(brief.period_date || 'latest'))}`]
  const summary = pickText(assembled.summary || assembled.market_summary || assembled.overview || assembled.headline)
  if (summary) lines.push('', escapeMd(summary))
  const sections = Array.isArray(assembled.sections) ? assembled.sections : []
  const directSections = sections.length ? sections : Object.entries(assembled)
    .filter(([key]) => includePrivate || !/portfolio|holding|position/i.test(key))
    .slice(0, 5)
    .map(([key, value]) => ({ title: key.replace(/_/g, ' '), body: value }))
  for (const section of directSections.slice(0, 5)) {
    const title = pickText(section.title || section.heading || section.key)
    const body = pickText(section.body || section.summary || section.items || section)
    if (!title && !body) continue
    if (!includePrivate && /portfolio|holding|position/i.test(`${title} ${body}`)) continue
    lines.push('', title ? `*${escapeMd(title)}*` : '*Update*')
    if (body) lines.push(escapeMd(body).slice(0, 650))
  }
  return lines.join('\n').slice(0, 3900)
}

function formatAlerts(rows: any[]) {
  const lines = ['*Recent Investor Intel Alerts*']
  for (const row of rows) {
    const p = row.payload || {}
    const title = p.title || p.headline || p.trigger_type || row.artifact?.title || 'Alert'
    const body = p.summary || p.reason || p.message || p.why || row.artifact?.body_md || ''
    lines.push('', `*${escapeMd(String(title)).slice(0, 140)}*`)
    lines.push(`${escapeMd(shortDate(row.fired_at))}${row.quality_score != null ? ` | Quality ${Number(row.quality_score).toFixed(0)}` : ''}`)
    if (body) lines.push(escapeMd(String(body)).slice(0, 500))
  }
  return lines.join('\n').slice(0, 3900)
}

function formatPortfolio(portfolio: any, holdings: any[]) {
  const lines = [
    `*${escapeMd(portfolio.name || 'Portfolio')}*`,
    `Value: ${money(portfolio.total_value_usd)} | Day: ${signedMoney(portfolio.day_pnl_usd)} (${pct(portfolio.day_pnl_pct)})`,
    `Unrealized P/L: ${signedMoney(portfolio.unrealized_pnl_usd)} | Risk: ${portfolio.risk_score == null ? 'n/a' : Number(portfolio.risk_score).toFixed(0)}/100`,
  ]
  if (holdings.length) {
    lines.push('', '*Top holdings*')
    for (const h of holdings) {
      const sym = h.normalized_symbol || h.asset_symbol || 'Asset'
      lines.push(`${escapeMd(sym)} - ${money(h.current_value)} (${pct(h.allocation_pct)} alloc, ${pct(h.day_pnl_pct)} day)`)
    }
  }
  return lines.join('\n')
}

function buildAskAnswer(question: string, terms: string[], brief: any, alerts: any[], signals: any[]) {
  const haystack = [
    ...signals.map((s) => ({ kind: 'Signal', title: s.title || s.signal_key, body: s.summary, score: s.score, time: s.observed_at })),
    ...alerts.map((a) => ({ kind: 'Alert', title: a.payload?.title || a.payload?.headline || 'Alert', body: a.payload?.summary || a.payload?.reason, time: a.fired_at })),
  ].filter((item) => {
    const text = `${item.title || ''} ${item.body || ''}`.toLowerCase()
    return !terms.length || terms.some((term) => text.includes(term.replace(/^\$/, '')))
  }).slice(0, 5)

  const lines = [`*Investor Intel answer*`, `Q: ${escapeMd(question).slice(0, 220)}`]
  if (haystack.length) {
    lines.push('', 'Based on recent stored intel:')
    for (const item of haystack) {
      lines.push(`- ${escapeMd(item.kind)}: ${escapeMd(String(item.title || 'Update')).slice(0, 140)}`)
      if (item.body) lines.push(`  ${escapeMd(String(item.body)).slice(0, 320)}`)
    }
  } else {
    const summary = pickText(brief?.assembled?.summary || brief?.assembled?.overview || brief?.assembled?.headline)
    lines.push('', summary ? escapeMd(summary) : 'No matching stored intel was found. Try asking for a token chart or latest brief.')
  }
  return lines.join('\n').slice(0, 3900)
}

function formatChartCaption(chart: any, query: string, timeframe: Timeframe) {
  const ent = chart?.entity || {}
  const ov = chart?.overview || {}
  const symbol = ent.symbol || query
  const name = ent.name && ent.name !== symbol ? ` (${ent.name})` : ''
  const lines = [
    `*${escapeMd(String(symbol))}${escapeMd(String(name))}* ${timeframe}`,
    `Price: ${price(ov.price)} | 24h: ${pct(ov.price_change_24h_pct)}`,
    `Volume: ${money(ov.volume_24h_usd)} | Liquidity: ${money(ov.liquidity)} | MCap: ${money(ov.market_cap)}`,
    `Source: ${escapeMd(chart?.source_label || chart?.source || 'market data')} | Candles: ${Array.isArray(chart?.candles) ? chart.candles.length : 0}`,
  ]
  if (chart?.unsupported) lines.push('Chart support is limited for this token; showing available market data.')
  return lines.join('\n')
}

async function renderChartSvg(chart: any, query: string, timeframe: Timeframe, ctx: BotContext) {
  const width = 1200
  const height = 675
  const pad = { l: 76, r: 42, t: 112, b: 78 }
  const plotW = width - pad.l - pad.r
  const plotH = height - pad.t - pad.b
  const candles: ChartCandle[] = Array.isArray(chart?.candles)
    ? chart.candles.slice(-90).map(normalizeCandle).filter((c: ChartCandle | null): c is ChartCandle => c !== null)
    : []
  const ov = chart?.overview || {}
  const ent = chart?.entity || {}
  const symbol = String(ent.symbol || query || 'Token').slice(0, 24)
  const subtitle = `${timeframe} chart | ${chart?.source_label || chart?.source || 'market data'} | ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`
  const logo = await logoDataUrl(ctx.env.PUBLIC_SITE_URL)

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const c of candles) {
    min = Math.min(min, c.l)
    max = Math.max(max, c.h)
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    min = Number(ov.price || 0) * 0.95
    max = Number(ov.price || 1) * 1.05
  }
  const range = max - min || 1
  const y = (v: number) => pad.t + (max - v) / range * plotH
  const xStep = candles.length > 1 ? plotW / candles.length : plotW
  const bodyW = Math.max(4, Math.min(11, xStep * 0.62))
  const grid = Array.from({ length: 5 }, (_, i) => {
    const gy = pad.t + (plotH / 4) * i
    const val = max - (range / 4) * i
    return `<line x1="${pad.l}" y1="${gy}" x2="${width - pad.r}" y2="${gy}" stroke="#243144" stroke-width="1"/><text x="${width - pad.r + 10}" y="${gy + 4}" fill="#91a0b7" font-size="16">${escapeXml(shortNumber(val))}</text>`
  }).join('')
  const candleSvg = candles.map((c: ChartCandle, i: number) => {
    const cx = pad.l + i * xStep + xStep / 2
    const up = c.c >= c.o
    const color = up ? '#31d98b' : '#ff5f6d'
    const yO = y(c.o)
    const yC = y(c.c)
    const yH = y(c.h)
    const yL = y(c.l)
    const top = Math.min(yO, yC)
    const h = Math.max(2, Math.abs(yC - yO))
    return `<line x1="${cx}" y1="${yH}" x2="${cx}" y2="${yL}" stroke="${color}" stroke-width="2" stroke-linecap="round"/><rect x="${cx - bodyW / 2}" y="${top}" width="${bodyW}" height="${h}" rx="2" fill="${color}" opacity="0.92"/>`
  }).join('')
  const noData = candles.length ? '' : `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="#e8eef8" font-size="34" font-weight="700">Market overview only</text><text x="${width / 2}" y="${height / 2 + 38}" text-anchor="middle" fill="#91a0b7" font-size="20">No verified OHLCV candles returned for this token.</text>`
  const chip = (label: string, value: string, x: number) =>
    `<g transform="translate(${x},48)"><rect width="176" height="44" rx="10" fill="#111c2e" stroke="#27374f"/><text x="14" y="17" fill="#91a0b7" font-size="13">${escapeXml(label)}</text><text x="14" y="34" fill="#f7fbff" font-size="18" font-weight="700">${escapeXml(value)}</text></g>`
  const watermarkImage = logo
    ? `<image href="${logo}" x="${width - 370}" y="${height - 164}" width="260" height="86" opacity="0.13" preserveAspectRatio="xMidYMid meet"/>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#07111f"/>
      <stop offset="58%" stop-color="#0b1728"/>
      <stop offset="100%" stop-color="#101827"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="675" fill="url(#bg)"/>
  <rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}" fill="#0a1322" stroke="#25344b" rx="12"/>
  ${watermarkImage}
  <text x="${width - 84}" y="${height - 92}" text-anchor="end" fill="#dfe8f5" opacity="0.16" font-size="44" font-weight="800">TheContentForge</text>
  <text x="76" y="54" fill="#f7fbff" font-size="42" font-weight="800">${escapeXml(symbol)}</text>
  <text x="76" y="86" fill="#91a0b7" font-size="19">${escapeXml(subtitle)}</text>
  ${chip('Price', price(ov.price), 520)}
  ${chip('24h', pct(ov.price_change_24h_pct), 708)}
  ${chip('Volume', money(ov.volume_24h_usd), 896)}
  ${grid}
  ${candleSvg}
  ${noData}
  <line x1="${pad.l}" y1="${height - pad.b}" x2="${width - pad.r}" y2="${height - pad.b}" stroke="#33445d" stroke-width="2"/>
  <text x="76" y="624" fill="#91a0b7" font-size="17">Liquidity ${escapeXml(money(ov.liquidity))} | Market cap ${escapeXml(money(ov.market_cap))} | Ref ${escapeXml(String(ent.ref || chart?.entity?.canonical_ref_key || query)).slice(0, 80)}</text>
</svg>`
}

async function logoDataUrl(publicSiteUrl: string | null): Promise<string | null> {
  const explicit = Deno.env.get('THECONTENTFORGE_LOGO_URL')
  const base = explicit || (publicSiteUrl ? `${publicSiteUrl.replace(/\/$/, '')}/logo-light.png` : null)
  if (!base) return null
  try {
    const res = await fetch(base, { signal: AbortSignal.timeout(3500) })
    if (!res.ok) return null
    const mime = res.headers.get('content-type')?.split(';')[0] || 'image/png'
    const bytes = new Uint8Array(await res.arrayBuffer())
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    return `data:${mime};base64,${btoa(binary)}`
  } catch {
    return null
  }
}

function normalizeCandle(c: any): ChartCandle | null {
  const out = { t: Number(c.t || c.time || 0), o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: c.v == null ? null : Number(c.v) }
  return [out.o, out.h, out.l, out.c].every(Number.isFinite) ? out : null
}

function detectChainAddress(query: string): { chain: string; address: string } | null {
  const clean = query.trim()
  if (/^0x[a-fA-F0-9]{40}$/.test(clean)) return { chain: 'ethereum', address: clean.toLowerCase() }
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(clean)) return { chain: 'solana', address: clean }
  return null
}

function nativeRef(symbol: string): string | null {
  const map: Record<string, string> = {
    btc: 'native:bitcoin',
    eth: 'native:ethereum',
    sol: 'native:solana',
    bnb: 'native:bnb',
    avax: 'native:avalanche',
    matic: 'native:polygon',
    pol: 'native:polygon',
    sui: 'native:sui',
    sei: 'native:sei',
    near: 'native:near',
    ton: 'native:ton',
    xrp: 'native:xrpl',
    zec: 'native:zcash',
    trx: 'native:tron',
    hype: 'native:hyperliquid',
  }
  for (const chain of CHAINS) {
    const cg = CHAIN_COINGECKO[chain.id]
    const key = chain.nativeSymbol?.toLowerCase()
    if (cg && key && !map[key]) map[key] = `native:${chain.id}`
  }
  return map[symbol.toLowerCase()] || null
}

function cleanTokenQuery(input: string) {
  return (input || '').replace(/^\/(?:chart|token|price|overview)(?:@[A-Za-z0-9_]+)?/i, '').trim().replace(/^[$#]/, '').trim()
}

function looksLikeTokenQuery(text: string) {
  const clean = cleanTokenQuery(text)
  if (/^\$?[a-zA-Z][a-zA-Z0-9]{1,12}$/.test(clean)) return true
  if (/^[a-z0-9_-]+:[^\s:]+$/i.test(clean)) return true
  if (/^0x[a-fA-F0-9]{40}$/.test(clean)) return true
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(clean)) return true
  return false
}

function normalizeTimeframe(value: unknown): Timeframe {
  const upper = String(value || '1D').toUpperCase()
  return (TIMEFRAMES as readonly string[]).includes(upper) ? upper as Timeframe : '1D'
}

function can(ctx: BotContext, key: string) {
  if (key === 'portfolio') return ctx.isPrivate && !!ctx.userId && !!ctx.permissions.portfolio
  if (key === 'charts') return !!ctx.permissions.charts && !!ctx.permissions.token_lookup
  return ctx.permissions[key] !== false
}

function pickText(value: any): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(pickText).filter(Boolean).slice(0, 4).join('\n')
  if (typeof value === 'object') {
    return pickText(value.summary || value.body || value.text || value.title || Object.values(value).slice(0, 3))
  }
  return String(value)
}

function money(v: unknown) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 'n/a'
  const abs = Math.abs(n)
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(2)}K`
  return `$${n.toFixed(abs >= 10 ? 2 : 4)}`
}

function signedMoney(v: unknown) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 'n/a'
  return `${n >= 0 ? '+' : ''}${money(n)}`
}

function price(v: unknown) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 'n/a'
  if (Math.abs(n) >= 1) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 4 })}`
  return `$${n.toPrecision(4)}`
}

function pct(v: unknown) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 'n/a'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function shortNumber(v: number) {
  if (!Number.isFinite(v)) return 'n/a'
  const abs = Math.abs(v)
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${(v / 1e3).toFixed(2)}K`
  if (abs >= 1) return v.toFixed(2)
  return v.toPrecision(3)
}

function shortDate(v: string) {
  if (!v) return ''
  try { return new Date(v).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' } catch { return v }
}

function escapeMd(s: string) {
  return String(s).replace(/([_*`\[])/g, '\\$1')
}

function escapeXml(s: string) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
