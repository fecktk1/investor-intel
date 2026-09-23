import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import TokenAvatar from './TokenAvatar'
import { fmtNum } from '../lib/market-format'
import ProviderText from './ProviderText'
import { clampProviderBlocks, providerTextBlocks } from '../lib/provider-text'

// The stored descriptive profile of one tokenized real-world asset, as a plain
// presentational block for a detail drawer.
//
// PURELY PRESENTATIONAL. It takes a profile object and renders it. It performs no
// read, holds no org context and knows nothing about the transport, so the page
// that hosts it decides when to fetch (see useRwaAssetProfile) and this file can be
// dropped into any drawer with three lines.
//
// EVERY FIELD HERE IS THE PROVIDER'S. The description, the logo, the website, the
// industry, the founding year, the headcount, the exchange and the rank are what
// CoinMarketCap published, captured at the time this block prints. They are
// labelled as that, once, at the bottom, rather than implied to be ours. Where the
// profile carries a filer number it belongs to the UNDERLYING LISTED COMPANY, not
// to the firm that issued the token, and the line that shows it says so.
//
// House visual language: no pills and no cards. An eyebrow, a definition list on
// hairlines, and a text link.

/** Characters of the description shown before the expand control. Long enough to
 *  be worth reading, short enough not to own the drawer. */
export const CLAMP_CHARS = 420

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** The clamped head of a description, cut at the last sentence or word boundary
 *  inside the limit so the expand control never opens mid-word. */
export function clampText(text, limit = CLAMP_CHARS) {
  const value = String(text || '').trim()
  if (value.length <= limit) return { head: value, clamped: false }
  const window = value.slice(0, limit)
  const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'))
  const cut = sentence > limit * 0.5 ? sentence + 1 : (window.lastIndexOf(' ') > 0 ? window.lastIndexOf(' ') : limit)
  return { head: value.slice(0, cut).trim(), clamped: true }
}

/** An https website only. An http link from a provider field would be a downgrade
 *  we chose to render, so it is shown as plain text instead. */
const httpsOnly = url => (typeof url === 'string' && /^https:\/\/[^\s]+$/i.test(url) ? url : null)

const rule = 'border-b border-[var(--border-default)] py-2'

export default function RwaAssetProfile({ profile, className = '' }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [expanded, setExpanded] = useState(false)

  // No profile is a stated state, not a blank. The caller may prefer its own
  // wording, but this component never renders nothing.
  if (!profile) {
    return (
      <div className={`intel-rwa-profile ${className}`}>
        <div className="eyebrow">{t('rwa_underlying.profile_eyebrow', { defaultValue: 'Asset profile' })}</div>
        <p role="status" className="text-[12px] mt-1">
          {t('rwa_underlying.profile_empty', { defaultValue: 'No descriptive profile has been captured for this asset yet. Profiles are read a batch at a time each day, so coverage grows over several days.' })}
        </p>
      </div>
    )
  }

  // The provider's prose carries light markdown ("### " headings, bullets). It is
  // rendered as blocks, never printed with its markers, and clamped by blocks.
  const blocks = providerTextBlocks(profile.description)
  const description = clampProviderBlocks(blocks, CLAMP_CHARS)
  const website = httpsOnly(profile.website)
  const employees = num(profile.employees)
  const rank = num(profile.rwaRank)
  const facts = [
    profile.industry ? { key: 'industry', label: t('rwa_underlying.profile_industry', { defaultValue: 'Industry' }), value: profile.industry } : null,
    profile.founded ? { key: 'founded', label: t('rwa_underlying.profile_founded', { defaultValue: 'Founded' }), value: profile.founded } : null,
    // A published headcount of 0 is a real figure and prints as 0.
    employees != null ? { key: 'employees', label: t('rwa_underlying.profile_employees', { defaultValue: 'Employees' }), value: fmtNum(employees), numeric: true } : null,
    profile.primaryExchange ? { key: 'exchange', label: t('rwa_underlying.profile_exchange', { defaultValue: 'Primary exchange' }), value: profile.primaryExchange } : null,
    rank != null ? { key: 'rank', label: t('rwa_underlying.profile_rank', { defaultValue: 'RWA rank' }), value: fmtNum(rank), numeric: true } : null,
  ].filter(Boolean)

  return (
    <div className={`intel-rwa-profile ${className}`} data-testid="rwa-asset-profile">
      <div className="eyebrow">{t('rwa_underlying.profile_eyebrow', { defaultValue: 'Asset profile' })}</div>
      <div className="flex items-center gap-2 mt-1">
        <TokenAvatar src={profile.logoUrl} symbol={profile.symbol} name={profile.name} size="md" />
        <div className="min-w-0">
          <p className="text-[13px] truncate">{profile.name || profile.symbol || `#${profile.rwaId}`}</p>
          {profile.symbol && profile.name ? <p className="text-[11px] text-[var(--fg-4)]">{profile.symbol}</p> : null}
        </div>
      </div>

      {facts.length > 0 && (
        <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2 text-[12px] mt-3">
          {facts.map(fact => (
            <div key={fact.key} className={rule}>
              <dt className="text-[var(--fg-4)]">{fact.label}</dt>
              <dd className={fact.numeric ? 'intel-number' : undefined}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {website && (
        <p className="text-[12px] mt-2">
          <a className="intel-text-link break-all" href={website} target="_blank" rel="noreferrer noopener">
            {t('rwa_underlying.profile_website', { defaultValue: 'Open the official site' })}
          </a>
        </p>
      )}

      {description.blocks.length > 0 && (
        <div className="mt-3">
          <ProviderText className="text-[12px] leading-relaxed max-w-[75ch]" blocks={expanded ? blocks : description.blocks}
            after={description.clamped && !expanded ? '…' : null} />
          {description.clamped && (
            <button type="button" className="intel-text-link text-[12px] mt-1" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
              {expanded
                ? t('rwa_underlying.profile_collapse', { defaultValue: 'Show less' })
                : t('rwa_underlying.profile_expand', { defaultValue: 'Read the full description' })}
            </button>
          )}
        </div>
      )}

      {/* Whose words these are, and whose filer number, said once and plainly. */}
      <p className="text-[11px] leading-relaxed text-[var(--fg-4)] mt-2 max-w-[75ch]">
        {t('rwa_underlying.profile_scope', {
          provider: profile.cikProvider || 'CoinMarketCap',
          capturedAt: String(profile.cikAssertedAt || '').slice(0, 10) || '—',
          defaultValue: 'Published by {{provider}} and captured on {{capturedAt}}. Where a filer number is shown it is the SEC filer number of the underlying listed company as the provider states it, not of the firm that issued the token.',
        })}
      </p>
    </div>
  )
}
