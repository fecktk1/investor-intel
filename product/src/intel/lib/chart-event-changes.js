// Presentation only: the append-only event remains unchanged.
export function chartEventChanges(changes) {
  const display = { ...(changes || {}) }
  for (const field of ['status', 'stance', 'conviction']) {
    const previous = display[`prev_${field}`], next = display[`new_${field}`]
    if (!display[field] && previous && next && Object.hasOwn(previous, 'after') && Object.hasOwn(next, 'after')) {
      display[field] = { before: previous.after, after: next.after }
      delete display[`prev_${field}`]
      delete display[`new_${field}`]
    }
  }
  const conviction = value => {
    if (value == null || value === '' || !Number.isFinite(Number(value))) return value
    const n = Number(value)
    return n >= 0 && n <= 1 ? `${Number((n * 5).toFixed(2))}/5` : value
  }
  for (const key of ['conviction', 'prev_conviction', 'new_conviction']) {
    const value = display[key]
    if (value && typeof value === 'object') display[key] = { ...value, before: conviction(value.before), after: conviction(value.after) }
  }
  return display
}
