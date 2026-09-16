// Investor Intel: the ISSUER ALIAS MAP.
//
// This is the module that decides whether a token may be connected to a legal
// entity at all, and it is deliberately the most conservative file in the lane.
//
// WHY IT EXISTS. A name is not an identifier. Probed against GLEIF 2026-09-16:
//   filter[fulltext]=Ondo                 17 records, top five being SARL
//                                         MOGABURE (FR), AUTOBUSES LA
//                                         GUIPUZCOANA SL (ES), SUNBETH GLOBAL
//                                         CONCEPTS LIMITED (NG) and two more
//                                         Spanish companies. None is Ondo.
//   filter[entity.legalName]=Ondo Finance          0 records
//   filter[entity.legalName]=Ondo Finance, Inc.    76,773 records, top hits
//                                         "INC Group Inc." (CA) and "INC" (FR)
//   filter[entity.legalName]=Paxos Trust Company, NA   748 records, and the only
//                                         Paxos-named one is a DIFFERENT legal
//                                         form (see the Paxos note below)
// A fuzzy match presented as fact would put a company name next to a sanctions
// pointer or a lapsed-registration signal. That is a legal problem, not a
// styling one. So: NOTHING IS EVER MATCHED BY SIMILARITY. A subject is mapped
// only by an explicit assertion below, recorded with what was compared, who
// asserted it and when. AN UNMAPPED ISSUER STAYS UNMAPPED.
//
// EDITORIAL CONTRACT, mirroring _shared/intel/rwa-issuer-evidence.ts: every
// assertion is dated, carries a seven-day review window, links its source, and
// is append only. A deployed assertion is never edited; it is superseded by a
// later version or it expires. Expiry is our freshness policy, not a claim that
// a legal entity ceased to exist on that date.
//
// FOUR KINDS OF RECORD, and the distinction is the honesty mechanism:
//   ALIAS_ASSERTIONS  a subject IS this legal entity. Both sides evidenced.
//   VERIFIED_ENTITIES a register record we read and can quote. It is NOT a
//                     claim that any token belongs to it.
//   UNMAPPED          a subject we deliberately did NOT map, with the
//                     reproduced negative probe that stopped us.
//   NAME_COLLISIONS   register records sharing a name stem with a mapped
//                     filer, surfaced for HUMAN REVIEW and explicitly not
//                     asserted. This is where a lapsed registration that may or
//                     may not be related shows up, without ever being attached
//                     to a token by similarity.

// VERSIONS. Each version is one dated review with one seven-day window. A later
// version only ADDS records: it never edits an earlier one. A subject may carry
// records in several versions; the assertion in force at a given instant is the
// one whose window contains it, and a non-mapping is read as of the newest
// probe made by then. The version 1 constants keep their original names so every
// replay and test that names them still means exactly what it meant.
export const ALIAS_REVIEWED_AT = '2026-09-16T14:30:00.000Z'
export const ALIAS_REVIEW_EXPIRES = '2026-09-23T14:30:00.000Z'
export const ALIAS_REVIEW_WINDOW_MS = 7 * 86_400_000
export const ALIAS_VERSION = 'rwa-issuer-alias-1'
/** Version 2, dated when its last source was read (2026-09-16 20:46:51 UTC).
 * Evidence: docs/investor-intel/evidence/rwa-issuer-alias-2-20260916.md. It
 * adds the OUSG mapping, re-probes all five version 1 non-mappings and records
 * one new one (USDY). It does NOT restate USTB or BUIDL, which were not re-read,
 * so those two still expire with version 1. */
export const ALIAS_V2_REVIEWED_AT = '2026-09-16T20:47:00.000Z'
export const ALIAS_V2_REVIEW_EXPIRES = '2026-09-23T20:47:00.000Z'
export const ALIAS_V2_VERSION = 'rwa-issuer-alias-2'
/** Who asserted every mapping in this version, recorded so a reader can ask. */
export const ALIAS_REVIEWER = 'investor-intel-editorial'

export interface AliasVersion { version: string; reviewedAt: string; expiresAt: string; evidenceFile: string }

/** Every review, oldest first. A record naming a version not listed here, or
 * dated differently from its version, is a structural problem. */
