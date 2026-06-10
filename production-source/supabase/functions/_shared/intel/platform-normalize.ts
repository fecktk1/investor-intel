// Investor Intel / Forge — canonical platform name normalization (pure).
//
// posts_normalized.platform is mixed-case across writers (CSV/publish: 'x'/
// 'instagram'/'facebook'; sync-social-analytics: 'X'/'IG'/'FB'; brand feeds:
// 'X'/'FB'/'IG'). This is the single canonical normalizer used by the Forge Says
// suppression filter so platform comparisons never miss on casing.

export type CanonicalPlatform = 'X' | 'IG' | 'FB' | 'UNKNOWN'

export function normalizePlatform(raw: unknown): CanonicalPlatform {
  switch (String(raw || '').trim().toLowerCase()) {
    case 'x': case 'twitter': case 'x.com': return 'X'
    case 'ig': case 'instagram': return 'IG'
    case 'fb': case 'facebook': case 'meta': return 'FB'
    default: return 'UNKNOWN'
  }
}

export const isX = (raw: unknown) => normalizePlatform(raw) === 'X'
