import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { normalizePlatform, isX } from './platform-normalize.ts'

Deno.test('normalizes all known platform casings', () => {
  for (const x of ['x', 'X', 'twitter', 'Twitter', 'x.com']) assertEquals(normalizePlatform(x), 'X')
  for (const ig of ['ig', 'IG', 'instagram', 'Instagram']) assertEquals(normalizePlatform(ig), 'IG')
  for (const fb of ['fb', 'FB', 'facebook', 'Facebook', 'meta']) assertEquals(normalizePlatform(fb), 'FB')
})

Deno.test('unknown / null → UNKNOWN; isX helper', () => {
  assertEquals(normalizePlatform('tiktok'), 'UNKNOWN')
  assertEquals(normalizePlatform(null), 'UNKNOWN')
  assertEquals(normalizePlatform(undefined), 'UNKNOWN')
  assertEquals(isX('TWITTER'), true)
  assertEquals(isX('instagram'), false)
})