export const ALIAS_VERSIONS: readonly AliasVersion[] = [
  { version: ALIAS_VERSION, reviewedAt: ALIAS_REVIEWED_AT, expiresAt: ALIAS_REVIEW_EXPIRES, evidenceFile: 'docs/investor-intel/evidence/rwa-issuer-alias-1-20260916.md' },
  { version: ALIAS_V2_VERSION, reviewedAt: ALIAS_V2_REVIEWED_AT, expiresAt: ALIAS_V2_REVIEW_EXPIRES, evidenceFile: 'docs/investor-intel/evidence/rwa-issuer-alias-2-20260916.md' },
]

/** What was actually compared to justify a mapping. There is no 'similar_name'
 * member, and there never may be. */
export type AliasBasis =
  /** The register's legalName is byte-identical to the name we searched. */
  | 'exact_legal_name_match'
  /** The filer name on EDGAR matches the token's on-chain name, allowing only
   * a trailing legal-form suffix or series clause. Stated per assertion. */
  | 'filing_entity_name_match'
  /** The issuer's own published document names the legal entity AND publishes
   * the token contract, and the register holds exactly one entity of that name. */
  | 'issuer_published_identifier'

export interface EntityRef {
  lei?: string | null
  cik?: string | null
  /** The name AS THE REGISTER PUBLISHES IT, never the CoinMarketCap string. */
  legalName: string
  jurisdiction?: string | null
  /** Register status as read on the probe date. Re-read live before display;
   * this copy exists so a reviewer can see what was true when asserted. */
  registrationStatus?: string | null
  sourceUrl: string
}

export interface AliasAssertion {
  /** 'token:<caip-like>' or 'cmc-issuer:<id>'. Never a name. */
  subject: string
  subjectLabel: string
  entity: EntityRef
  basis: AliasBasis
  /** Exactly what was compared, in words a reviewer can re-run. */
  evidence: string
  assertedBy: string
  assertedAt: string
  expiresAt: string
  version: string
}

export interface UnmappedRecord {
  subject: string
  subjectLabel: string
  /** Short machine-readable cause. */
  reason: 'no_register_record' | 'name_not_an_identifier' | 'legal_form_mismatch' | 'issuer_changed_over_time'
  /** The reproduced probe that stopped the mapping. */
  evidence: string
  probedAt: string
  sourceUrl: string
  version: string
}

export interface NameCollision {
  /** The mapped subject whose filer name contains the shared stem. */
  relatedSubject: string
  stem: string
  entities: EntityRef[]
  note: string
  probedAt: string
  version: string
}

const review = { assertedBy: ALIAS_REVIEWER, assertedAt: ALIAS_REVIEWED_AT, expiresAt: ALIAS_REVIEW_EXPIRES, version: ALIAS_VERSION }
const reviewV2 = { assertedBy: ALIAS_REVIEWER, assertedAt: ALIAS_V2_REVIEWED_AT, expiresAt: ALIAS_V2_REVIEW_EXPIRES, version: ALIAS_V2_VERSION }

/**
 * Subject IS this legal entity.
 *
 * Only two mappings are asserted in this version, both from a TOKEN CONTRACT to
 * an SEC filer. A token contract is a precise identifier and its on-chain name
 * is readable, so the comparison is checkable. Mapping from a CoinMarketCap
 * issuer STRING was attempted and abandoned: see UNMAPPED below.
 */
