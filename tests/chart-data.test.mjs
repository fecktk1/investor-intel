import test from 'node:test'
import assert from 'node:assert/strict'
import { ohlcvBars } from '../src/chart-data.mjs'
import { candles } from '../src/fixtures.mjs'
const point=(quote)=>({time_close:'2026-09-10T23:59:59.999Z',quote})
const result=quotes=>({data:{rows:[{id:1027,quotes}]}})
test('OHLCV preserves close time, USD and missing volume without fabricated prices',()=>{
  const q={open:100,high:115,low:95,close:110,volume:null}
  const expected={t:Date.parse('2026-09-10T23:59:59.999Z'),closedAt:Date.parse('2026-09-10T23:59:59.999Z'),o:100,h:115,l:95,c:110,v:null,volumeKind:'period',volumeUnit:'USD'}
  for(const quote of [q,{USD:q},[{id:2781,...q}]])assert.deepEqual(ohlcvBars(result([point(quote)])),[expected])
  assert.deepEqual(ohlcvBars(result([point({EUR:q})])),[])
})
test('incomplete or invalid OHLCV is unavailable, not zero or inferred candle data',()=>{
  const q={open:100,high:115,low:95,close:110,volume:0}
  assert.equal(ohlcvBars(result([point(q)]))[0].v,0)
  for(const invalid of [{...q,open:null},{...q,low:101},{...q,high:99},{...q,close:0},{...q,open:''}])assert.deepEqual(ohlcvBars(result([point(invalid)])),[])
  assert.deepEqual(ohlcvBars(result([{...point(q),time_close:'invalid'}])),[])
})
test('offline synthetic candles have deterministic complete OHLCV on regular hourly timestamps',()=>{
  const bars=candles(Date.parse('2026-09-11T12:34:00Z'))
  assert.equal(bars.length,169)
  for(const [i,b] of bars.entries()){assert.ok(b.h>=Math.max(b.o,b.c));assert.ok(b.l<=Math.min(b.o,b.c));assert.ok(b.v>0);if(i)assert.equal(b.t-bars[i-1].t,3600000)}
  assert.deepEqual(bars,candles(Date.parse('2026-09-11T12:34:00Z')))
})
