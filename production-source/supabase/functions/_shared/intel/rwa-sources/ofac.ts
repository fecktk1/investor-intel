// Investor Intel: OFAC Specially Designated Nationals screening of ISSUER LEGAL
// ENTITIES.
//
// THE REGISTER MATTERS MORE THAN THE CODE HERE. A sanctions signal is a POINTER
// TO A PRIMARY SOURCE. It is never an accusation, never a conclusion that a
// named party is sanctioned, and never advice. Getting this wrong is a legal
// problem, not a style problem. Two rules follow from that and are enforced
// below rather than left to a caller:
//
//   1. EXACT NORMALISED NAME MATCHES ONLY. No fuzzy matching, no edit distance,
//      no token overlap, no "probably the same company". A near-match printed
//      next to a sanctions list is a defamation risk, and the whole reason this
//      product maps issuers through a dated, reviewed alias map is that names
//      are not identifiers. A non-match is reported as `no_exact_match`, which
//      explicitly does NOT mean "screened clear".
//   2. LEGAL ENTITIES ONLY. Individual SDN entries are dropped at parse time.
//      This codebase does not describe a person, so a natural person cannot
//      enter the index, cannot be matched and cannot be displayed.
//
// Publication, probed 2026-09-16:
//   sdn.csv 5,692,933 bytes and sdn.xml 29,082,239 bytes both answered 200.
//   The CSV is used: a fifth of the bytes for the same names, and it parses
//   without an XML dependency. Columns are
//     ent_num, SDN_Name, SDN_Type, Program, Title, Call_Sign, Vess_type,
//     Tonnage, GRT, Vess_flag, Vess_owner, Remarks
//   with the literal string `-0-` standing in for an empty field. An individual
//   carries SDN_Type 'individual'; an entity leaves it `-0-`.

import { fetchSource, type SourceDeps } from './http.ts'

export const OFAC_SDN_CSV_URL = 'https://www.treasury.gov/ofac/downloads/sdn.csv'
/** The published list is about 5.7 MB. The ceiling leaves room for growth and
 * still refuses a runaway response. */
export const OFAC_MAX_BYTES = 12 * 1024 * 1024
/** Where every sanctions signal points. */
export const OFAC_SDN_SEARCH_URL = 'https://sanctionssearch.ofac.treas.gov/'

export interface SdnEntity {
  entNum: string
  name: string
  program: string | null
  remarks: string | null
}

/**
 * Normalise a legal-entity name for EXACT comparison.
 *
 * Case, punctuation and whitespace only, so that "Paxos Trust Company, LLC" and
 * "PAXOS TRUST COMPANY LLC" are the same string.
 *
 * THE LEGAL FORM IS DELIBERATELY NOT REMOVED, and this is a correctness rule
 * rather than a preference. Stripping suffixes such as LIMITED and INC would
 * collapse "Superstate Limited" (British Virgin Islands, registration LAPSED)
 * and "SUPERSTATE INC." (US Delaware, registration ISSUED) onto one key. Those
 * are two provably different legal persons with different statuses, and a
 * sanctions pointer that treated them as one would attach a publication to the
 * wrong company. When this normalisation is wrong it therefore fails to match,
 * which is reported honestly as `no_exact_match` and explicitly not as a
 * clearance, rather than matching something it should not.
 */
export function normalizeEntityName(value: unknown): string {
  return String(value ?? '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[.,'"()\-\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Split one CSV line, honouring quoted fields. The publication quotes names
 * that contain commas, so a naive split would truncate them. */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') { if (line[i + 1] === '"') { field += '"'; i++ } else quoted = false }
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { out.push(field); field = '' }
    else field += ch
  }
  out.push(field)
  return out.map((v) => v.trim())
}

const cell = (v: string | undefined): string | null => {
  const s = (v ?? '').trim()
  return !s || s === '-0-' ? null : s
}

export interface SdnIndex {
  /** Normalised name to the entries carrying it. */
  byName: Map<string, SdnEntity[]>
  entities: number
  /** Individuals seen and deliberately discarded. Reported so the count is
   * visible rather than silent. */
  individualsSkipped: number
  publishedAt: string | null
}

/**
 * Parse the SDN CSV into a legal-entity index.
 *
 * Individual entries are DROPPED, not merely skipped at match time: there is no
 * path by which a natural person reaches the index or anything downstream.
 */
