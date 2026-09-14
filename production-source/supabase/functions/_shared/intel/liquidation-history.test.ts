import {assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {liquidationHistory} from './liquidation-history.ts'
import type {Observation} from './investigation-evidence.ts'
const t=Date.parse('2026-09-10T12:00:00Z'),iso=(n:number)=>new Date(n).toISOString()
const o=(patch:Partial<Observation>={}):Observation=>({id:'one',subject:'market:coinmarketcap:1',metric:'liquidations_1h',value:100,unit:'USD',periodSeconds:3600,provider:'cmc',sourceRef:'synthetic',universe:'covered_derivatives',observedAt:iso(t),recordedAt:iso(t+100),expiresAt:iso(t+3600000),...patch})
Deno.test('rolling liquidation windows retain samples without summing overlapping periods',()=>{const r=liquidationHistory([o(),o({id:'two',value:150,observedAt:iso(t+1000),recordedAt:iso(t+1100)})],'market:coinmarketcap:1','1h',t-1000,t+2000);eq(r.rows.length,2);eq(r.current?.value,150);eq('total' in r,false)})
Deno.test('different units, assets, periods and future knowledge do not enter the plot',()=>{const r=liquidationHistory([o({subject:'market:coinmarketcap:2'}),o({unit:'BTC'}),o({periodSeconds:86400}),o({recordedAt:iso(t+99999)}),o({value:-1})],'market:coinmarketcap:1','1h',t-1,t+2000);eq(r.rows,[])})
Deno.test('corrections replace a sample only once their recording time is known',()=>{const observations=[o(),o({id:'corrected',value:80,recordedAt:iso(t+3000)})];eq(liquidationHistory(observations,'market:coinmarketcap:1','1h',t-1,t+2000).current?.value,100);eq(liquidationHistory(observations,'market:coinmarketcap:1','1h',t-1,t+4000).current?.value,80)})
Deno.test('old samples remain historical evidence with a stale latest state',()=>{const r=liquidationHistory([o()],'market:coinmarketcap:1','1h',t-1,t+7200000);eq(r.rows.length,1);eq(r.currentState,'stale')})
