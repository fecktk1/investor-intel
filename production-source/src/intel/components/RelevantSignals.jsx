import React, { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Radar, ArrowRight } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { loadSignalFeed } from '../lib/signals-api'
import SignalCard from './SignalCard'

// Drop-in "Relevant signals" rail powered by the reusable Intel Signal store.
// Self-contained (fetches its own data) so any surface can include it with one line.
// `personalOnly` keeps only signals that matched the user's watchlist/holdings/
// followed narratives/chains/topics — i.e. "what matters to YOU". Renders nothing
// while empty so it never adds noise. Maps store rows → SignalCard shape.

function rowToCard(r) {
  const kind = r.subject_type === 'chain' ? 'chain' : r.subject_type === 'narrative' ? 'narrative' : r.subject_type === 'news' ? 'news' : 'token'
  return {
    id: r.signal_key,
    name: r.display_symbol || r.subject_id,
    kind,
    asset_symbol: r.subject_type === 'asset' ? String(r.display_symbol || '').toUpperCase() || null : null,
    chain: r.chain || null,
    ref: (r.subject_type === 'asset' || r.subject_type === 'chain') ? r.subject_id : null,
    signal_type: r.signal_type || 'Signal',
    signal_scope: kind === 'token' ? 'token_specific' : kind === 'chain' ? 'chain_specific' : kind,
    direction: r.direction,
    confidence: r.confidence,
    time_window: 'last 24h',
    mention_count: r.source_count,
    source_count: r.source_count,
    source_diversity: r.source_diversity,
    headlines: r.headlines || [],
    why_it_matters: r.why_it_matters,
    what_to_watch_next: r.what_to_watch_next,
    change_24h: r.metrics && typeof r.metrics.change_24h === 'number' ? r.metrics.change_24h : null,
    score_delta: r.score_delta || null,
    stale_after: r.stale_after || null,
    corroboration: r.metrics?.corroboration || null,
    reasons: r.reasons || [],
  }
}

export default function RelevantSignals({ subjectType = null, title = 'Signals relevant to you', personalOnly = true, limit = 5, seeAllHref = '/intel' }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [rows, setRows] = useState(null)

  useEffect(() => {
    let alive = true
    if (!org?.id) return
    loadSignalFeed(supabase, org.id, { subjectType, limit: 24 })
      .then((data) => { if (alive) setRows(data) })
      .catch(() => { if (alive) setRows([]) })
    return () => { alive = false }
  }, [org?.id, supabase, subjectType])

  if (!rows) return null
  const cards = rows.map(rowToCard).filter((c) => !personalOnly || (c.reasons || []).length > 0).slice(0, limit)
  if (!cards.length) return null

  return (
    <section className="space-y-2">
      <div className="intel-section-header">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><Radar className="h-3.5 w-3.5" /> {title}</div>
          <div className="intel-section-sub">{t('signals.personalized_sub', { defaultValue: 'Personalized from your watchlist, holdings, followed narratives, chains, and topics.' })}</div>
        </div>
        <Link to={seeAllHref} className="btn btn--quiet btn--sm">All <ArrowRight className="h-3 w-3" /></Link>
      </div>
      <div className="space-y-2">{cards.map((c) => <SignalCard key={c.id} s={c} />)}</div>
    </section>
  )
}
