import React from 'react'
import { AlertTriangle, Inbox, Sparkles } from 'lucide-react'

export function cx(...parts) {
  return parts.flat().filter(Boolean).join(' ')
}

export function IntelPageShell({ children, className = '' }) {
  return <div className={cx('intel-page space-y-5', className)}>{children}</div>
}

export function IntelPageHeader({ icon: Icon, eyebrow, title, subtitle, actions, className = '' }) {
  return (
    <div className={cx('intel-page-header', className)}>
      <div className="min-w-0">
        {eyebrow && (
          <div className="eyebrow flex items-center gap-1.5">
            {Icon && <Icon className="h-3.5 w-3.5" />}
            {eyebrow}
          </div>
        )}
        <h1 className="page-title mt-1">{title}</h1>
        {subtitle && <p className="page-sub mt-1 max-w-3xl">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  )
}

export function IntelSectionHeader({ icon: Icon, label, subtitle, actions, eyebrow, className = '' }) {
  return (
    <div className={cx('intel-section-header', className)}>
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
        <div className="intel-section-title">
          {Icon && <Icon className="h-3.5 w-3.5 text-[var(--forge-gold)]" />}
          <span>{label}</span>
        </div>
        {subtitle && <div className="intel-section-sub mt-1">{subtitle}</div>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  )
}

export function IntelSurface({ children, className = '', tone = 'default', clickable = false, as: Component = 'div', ...props }) {
  const toneClass = tone === 'raised'
    ? 'intel-surface intel-surface--raised'
    : tone === 'flat'
      ? 'intel-surface intel-surface--flat'
      : tone === 'accent'
        ? 'intel-surface intel-surface--accent'
        : 'intel-surface'
  return (
    <Component className={cx(toneClass, clickable && 'intel-clickable', className)} {...props}>
      {children}
    </Component>
  )
}

export function IntelHeroRead({ eyebrow, title, body, children, meta, actions, className = '' }) {
  // `meta` may be a renderable node (fragment) OR an array of { label, value }
  // key/value pairs. Normalize arrays so callers can pass structured meta.
  const metaNode = Array.isArray(meta)
    ? meta.map((m, i) => (
        m && typeof m === 'object' && !React.isValidElement(m) && 'label' in m
          ? <span key={i} className="whitespace-nowrap"><span className="text-[var(--fg-4)]">{m.label}</span> <span className="text-[var(--fg-2)]">{m.value}</span></span>
          : <span key={i}>{m}</span>
      ))
    : meta
  const hasMeta = Array.isArray(meta) ? meta.length > 0 : (meta != null && meta !== false)
  return (
    <section className={cx('intel-hero-read space-y-3', className)}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          {eyebrow && <div className="eyebrow eyebrow-accent flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" />{eyebrow}</div>}
          {title && <h2 className="text-[18px] font-semibold text-[var(--fg-1)] leading-tight mt-1">{title}</h2>}
          {body && <p className="page-sub mt-1 max-w-3xl">{body}</p>}
          {hasMeta && <div className="intel-source-strip mt-2">{metaNode}</div>}
        </div>
        {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

export function IntelMetricCard({ label, value, sub, tone = 'default', icon: Icon, className = '' }) {
  const toneClass = tone === 'positive'
    ? 'text-[var(--signal-green)]'
    : tone === 'negative'
      ? 'text-[var(--signal-red)]'
      : tone === 'warning'
        ? 'text-[var(--signal-yellow)]'
        : tone === 'info'
          ? 'text-[var(--signal-blue)]'
          : 'text-[var(--fg-1)]'
  return (
    <div className={cx('intel-metric-card', className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="intel-metric-label">{label}</div>
        {Icon && <Icon className="h-3.5 w-3.5 text-[var(--fg-5)]" />}
      </div>
      <div className={cx('intel-metric-value', toneClass)}>{value}</div>
      {sub && <div className="intel-metric-sub">{sub}</div>}
    </div>
  )
}

export function IntelDataPill({ children, tone = 'default', className = '', title }) {
  const toneClass = tone === 'accent'
    ? 'intel-data-pill--accent'
    : tone === 'ok'
      ? 'intel-data-pill--ok'
      : tone === 'err'
        ? 'intel-data-pill--err'
        : tone === 'info'
          ? 'intel-data-pill--info'
          : ''
  return <span title={title} className={cx('chip intel-data-pill', toneClass, className)}>{children}</span>
}

export function IntelStatusBadge({ label, tone = 'default', className = '', title }) {
  return <IntelDataPill tone={tone} title={title} className={cx('text-[10px] uppercase', className)}>{label}</IntelDataPill>
}

export function IntelTabs({ items, value, onChange, getLabel, className = '' }) {
  return (
    <div className={cx('intel-tabs', className)} role="tablist">
      {items.map((item) => {
        // Accept either `value` or `key`-shaped items; resolve a label via
        // getLabel when provided (callers may pass i18n-resolved labels).
        const itemValue = item.value !== undefined ? item.value : item.key
        const active = itemValue === value
        const Icon = item.icon
        return (
          <button
            key={itemValue}
            type="button"
            role="tab"
            aria-selected={active}
            className="intel-tab"
            onClick={() => onChange?.(itemValue)}
          >
            {Icon && <Icon className="h-3.5 w-3.5" />}
            {getLabel ? getLabel(item) : item.label}
          </button>
        )
      })}
    </div>
  )
}

export function IntelMiniChartFrame({ children, className = '' }) {
  return <div className={cx('intel-mini-chart-frame', className)}>{children}</div>
}

export function IntelSkeleton({ className = 'h-24 rounded-[var(--intel-radius-lg)]' }) {
  return <div className={cx('intel-skeleton', className)} />
}

export function IntelEmptyState({ title, body, action, icon: Icon = Inbox, className = '' }) {
  return (
    <div className={cx('intel-empty-state card p-8', className)}>
      <Icon className="h-7 w-7 text-[var(--fg-5)]" />
      <div>
        {title && <div className="text-sm font-semibold text-[var(--fg-1)]">{title}</div>}
        {body && <div className="text-[13px] text-[var(--fg-3)] mt-1 max-w-md">{body}</div>}
      </div>
      {action}
    </div>
  )
}

export function IntelErrorState({ error, fallback = 'Something went wrong.', className = '' }) {
  if (!error) return null
  return (
    <div className={cx('card--flat p-3 text-[13px] text-[var(--signal-red)] flex items-start gap-2', className)}>
      <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
      <span>{typeof error === 'string' ? error : error?.message || fallback}</span>
    </div>
  )
}

export function IntelScoreBar({ value = 0, tone = 'accent', className = '' }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0))
  const color = tone === 'ok'
    ? 'var(--signal-green)'
    : tone === 'err'
      ? 'var(--signal-red)'
      : tone === 'info'
        ? 'var(--signal-blue)'
        : tone === 'warning'
          ? 'var(--signal-yellow)'
          : 'var(--forge-gold)'
  return (
    <div className={cx('intel-score-track', className)} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} role="meter">
      <div className="intel-score-bar" style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}

export function IntelSourceStrip({ children, className = '' }) {
  return <div className={cx('intel-source-strip', className)}>{children}</div>
}

