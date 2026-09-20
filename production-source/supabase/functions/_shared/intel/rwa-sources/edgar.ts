// Investor Intel: SEC EDGAR submissions and Form D (US public domain).
//
// This is the source that answers the admission question directly, and it is
// the source that proves a hand-curated registry cannot stay right.
//
// VERIFIED 2026-09-16, CIK 0002004367:
//   submissions.formerNames carries
//     "Superstate Short Duration US Government Securities Fund, a series of
//      Superstate Asset Trust", from 2024-01-02 to 2026-07-07.
//   The filer is now named "Invesco Short Duration US Government Securities
//     Fund, a separate series of Superstate Asset Trust".
//   Its Form D terms changed underneath that name:
//     2024-01-02 D     exemptions 06c, 3C, 3C.1, 3C.7   minimum 0
//     2026-05-05 D/A   exemptions 06c, 3C, 3C.7         minimum 100000
//     2026-07-14 D/A   same terms, new name
//   So both the NAME and the ADMISSION TERMS moved, on different dates. A
//   registry curated at any single moment is wrong about one of them.
//
// PRIVACY, AND IT IS NOT NEGOTIABLE. A Form D primary_doc.xml contains a
// `relatedPersonsList` naming NATURAL PERSONS (directors) with their street
// addresses. Probed 2026-09-16, the BUIDL filing names three. This codebase
// forbids describing an address or an entity as a person (see
// _shared/intel/holder-tags.ts). `parseFormD` therefore DROPS that element
// entirely: there is no field on the returned shape that could carry a person,
// so nothing downstream can store, display or export one. The test asserts it.
//
// EDGAR answers 403 without a descriptive User-Agent (probed 2026-09-16). The
// shared transport refuses such a call BEFORE issuing it and names the reason
// `user_agent_required`, so a missing agent is an honest failure rather than an
// empty filing list.

import { fetchSource, type SourceDeps } from './http.ts'

export interface FormerName { name: string; from: string | null; to: string | null }
export interface FilingRef { accessionNumber: string; form: string; filingDate: string | null; primaryDocument: string | null }

export interface SubmissionsRecord {
  cik: string
  name: string | null
  stateOfIncorporation: string | null
  /** The rename trail. Empty is a real answer (BUIDL has none). */
  formerNames: FormerName[]
  filings: FilingRef[]
  /** Standard Industrial Classification code and EDGAR's own description of it,
   * `fiscalYearEnd` as EDGAR publishes it (MMDD), and the exchanges and tickers
   * the filer reports. Added for the underlying-registrant lane, which reads a
   * LISTED COMPANY's submissions rather than a fund's Form D series.
   *
   * These five names come from EDGAR's DOCUMENTED submissions schema, not from a
   * probe: the fund CIK this module was built against files Form D and publishes
   * none of them. Every one is therefore read defensively and is null or empty
   * when absent, so a filer that publishes nothing here produces a row saying so
   * rather than a failed read. */
  sic: string | null
  sicDescription: string | null
  fiscalYearEnd: string | null
  exchanges: string[]
  tickers: string[]
  /** WHAT THE `recent` BLOCK ACTUALLY COVERED, which is not the same as the
   * filer's history. EDGAR's `filings.recent` holds about a thousand entries, so
   * a bank that lodges thousands of 424B2 prospectus supplements a year pushes
   * its own 10-K and 10-Q straight out of it. Read in production 2026-09-20:
   * BANK OF AMERICA CORP and JPMORGAN CHASE & CO both came back with no annual
   * and no quarterly report at all, while filers that file little did not.
   *
   * Without this span, "no 10-K in the data" is indistinguishable from "this
   * company has not filed a 10-K", and the second is a false and damaging claim.
   * `oldest` is the earliest filing date the block carried; a block that starts
   * INSIDE the form's own window cannot be evidence of absence. */
  recent: { count: number; oldest: string | null; newest: string | null }
  /** The older pages EDGAR names in the same document (`filings.files`), newest
   * period first. Each is a further JSON file of the same parallel arrays. */
  olderFiles: { name: string; from: string | null; to: string | null; count: number | null }[]
}

/** Which forms `normalizeSubmissions` keeps, and how many. Defaults keep the
 * first FILING_LIMIT entries of `filings.recent` whatever they are, which is
 * what the Form D lane has always read. */
