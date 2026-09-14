import {assertEquals} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {normalizeCmcInvestigation} from './investigation-normalize.ts'
import {cmcParams,cmcRows} from '../market-assets/cmc-capabilities.ts'
import {retainCurrentObservations} from './investigation-service.ts'

Deno.test('a projected shared quote has the same retained evidence IDs as its batch',async()=>{
  const fetched='2026-09-10T21:00:00Z',expires='2026-09-10T21:01:00Z',stale='2026-09-11T03:00:00Z'
  const row=(id:number)=>({id,name:id===1027?'Ethereum':'Bitcoin',quote:[{id:2781,price:2500,last_updated:'2026-09-10T20:59:00Z',volume_24h:100,market_cap:500}]})
  const batch={data:[row(1),row(1027)]}
  const stored=await normalizeCmcInvestigation('quotes',batch,cmcParams('quotes',{id:'1,1027,1839,5426,5805'}),fetched,expires,stale)
  const projected={data:cmcRows('quotes',batch).rows.filter(row=>row.id===1027)}
  const displayed=await normalizeCmcInvestigation('quotes',projected,cmcParams('quotes',{id:'1027'}),fetched,expires,stale)
  assertEquals(displayed.observations.length,4)
  assertEquals(displayed.observations,stored.observations.filter(o=>o.subject==='market:coinmarketcap:1027'))
  const other=await normalizeCmcInvestigation('quotes',{data:[row(1)]},cmcParams('quotes',{id:'1'}),fetched,expires,stale)
  assertEquals(new Set([...displayed.observations,...other.observations].map(o=>o.id)).size,8)
})
Deno.test('evidence repair posts one bounded batch and leaves duplicate retention to the atomic RPC',async()=>{
  const now=Date.parse('2026-09-10T21:00:00Z'),calls:any[]=[]
  const original={id:'known',recordedAt:'2026-09-10T20:40:00Z',retainUntil:'2026-09-10T21:30:00Z'}
  const stored=new Map<string,any>([['known',original]])
  const db={from:()=>{throw new Error('Evidence IDs must not be put in a GET URL')},rpc:(name:string,args:any)=>{assertEquals(name,'intel_record_market_observations');calls.push(args);for(const r of args.p_rows)if(!stored.has(r.id))stored.set(r.id,r);return Promise.resolve({data:args.p_rows.length})}}
  const newRecord={id:'new',recordedAt:'2026-09-10T20:50:00Z',retainUntil:'2026-09-10T22:00:00Z'}
  await retainCurrentObservations(db,[{...newRecord,id:'known'},newRecord,newRecord,{...newRecord,id:'expired',retainUntil:'2026-09-10T20:59:00Z'}],now)
  assertEquals(calls,[{p_rows:[{...newRecord,id:'known'},newRecord]}])
  assertEquals(stored.get('known'),original)
  assertEquals(stored.has('expired'),false)
  await retainCurrentObservations(db,[newRecord],now)
  assertEquals(calls.length,2)
  assertEquals(stored.size,2)
  assertEquals(stored.get('new'),newRecord)
})
Deno.test('a 400-observation discovery batch uses one body request instead of an oversized URL',async()=>{
  const rows=Array.from({length:400},(_,i)=>({id:String(i).padStart(64,'0'),retainUntil:'2026-09-11T22:00:00Z'})),calls:any[]=[]
  await retainCurrentObservations({rpc:(_name:string,args:any)=>{calls.push(args);return Promise.resolve({data:400})}},rows,Date.parse('2026-09-11T21:00:00Z'))
  assertEquals(calls.length,1)
  assertEquals(calls[0].p_rows,rows)
})
