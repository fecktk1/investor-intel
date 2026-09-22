// Investor Intel: admission reality as a TIME SERIES, and the drift that proves
// a curated registry cannot stay right.
//
// A hand-curated "can I invest in this?" registry states today's answer. This
// module states every answer the filer has given, in filing order, and names
// the date each one changed.
//
// THE CASE THAT MOTIVATES IT, verified 2026-09-16 on EDGAR CIK 0002004367:
//   2024-01-02 D     exemptions 06c, 3C, 3C.1, 3C.7   minimum 0
//   2026-05-05 D/A   exemptions 06c, 3C, 3C.7         minimum 100000
//   2026-07-14 D/A   same terms, filed under a NEW NAME (Superstate to Invesco)
// Two separate drift events on two separate dates: the terms moved first, the
// name moved later. A registry curated at any single moment is wrong about one.
//
// TERMS VERSUS ACTIVITY, and why the distinction is load-bearing. BUIDL (CIK
// 0002013810) filed the SAME terms in 2024 and 2026 (minimum 100000, 3C.7,
// accredited only) while its reported amount sold moved from 0 to 5,135,523,412
// and its investor count from 0 to 28. If those were counted as admission drift
// the detector would cry wolf on every fund that simply grew. So a change in
// what the filing DEMANDS OF AN INVESTOR is drift; a change in how much has
// been sold is activity, reported separately and labelled as such.
//
// A MISSING VALUE IS NOT A CHANGE. If either side of a comparison is null, no
// drift record is emitted: "the filing stopped stating this" is not the same as
// "the term changed", and inventing the latter would date a change that never
// happened. A ZERO, by contrast, is a real value: minimum 0 to minimum 100000
// is exactly the drift this module exists to catch.

import type { FilingRef, FormDTerms, SubmissionsRecord } from './rwa-sources/edgar.ts'

/** One filing's admission terms, with the clocks that date it. */
export interface AdmissionSnapshot {
  accessionNumber: string
  /** EDGAR's filing date. This is the SOURCE's clock, not ours. */
  filingDate: string | null
  signatureDate: string | null
  submissionType: string | null
  entityName: string | null
  jurisdictionOfInc: string | null
  federalExemptions: string[]
  minimumInvestmentAccepted: number | null
  hasNonAccreditedInvestors: boolean | null
  totalAmountSold: number | null
  totalNumberAlreadyInvested: number | null
  sourceUrl: string
  /** When WE read it. Distinct from filingDate, and never shown as the same. */
  fetchedAt: string
}

export const ADMISSION_TERM_FIELDS = ['entity_name', 'jurisdiction', 'federal_exemptions', 'minimum_investment', 'non_accredited'] as const
export const ADMISSION_ACTIVITY_FIELDS = ['amount_sold', 'investor_count'] as const
export type AdmissionField = typeof ADMISSION_TERM_FIELDS[number] | typeof ADMISSION_ACTIVITY_FIELDS[number]

export interface DriftRecord {
  field: AdmissionField
  /** 'term' changes what is asked of an investor. 'activity' does not. */
  kind: 'term' | 'activity'
  from: string
  to: string
  fromAccession: string
  toAccession: string
  /** The filing date of the EARLIER filing: the last date the old answer held. */
  heldUntil: string | null
  /** The filing date of the LATER filing: when the new answer appears. The
   * change happened at or before this date, never exactly on it, and the scope
   * string says so. */
  changedBy: string | null
  label: string
  scope: string
}

const DRIFT_SCOPE =
  'A difference between two filings by the same filer on EDGAR. The date shown is the date of the LATER filing, so the change happened at or before it, not necessarily on it. This describes what the filings say. It does not explain why a term changed, does not establish what the terms are today, and is not legal or investment advice. Read both filings.'

const FIELD_LABELS: Record<AdmissionField, string> = {
  entity_name: 'Filed entity name',
  jurisdiction: 'Jurisdiction of incorporation',
  federal_exemptions: 'Claimed exemptions',
  minimum_investment: 'Minimum investment accepted',
  non_accredited: 'Non-accredited investors accepted',
  amount_sold: 'Total amount sold',
  investor_count: 'Investors already invested',
}

/** Present a value for comparison and display. `null` means the filing did not
 * state it, and a null on either side suppresses the comparison entirely. */
const show = (value: unknown): string | null => {
  if (value == null) return null
  if (Array.isArray(value)) return value.length ? value.join(', ') : null
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  const s = String(value).trim()
  return s || null
}

