// Investor Intel: GLEIF Level 1 and Level 2 reference data (CC0).
//
// THIS ADAPTER DELIBERATELY HAS NO NAME SEARCH, and that absence is the whole
// point of the module.
//
// Probed 2026-09-16, all against api.gleif.org:
//   filter[fulltext]=Ondo            returned 17 records, whose first five were
//                                    SARL MOGABURE (FR), AUTOBUSES LA
//                                    GUIPUZCOANA SL (ES), SUNBETH GLOBAL
//                                    CONCEPTS LIMITED (NG) and two more Spanish
//                                    companies. None is Ondo Finance.
//   filter[entity.legalName]=
//     Ondo Finance                   returned ZERO records.
//   filter[entity.legalName]=
//     Paxos Trust Company, LLC       returned 191,698 records. The FIRST is the
//                                    correct entity; the total proves the
//                                    filter tokenises rather than matching the
//                                    whole string.
//
// So a name is not an identifier here. Resolving an issuer STRING to a legal
// entity by search would manufacture a fact, and this codebase would then print
// that fact next to a sanctions or lapsed-registration signal. An issuer is
// mapped only by an explicit, dated, human-reviewable assertion in
// rwa-issuer-aliases.ts, and an unmapped issuer stays unmapped.
//
// What this adapter does instead: fetch ONE record by its exact 20-character
// LEI, and fetch the Level 2 relationships of a known LEI. Nothing else.

import { fetchSource, type SourceDeps } from './http.ts'

/** ISO 17442: 18 alphanumerics then 2 check digits. */
export const LEI_PATTERN = /^[0-9A-Z]{18}[0-9]{2}$/

/** GLEIF registration statuses that mean the record is NOT being maintained.
 * LAPSED is the one this product cares about most: the entity did not renew. */
export const LEI_UNMAINTAINED_STATUSES = ['LAPSED', 'RETIRED', 'ANNULLED', 'DUPLICATE', 'PENDING_ARCHIVAL'] as const

export interface LeiRecord {
  lei: string
  legalName: string | null
  jurisdiction: string | null
  /** The ENTITY's own status (ACTIVE / INACTIVE), distinct from whether its
   * REGISTRATION is being maintained. Superstate Limited is ACTIVE and LAPSED
   * at the same time, which is exactly why both are kept. */
  entityStatus: string | null
  registrationStatus: string | null
  initialRegistrationDate: string | null
  lastUpdateDate: string | null
  nextRenewalDate: string | null
  managingLou: string | null
  corroborationLevel: string | null
  registeredAs: string | null
  legalAddressCountry: string | null
  headquartersCountry: string | null
}

export interface LeiReadResult {
  state: 'known' | 'not_found' | 'unavailable'
  record: LeiRecord | null
  reason: string | null
  fetchedAt: string
  sourceUrl: string
}

const str = (v: unknown, max = 200): string | null => {
  const s = v == null ? '' : String(v).trim()
  return s ? s.slice(0, max) : null
}

/** The public human-readable page for an LEI. Every signal points here. */
export const gleifRecordUrl = (lei: string): string => `https://search.gleif.org/#/record/${encodeURIComponent(lei)}`

// deno-lint-ignore no-explicit-any
export function normalizeLeiRecord(payload: any): LeiRecord | null {
  const attributes = payload?.attributes ?? payload
  const lei = str(attributes?.lei ?? payload?.id, 20)
  if (!lei || !LEI_PATTERN.test(lei)) return null
  const entity = attributes?.entity ?? {}
  const registration = attributes?.registration ?? {}
  return {
    lei,
    legalName: str(entity?.legalName?.name, 500),
    jurisdiction: str(entity?.jurisdiction, 20),
    entityStatus: str(entity?.status, 40),
    registrationStatus: str(registration?.status, 40),
    initialRegistrationDate: str(registration?.initialRegistrationDate, 40),
    lastUpdateDate: str(registration?.lastUpdateDate, 40),
    nextRenewalDate: str(registration?.nextRenewalDate, 40),
    managingLou: str(registration?.managingLou, 20),
    corroborationLevel: str(registration?.corroborationLevel, 40),
    registeredAs: str(entity?.registeredAs, 100),
    legalAddressCountry: str(entity?.legalAddress?.country, 10),
    headquartersCountry: str(entity?.headquartersAddress?.country, 10),
  }
}

/**
 * One record, by exact LEI. A malformed LEI never reaches the network.
 *
 * A 404 is `not_found`, which is a REAL answer about the register and is not a
 * failure. Anything else unsuccessful is `unavailable` with its own reason, so
 * a caller can tell "this LEI is not in the register" from "we could not ask".
 */
