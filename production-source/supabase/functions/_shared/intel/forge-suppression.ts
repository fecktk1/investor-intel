// Forge Says — deterministic self-post suppression (pure; no AI, no I/O).
//
// Prompt-only suppression is not enough: this is the deterministic FILTER that
// drops a recommendation EVEN IF the model produced it, when the org already
// covered the same topic/story/angle on the connected channel within the window.
// Reuses the Intelligence Core hashing + Jaccard so keys are consistent with the
// signal layer. Required categories are NEVER suppressed as a class — only
// already-covered individual recommendations are.

import { h32 } from '../core-intel/hashing.ts'
import { shingleSet, jaccard, normalizeQuestion } from '../core-intel/context-router.ts'

export const SUPPRESSION_REASONS = [
  'recent_org_post_match', 'duplicate_story_cluster', 'duplicate_angle',
  'duplicate_trend', 'duplicate_recommendation', 'low_material_difference',
] as const
export type SuppressionReason = typeof SUPPRESSION_REASONS[number]

export interface CandidateKeys { topicKey: string; angleHash: string; shingles: string[] }

/** Deterministic keys for a recommendation candidate from its topic + angle text. */
export function buildCandidateKeys(topic: string, angleText = ''): CandidateKeys {
  const topicNorm = normalizeQuestion(topic)
  const topicKey = h32(topicNorm)
  const angleNorm = normalizeQuestion(`${topic} ${angleText}`)
  return { topicKey, angleHash: h32(angleNorm), shingles: shingleSet(angleNorm) }
}

export interface SuppressionCandidate extends CandidateKeys {
  kind: string                 // viral_topic | post_angle | trend
  label: string
  assets?: string[]
  clusterId?: string | null
  isBreaking?: boolean         // major breaking update → allowed exception
  materiallyNew?: boolean      // materially new development → allowed exception
  isReply?: boolean            // reply/comment suggestion → allowed
  isThreadContinuation?: boolean
}

export interface RecentPost { platform: string; text: string; postedAt?: string | null; externalId?: string | null; clusterId?: string | null }

export interface SuppressionVerdict { suppressed: boolean; reason: SuppressionReason | null; matchedPostId: string | null; matchedAt: string | null }

export interface SuppressionOpts {
  xOnly?: boolean              // X is the only connected channel → stricter
  angleThreshold?: number      // default 0.7 (0.55 when xOnly)
  topicTokenOverlap?: number   // default 0.5 (0.4 when xOnly)
}

/** Decide whether a single candidate should be suppressed against recent owned
 *  posts on the SAME canonical platform. Allowed exceptions short-circuit. */
export function evaluateSuppression(candidate: SuppressionCandidate, recentPosts: RecentPost[], opts: SuppressionOpts = {}): SuppressionVerdict {
  const none: SuppressionVerdict = { suppressed: false, reason: null, matchedPostId: null, matchedAt: null }
  // Allowed exceptions (decision #13): never suppress these.
  if (candidate.isBreaking || candidate.materiallyNew || candidate.isReply || candidate.isThreadContinuation) return none
  if (!recentPosts?.length) return none

  const angleTh = opts.angleThreshold ?? (opts.xOnly ? 0.55 : 0.7)
  const tokTh = opts.topicTokenOverlap ?? (opts.xOnly ? 0.4 : 0.5)
  const candTokens = new Set(candidate.shingles.flatMap((s) => s.split(' ')))

  for (const p of recentPosts) {
    // 1) same canonical story cluster the org already posted about
    if (candidate.clusterId && p.clusterId && candidate.clusterId === p.clusterId) {
      return { suppressed: true, reason: 'duplicate_story_cluster', matchedPostId: p.externalId ?? null, matchedAt: p.postedAt ?? null }
    }
    const postShingles = shingleSet(p.text)
    // 2) angle near-duplicate (shingle Jaccard)
    if (jaccard(candidate.shingles, postShingles) >= angleTh) {
      return { suppressed: true, reason: 'duplicate_angle', matchedPostId: p.externalId ?? null, matchedAt: p.postedAt ?? null }
    }
    // 3) topic token overlap (covers paraphrases the model rewrote)
    const postTokens = new Set(normalizeQuestion(p.text).split(' '))
    let inter = 0
    for (const tk of candTokens) if (postTokens.has(tk)) inter++
    const overlap = candTokens.size ? inter / candTokens.size : 0
    if (overlap >= tokTh) {
      return { suppressed: true, reason: 'recent_org_post_match', matchedPostId: p.externalId ?? null, matchedAt: p.postedAt ?? null }
    }
  }
  return none
}

/** Within-batch recommendation dedupe (decision #14 recommendation/recent-output
 *  layers): drop later candidates that duplicate an earlier kept one by angle
 *  hash or high shingle overlap. Conservative — only near-identical angles. */
export function dedupeCandidates<T extends SuppressionCandidate>(candidates: T[]): { kept: T[]; dropped: Array<{ candidate: T; reason: SuppressionReason }> } {
  const kept: T[] = []
  const dropped: Array<{ candidate: T; reason: SuppressionReason }> = []
  for (const c of candidates) {
    let dup = false
    for (const k of kept) {
      if (c.angleHash === k.angleHash || jaccard(c.shingles, k.shingles) >= 0.8) { dup = true; break }
    }
    if (dup) dropped.push({ candidate: c, reason: 'duplicate_recommendation' })
    else kept.push(c)
  }
  return { kept, dropped }
}
