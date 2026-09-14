import {assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {chartSeriesResponse} from './chart-series-contract.ts'
const t=Date.parse('2026-09-10T00:00:00Z'),candles=[{t,o:10,h:12,l:9,c:11,v:null},{t:t+14400000,o:11,h:13,l:10,c:12,v:null}]
Deno.test('CoinGecko close timestamps survive normalization; requested 1d never changes actual 4h spacing',()=>{const r=chartSeriesResponse({source:'coingecko',timeframe:'1D',candles},t+18000000);eq(r.candles[0].t,t);eq(r.candles[0].closedAt,t);eq(r.source.intervalMs,14400000);eq(r.source.timestampMeaning,'close');eq(r.candles[0].v,null)})
Deno.test('unknown OHLC timestamp meaning is not fabricated from spacing',()=>{const r=chartSeriesResponse({source:'unknown',candles},t+18000000);eq(r.source.timestampMeaning,'unknown');eq(r.candles[0].closedAt,undefined)})
Deno.test('close-only observations stay close-only and missing prices remain absent',()=>{const r=chartSeriesResponse({source:'coingecko',candles:[{t,price:11},{t:t+1000,price:null}]});eq(r.candles.length,1);eq(r.candles[0].o,null);eq(r.source.timestampMeaning,'observation');eq(r.source.intervalMs,null)})