export interface SubmissionsOptions { limit?: number; forms?: readonly string[] }

export interface SubmissionsResult {
  state: 'known' | 'not_found' | 'unavailable'
  record: SubmissionsRecord | null
  reason: string | null
  fetchedAt: string
  sourceUrl: string
}

const str = (v: unknown, max = 500): string | null => {
  const s = v == null ? '' : String(v).trim()
  return s ? s.slice(0, max) : null
}
const int = (v: unknown): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/** EDGAR keys submissions by a zero-padded ten-digit CIK. */
export function cikKey(cik: unknown): string | null {
  const digits = String(cik ?? '').trim().replace(/^CIK/i, '').replace(/\D/g, '')
  if (!digits || digits.length > 10) return null
  return digits.padStart(10, '0')
}

/** Archives paths use the UNPADDED cik and the accession with no dashes. */
export function formDUrl(cik: unknown, accessionNumber: unknown): string | null {
  const key = cikKey(cik)
  const accession = String(accessionNumber ?? '').trim()
  if (!key || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) return null
  return `https://www.sec.gov/Archives/edgar/data/${Number(key)}/${accession.replace(/-/g, '')}/primary_doc.xml`
}

export const submissionsUrl = (cik: unknown): string | null => {
  const key = cikKey(cik)
  return key ? `https://data.sec.gov/submissions/CIK${key}.json` : null
}

/** The exact shape of an older submissions page's file name, as EDGAR publishes
 * it in `filings.files[].name`. A name from the response is DATA, never a path:
 * only a name of this shape becomes a URL, so nothing the document says can send
 * a request anywhere except to this one directory of data.sec.gov. */
export const EDGAR_SUBMISSION_PAGE = /^CIK\d{10}-submissions-\d{3}\.json$/

/** One older submissions page, by the file name EDGAR itself named. Null for any
 * other string. */
export const submissionPageUrl = (name: unknown): string | null => {
  const file = String(name ?? '').trim()
  return EDGAR_SUBMISSION_PAGE.test(file) ? `https://data.sec.gov/submissions/${file}` : null
}

/** The public filing index for an entity. Every EDGAR signal points here. */
export const edgarEntityUrl = (cik: unknown): string => {
  const key = cikKey(cik)
  return key ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${key}&type=D&dateb=&owner=include&count=40` : 'https://www.sec.gov/edgar/searchedgar/companysearch'
}

/** The filer's own EDGAR browse page, with NO form filter. `edgarEntityUrl`
 * above narrows to Form D, which is right for the fund admission lane and wrong
 * for a listed registrant whose periodic reports are the point. */
export const edgarFilerUrl = (cik: unknown): string => {
  const key = cikKey(cik)
  return key
    ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${key}&type=&dateb=&owner=include&count=40`
    : 'https://www.sec.gov/edgar/searchedgar/companysearch'
}

/** How many filings one read keeps. A filer with a long history is truncated
 * from the OLDEST end, so the newest admission terms are never the ones lost. */
export const FILING_LIMIT = 40
/** The ceiling when a `forms` filter is in force. `filings.recent` holds up to a
 * thousand entries and an active filer's newest forty are routinely all Form 4s,
 * so a periodic-report reader that stopped at FILING_LIMIT would report "no
 * 10-K" for companies that file one every year. */
export const FILING_SCAN_LIMIT = 1000

const textList = (value: unknown, max: number): string[] =>
  (Array.isArray(value) ? value : []).slice(0, 20).map((v) => str(v, max)).filter((v): v is string => !!v)

const day = (v: unknown): string | null => { const s = str(v, 20); return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null }

/**
 * The filings of ONE block of EDGAR's parallel arrays.
 *
 * Shared by `filings.recent` and by the older `CIK##########-submissions-NNN.json`
 * pages, which carry the same column arrays with no wrapper around them. It also
 * reports the SPAN the block covered, so a caller can tell "no 10-K here" from
 * "this filer has no 10-K": the second needs the block to reach back past the
 * form's own filing window, and only the span can say whether it does.
 */