export const ALIAS_ASSERTIONS: readonly AliasAssertion[] = [
  {
    subject: 'token:eip155:1:0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e',
    subjectLabel: 'USTB',
    entity: {
      cik: '0002004367',
      legalName: 'Invesco Short Duration US Government Securities Fund, a separate series of Superstate Asset Trust',
      jurisdiction: 'DE',
      sourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0002004367&type=D&dateb=&owner=include&count=40',
    },
    basis: 'filing_entity_name_match',
    evidence:
      'Probed 2026-09-16. The token at this contract reports its on-chain name as "Invesco Short Duration US Government Securities Fund" (symbol USTB). EDGAR filer CIK 0002004367 is named "Invesco Short Duration US Government Securities Fund, a separate series of Superstate Asset Trust". The on-chain name is the exact leading portion of the filer name, the remainder being the series clause. EDGAR formerNames additionally records the filer as "Superstate Short Duration US Government Securities Fund, a series of Superstate Asset Trust" from 2024-01-02 to 2026-07-07, which is why this mapping is made to a CIK and not to a name.',
    ...review,
  },
  {
    subject: 'token:eip155:1:0x7712c34205737192402172409a8f7ccef8aa2aec',
    subjectLabel: 'BUIDL',
    entity: {
      cik: '0002013810',
      legalName: 'BlackRock USD Institutional Digital Liquidity Fund Ltd.',
      jurisdiction: 'VIRGIN ISLANDS, BRITISH',
      sourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0002013810&type=D&dateb=&owner=include&count=40',
    },
    basis: 'filing_entity_name_match',
    evidence:
      'Probed 2026-09-16. The token at this contract reports its on-chain name as "BlackRock USD Institutional Digital Liquidity Fund" (symbol BUIDL). EDGAR filer CIK 0002013810 is named "BlackRock USD Institutional Digital Liquidity Fund Ltd.", differing only by the trailing legal-form suffix "Ltd.". That filer has no formerNames. Its Form D reports jurisdiction of incorporation VIRGIN ISLANDS, BRITISH.',
    ...review,
  },
  // ── rwa-issuer-alias-2 ──────────────────────────────────────────────────────
  {
    subject: 'token:eip155:1:0x1b19c19393e2d034d8ff31ff34c81252fcbbee92',
    subjectLabel: 'OUSG',
    entity: {
      cik: '0001957431',
      legalName: 'Ondo I LP',
      jurisdiction: 'DE',
      sourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001957431&type=D&dateb=&owner=include&count=40',
    },
    basis: 'issuer_published_identifier',
    evidence:
      'Probed 2026-09-16 between 20:39 and 20:43 UTC. The issuer\'s OUSG regulatory compliance page (docs.ondo.finance/qualified-access-products/ousg/regulatory-compliance) names "The issuer of OUSG, Ondo I LP" and says OUSG is sold under Rule 506(c) of Regulation D. The issuer\'s published contract list (docs.ondo.finance/addresses) gives the Ethereum OUSG token as 0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92, which Blockscout reads as "Ondo Short-Term U.S. Government Bond Fund" (symbol OUSG, an eip1967 proxy). EDGAR company lookup for "Ondo" returns exactly one filer named "Ondo I LP": CIK 0001957431, Delaware, no formerNames, four Form D filings from 2023-01-11 to 2026-01-20, the newest claiming exemptions 06c (Rule 506(c)), 3C and 3C.7. GLEIF filter[entity.legalName]=Ondo I LP returned 0 records, so the mapping is to the CIK. Only the Ethereum contract was read on chain; the Polygon, Solana and XRP Ledger representations are not asserted.',
    ...reviewV2,
  },
]

/**
 * Register records we read and can quote.
 *
 * Presence here is NOT a mapping. These exist so the legitimacy view can quote
 * a register accurately when something resolves to one, and so a reviewer can
 * see the lapsed registrations that motivated the feature.
 */
export const VERIFIED_ENTITIES: readonly EntityRef[] = [
  { cik: '0002004367', legalName: 'Invesco Short Duration US Government Securities Fund, a separate series of Superstate Asset Trust', jurisdiction: 'DE', sourceUrl: 'https://data.sec.gov/submissions/CIK0002004367.json' },
  { cik: '0002013810', legalName: 'BlackRock USD Institutional Digital Liquidity Fund Ltd.', jurisdiction: 'VIRGIN ISLANDS, BRITISH', sourceUrl: 'https://data.sec.gov/submissions/CIK0002013810.json' },
  // Carried in version 1 for its admission time series only, when it was NOT
  // asserted to issue any tokenised product. Version 2 asserts the Ethereum OUSG
  // contract to it on the issuer's own published statement; see ALIAS_ASSERTIONS.
  // Ondo I LP and Ondo Finance Inc. remain separate Delaware filers (CIK
  // 0001957431 and 0001949480).
  { cik: '0001957431', legalName: 'Ondo I LP', jurisdiction: 'DE', sourceUrl: 'https://data.sec.gov/submissions/CIK0001957431.json' },
  { lei: '254900RYEZ47C0C0YO93', legalName: 'SUPERSTATE INC.', jurisdiction: 'US-DE', registrationStatus: 'ISSUED', sourceUrl: 'https://search.gleif.org/#/record/254900RYEZ47C0C0YO93' },
  { lei: '2549003P4H6K2FQ3UV85', legalName: 'Superstate Limited', jurisdiction: 'VG', registrationStatus: 'LAPSED', sourceUrl: 'https://search.gleif.org/#/record/2549003P4H6K2FQ3UV85' },
  { lei: '254900AG86JY01ULWX64', legalName: 'Hashnote Master Fund LP', jurisdiction: 'KY', registrationStatus: 'LAPSED', sourceUrl: 'https://search.gleif.org/#/record/254900AG86JY01ULWX64' },
  { lei: '529900VBK42Y5HHRMD23', legalName: 'BlackRock, Inc.', jurisdiction: 'US-DE', registrationStatus: 'ISSUED', sourceUrl: 'https://search.gleif.org/#/record/529900VBK42Y5HHRMD23' },
  { lei: '549300EQW4J4RXDLD359', legalName: 'Paxos Trust Company, LLC', jurisdiction: 'US-NY', registrationStatus: 'ISSUED', sourceUrl: 'https://search.gleif.org/#/record/549300EQW4J4RXDLD359' },
  { lei: '254900THYWS8K2PQL620', legalName: 'PAXOS HOLDINGS LLC', jurisdiction: 'US-DE', registrationStatus: 'ISSUED', sourceUrl: 'https://search.gleif.org/#/record/254900THYWS8K2PQL620' },
  // Read in version 2. Neither is mapped to any subject: see UNMAPPED.
  { lei: '984500Z0Q6A5E8BE2B61', legalName: 'Ondo Global Markets (BVI) Limited', jurisdiction: 'VG', registrationStatus: 'ISSUED', sourceUrl: 'https://search.gleif.org/#/record/984500Z0Q6A5E8BE2B61' },
  { lei: '2549009GCAXB65G4OZ82', legalName: 'TETHER HOLDINGS, SOCIEDAD ANONIMA DE CAPITAL VARIABLE', jurisdiction: 'SV', registrationStatus: 'ISSUED', sourceUrl: 'https://search.gleif.org/#/record/2549009GCAXB65G4OZ82' },
]