/** Build a snapshot from one parsed filing plus the reference that located it. */
export function admissionSnapshot(filing: FilingRef, terms: FormDTerms, sourceUrl: string, fetchedAt: string): AdmissionSnapshot {
  return {
    accessionNumber: filing.accessionNumber,
    filingDate: filing.filingDate ?? null,
    signatureDate: terms.signatureDate ?? null,
    submissionType: terms.submissionType ?? null,
    entityName: terms.entityName ?? null,
    jurisdictionOfInc: terms.jurisdictionOfInc ?? null,
    federalExemptions: Array.isArray(terms.federalExemptions) ? terms.federalExemptions : [],
    minimumInvestmentAccepted: terms.minimumInvestmentAccepted,
    hasNonAccreditedInvestors: terms.hasNonAccreditedInvestors,
    totalAmountSold: terms.totalAmountSold,
    totalNumberAlreadyInvested: terms.totalNumberAlreadyInvested,
    sourceUrl,
    fetchedAt,
  }
}

/** Oldest first. A filing with no date sorts by accession, which is issued in
 * ascending order, so the series never silently reorders itself. */
export function admissionTimeline(snapshots: readonly AdmissionSnapshot[]): AdmissionSnapshot[] {
  return [...snapshots].sort((a, b) =>
    String(a.filingDate ?? '').localeCompare(String(b.filingDate ?? '')) ||
    a.accessionNumber.localeCompare(b.accessionNumber))
}

const FIELD_READERS: Array<{ field: AdmissionField; kind: 'term' | 'activity'; read: (s: AdmissionSnapshot) => unknown }> = [
  { field: 'entity_name', kind: 'term', read: (s) => s.entityName },
  { field: 'jurisdiction', kind: 'term', read: (s) => s.jurisdictionOfInc },
  { field: 'federal_exemptions', kind: 'term', read: (s) => s.federalExemptions },
  { field: 'minimum_investment', kind: 'term', read: (s) => s.minimumInvestmentAccepted },
  { field: 'non_accredited', kind: 'term', read: (s) => s.hasNonAccreditedInvestors },
  { field: 'amount_sold', kind: 'activity', read: (s) => s.totalAmountSold },
  { field: 'investor_count', kind: 'activity', read: (s) => s.totalNumberAlreadyInvested },
]

/**
 * Every dated change between consecutive filings.
 *
 * Consecutive pairs only: comparing the newest against the oldest would collapse
 * two separate changes on two separate dates into one undated claim, which is
 * precisely the failure this module exists to avoid.
 */
export function admissionDrift(snapshots: readonly AdmissionSnapshot[], options: { kinds?: readonly ('term' | 'activity')[] } = {}): DriftRecord[] {
  const kinds = options.kinds ?? ['term', 'activity']
  const series = admissionTimeline(snapshots)
  const out: DriftRecord[] = []
  for (let i = 1; i < series.length; i++) {
    const previous = series[i - 1], current = series[i]
    for (const { field, kind, read } of FIELD_READERS) {
      if (!kinds.includes(kind)) continue
      const from = show(read(previous)), to = show(read(current))
      // Unknown on either side is not a change.
      if (from == null || to == null || from === to) continue
      out.push({
        field, kind, from, to,
        fromAccession: previous.accessionNumber, toAccession: current.accessionNumber,
        heldUntil: previous.filingDate, changedBy: current.filingDate,
        label: FIELD_LABELS[field], scope: DRIFT_SCOPE,
      })
    }
  }
  return out
}

export interface RenameRecord {
  from: string
  to: string
  /** EDGAR's own record of when the former name applied. */
  usedFrom: string | null
  usedUntil: string | null
  scope: string
}

const RENAME_SCOPE =
  'EDGAR records that this filer previously filed under another name, and the dates between which it did. Both names are kept: the token contract, the registry and the filings can each still carry a different one. A rename is an administrative fact about a filer record. It does not establish a change of ownership, control or obligations, and it is not advice.'

/**
 * The rename trail, from EDGAR `formerNames`.
 *
 * BOTH names are retained. Replacing the old name with the new one would
 * destroy the ability to match a token that still carries the old one, which is
 * exactly the situation that exists on chain today: probed 2026-09-16, the
 * Invesco fund's own token metadata still carried the Superstate name after the
 * filer had been renamed.
 */
export function renameHistory(record: SubmissionsRecord | null): RenameRecord[] {
  const current = record?.name?.trim()
  if (!current) return []
  return (record?.formerNames ?? [])
    .filter((former) => former.name && former.name.trim() !== current)
    .map((former) => ({ from: former.name.trim(), to: current, usedFrom: former.from, usedUntil: former.to, scope: RENAME_SCOPE }))
}

/** Every name this filer is known to have used, newest first, deduplicated.
 * Used to match a token whose metadata has not caught up with the rename. */
export function knownFilerNames(record: SubmissionsRecord | null): string[] {
  const names = [record?.name, ...(record?.formerNames ?? []).map((f) => f.name)]
    .map((n) => String(n ?? '').trim()).filter(Boolean)
  return [...new Set(names)]
}
