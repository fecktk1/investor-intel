import { assertEquals } from 'jsr:@std/assert@1'
import { NO_TIMER, phaseTimer, TIMING_HEADERS } from './server-timing.ts'

Deno.test('phases are timed on their own clock, overlap freely, and end with total', async () => {
  let now = 0
  const timer = phaseTimer(() => now)
  const a = timer.time('limit', async () => { now += 40; return 'a' })
  assertEquals(await a, 'a')
  await Promise.all([
    timer.time('resolve', async () => { now += 25 }),
    timer.time('quote', async () => { now += 10 }),
  ])
  timer.note('stored_answer', 12.4)
  assertEquals(timer.header(), 'limit;dur=40, resolve;dur=35, quote;dur=10, stored_answer;dur=12, total;dur=75')
})

Deno.test('a failing phase is still timed, and only fixed house names are ever written', async () => {
  let now = 0
  const timer = phaseTimer(() => now)
  await timer.time('read', async () => { now += 7; throw new Error('boom') }).catch(() => {})
  timer.note('Bad Name; dur=1', 5)
  timer.note('x'.repeat(60), 5)
  timer.note('nan', Number.NaN)
  assertEquals(timer.phases(), [['read', 7]])
  assertEquals(TIMING_HEADERS['Timing-Allow-Origin'], '*')
  assertEquals(await NO_TIMER.time('x', async () => 3), 3)
  assertEquals(NO_TIMER.header(), '')
})