// deno-lint-ignore no-explicit-any
export function filingBlock(block: any, options: SubmissionsOptions = {}): { filings: FilingRef[]; count: number; oldest: string | null; newest: string | null } {
  const accessions = Array.isArray(block?.accessionNumber) ? block.accessionNumber : []
  // A `forms` filter scans the whole block and keeps only the named forms; with
  // none it keeps the first entries exactly as before.
  const wanted = options.forms && options.forms.length ? new Set(options.forms) : null
  const keep = Math.max(1, Math.trunc(options.limit ?? FILING_LIMIT))
  const scan = Math.min(accessions.length, wanted ? FILING_SCAN_LIMIT : accessions.length)
  const filings: FilingRef[] = []
  let oldest: string | null = null, newest: string | null = null
  for (let i = 0; i < scan; i++) {
    // The span is measured over EVERY entry scanned, not over the kept ones: it
    // describes the block, and the kept rows are a filtered view of it.
    const date = day(block?.filingDate?.[i])
    if (date) {
      if (!oldest || date < oldest) oldest = date
      if (!newest || date > newest) newest = date
    }
    if (filings.length >= keep) continue
    const accessionNumber = str(accessions[i], 25)
    const form = str(block?.form?.[i], 20)
    if (!accessionNumber || !form) continue
    if (wanted && !wanted.has(form)) continue
    filings.push({ accessionNumber, form, filingDate: str(block?.filingDate?.[i], 20), primaryDocument: str(block?.primaryDocument?.[i], 200) })
  }
  return { filings, count: scan, oldest, newest }
}

// deno-lint-ignore no-explicit-any
export function normalizeSubmissions(payload: any, options: SubmissionsOptions = {}): SubmissionsRecord | null {
  const cik = cikKey(payload?.cik)
  if (!cik) return null
  const former = Array.isArray(payload?.formerNames) ? payload.formerNames : []
  const block = filingBlock(payload?.filings?.recent ?? {}, options)
  const filings = block.filings
  // Newest period first, so a follow-up read starts with the page that adjoins
  // `recent` rather than with whichever one EDGAR happened to list first.
  const olderFiles = (Array.isArray(payload?.filings?.files) ? payload.filings.files : [])
    .slice(0, 50)
    // deno-lint-ignore no-explicit-any
    .map((entry: any) => ({ name: str(entry?.name, 120), from: day(entry?.filingFrom), to: day(entry?.filingTo), count: int(entry?.filingCount) }))
    .filter((entry: { name: string | null }): entry is { name: string; from: string | null; to: string | null; count: number | null } => !!entry.name && EDGAR_SUBMISSION_PAGE.test(entry.name))
    .sort((a: { to: string | null }, b: { to: string | null }) => String(b.to ?? '').localeCompare(String(a.to ?? '')))
    .slice(0, 20)
  return {
    recent: { count: block.count, oldest: block.oldest, newest: block.newest },
    olderFiles,
    cik,
    name: str(payload?.name, 500),
    stateOfIncorporation: str(payload?.stateOfIncorporation, 20),
    sic: str(payload?.sic, 10),
    sicDescription: str(payload?.sicDescription, 200),
    fiscalYearEnd: str(payload?.fiscalYearEnd, 8),
    exchanges: textList(payload?.exchanges, 40),
    tickers: textList(payload?.tickers, 20),
    formerNames: former.slice(0, 20).map((entry: unknown) => ({
      // deno-lint-ignore no-explicit-any
      name: str((entry as any)?.name, 500) ?? '',
      // deno-lint-ignore no-explicit-any
      from: str((entry as any)?.from, 40),
      // deno-lint-ignore no-explicit-any
      to: str((entry as any)?.to, 40),
    })).filter((entry: FormerName) => !!entry.name),
    filings,
  }
}

