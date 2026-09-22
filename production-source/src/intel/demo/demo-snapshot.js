// Investor Intel public demo: the snapshot reader.
//
// The snapshot is a set of JSON files in the public `intel-demo` Storage bucket,
// written once a day by the intel-demo-snapshot Edge Function:
//   latest.json                            {date, capturedAt, version, keys:[...]}
//   snapshots/<YYYY-MM-DD>/<key>.json      one stored response body per request key
// latest.json is loaded once per document; entries are loaded lazily by key and
// kept in memory. These public object reads are the ONLY network requests the
// demo makes to the backend host, and they carry no credentials.

import {
  DEMO_BUCKET, DEMO_DATE_PATTERN, DEMO_KEY_PATTERN, DEMO_LATEST_PATH, demoEntryPath,
} from '../../../supabase/functions/_shared/intel/demo-snapshot-key.ts'

export function publicObjectUrl(supabaseUrl, path) {
  const base = String(supabaseUrl || '').replace(/\/+$/, '')
  return `${base}/storage/v1/object/public/${DEMO_BUCKET}/${path}`
}

/** Is this URL a public read of the demo bucket? */
export function isDemoBucketUrl(supabaseUrl, url) {
  const prefix = publicObjectUrl(supabaseUrl, '')
  return String(url || '').startsWith(prefix)
}

export function createSnapshotReader({ supabaseUrl, fetchImpl }) {
  let manifestPromise = null
  const entries = new Map()

  async function getJson(path) {
    const response = await fetchImpl(publicObjectUrl(supabaseUrl, path), {
      method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', cache: 'no-cache',
    })
    if (!response || !response.ok) return null
    try { return await response.json() } catch { return null }
  }

  /** latest.json, validated. Null when there is no snapshot yet. */
  function manifest() {
    if (!manifestPromise) {
      manifestPromise = getJson(DEMO_LATEST_PATH).then((raw) => {
        if (!raw || typeof raw !== 'object' || !DEMO_DATE_PATTERN.test(String(raw.date || ''))) return null
        const keys = new Set((Array.isArray(raw.keys) ? raw.keys : []).filter((k) => DEMO_KEY_PATTERN.test(String(k))))
        return { date: raw.date, capturedAt: typeof raw.capturedAt === 'string' ? raw.capturedAt : null, version: raw.version ?? null, keys }
      }).catch(() => null)
    }
    return manifestPromise
  }

  /** The stored body for a key, or null when the snapshot does not hold it. */
  async function entry(key) {
    const m = await manifest()
    if (!m || !m.keys.has(key)) return null
    if (!entries.has(key)) {
      entries.set(key, getJson(demoEntryPath(m.date, key)).then((raw) => {
        if (raw && typeof raw === 'object' && 'body' in raw) return raw
        return null
      }).catch(() => null))
    }
    return entries.get(key)
  }

  return { manifest, entry }
}