/**
 * Deliberate non-mappings, each with the probe that stopped it.
 *
 * These are a FEATURE. "We do not know" is a publishable answer; a wrong legal
 * entity is not. The CoinMarketCap issuer identifiers are the ones already
 * reviewed in rwa-issuer-evidence.ts.
 */
export const UNMAPPED: readonly UnmappedRecord[] = [
  {
    subject: 'cmc-issuer:688ca4ccabae9b5b9fb3167a',
    subjectLabel: 'Ondo',
    reason: 'name_not_an_identifier',
    evidence:
      'GLEIF holds no entity under this name. filter[entity.legalName]=Ondo Finance returned 0 records; filter[entity.legalName]=Ondo Finance, Inc. returned 76,773 records whose top hits were "INC Group Inc." (CA) and "INC" (FR); filter[fulltext]=Ondo returned 17 unrelated records including SARL MOGABURE (FR) and AUTOBUSES LA GUIPUZCOANA SL (ES). EDGAR does hold Ondo Finance Inc. (CIK 0001949480) and Ondo I LP (CIK 0001957431), which are separate Delaware filers; neither has been shown to issue the CoinMarketCap-listed token, so neither is asserted.',
    probedAt: ALIAS_REVIEWED_AT,
    sourceUrl: 'https://api.gleif.org/api/v1/lei-records',
    version: ALIAS_VERSION,
  },
  {
    subject: 'cmc-issuer:68904c24abae9b5b9fb35815',
    subjectLabel: 'Paxos',
    reason: 'legal_form_mismatch',
    evidence:
      'The PAX Gold terms name the issuer "Paxos Trust Company, NA". GLEIF holds no entity under that name: filter[fulltext]=Paxos Trust returned exactly two records, "Paxos Trust Company, LLC" (US-NY, ISSUED) and "PAXOS HOLDINGS LLC" (US-DE, ISSUED). A national association and a limited liability company are different legal forms, and this review did not establish that the LLC record is the entity named in the terms. Mapping the issuer string to the LLC would assert an identity the sources do not support.',
    probedAt: ALIAS_REVIEWED_AT,
    sourceUrl: 'https://www.paxos.com/terms-and-conditions/pax-gold-terms-conditions',
    version: ALIAS_VERSION,
  },
  {
    subject: 'cmc-issuer:68904e9cabae9b5b9fb358ac',
    subjectLabel: 'Tether Holdings',
    reason: 'no_register_record',
    evidence: 'GLEIF filter[entity.legalName]=TG Commodities Limited, the entity named in the Tether Gold fee schedule, returned 0 records. No LEI was found and none is asserted.',
    probedAt: ALIAS_REVIEWED_AT,
    sourceUrl: 'https://api.gleif.org/api/v1/lei-records',
    version: ALIAS_VERSION,
  },
  {
    subject: 'cmc-issuer:68905a7babae9b5b9fb35a8d',
    subjectLabel: 'Matrixdock',
    reason: 'no_register_record',
    evidence: 'GLEIF filter[entity.legalName]=Matrixdock returned 0 records. No LEI was found and none is asserted.',
    probedAt: ALIAS_REVIEWED_AT,
    sourceUrl: 'https://api.gleif.org/api/v1/lei-records',
    version: ALIAS_VERSION,
  },
  {
    subject: 'cmc-issuer:68904cceabae9b5b9fb35839',
    subjectLabel: 'Comtech Gold',
    reason: 'no_register_record',
    evidence: 'GLEIF filter[entity.legalName]=Comtech Gold returned 0 records. No LEI was found and none is asserted.',
    probedAt: ALIAS_REVIEWED_AT,
    sourceUrl: 'https://api.gleif.org/api/v1/lei-records',
    version: ALIAS_VERSION,
  },
  // ── rwa-issuer-alias-2: every version 1 refusal re-probed, plus USDY ────────
  {
    subject: 'cmc-issuer:688ca4ccabae9b5b9fb3167a',
    subjectLabel: 'Ondo',
    reason: 'name_not_an_identifier',
    evidence:
      'Re-probed 2026-09-16. The issuer string "Ondo" spans products that the issuer\'s own documentation attributes to different legal entities: Ondo Global Markets (BVI) Limited issues Ondo tokenized stocks, which is what CoinMarketCap lists under this issuer, while Ondo I LP issues OUSG. GLEIF now holds Ondo Global Markets (BVI) Limited, LEI 984500Z0Q6A5E8BE2B61 (VG, ISSUED, first registered 2025-10-27), and filter[entity.legalName]=Ondo Finance Inc. returned 0 records. The issuer publishes per-token contract addresses for its tokenized stocks only through a keyed API, so no token contract could be tied to that LEI from a free published source. A string that names several issuers is not an identifier, so nothing is asserted for it.',
    probedAt: ALIAS_V2_REVIEWED_AT,
    sourceUrl: 'https://docs.ondo.finance/ondo-stocks/legal-and-regulatory',
    version: ALIAS_V2_VERSION,
  },
  {
    subject: 'cmc-issuer:68904c24abae9b5b9fb35815',
    subjectLabel: 'Paxos',
    reason: 'legal_form_mismatch',
    evidence:
      'Re-probed 2026-09-16. The PAX Gold terms still name the issuer "Paxos Trust Company, NA". GLEIF filter[fulltext]=Paxos returned 11 records and none is a national association; the only trust company is "Paxos Trust Company, LLC" (LEI 549300EQW4J4RXDLD359, US-NY, ISSUED, last updated 2026-04-30), whose only recorded previous legal name is "itBit Trust Company, LLC". filter[entity.legalName]=Paxos Trust Company, National Association returned 486 records led by that same LLC and by unrelated banks. A national association and a limited liability company are different legal forms, and the register does not record the LLC as having become the national association, so no mapping is made.',
    probedAt: ALIAS_V2_REVIEWED_AT,
    sourceUrl: 'https://www.paxos.com/terms-and-conditions/pax-gold-terms-conditions',
    version: ALIAS_V2_VERSION,
  },
  {
    subject: 'cmc-issuer:68904e9cabae9b5b9fb358ac',
    subjectLabel: 'Tether Holdings',
    reason: 'no_register_record',
    evidence:
      'Re-probed 2026-09-16. GLEIF filter[entity.legalName]=TG Commodities Limited returned 0 records and filter[fulltext]=TG Commodities returned 0 records. GLEIF does hold TETHER HOLDINGS, SOCIEDAD ANONIMA DE CAPITAL VARIABLE (LEI 2549009GCAXB65G4OZ82, SV, ISSUED, other name "Tether Holdings Limited"), but the Tether Gold fee schedule, as read for version 1, named TG Commodities Limited, and the issuer\'s legal pages render only with JavaScript, so they could not be re-read in this review. A group holding company is not the token issuer by default, so the CoinMarketCap issuer label is not mapped to it.',
    probedAt: ALIAS_V2_REVIEWED_AT,
    sourceUrl: 'https://api.gleif.org/api/v1/lei-records',
    version: ALIAS_V2_VERSION,
  },
  {
    subject: 'cmc-issuer:68905a7babae9b5b9fb35a8d',
    subjectLabel: 'Matrixdock',
    reason: 'no_register_record',
    evidence:
      'Re-probed 2026-09-16. GLEIF filter[fulltext]=Matrixdock returned 0 records and filter[entity.legalName]=Matrixdock Pte. Ltd. returned 0 records; filter[fulltext]=Matrix Dock returned one unrelated record, THE MATRIX MODEL GROUP (UK) LIMITED. The issuer documentation lists a Hong Kong precious metals dealer registration held by MATRIX INFINITUS (HONG KONG) LIMITED but does not say that company issues XAUm, and filter[fulltext]=Matrix Infinitus returned 0 records. No LEI was found and none is asserted.',
    probedAt: ALIAS_V2_REVIEWED_AT,
    sourceUrl: 'https://matrixdock.gitbook.io/matrixdock-docs/english/gold-token-xaum/licenses-and-certificates',
    version: ALIAS_V2_VERSION,
  },
  {
    subject: 'cmc-issuer:68904cceabae9b5b9fb35839',
    subjectLabel: 'Comtech Gold',
    reason: 'no_register_record',
    evidence:
      'Re-probed 2026-09-16. The issuer terms name the digitization entity as "[Comtech FZCO]", in square brackets and with its registration number left blank, registered in the Dubai Airport Free Zone. GLEIF filter[fulltext]=Comtech FZCO returned 0 records and filter[fulltext]=Comtech Gold returned 0 records. No LEI was found and none is asserted.',
    probedAt: ALIAS_V2_REVIEWED_AT,
    sourceUrl: 'https://comtechgold.com/assets/pdf/Terms_and_Conditions.pdf',
    version: ALIAS_V2_VERSION,
  },
  {
    subject: 'token:eip155:1:0x96f6ef951840721adbf46ac996b59e0235cb985c',
    subjectLabel: 'USDY',
    reason: 'issuer_changed_over_time',
    evidence:
      'Probed 2026-09-16. The issuer publishes this contract as the Ethereum USDY token (Blockscout name "Ondo US Dollar Yield", symbol USDY), and its important notes page says USDY tokens are issued by Ondo Global Markets (BVI) Limited, which GLEIF holds as LEI 984500Z0Q6A5E8BE2B61. The same documentation also says USDY was formerly issued by Ondo USDY LLC, folded into Ondo Global Markets as of 2025-12-15, that its collateral depends on the issuance date, and it still names Ondo USDY LLC for USD redemptions. One contract therefore carries notes from two issuers over time, and GLEIF filter[entity.legalName]=Ondo USDY LLC returned 0 records. Mapping the contract to either entity would be wrong for some holders, so nothing is asserted.',
    probedAt: ALIAS_V2_REVIEWED_AT,
    sourceUrl: 'https://docs.ondo.finance/general-access-products/usdy/basics',
    version: ALIAS_V2_VERSION,
  },
]

