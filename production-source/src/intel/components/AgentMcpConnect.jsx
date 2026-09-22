// Connect your agent: the one URL, and the line that connects it.
//
// This block sits under the token card because it is the step AFTER minting one.
// A member who has a token and no idea where to put it has agent access in name
// only, so the copy here is the connection itself rather than an explanation of
// it: a URL, three ready-made snippets and a list of what the agent will be able
// to do.
//
// THE TOKEN IS NEVER RENDERED HERE. Every snippet carries the placeholder
// YOUR_TOKEN. The plaintext exists once, in the reveal on the card above, and
// putting it into a copyable command afterwards would mean re-displaying a
// credential we promised to show only once.
//
// No pills and no chips: an eyebrow, a hairline rail and a plain table.

import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Plug } from 'lucide-react'
import { hostedMcpUrl } from '../lib/agent-token-api'

/** The catalogue as a member reads it. `plan` is what the row says in the last
 * column; `scope` is named when a tool needs one, because a member who ticked
 * nothing will otherwise wonder why their agent cannot see their alerts.
 *
 * This list mirrors MCP_TOOLS in supabase/functions/_shared/intel/mcp-tools.ts.
 * The tool NAMES are identifiers the agent uses and are deliberately not
 * translated; only the description and the plan column are. */
export const MCP_TOOL_ROWS = [
  { name: 'whoami', plan: 'free' },
  { name: 'search_assets', plan: 'free' },
  { name: 'get_asset', plan: 'free' },
  { name: 'market_regime', plan: 'free' },
  { name: 'market_structure', plan: 'free' },
  { name: 'new_listings', plan: 'free' },
  { name: 'meme_graduations', plan: 'free' },
  { name: 'rwa_universe', plan: 'free' },
  { name: 'rwa_issuer_legitimacy', plan: 'free' },
  { name: 'rwa_yield_provenance', plan: 'free' },
  { name: 'rwa_issuer_terms', plan: 'starter' },
  { name: 'rwa_wrapper_premiums', plan: 'free' },
  { name: 'rwa_best_wrapper', plan: 'free' },
  { name: 'rwa_liquidity_depth', plan: 'free' },
  { name: 'rwa_underlying_registrant', plan: 'free' },
  { name: 'rwa_coverage', plan: 'free' },
  { name: 'rwa_universe_changes', plan: 'free' },
  { name: 'rwa_issuer_concentration', plan: 'free' },
  { name: 'rwa_premium_history', plan: 'free' },
  { name: 'rwa_exit_capacity', plan: 'free' },
  { name: 'watchlist_read', plan: 'free', scope: 'read:watchlists' },
  { name: 'watchlist_add', plan: 'free', scope: 'write:watchlists' },
  { name: 'alerts_list', plan: 'starter', scope: 'read:alerts' },
  { name: 'alert_create', plan: 'starter', scope: 'write:alerts' },
  { name: 'write_status', plan: 'free' },
  { name: 'write_run', plan: 'free' },
  { name: 'save_research_note', plan: 'free', scope: 'write:research' },
  { name: 'data_budget', plan: 'free' },
]

const PLACEHOLDER = 'YOUR_TOKEN'

/** The snippets, built from the live URL so a member never edits one by hand.
 * Each is exactly what that client wants, with nothing to fill in but the token.
 *
 * WHY CLAUDE DESKTOP HAS ITS OWN ENTRY, AND WHY IT IS NOT THE SAME JSON. Claude
 * Desktop adds a remote server as a Custom Connector, which takes a URL and then
 * runs the SERVER's own authentication: there is no field for a header you supply,
 * and claude_desktop_config.json has no url-plus-headers form for a remote server.
 * This server authenticates with a bearer token a member minted here, not with
 * OAuth, so a Custom Connector cannot reach it. The route that does work is the
 * mcp-remote stdio bridge, which Claude Desktop spawns like any local server and
 * which forwards the header. The token goes in `env` rather than into the argument
 * list, because an argument list is visible to anything that can see the process.
 *
 * Cursor is genuinely url-plus-headers and keeps the plain JSON. Lumping the two
 * together under one snippet, which is what this component used to do, sent every
 * Claude Desktop member to a config shape that does nothing. */
