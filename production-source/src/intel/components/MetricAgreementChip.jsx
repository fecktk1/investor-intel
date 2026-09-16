import React from 'react'
import { useTranslation } from 'react-i18next'

// The evidentiary standard, rendered.
//
// The reader gets TWO faces, not four: a move is either corroborated or it is a
// research lead. Making somebody learn a four-value vocabulary to answer "can I
// rely on this" would defeat the point of stating a standard. The specific
// shortfall stays underneath as a sentence, and the full per-metric readings are
// already in the receipt JSON alongside this.
//
// The code term is `metric_agreement` and never "confirmed": four other things
// in this codebase already carry that word (narrative confirmation scores and
// the 'confirmed' lifecycle stage, the signal feed's market_confirmed, the
// thesis EngineStatus, and the portfolio classifier).
const WHY = {
  corroborated: ['evidence.corroborated_why', 'Price, market capitalisation and volume all moved the same way over the same window.'],
  conflicting: ['evidence.conflicting_why', 'Price, market capitalisation and volume do not agree with each other, so this is a lead to research rather than a corroborated move.'],
  incomplete: ['evidence.incomplete_why', 'Fewer than all three of price, market capitalisation and volume could be measured over one window, so this is a lead to research rather than a corroborated move.'],
  unmeasured: ['evidence.unmeasured_why', 'No dated change in price, market capitalisation or volume could be measured, so this is a lead to research rather than a corroborated move.'],
}

// Only the reasons a reader can actually meet on a receipt are translated. The
// rest stay machine codes in the receipt JSON, where they belong.
const REASONS = {
  market_cap_undated_by_source: ['evidence.reason_cap_undated', 'This source publishes market capitalisation without an observation time of its own, so no dated change can be derived from it.'],
  market_cap_single_observation: ['evidence.reason_cap_single', 'Only one dated market capitalisation reading is retained, and a change needs two.'],
  not_a_market_move: ['evidence.reason_not_market_move', 'This alert reports a recorded event rather than a market move, so price, market capitalisation and volume have nothing to agree about.'],
  narrative_scores_exclude_market_cap: ['evidence.reason_narrative_no_cap', 'A narrative score carries price and volume components but no market capitalisation, so the full test cannot be run on it.'],
}

export default function MetricAgreementChip({ agreement }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const verdict = agreement?.metric_agreement
  // An absent verdict means the standard was never run for this receipt. Nothing
  // is claimed rather than showing a reassuring-looking empty chip.
  if (!WHY[verdict]) return null
  const corroborated = verdict === 'corroborated'
  const [whyKey, whyDefault] = WHY[verdict]
  const reasons = (Array.isArray(agreement.reasons) ? agreement.reasons : []).filter((r) => REASONS[r])
  return (
    <p className="intel-analysis-caption">
      <span className={`chip text-[10px] ${corroborated ? 'chip--ok' : 'chip--info'}`}>
        {corroborated
          ? t('evidence.corroborated', { defaultValue: 'Corroborated' })
          : t('evidence.research_lead', { defaultValue: 'Research lead' })}
      </span>{' '}
      {t(whyKey, { defaultValue: whyDefault })}
      {reasons.map((r) => ` ${t(REASONS[r][0], { defaultValue: REASONS[r][1] })}`).join('')}
    </p>
  )
}