/**
 * Register records that share a name stem with a mapped filer.
 *
 * Surfaced for HUMAN REVIEW, never joined to a token. This is how a lapsed
 * registration becomes visible without being attached to a product by
 * similarity, which is exactly the mistake this module refuses to make.
 */
export const NAME_COLLISIONS: readonly NameCollision[] = [
  {
    relatedSubject: 'token:eip155:1:0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e',
    stem: 'Superstate',
    entities: [
      { lei: '254900RYEZ47C0C0YO93', legalName: 'SUPERSTATE INC.', jurisdiction: 'US-DE', registrationStatus: 'ISSUED', sourceUrl: 'https://search.gleif.org/#/record/254900RYEZ47C0C0YO93' },
      { lei: '2549003P4H6K2FQ3UV85', legalName: 'Superstate Limited', jurisdiction: 'VG', registrationStatus: 'LAPSED', sourceUrl: 'https://search.gleif.org/#/record/2549003P4H6K2FQ3UV85' },
    ],
    note:
      'The EDGAR filer name for this token contains "Superstate Asset Trust". GLEIF holds two entities whose legal names begin with "Superstate": one US Delaware record with an ISSUED registration and one British Virgin Islands record whose registration is LAPSED. NEITHER has been shown to be the sponsor of this trust, and neither is asserted to be. They are listed so a reviewer can check the relationship at the register; a shared name stem is not a relationship.',
    probedAt: ALIAS_REVIEWED_AT,
    version: ALIAS_VERSION,
  },
]

