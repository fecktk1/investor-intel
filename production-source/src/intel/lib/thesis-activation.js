// Minimum authored specificity, not a claim that prose can be automated.
// Keep this predicate aligned with the authoritative database trigger.
export function hasInvalidationCondition(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length >= 12 && /[\p{L}]/u.test(text)
    && !/^(tbd|todo|none|n\/?a|not (sure|applicable|known)|to be (decided|determined)|[?.\s]+)(\b|$)/i.test(text)
}
export function assertThesisActivation(thesis) {
  if (['active', 'strengthening', 'weakening', 'needs_review'].includes(thesis.status || 'active') && !hasInvalidationCondition(thesis.what_would_invalidate)) {
    throw new Error('Invalidated if: describe a specific condition (at least 12 characters) before activating. You can save an incomplete draft.')
  }
}