export function mcpSnippets(url) {
  const safe = url || 'https://YOUR-PROJECT.supabase.co/functions/v1/intel-mcp'
  return {
    claudeCode: `claude mcp add --transport http investor-intel ${safe} --header "Authorization: Bearer ${PLACEHOLDER}"`,
    json: JSON.stringify({
      mcpServers: {
        'investor-intel': {
          url: safe,
          headers: { Authorization: `Bearer ${PLACEHOLDER}` },
        },
      },
    }, null, 2),
    desktop: JSON.stringify({
      mcpServers: {
        'investor-intel': {
          command: 'npx',
          args: ['-y', 'mcp-remote', safe, '--header', 'Authorization:${INTEL_TOKEN}', '--transport', 'http-only'],
          env: { INTEL_TOKEN: `Bearer ${PLACEHOLDER}` },
        },
      },
    }, null, 2),
    curl: `curl -s ${safe} \\\n  -H "Authorization: Bearer ${PLACEHOLDER}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  }
}

export default function AgentMcpConnect() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [copied, setCopied] = useState(null)
  const [copyError, setCopyError] = useState(null)

  const url = useMemo(() => hostedMcpUrl(), [])
  const snippets = useMemo(() => mcpSnippets(url), [url])

  const copy = useCallback(async (key, value) => {
    setCopyError(null)
    try {
      await navigator.clipboard.writeText(value)
      setCopied(key)
    } catch {
      // A failed copy leaves the value on screen and selectable rather than
      // silently doing nothing, which is the only useful fallback.
      setCopied(null)
      setCopyError(t('settings.agent_mcp_copy_failed', { defaultValue: 'Copy failed. Select the text and copy it by hand.' }))
    }
  }, [t])

  const block = (key, label, value, hint) => (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-[var(--fg-3)]">{label}</span>
        <button
          type="button"
          onClick={() => copy(key, value)}
          className="btn btn--quiet btn--sm"
          aria-label={t('settings.agent_mcp_copy', { defaultValue: 'Copy' })}
          data-testid={`mcp-copy-${key}`}
        >
          {copied === key ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      <pre data-testid={`mcp-snippet-${key}`} className="text-[11px] text-[var(--fg-1)] overflow-x-auto whitespace-pre-wrap break-all border-t border-[var(--border)] pt-2">{value}</pre>
      {hint ? <p className="text-[11px] text-[var(--fg-4)]">{hint}</p> : null}
    </div>
  )

  return (
    <section className="space-y-4 border-t border-[var(--border)] pt-4" data-testid="agent-mcp-connect">
      <div>
        <div className="text-[11px] uppercase tracking-wide text-[var(--fg-3)] flex items-center gap-2">
          <Plug className="h-3.5 w-3.5 text-[var(--accent)]" />
          {t('settings.agent_mcp_eyebrow', { defaultValue: 'Connect your agent' })}
        </div>
        <div className="text-sm font-medium text-[var(--fg-1)] mt-1">
          {t('settings.agent_mcp_heading', { defaultValue: 'One address, no install' })}
        </div>
        <p className="text-[13px] text-[var(--fg-3)] max-w-2xl mt-1">
          {t('settings.agent_mcp_intro', { defaultValue: 'Claude, Cursor and anything else that speaks MCP can connect straight to this address with a token from above. Nothing to install and nothing running on your machine. Your agent gets the market and tokenized-asset readings as well as your own records, and every figure it reads comes back with the time it was captured and where it came from.' })}
        </p>
      </div>

      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12px] text-[var(--fg-3)]">{t('settings.agent_mcp_url_label', { defaultValue: 'Server address' })}</span>
          <button
            type="button"
            onClick={() => copy('url', url)}
            disabled={!url}
            className="btn btn--quiet btn--sm disabled:opacity-50"
            aria-label={t('settings.agent_mcp_copy', { defaultValue: 'Copy' })}
            data-testid="mcp-copy-url"
          >
            {copied === 'url' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
        <code data-testid="mcp-url" className="block text-[12px] text-[var(--fg-1)] break-all border-t border-[var(--border)] pt-2">
          {url || t('settings.agent_mcp_url_unavailable', { defaultValue: 'The address is unavailable in this session. Reload the page.' })}
        </code>
      </div>

      {block(
        'claude-code',
        t('settings.agent_mcp_claude_code', { defaultValue: 'Claude Code, in a terminal' }),
        snippets.claudeCode,
        t('settings.agent_mcp_placeholder_note', { defaultValue: 'Replace YOUR_TOKEN with the token you copied when you created it. We cannot fill it in for you: it is stored only as a fingerprint and is never shown again.' }),
      )}
      {block(
        'json',
        t('settings.agent_mcp_json', { defaultValue: 'Cursor and other config files' }),
        snippets.json,
        t('settings.agent_mcp_json_note', { defaultValue: 'Merge this into the client\'s MCP config, at .cursor/mcp.json for one project or ~/.cursor/mcp.json for all of them. Keep the file readable only by you: it holds the token in plain text.' }),
      )}
      {block(
        'desktop',
        t('settings.agent_mcp_desktop', { defaultValue: 'Claude Desktop' }),
        snippets.desktop,
        t('settings.agent_mcp_desktop_note', { defaultValue: 'Claude Desktop reaches a remote server through a small bridge it starts for you, so this goes in claude_desktop_config.json under Settings, then Developer, then Edit Config. Node has to be installed. Adding the address as a custom connector instead will not work: that path asks the server to run a sign-in, and this one wants the token above.' }),
      )}
      {block(
        'curl',
        t('settings.agent_mcp_check', { defaultValue: 'Check it works' }),
        snippets.curl,
        t('settings.agent_mcp_check_note', { defaultValue: 'A list of tools means the token is live. A 401 means it is wrong, revoked or expired.' }),
      )}

      {copyError ? <p role="status" className="text-[12px] text-[var(--danger,#f87171)]">{copyError}</p> : null}

      <div className="space-y-2">
        <div className="text-[12px] text-[var(--fg-3)]">{t('settings.agent_mcp_tools_label', { defaultValue: 'What your agent can do' })}</div>
        <p className="text-[11px] text-[var(--fg-4)]">
          {t('settings.agent_mcp_tools_note', { defaultValue: 'A tool that needs a tick from the list above only works on a token that carries it. Creating an alert is still a request you approve here, never something your agent does on its own.' })}
        </p>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-[var(--fg-3)] text-left border-b border-[var(--border)]">
              <th scope="col" className="font-normal py-1 pr-3">{t('settings.agent_mcp_col_tool', { defaultValue: 'Tool' })}</th>
              <th scope="col" className="font-normal py-1 pr-3">{t('settings.agent_mcp_col_what', { defaultValue: 'What it reads or does' })}</th>
              <th scope="col" className="font-normal py-1">{t('settings.agent_mcp_col_needs', { defaultValue: 'Needs' })}</th>
            </tr>
          </thead>
          <tbody>
            {MCP_TOOL_ROWS.map((row) => (
              <tr key={row.name} className="border-b border-[var(--border)] align-top">
                <td className="py-1 pr-3"><code className="text-[var(--fg-1)]">{row.name}</code></td>
                <td className="py-1 pr-3 text-[var(--fg-2)]">{t(`settings.agent_mcp_tool.${row.name}`, { defaultValue: row.name })}</td>
                <td className="py-1 text-[var(--fg-3)]">
                  {row.plan === 'starter'
                    ? t('access.tier_starter', { defaultValue: 'Starter' })
                    : t('settings.agent_mcp_needs_none', { defaultValue: 'Any plan' })}
                  {row.scope ? <><br /><code className="text-[11px] text-[var(--fg-4)]">{row.scope}</code></> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-[var(--fg-4)] max-w-2xl">
        {t('settings.agent_mcp_limits', { defaultValue: 'Each token may make 60 tool calls a minute and, on Starter, 2,000 a day. Every call is recorded with the tool it used and whether it was answered or refused. Revoke a token above and it stops working on its next call.' })}
      </p>
    </section>
  )
}
