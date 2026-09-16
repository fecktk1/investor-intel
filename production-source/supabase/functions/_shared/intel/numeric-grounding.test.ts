import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  extractFigures, evidenceNumbers, checkNumericGrounding, groundOrRefuse, groundingRefusal,
  groundingRetryInstruction, NUMERIC_GROUNDING_RULE,
} from './numeric-grounding.ts'

const figures = (text: string) => extractFigures(text).map((f) => [f.kind, f.value])

Deno.test('percentages, currency, multiples and counts are extracted with their magnitudes', () => {
  eq(figures('SOL rose 12.5% while volume hit $1.2B.'), [['percent', 12.5], ['currency', 1.2e9]])
  eq(figures('TVL fell -8 percent to $450,000 and 3.5x the average.'), [['percent', 8], ['currency', 450000], ['multiplier', 3.5]])
  eq(figures('Holders reached 12,400 holders and 1.5 million transfers.'), [['count', 12400], ['count', 1.5e6]])
  eq(figures('Supply is 21 million with 2.4bn USD locked, a €300k grant and 45 bps of fees.'), [['count', 21e6], ['currency', 2.4e9], ['currency', 300e3], ['percent', 45]])
})

Deno.test('dates, years, times, ordinals, windows, citations and identifiers are not figures', () => {
  eq(figures('On 2026-09-16 at 14:30 UTC, in Q3 2026 and on 9/16/2026, the 3rd listing [E12] on Layer 2 moved.'), [])
  eq(figures('Over the last 24h, the 7-day and the 30 days window, and in 2025, nothing was quoted.'), [])
  eq(figures('ERC-20 and BEP-20 tokens on L2 v3 with Web3 and address 0xabcdef1234567890 ranked top 10, #5 and rank 3.'), [])
  eq(figures('The first, second and third risks, and three exchanges, and 3 risks, 2 exchanges and 9 wallets.'), [])
  eq(figures('A bare 42 or 7.5 without a unit is a label, not a claim.'), [])
})

Deno.test('a range is two figures that share the unit written after it', () => {
  eq(figures('Funding ranged 10-15% and later 20 to 25%.'), [['percent', 10], ['percent', 15], ['percent', 20], ['percent', 25]])
  eq(figures('Valued at $1-2B.'), [['currency', 1e9], ['currency', 2e9]])
  eq(figures('Between 2x and 3x.'), [['multiplier', 2], ['multiplier', 3]])
})

Deno.test('rounding to the written precision grounds, and a different number does not', () => {
  const evidence = { price_change_24h_pct: 12.4731, market_cap: 1_234_567_890, holders: 12391, ratio: 0.125, note: 'volume 3.2M' }
  eq(checkNumericGrounding('Up 12% on a $1.2B market cap.', evidence).ok, true, '12.47 rounds to 12; 1.23B rounds to 1.2B')
  eq(checkNumericGrounding('Up 12.5% with 12,400 holders.', evidence).ok, true, 'within 1% relative')
  eq(checkNumericGrounding('A 12.5% share and $3.2M volume.', evidence).ok, true, 'a fraction equals its percentage; string evidence counts')
  eq(checkNumericGrounding('Down 12.47%.', { change: -12.4731 }).ok, true, 'sign is ignored')
  eq(checkNumericGrounding('A 45 bps fee.', { fee: 0.0045 }).ok, true, 'basis points equal their fraction')
  const bad = checkNumericGrounding('Up 14% on a $1.5B market cap and 5x volume.', evidence)
  eq(bad.ok, false)
  eq(bad.ungrounded.map((f) => f.raw), ['14%', '$1.5B', '5x'])
  eq(checkNumericGrounding('The 2026 roadmap for the 3rd quarter.', {}).checked, 0)
})

Deno.test('a computed figure is not in the evidence and does not ground', () => {
  // 110 from 100 is +10%, but only the two prices are evidence.
  eq(checkNumericGrounding('Price is up 10% on the day.', { open: 100, close: 110 }).ok, false)
})

Deno.test('evidence numbers come from JSON numbers and from numbers written inside strings', () => {
  const numbers = evidenceNumbers({ a: 5, b: ['TVL $2.5bn', { c: '-3.1%' }], d: null, e: true })
  assert(numbers.includes(5)); assert(numbers.includes(2.5)); assert(numbers.includes(2.5e9)); assert(numbers.includes(3.1))
})

Deno.test('ground or refuse: grounded output passes without regenerating', async () => {
  let calls = 0
  const r = await groundOrRefuse({ output: { summary: 'Up 5%.' }, textOf: (o) => o.summary, evidence: { pct: 5 }, regenerate: async () => { calls++; return null } })
  eq(r.status, 'grounded'); eq(calls, 0); eq(r.output, { summary: 'Up 5%.' })
})

Deno.test('ground or refuse: one regeneration names the figures and a grounded retry is used', async () => {
  const instructions: string[] = []
  const r = await groundOrRefuse({
    output: { summary: 'Up 9% to $4B.' }, textOf: (o) => o.summary, evidence: { pct: 5, cap: 4e9 },
    regenerate: async (instruction) => { instructions.push(instruction); return { summary: 'Up 5% to $4B.' } },
  })
  eq(r.status, 'regenerated'); eq(instructions.length, 1)
  assert(instructions[0].includes('9%')); assert(!instructions[0].includes('$4B'))
  eq(r.output, { summary: 'Up 5% to $4B.' })
})

Deno.test('ground or refuse: a second failure or a failed regeneration is a refusal with no output', async () => {
  let calls = 0
  const twice = await groundOrRefuse({ output: { s: 'Up 9%.' }, textOf: (o) => o.s, evidence: { pct: 5 }, regenerate: async () => { calls++; return { s: 'Up 7%.' } } })
  eq(twice.status, 'refused'); eq(twice.output, null); eq(twice.ungrounded, ['7%']); eq(calls, 1, 'exactly one bounded regeneration')
  const thrown = await groundOrRefuse({ output: { s: 'Up 9%.' }, textOf: (o) => o.s, evidence: {}, regenerate: async () => { throw new Error('provider down') } })
  eq(thrown.status, 'refused'); eq(thrown.output, null); eq(thrown.ungrounded, ['9%'])
})

Deno.test('the refusal states the failure and carries none of the ungrounded prose', () => {
  const refusal = groundingRefusal(['9%', '$4B'], { sources: ['Evidence pack'] })
  assert(refusal.summary.includes('could not be matched to the supplied evidence'))
  eq(refusal.grounding.status, 'refused')
  eq(refusal.sources, ['Evidence pack'])
  eq(refusal.net_signal, 'data_limited')
  const everything = refusal.summary + groundingRetryInstruction({ ok: false, checked: 1, ungrounded: [], tolerance: '' }) + NUMERIC_GROUNDING_RULE
  assert(!everything.includes('—'))
})