const normalizeSubject = (value: unknown): string => String(value ?? '').trim().toLowerCase()

const inWindow = (a: AliasAssertion, at: number): boolean => at >= Date.parse(a.assertedAt) && at < Date.parse(a.expiresAt)

/** The mapping for a subject, or null. Exact subject equality only.
 *
 * Several versions may assert the same subject. The one returned is the newest
 * assertion whose window contains `at`; no window containing it means no
 * mapping. */
export function resolveAlias(subject: unknown, at: number = Date.parse(ALIAS_REVIEWED_AT)): AliasAssertion | null {
  const key = normalizeSubject(subject)
  if (!key) return null
  // An expired assertion is not a mapping. It keeps its words for replay, but
  // it stops resolving until a later version restates it.
  const current = ALIAS_ASSERTIONS
    .filter((a) => normalizeSubject(a.subject) === key && inWindow(a, at))
    .sort((a, b) => Date.parse(b.assertedAt) - Date.parse(a.assertedAt))
  return current[0] ?? null
}

/**
 * One assertion per subject that had been asserted by `at`: the one in force,
 * or, when none is, the most recently asserted one (which is then expired).
 * A subject first asserted AFTER `at` is absent: a replay must not show a
 * mapping that did not exist yet. Ordered by first assertion, so earlier
 * subjects keep their place.
 */