export async function fetchLeiRecord(lei: unknown, deps: SourceDeps = {}): Promise<LeiReadResult> {
  const code = String(lei ?? '').trim().toUpperCase()
  const url = `https://api.gleif.org/api/v1/lei-records/${encodeURIComponent(code)}`
  if (!LEI_PATTERN.test(code)) {
    return { state: 'unavailable', record: null, reason: 'invalid_lei', fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(), sourceUrl: url }
  }
  // deno-lint-ignore no-explicit-any
  const response = await fetchSource<any>('gleif', url, deps)
  if (!response.ok) {
    const notFound = response.status === 404
    return { state: notFound ? 'not_found' : 'unavailable', record: null, reason: notFound ? null : response.reason, fetchedAt: response.fetchedAt, sourceUrl: url }
  }
  const record = normalizeLeiRecord(response.data?.data)
  if (!record) return { state: 'unavailable', record: null, reason: 'unreadable_record', fetchedAt: response.fetchedAt, sourceUrl: url }
  return { state: 'known', record, reason: null, fetchedAt: response.fetchedAt, sourceUrl: url }
}

export type LeiRelationshipKind = 'direct-parent' | 'ultimate-parent' | 'direct-children'

export interface LeiRelationshipResult {
  state: 'known' | 'none' | 'unavailable'
  kind: LeiRelationshipKind
  /** For a parent: that parent's LEI record. For children: how many the
   * register reports, which is a count and never a list of people. */
  parent: LeiRecord | null
  childCount: number | null
  reason: string | null
  fetchedAt: string
  sourceUrl: string
}

/**
 * Level 2: who owns this entity, or how many children it has.
 *
 * A 404 here means the register records NO such relationship. That is a real
 * answer (`none`), not a failure: probed 2026-09-16, SUPERSTATE INC. returned
 * 404 for both direct-parent and ultimate-parent, while BlackRock, Inc.
 * reported 125 direct children.
 */
export async function fetchLeiRelationship(lei: unknown, kind: LeiRelationshipKind, deps: SourceDeps = {}): Promise<LeiRelationshipResult> {
  const code = String(lei ?? '').trim().toUpperCase()
  const url = `https://api.gleif.org/api/v1/lei-records/${encodeURIComponent(code)}/${kind}${kind === 'direct-children' ? '?page%5Bsize%5D=1' : ''}`
  const base = { kind, parent: null, childCount: null, fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(), sourceUrl: url }
  if (!LEI_PATTERN.test(code)) return { ...base, state: 'unavailable', reason: 'invalid_lei' }
  // deno-lint-ignore no-explicit-any
  const response = await fetchSource<any>('gleif', url, deps)
  if (!response.ok) {
    if (response.status === 404) return { ...base, state: 'none', reason: null, fetchedAt: response.fetchedAt }
    return { ...base, state: 'unavailable', reason: response.reason, fetchedAt: response.fetchedAt }
  }
  if (kind === 'direct-children') {
    const total = Number(response.data?.meta?.pagination?.total)
    return { ...base, state: 'known', childCount: Number.isFinite(total) && total >= 0 ? Math.trunc(total) : null, reason: null, fetchedAt: response.fetchedAt }
  }
  const parent = normalizeLeiRecord(response.data?.data)
  return parent
    ? { ...base, state: 'known', parent, reason: null, fetchedAt: response.fetchedAt }
    : { ...base, state: 'none', reason: null, fetchedAt: response.fetchedAt }
}

export interface LeiSignal {
  level: 'maintained' | 'unmaintained' | 'unknown'
  status: string | null
  /** What this signal does NOT mean. Rendered with the figure, never dropped. */
  scope: string
  sourceUrl: string
}

/** A registration-status signal, worded as a POINTER TO A PRIMARY SOURCE.
 *
 * A lapsed LEI is a fact about a REGISTRY RECORD, not about conduct. Getting
 * this register wrong is a legal problem, not a style problem, so the scope
 * string travels with the level and no caller may render one without the other. */
export function leiRegistrationSignal(record: LeiRecord | null): LeiSignal {
  const sourceUrl = record?.lei ? gleifRecordUrl(record.lei) : 'https://search.gleif.org/'
  const status = record?.registrationStatus ?? null
  if (!status) return { level: 'unknown', status: null, scope: 'No GLEIF registration status was read for this entity. Nothing is asserted about it.', sourceUrl }
  const unmaintained = (LEI_UNMAINTAINED_STATUSES as readonly string[]).includes(status)
  return {
    level: unmaintained ? 'unmaintained' : 'maintained',
    status,
    scope: unmaintained
      ? `The Global LEI Foundation records this entity's registration as ${status}, which means the record was not renewed or was withdrawn. This describes the maintenance state of a reference-data record. It is not a finding about the entity's licensing, solvency, conduct or the standing of any security, and it is not advice. Read the GLEIF record.`
      : `The Global LEI Foundation records this entity's registration as ${status}. A maintained registration confirms only that reference data is current. It does not establish that the entity is authorised, regulated or suitable, and it is not advice. Read the GLEIF record.`,
    sourceUrl,
  }
}
