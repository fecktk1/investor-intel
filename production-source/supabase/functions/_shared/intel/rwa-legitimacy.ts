// Investor Intel: the RWA issuer legitimacy projection.
//
// Assembles one reader-facing view from the primary sources, under one rule
// that overrides every other consideration in this file:
//
//   AN UNMAPPED SUBJECT GETS NO LEGAL FACTS. If rwa-issuer-aliases.ts has not
//   asserted an identity for this subject, the view carries no registration
//   status, no sanctions pointer, no jurisdiction and no admission terms. It
//   carries the deliberate non-mapping and its evidence, and nothing else. A
//   legal fact attached to the wrong company is the failure mode this whole
//   feature exists to avoid, so the guard lives here rather than in a caller.
//
// Two further rules, inherited from the surrounding codebase:
//   * A FAILURE NEVER EMPTIES A LIST. Each source reports its own named reason
//     into `unavailable`, and whatever else was read stays visible.
//   * VALID ZEROS STAY ZEROS. A zero share, a zero minimum investment and a
//     zero investor count are measurements and are rendered as such.

import {
  aliasState, collisionsFor, resolveAlias, unmappedRecord,
  type AliasAssertion, type AliasState, type NameCollision, type UnmappedRecord,
} from './rwa-issuer-aliases.ts'
import { leiRegistrationSignal, type LeiRecord, type LeiSignal } from './rwa-sources/gleif.ts'
import { screenLegalEntity, type ScreeningResult, type SdnIndex } from './rwa-sources/ofac.ts'
import { concentrationScope, type Concentration } from './rwa-sources/blockscout.ts'
import type { TransferRestrictions } from './rwa-sources/sourcify.ts'
import type { SubmissionsRecord } from './rwa-sources/edgar.ts'
import { admissionDrift, admissionTimeline, renameHistory, type AdmissionSnapshot, type DriftRecord, type RenameRecord } from './rwa-admission-drift.ts'

export interface LegitimacyInput {
  /** 'token:eip155:1:0x...' or 'cmc-issuer:<id>'. */
  subject: string
  at?: number
  lei?: LeiRecord | null
  sdn?: SdnIndex | null
  submissions?: SubmissionsRecord | null
  admissions?: readonly AdmissionSnapshot[]
  concentration?: Concentration | null
  /** OUR capture hour for the concentration figure, never a provider clock. */
  concentrationCapturedAt?: string | null
  holdersCount?: number | null
  restrictions?: TransferRestrictions | null
  /** Named failure per source, e.g. { edgar: 'user_agent_required' }. */
  reasons?: Record<string, string | null>
}

export interface RiskSignal {
  type: 'lei_registration' | 'sanctions_name_pointer'
  level: string
  status: string | null
  /** What this signal does NOT mean. Never rendered without it. */
  scope: string
  sourceUrl: string
}

export interface UnavailableSource { source: string; reason: string }

export interface LegitimacyView {
  subject: string
  identity: {
    state: AliasState
    assertion: AliasAssertion | null
    unmapped: UnmappedRecord | null
    collisions: NameCollision[]
    legalName: string | null
    jurisdiction: string | null
  }
  admission: {
    timeline: AdmissionSnapshot[]
    termDrift: DriftRecord[]
    activityDrift: DriftRecord[]
    renames: RenameRecord[]
    /** Current terms are simply the newest filing, labelled as such. */
    current: AdmissionSnapshot | null
  }
  signals: RiskSignal[]
  concentration: {
    tiers: { topN: number; share: number | null }[]
    holdersCount: number | null
    holdersRead: number
    truncated: boolean
    capturedAt: string | null
    exportAllowed: boolean
    scope: string
  } | null
  restrictions: TransferRestrictions | null
  unavailable: UnavailableSource[]
}

const EMPTY_ADMISSION = { timeline: [], termDrift: [], activityDrift: [], renames: [], current: null }

/**
 * One reader-facing view.
 *
 * Concentration and transfer restrictions are properties of a TOKEN CONTRACT,
 * not of a legal entity, so they are shown even when the issuer is unmapped:
 * "we do not know who issues this, and here is how concentrated it is" is an
 * honest and useful pair. Everything that speaks about a LEGAL PERSON is gated
 * behind the mapping.
 */
export function legitimacyView(input: LegitimacyInput): LegitimacyView {
  const at = input.at ?? Date.now()
  const subject = String(input.subject ?? '')
  const state = aliasState(subject, at)
  const assertion = resolveAlias(subject, at)
  const unavailable: UnavailableSource[] = Object.entries(input.reasons ?? {})
    .filter(([, reason]) => !!reason)
    .map(([source, reason]) => ({ source, reason: String(reason) }))

  // Token-level facts, which do not depend on knowing the legal entity.
  const concentration = input.concentration
    ? {
      tiers: input.concentration.tiers,
      holdersCount: input.holdersCount ?? null,
      holdersRead: input.concentration.holdersRead,
      truncated: input.concentration.truncated,
      capturedAt: input.concentrationCapturedAt ?? null,
      // The explorer's redistribution terms could not be verified, so a figure
      // derived from it never leaves the product.
      exportAllowed: false,
      scope: concentrationScope(input.concentration.truncated),
    }
    : null

  const base = {
    subject,
    concentration,
    restrictions: input.restrictions ?? null,
    unavailable,
  }

  if (state !== 'mapped' || !assertion) {
    // THE GUARD. No legal facts for a subject we have not identified, even when
    // a register record happens to be in hand.
    return {
      ...base,
      identity: { state, assertion: null, unmapped: unmappedRecord(subject), collisions: [], legalName: null, jurisdiction: null },
      admission: { ...EMPTY_ADMISSION },
      signals: [],
    }
  }

  const admissions = Array.isArray(input.admissions) ? input.admissions : []
  const timeline = admissionTimeline(admissions)
  const signals: RiskSignal[] = []

  // Registration status, only when a register record was actually read.
  if (input.lei) {
    const signal: LeiSignal = leiRegistrationSignal(input.lei)
    signals.push({ type: 'lei_registration', level: signal.level, status: signal.status, scope: signal.scope, sourceUrl: signal.sourceUrl })
  }

  // Sanctions screening, against the name the REGISTER publishes for the mapped
  // entity, never against a CoinMarketCap issuer string.
  const legalName = input.lei?.legalName ?? assertion.entity.legalName ?? null
  if (legalName) {
    const screening: ScreeningResult = screenLegalEntity(legalName, input.sdn ?? null)
    signals.push({ type: 'sanctions_name_pointer', level: screening.state, status: screening.matches[0]?.program ?? null, scope: screening.scope, sourceUrl: screening.sourceUrl })
  }

  return {
    ...base,
    identity: {
      state,
      assertion,
      unmapped: null,
      collisions: collisionsFor(subject),
      legalName,
      jurisdiction: input.lei?.jurisdiction ?? assertion.entity.jurisdiction ?? null,
    },
    admission: {
      timeline,
      termDrift: admissionDrift(timeline, { kinds: ['term'] }),
      activityDrift: admissionDrift(timeline, { kinds: ['activity'] }),
      renames: renameHistory(input.submissions ?? null),
      current: timeline.at(-1) ?? null,
    },
    signals,
  }
}

/** Does this view carry anything a reader can act on? Used by the read view to
 * choose between rendering and stating an honest reason. */
export const hasLegitimacyContent = (view: LegitimacyView): boolean =>
  view.identity.state !== 'unknown' || !!view.concentration || !!view.restrictions || view.admission.timeline.length > 0