export function assertionsAsOf(at: number): AliasAssertion[] {
  const out = new Map<string, AliasAssertion>()
  const asserted = ALIAS_ASSERTIONS.filter((a) => Date.parse(a.assertedAt) <= at)
  for (const a of asserted) {
    const key = normalizeSubject(a.subject)
    if (!out.has(key)) out.set(key, resolveAlias(key, at) ?? asserted.filter((b) => normalizeSubject(b.subject) === key).at(-1)!)
  }
  return [...out.values()]
}

/** The assertions in force at `at`, one per subject. This is what a capture
 * lane may act on: an expired assertion no longer identifies anyone. */
export const currentAssertions = (at: number): AliasAssertion[] => assertionsAsOf(at).filter((a) => inWindow(a, at))

/** A deliberate non-mapping, if one was recorded for this subject by `at`: the
 * newest probe made by then. */
export function unmappedRecord(subject: unknown, at: number = Date.parse(ALIAS_REVIEWED_AT)): UnmappedRecord | null {
  const key = normalizeSubject(subject)
  const found = UNMAPPED
    .filter((u) => normalizeSubject(u.subject) === key && Date.parse(u.probedAt) <= at)
    .sort((a, b) => Date.parse(b.probedAt) - Date.parse(a.probedAt))
  return found[0] ?? null
}

/** Every deliberate non-mapping as of `at`, newest probe per subject, in the
 * order the subjects were first recorded. A subject mapped at `at` is left out:
 * it is a mapping now, and its earlier refusal is history. */
export function unmappedAsOf(at: number): UnmappedRecord[] {
  const keys = [...new Set(UNMAPPED.filter((u) => Date.parse(u.probedAt) <= at).map((u) => normalizeSubject(u.subject)))]
  return keys
    .filter((key) => !resolveAlias(key, at))
    .map((key) => unmappedRecord(key, at))
    .filter((u): u is UnmappedRecord => !!u)
}

export type AliasState = 'mapped' | 'deliberately_unmapped' | 'expired' | 'unknown'

/**
 * What we are willing to say about this subject's legal identity.
 *
 * 'unknown' means nobody has reviewed it. 'deliberately_unmapped' means somebody
 * did and the sources did not support a mapping. The two must never be
 * collapsed: the second is a finding.
 */
export function aliasState(subject: unknown, at: number = Date.parse(ALIAS_REVIEWED_AT)): AliasState {
  const key = normalizeSubject(subject)
  if (!key) return 'unknown'
  if (resolveAlias(key, at)) return 'mapped'
  if (ALIAS_ASSERTIONS.some((a) => normalizeSubject(a.subject) === key)) return 'expired'
  if (unmappedRecord(key, at)) return 'deliberately_unmapped'
  return 'unknown'
}

/** Name collisions recorded against a mapped subject. */
export const collisionsFor = (subject: unknown): NameCollision[] => {
  const key = normalizeSubject(subject)
  return NAME_COLLISIONS.filter((c) => normalizeSubject(c.relatedSubject) === key)
}

