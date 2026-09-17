import React from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Briefcase, Star, Compass, Rss, LineChart, ShieldAlert } from 'lucide-react'

// "Build your first investment thesis" — guides the user into action instead of a
// blank note. Each starter deep-links to the builder with prefilled context.
const STARTERS = [
  { key: 'portfolio', icon: Briefcase,  label: 'Portfolio holding', prefill: { source: 'portfolio' } },
  { key: 'watchlist', icon: Star,       label: 'Watchlist asset',   prefill: { source: 'watchlist' } },
  { key: 'market',    icon: Compass,    label: 'Market page',       prefill: { source: 'market' } },
  { key: 'news',      icon: Rss,        label: 'Recent news',       prefill: { source: 'news' } },
  { key: 'trade',     icon: LineChart,  label: 'Trade idea',        prefill: { source: 'trade', withTrade: true } },
  { key: 'bear',      icon: ShieldAlert,label: 'Bear case',         prefill: { source: 'bear', stance: 'bearish', thesisType: 'bear_case' } },
]

const EXAMPLES = [
  'Create a thesis from recent developments around SOL',
  'Review a holding with no thesis',
  'Turn a news event into a trade plan',
  'Create a bear case for your largest position',
]

export default function ThesisEmptyState() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const navigate = useNavigate()
  const start = (prefill) => navigate('/intel/theses/new', { state: { prefill } })

  return (
    <div className="card p-8 space-y-5 text-center">
      <div>
        <h2 className="text-lg font-semibold text-[var(--fg-1)]">{t('journal.empty.title', { defaultValue: 'Build your first investment thesis' })}</h2>
        <p className="page-sub mt-1">{t('journal.empty.sub', { defaultValue: 'Start from where you already are. The app pulls the evidence for you.' })}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3 max-w-2xl mx-auto">
        {STARTERS.map((s) => {
          const Icon = s.icon
          return (
            <button key={s.key} onClick={() => start(s.prefill)}
              className="card--flat p-4 flex flex-col items-center gap-2 hover:border-[var(--accent)] transition-colors">
              <Icon className="h-5 w-5 text-[var(--accent)]" />
              <span className="text-[13px] text-[var(--fg-2)]">{t(`journal.empty.start_${s.key}`, { defaultValue: s.label })}</span>
            </button>
          )
        })}
      </div>
      <div className="text-left max-w-2xl mx-auto space-y-1">
        <div className="eyebrow">{t('journal.empty.examples', { defaultValue: 'Examples' })}</div>
        {EXAMPLES.map((ex, i) => (
          <div key={i} className="text-[12px] text-[var(--fg-4)]">• {t(`journal.empty.example_${i}`, { defaultValue: ex })}</div>
        ))}
      </div>
    </div>
  )
}
