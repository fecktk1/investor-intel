export const THESIS_DRAFT_FIELDS = [
  ['statement', 'Thesis statement'], ['why_now', 'Why now'],
  ['whats_missing', 'What the market may be missing'], ['supports', 'Supporting evidence'],
  ['weakens', 'Weakening evidence'], ['proves_wrong', 'What would prove this wrong'],
  ['opposing', 'The opposing view'],
]

// Keep the authored words verbatim, including newlines and intentional spacing.
export function thesisDraftPayload(draft = {}) {
  return Object.fromEntries(THESIS_DRAFT_FIELDS.map(([key]) => [key, typeof draft[key] === 'string' ? draft[key] : '']))
}

export function applyResolvedThesisDefaults(current, symbol, identifier) {
  return { ...current, title: current.title || `${symbol || identifier} thesis`, benchmark: current.benchmark || (String(symbol).toUpperCase() === 'BTC' ? 'ETH' : 'BTC') }
}