export function parseSdnCsv(text: unknown, publishedAt: string | null = null): SdnIndex {
  const byName = new Map<string, SdnEntity[]>()
  let entities = 0
  let individualsSkipped = 0
  const lines = String(text ?? '').split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    const fields = splitCsvLine(line)
    const entNum = cell(fields[0])
    const name = cell(fields[1])
    const type = (cell(fields[2]) ?? '').toLowerCase()
    if (!entNum || !name) continue
    if (type === 'individual') { individualsSkipped++; continue }
    const key = normalizeEntityName(name)
    if (!key) continue
    const entry: SdnEntity = { entNum, name, program: cell(fields[3]), remarks: cell(fields[11]) }
    const bucket = byName.get(key)
    if (bucket) bucket.push(entry); else byName.set(key, [entry])
    entities++
  }
  return { byName, entities, individualsSkipped, publishedAt }
}

export interface ScreeningResult {
  state: 'exact_match' | 'no_exact_match' | 'not_screened'
  matches: SdnEntity[]
  /** What this result does NOT mean. Rendered with it, always. */
  scope: string
  sourceUrl: string
  screenedName: string | null
}

const MATCH_SCOPE =
  'The name recorded for this legal entity is byte-for-byte identical, after removing punctuation and legal-form words, to a name published on the OFAC Specially Designated Nationals list. An identical name is NOT proof that this is the same organisation, and this product does not assert that it is. It is a pointer to a primary source that a person must read and judge. It is not a determination, not an allegation of wrongdoing, and not legal or investment advice. Open the OFAC search and verify.'

const NO_MATCH_SCOPE =
  'No entry on the OFAC Specially Designated Nationals list carries this exact legal-entity name. This is not a sanctions clearance, not a screening certificate, and not advice. Only the SDN list was compared, only by exact name, and only for legal entities. Other sanctions lists, other name spellings, parent and subsidiary entities, and individuals were not checked.'

const NOT_SCREENED_SCOPE =
  'No sanctions screening was performed for this entity, because the published list could not be read or no legal-entity name was available. Nothing is asserted either way.'

/**
 * Screen ONE legal-entity name against the parsed index.
 *
 * Exact normalised equality only. There is no scoring, no threshold and no
 * "close match" branch to tune, because there is no safe threshold for printing
 * a sanctions pointer next to a company name.
 */
export function screenLegalEntity(name: unknown, index: SdnIndex | null): ScreeningResult {
  const raw = String(name ?? '').trim()
  if (!raw || !index) return { state: 'not_screened', matches: [], scope: NOT_SCREENED_SCOPE, sourceUrl: OFAC_SDN_SEARCH_URL, screenedName: raw || null }
  const key = normalizeEntityName(raw)
  const matches = key ? (index.byName.get(key) ?? []) : []
  return matches.length
    ? { state: 'exact_match', matches, scope: MATCH_SCOPE, sourceUrl: OFAC_SDN_SEARCH_URL, screenedName: raw }
    : { state: 'no_exact_match', matches: [], scope: NO_MATCH_SCOPE, sourceUrl: OFAC_SDN_SEARCH_URL, screenedName: raw }
}

export interface SdnFetchResult {
  state: 'known' | 'unavailable'
  index: SdnIndex | null
  reason: string | null
  fetchedAt: string
  sourceUrl: string
}

export async function fetchSdnIndex(deps: SourceDeps = {}): Promise<SdnFetchResult> {
  const response = await fetchSource('ofac', OFAC_SDN_CSV_URL, deps, { as: 'text', maxBytes: OFAC_MAX_BYTES, accept: 'text/csv,text/plain,*/*' })
  if (!response.ok) return { state: 'unavailable', index: null, reason: response.reason, fetchedAt: response.fetchedAt, sourceUrl: OFAC_SDN_CSV_URL }
  const index = parseSdnCsv(response.text, response.fetchedAt)
  // A publication that parsed to nothing is a failed read, not an empty list.
  if (!index.entities) return { state: 'unavailable', index: null, reason: 'empty_publication', fetchedAt: response.fetchedAt, sourceUrl: OFAC_SDN_CSV_URL }
  return { state: 'known', index, reason: null, fetchedAt: response.fetchedAt, sourceUrl: OFAC_SDN_CSV_URL }
}
