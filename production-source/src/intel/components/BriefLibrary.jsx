import React, { useState } from 'react'

const keyOf = brief => `${brief.scope}:${brief.id}`
const summaryOf = brief => brief.artifact?.structured?.summary || brief.assembled?.market_regime?.rationale || brief.assembled?.no_meaningful_change || 'Open the saved brief.'

// An archive and one reading surface keep historical briefs reachable without
// making every visit download a wall of expanded analysis into the page.
export default function BriefLibrary({ briefs, selectedKey, onSelect, renderBrief, nextCursor, loadingMore, onLoadMore }) {
  const [archiveOpen, setArchiveOpen] = useState(false)
  const selected = briefs.find(brief => keyOf(brief) === selectedKey) || briefs[0]
  return <div className="intel-brief-library">
    <aside className="intel-brief-archive" aria-label="Brief archive" data-open={archiveOpen}>
      <button className="intel-brief-archive-toggle" aria-expanded={archiveOpen} aria-controls="brief-archive-list" onClick={() => setArchiveOpen(open => !open)}>Brief archive <span>{archiveOpen ? 'Close' : 'Browse dates'}</span></button>
      <h2>Brief archive</h2>
      <div id="brief-archive-list" className="intel-brief-archive-list">
        {briefs.map(brief => <button key={keyOf(brief)} aria-current={keyOf(brief) === keyOf(selected) ? 'true' : undefined} onClick={() => { onSelect(keyOf(brief)); setArchiveOpen(false) }}>
          <time dateTime={brief.period_date}>{brief.period_date}</time>
          <span className="intel-brief-scope">{brief.scope === 'personal' ? 'Private · only you' : 'Organization history · shared'}</span>
          <span className="intel-brief-excerpt">{summaryOf(brief)}</span>
        </button>)}
        {nextCursor && <button className="intel-brief-older" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? 'Loading older briefs…' : 'Load older briefs'}</button>}
      </div>
    </aside>
    <article className="intel-brief-reader" aria-label="Selected brief">
      {selected && renderBrief(selected)}
    </article>
  </div>
}