const LEI = /^[0-9A-Z]{18}[0-9]{2}$/
const CIK = /^[0-9]{10}$/

/**
 * Structural problems in the map, for the test to assert is empty.
 *
 * This is the guard that keeps a future edit honest: a subject asserted twice at
 * the same time, a malformed identifier, a review window that is not seven days,
 * a record whose dates are not its version's, a subject asserted and recorded as
 * unmapped at the same instant, or a record with no evidence.
 */
export function aliasProblems(): string[] {
  const problems: string[] = []
  const versions = new Map(ALIAS_VERSIONS.map((v) => [v.version, v]))
  ALIAS_VERSIONS.forEach((v, i) => {
    if (Date.parse(v.expiresAt) - Date.parse(v.reviewedAt) !== ALIAS_REVIEW_WINDOW_MS) problems.push(`${v.version}: review window must be seven days`)
    if (i > 0 && Date.parse(v.reviewedAt) <= Date.parse(ALIAS_VERSIONS[i - 1].reviewedAt)) problems.push(`${v.version}: must be reviewed after the version before it`)
  })
  for (const a of ALIAS_ASSERTIONS) {
    const key = normalizeSubject(a.subject)
    // A later version may restate a subject; nothing may assert it twice at once.
    const overlapping = ALIAS_ASSERTIONS.some((b) => b !== a && normalizeSubject(b.subject) === key
      && Date.parse(b.assertedAt) < Date.parse(a.expiresAt) && Date.parse(a.assertedAt) < Date.parse(b.expiresAt))
    if (overlapping) problems.push(`${a.subject}: asserted more than once`)
    const version = versions.get(a.version)
    if (!version) problems.push(`${a.subject}: unknown version ${a.version}`)
    else if (version.reviewedAt !== a.assertedAt || version.expiresAt !== a.expiresAt) problems.push(`${a.subject}: dates differ from ${a.version}`)
    if (!a.entity.lei && !a.entity.cik) problems.push(`${a.subject}: mapping carries no identifier`)
    if (a.entity.lei && !LEI.test(a.entity.lei)) problems.push(`${a.subject}: malformed LEI`)
    if (a.entity.cik && !CIK.test(a.entity.cik)) problems.push(`${a.subject}: malformed CIK`)
    if (!a.entity.sourceUrl.startsWith('https://')) problems.push(`${a.subject}: mapping has no https source`)
    // An assertion with no stated comparison is unreviewable, which defeats the
    // entire point of the map.
    if (a.evidence.trim().length < 60) problems.push(`${a.subject}: evidence is too thin to review`)
    if (!a.assertedBy.trim()) problems.push(`${a.subject}: no asserter recorded`)
    if (Date.parse(a.expiresAt) - Date.parse(a.assertedAt) !== ALIAS_REVIEW_WINDOW_MS) problems.push(`${a.subject}: review window must be seven days`)
  }
  for (const u of UNMAPPED) {
    const key = normalizeSubject(u.subject)
    const probed = Date.parse(u.probedAt)
    if (ALIAS_ASSERTIONS.some((a) => normalizeSubject(a.subject) === key && inWindow(a, probed))) problems.push(`${u.subject}: recorded as both mapped and unmapped`)
    if (UNMAPPED.some((o) => o !== u && normalizeSubject(o.subject) === key && o.version === u.version)) problems.push(`${u.subject}: recorded as unmapped twice in ${u.version}`)
    const version = versions.get(u.version)
    if (!version) problems.push(`${u.subject}: unknown version ${u.version}`)
    else if (version.reviewedAt !== u.probedAt) problems.push(`${u.subject}: probe date differs from ${u.version}`)
    if (u.evidence.trim().length < 60) problems.push(`${u.subject}: non-mapping needs the probe that stopped it`)
  }
  for (const e of VERIFIED_ENTITIES) {
    if (e.lei && !LEI.test(e.lei)) problems.push(`${e.legalName}: malformed LEI`)
    if (e.cik && !CIK.test(e.cik)) problems.push(`${e.legalName}: malformed CIK`)
  }
  for (const c of NAME_COLLISIONS) {
    if (!ALIAS_ASSERTIONS.some((a) => normalizeSubject(a.subject) === normalizeSubject(c.relatedSubject))) {
      problems.push(`${c.stem}: collision recorded against an unmapped subject`)
    }
  }
  return problems
}
