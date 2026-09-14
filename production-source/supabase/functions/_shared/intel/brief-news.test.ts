import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { readBriefNews } from './brief-news.ts'
Deno.test('brief news rejects old high-score, expired, future and undated stories and deduplicates titles',async()=>{
 const now=new Date('2026-09-10T22:00:00Z'),current={published_at:'2026-09-10T21:00:00Z',stale_after:'2026-09-11T00:00:00Z'}
 const data=[{...current,id:'old',title:'June headline',published_at:'2026-06-25T14:00:00Z',final_score:100,created_at:now.toISOString()}, {...current,id:'future',title:'Future',published_at:'2026-09-11T00:00:00Z'}, {...current,id:'expired',title:'Expired',stale_after:'2026-09-10T20:00:00Z'}, {...current,id:'undated',title:'Undated',published_at:null}, {...current,id:'a',title:'Verified story',primary_url:'https://example.com/one'}, {...current,id:'b',title:'Verified story!',primary_url:'https://example.com/two'}, {...current,id:'c',title:'Second story'}]
 const filters:any[]=[],q:any={select:()=>q,eq:()=>q,gte:(...args:any[])=>{filters.push(args);return q},lte:(...args:any[])=>{filters.push(args);return q},gt:(...args:any[])=>{filters.push(args);return q},order:()=>q,limit:(size:number)=>{assertEquals(size,60);return Promise.resolve({data})}}
 const result=await readBriefNews({from:()=>q},now,8)
 assertEquals(result.map(row=>row.id),['a','c']);assertEquals(data.length,7)
 assertEquals(filters,[['published_at','2026-09-08T22:00:00.000Z'],['published_at',now.toISOString()],['stale_after',now.toISOString()]])
})
Deno.test('brief news read failures remain errors',async()=>{
 const q:any={select:()=>q,eq:()=>q,gte:()=>q,lte:()=>q,gt:()=>q,order:()=>q,limit:()=>Promise.resolve({error:new Error('Read unavailable')})}
 await assertRejects(()=>readBriefNews({from:()=>q},new Date()),Error,'Read unavailable')
})
