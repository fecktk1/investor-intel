// Investor Intel public demo: the in-memory table store.
//
// Everything a demo visitor creates (a watchlist, a thesis, an alert, a note)
// lands here and nowhere else. It lives in this module's memory, so a reload
// or leaving the demo discards it. Reads of the same table merge it back, so
// the page updates the way it would for a member.
//
// A deliberately small PostgREST emulator: equality, set and range filters,
// order, limit/offset, count, single-object responses and return=representation.
// Anything it does not understand filters nothing rather than failing.

let sequence = 0
const nextId = () => {
  sequence += 1
  const tail = String(sequence).padStart(12, '0')
  return `00000000-0000-4000-9000-${tail}`
}

function parseValue(raw) {
  if (raw === 'null') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  return raw
}

function splitList(inner) {
  // in.(a,b,"c,d") → ['a','b','c,d']
  const out = []
  let current = '', quoted = false
  for (const ch of inner) {
    if (ch === '"') { quoted = !quoted; continue }
    if (ch === ',' && !quoted) { out.push(current); current = ''; continue }
    current += ch
  }
  if (current !== '' || out.length) out.push(current)
  return out
}

function like(value, pattern, insensitive) {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/%/g, '.*')
  return new RegExp(`^${escaped}$`, insensitive ? 'i' : '').test(String(value ?? ''))
}

function compare(a, b) {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  const na = Number(a), nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na - nb
  return String(a).localeCompare(String(b))
}

/** One `column=op.value` filter as a predicate. Unknown operators pass. */
export function filterPredicate(column, expression) {
  const text = String(expression ?? '')
  let negate = false, rest = text
  if (rest.startsWith('not.')) { negate = true; rest = rest.slice(4) }
  const dot = rest.indexOf('.')
  const op = dot === -1 ? rest : rest.slice(0, dot)
  const arg = dot === -1 ? '' : rest.slice(dot + 1)
  let test
  switch (op) {
    case 'eq': test = (v) => String(v ?? 'null') === String(parseValue(arg) ?? 'null'); break
    case 'neq': test = (v) => String(v ?? 'null') !== String(parseValue(arg) ?? 'null'); break
    case 'gt': test = (v) => compare(v, arg) > 0; break
    case 'gte': test = (v) => compare(v, arg) >= 0; break
    case 'lt': test = (v) => compare(v, arg) < 0; break
    case 'lte': test = (v) => compare(v, arg) <= 0; break
    case 'is': test = (v) => (arg === 'null' ? v == null : arg === 'true' ? v === true : arg === 'false' ? v === false : true); break
    case 'in': {
      const list = splitList(arg.replace(/^\(/, '').replace(/\)$/, '')).map(String)
      test = (v) => list.includes(String(v)); break
    }
    case 'like': test = (v) => like(v, arg, false); break
    case 'ilike': test = (v) => like(v, arg, true); break
    default: test = () => true
  }
  return (row) => {
    const value = row?.[column]
    const result = test(value)
    return negate ? !result : result
  }
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'or', 'and'])

/** Parse the PostgREST query string of a request into filters and modifiers. */
export function parseQuery(searchParams) {
  const filters = []
  let order = null, limit = null, offset = 0, onConflict = null
  for (const [key, value] of searchParams.entries()) {
    if (key === 'order') order = value
    else if (key === 'limit') limit = Number(value)
    else if (key === 'offset') offset = Number(value) || 0
    else if (key === 'on_conflict') onConflict = value.split(',').map((c) => c.trim()).filter(Boolean)
    else if (!RESERVED.has(key) && !key.includes('.')) filters.push(filterPredicate(key, value))
  }
  return { filters, order, limit: Number.isFinite(limit) ? limit : null, offset, onConflict }
}

function applyOrder(rows, order) {
  if (!order) return rows
  const parts = order.split(',').map((part) => {
    const [column, ...mods] = part.split('.')
    return { column, desc: mods.includes('desc') }
  })
  return [...rows].sort((a, b) => {
    for (const { column, desc } of parts) {
      const c = compare(a?.[column], b?.[column])
      if (c !== 0) return desc ? -c : c
    }
    return 0
  })
}

export function createDemoStore() {
  const tables = new Map()
  const rowsOf = (table) => {
    if (!tables.has(table)) tables.set(table, [])
    return tables.get(table)
  }

  function select(table, searchParams) {
    const q = parseQuery(searchParams)
    const matched = applyOrder(rowsOf(table).filter((row) => q.filters.every((f) => f(row))), q.order)
    const total = matched.length
    const start = q.offset || 0
    const page = q.limit != null ? matched.slice(start, start + q.limit) : matched.slice(start)
    return { rows: page.map((row) => ({ ...row })), total, start }
  }

  function insert(table, payload, searchParams, { upsert = false } = {}) {
    const incoming = (Array.isArray(payload) ? payload : [payload]).filter((row) => row && typeof row === 'object')
    const q = parseQuery(searchParams)
    const keys = q.onConflict || ['id']
    const rows = rowsOf(table)
    const now = new Date().toISOString()
    const written = []
    for (const row of incoming) {
      const existing = upsert ? rows.find((candidate) => keys.every((k) => row[k] !== undefined && String(candidate[k]) === String(row[k]))) : null
      if (existing) {
        Object.assign(existing, row, { updated_at: now })
        written.push({ ...existing })
      } else {
        const created = { id: nextId(), created_at: now, updated_at: now, ...row }
        rows.push(created)
        written.push({ ...created })
      }
    }
    return written
  }

  function update(table, patch, searchParams) {
    const q = parseQuery(searchParams)
    const now = new Date().toISOString()
    const written = []
    for (const row of rowsOf(table)) {
      if (q.filters.every((f) => f(row))) {
        Object.assign(row, patch && typeof patch === 'object' ? patch : {}, { updated_at: now })
        written.push({ ...row })
      }
    }
    return written
  }

  function remove(table, searchParams) {
    const q = parseQuery(searchParams)
    const rows = rowsOf(table)
    const kept = [], removed = []
    for (const row of rows) (q.filters.every((f) => f(row)) ? removed : kept).push(row)
    tables.set(table, kept)
    return removed.map((row) => ({ ...row }))
  }

  return {
    select, insert, update, remove,
    tableNames: () => [...tables.keys()],
    clear: () => tables.clear(),
  }
}