export async function fetchSubmissions(cik: unknown, deps: SourceDeps = {}, options: SubmissionsOptions = {}): Promise<SubmissionsResult> {
  const url = submissionsUrl(cik)
  const fetchedAt = new Date((deps.now ?? Date.now)()).toISOString()
  if (!url) return { state: 'unavailable', record: null, reason: 'invalid_cik', fetchedAt, sourceUrl: 'https://data.sec.gov/submissions/' }
  // deno-lint-ignore no-explicit-any
  const response = await fetchSource<any>('edgar', url, deps)
  if (!response.ok) {
    const notFound = response.status === 404
    return { state: notFound ? 'not_found' : 'unavailable', record: null, reason: notFound ? null : response.reason, fetchedAt: response.fetchedAt, sourceUrl: url }
  }
  const record = normalizeSubmissions(response.data, options)
  return record
    ? { state: 'known', record, reason: null, fetchedAt: response.fetchedAt, sourceUrl: url }
    : { state: 'unavailable', record: null, reason: 'unreadable_submissions', fetchedAt: response.fetchedAt, sourceUrl: url }
}

export interface SubmissionPageResult {
  state: 'known' | 'not_found' | 'unavailable'
  filings: FilingRef[]
  count: number
  oldest: string | null
  newest: string | null
  reason: string | null
  fetchedAt: string
  sourceUrl: string | null
}

/**
 * ONE older submissions page, for the case `filings.recent` could not answer.
 *
 * The older pages are the same public JSON, the same host and the same pacing as
 * the main document, and they are read ONLY when the recent block is too short
 * to settle the question (see the registrant lane's own guard). The page carries
 * the parallel arrays with no wrapper, so `filingBlock` reads it unchanged.
 */
export async function fetchSubmissionPage(name: unknown, deps: SourceDeps = {}, options: SubmissionsOptions = {}): Promise<SubmissionPageResult> {
  const url = submissionPageUrl(name)
  const fetchedAt = new Date((deps.now ?? Date.now)()).toISOString()
  const empty = { filings: [] as FilingRef[], count: 0, oldest: null, newest: null }
  if (!url) return { state: 'unavailable', ...empty, reason: 'invalid_submission_page', fetchedAt, sourceUrl: null }
  // deno-lint-ignore no-explicit-any
  const response = await fetchSource<any>('edgar', url, deps)
  if (!response.ok) {
    const notFound = response.status === 404
    return { state: notFound ? 'not_found' : 'unavailable', ...empty, reason: notFound ? null : response.reason, fetchedAt: response.fetchedAt, sourceUrl: url }
  }
  // An older page is a bare block; a wrapper is tolerated rather than required.
  const block = filingBlock(response.data?.filings?.recent ?? response.data ?? {}, options)
  return { state: 'known', filings: block.filings, count: block.count, oldest: block.oldest, newest: block.newest, reason: null, fetchedAt: response.fetchedAt, sourceUrl: url }
}

/** The admission terms of ONE Form D. Every field is what the filing SAYS; none
 * of it is a conclusion about whether a given reader may invest. */
export interface FormDTerms {
  submissionType: string | null
  entityName: string | null
  cik: string | null
  jurisdictionOfInc: string | null
  entityType: string | null
  yearOfInc: string | null
  /** Rule 506(b)/506(c) and Investment Company Act 3(c) exclusions, in filing
   * order, e.g. ['06c','3C','3C.7']. */
  federalExemptions: string[]
  /** 0 is a REAL minimum and stays 0. null means the filing did not state one. */
  minimumInvestmentAccepted: number | null
  hasNonAccreditedInvestors: boolean | null
  totalAmountSold: number | null
  totalOfferingAmount: number | null
  totalNumberAlreadyInvested: number | null
  /** Previous names the FILING itself declares, distinct from EDGAR's
   * formerNames. 'None' is normalised away to an empty list. */
  issuerPreviousNames: string[]
  signatureDate: string | null
}

const block = (xml: string, tag: string): string | null => {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)
  return match ? match[1] : null
}
const tagText = (xml: string, tag: string): string | null => {
  const inner = block(xml, tag)
  if (inner == null) return null
  const text = inner.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim()
  return text || null
}
const money = (v: string | null): number | null => {
  if (v == null) return null
  const n = Number(String(v).replace(/[, ]/g, ''))
  // A negative amount sold is not a measurement.
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Parse ONE Form D primary_doc.xml into its admission terms.
 *
 * Deliberately tolerant and regex based: Deno has no built-in XML parser, and a
 * dependency is not worth carrying for a flat document. It reads only the
 * elements listed on `FormDTerms`.
 *
 * `relatedPersonsList` IS NEVER READ. There is no field for it on the returned
 * shape, so a natural person named in the filing cannot reach the database, the
 * UI or an export.
 */
export function parseFormD(xml: unknown): FormDTerms | null {
  const text = typeof xml === 'string' ? xml : ''
  if (!text || !/<edgarSubmission/i.test(text)) return null
  // Scope the exemption items to their own element: `<item>` is a generic tag
  // and a document-wide sweep would collect unrelated list entries.
  const exemptionBlock = block(text, 'federalExemptionsExclusions') ?? ''
  const federalExemptions = [...exemptionBlock.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .map((m) => m[1].trim()).filter(Boolean).slice(0, 20)
  const issuer = block(text, 'primaryIssuer') ?? text
  const offering = block(text, 'offeringData') ?? text
  const previousBlock = block(issuer, 'issuerPreviousNameList') ?? ''
  const issuerPreviousNames = [...previousBlock.matchAll(/<value>([\s\S]*?)<\/value>/gi)]
    .map((m) => m[1].trim())
    // The filing writes the literal string 'None' when there are no previous
    // names. Keeping it would invent a rename that did not happen.
    .filter((v) => v && v.toLowerCase() !== 'none').slice(0, 20)
  const nonAccredited = tagText(offering, 'hasNonAccreditedInvestors')
  const minimum = money(tagText(offering, 'minimumInvestmentAccepted'))
  return {
    submissionType: tagText(text, 'submissionType'),
    entityName: tagText(issuer, 'entityName'),
    cik: cikKey(tagText(issuer, 'cik')),
    jurisdictionOfInc: tagText(issuer, 'jurisdictionOfInc'),
    entityType: tagText(issuer, 'entityType'),
    yearOfInc: tagText(block(issuer, 'yearOfInc') ?? '', 'value'),
    federalExemptions,
    minimumInvestmentAccepted: minimum,
    hasNonAccreditedInvestors: nonAccredited == null ? null : /^true$/i.test(nonAccredited),
    totalAmountSold: money(tagText(offering, 'totalAmountSold')),
    totalOfferingAmount: money(tagText(offering, 'totalOfferingAmount')),
    totalNumberAlreadyInvested: (() => { const n = int(tagText(offering, 'totalNumberAlreadyInvested')); return n != null && n >= 0 ? n : null })(),
    issuerPreviousNames,
    signatureDate: tagText(text, 'signatureDate'),
  }
}

export interface FormDResult {
  state: 'known' | 'not_found' | 'unavailable'
  terms: FormDTerms | null
  accessionNumber: string | null
  reason: string | null
  fetchedAt: string
  sourceUrl: string
}

export async function fetchFormD(cik: unknown, accessionNumber: unknown, deps: SourceDeps = {}): Promise<FormDResult> {
  const url = formDUrl(cik, accessionNumber)
  const accession = String(accessionNumber ?? '').trim() || null
  const fetchedAt = new Date((deps.now ?? Date.now)()).toISOString()
  if (!url) return { state: 'unavailable', terms: null, accessionNumber: accession, reason: 'invalid_filing_reference', fetchedAt, sourceUrl: 'https://www.sec.gov/Archives/edgar/data/' }
  const response = await fetchSource('edgar', url, deps, { as: 'text', accept: 'application/xml,text/xml,*/*' })
  if (!response.ok) {
    const notFound = response.status === 404
    return { state: notFound ? 'not_found' : 'unavailable', terms: null, accessionNumber: accession, reason: notFound ? null : response.reason, fetchedAt: response.fetchedAt, sourceUrl: url }
  }
  const terms = parseFormD(response.text)
  return terms
    ? { state: 'known', terms, accessionNumber: accession, reason: null, fetchedAt: response.fetchedAt, sourceUrl: url }
    : { state: 'unavailable', terms: null, accessionNumber: accession, reason: 'unreadable_form_d', fetchedAt: response.fetchedAt, sourceUrl: url }
}

/** Form D filings only, newest first. `D` and `D/A` are the admission record;
 * every other form this filer lodged is a different question. */
export const formDFilings = (record: SubmissionsRecord | null): FilingRef[] =>
  (record?.filings ?? []).filter((f) => f.form === 'D' || f.form === 'D/A')
    .sort((a, b) => String(b.filingDate ?? '').localeCompare(String(a.filingDate ?? '')))
