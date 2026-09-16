import assert from 'node:assert/strict'
import {capByEntity,capRankedBoard} from './feed-entity-cap.ts'

interface Row{id:string;chain:string}
const board=(...chains:string[]):Row[]=>chains.map((chain,i)=>({id:`r${i}`,chain}))
const chainOf=(row:Row)=>row.chain
const ids=(rows:Row[])=>rows.map(r=>r.id).join(',')

Deno.test('one entity can no longer fill a board while other entities are waiting',()=>{
 const rows=board('solana','solana','solana','solana','solana','base','ethereum','arbitrum')
 const capped=capRankedBoard(rows,{entityOf:chainOf,perEntity:2,limit:5})
 assert.equal(capped.filter(r=>r.chain==='solana').length,2)
 assert.equal(capped.length,5)
 assert.equal(ids(capped),'r0,r1,r5,r6,r7')
})

Deno.test('the quota yields to the board size: a thin board is refilled rather than shipped short',()=>{
 // Only four rows survive a quota of two across three chains, so the fifth slot
 // is filled from the over-quota rows. Diversity is a preference, never a reason
 // to show the reader less than they would otherwise have seen.
 const rows=board('solana','solana','solana','solana','solana','base','ethereum')
 const capped=capByEntity(rows,{entityOf:chainOf,perEntity:2,limit:5})
 assert.equal(capped.rows.length,5)
 assert.equal(capped.backfilled,1)
 assert.equal(capped.rows.filter(r=>r.chain==='solana').length,3)
})

Deno.test('a capped board is never shorter than the same board was before the cap',()=>{
 // Every row belongs to one entity, so the quota alone would leave two rows on a
 // board of six. The shortfall is backfilled instead of shipping a thin board.
 const rows=board('solana','solana','solana','solana','solana','solana')
 const uncapped=rows.slice(0,6)
 const capped=capByEntity(rows,{entityOf:chainOf,perEntity:2,limit:6})
 assert.equal(capped.rows.length,uncapped.length)
 assert.equal(capped.backfilled,4)
 assert.equal(ids(capped.rows),ids(uncapped),'backfill restores the original rank order')
})

Deno.test('a cap never empties a list, whatever the quota or the limit says',()=>{
 const rows=board('solana','solana','solana')
 for(const perEntity of [0,-1,Number.NaN,0.4]){
  const capped=capByEntity(rows,{entityOf:chainOf,perEntity,limit:3})
  assert.equal(capped.rows.length,3,'a quota below one means no cap, never an empty board')
 }
 assert.equal(capByEntity([],{entityOf:chainOf,perEntity:2,limit:5}).rows.length,0)
 assert.equal(capByEntity(null,{entityOf:chainOf,perEntity:2,limit:5}).rows.length,0)
})

Deno.test('a board smaller than its limit keeps every row it had',()=>{
 const rows=board('solana','base')
 const capped=capByEntity(rows,{entityOf:chainOf,perEntity:1,limit:10})
 assert.equal(capped.rows.length,2)
})

Deno.test('the deferring policy drops nothing and changes no total, it only reorders the head',()=>{
 const rows=board('solana','solana','solana','base','ethereum')
 const capped=capByEntity(rows,{entityOf:chainOf,perEntity:1,overflow:'defer'})
 assert.equal(capped.rows.length,rows.length,'a paginated ranking keeps every row reachable')
 assert.equal(ids(capped.rows),'r0,r3,r4,r1,r2')
 assert.equal(capped.deferred,2)
})

Deno.test('rows whose entity is unknown are never treated as one entity',()=>{
 const rows:Row[]=[{id:'a',chain:''},{id:'b',chain:''},{id:'c',chain:''}]
 const capped=capByEntity(rows,{entityOf:chainOf,perEntity:1,limit:3})
 assert.equal(capped.rows.length,3)
 assert.equal(capped.deferred,0,'an unnamed row is its own entity, not a member of a shared bucket')
})

Deno.test('entity names differing only by case or padding are the same entity',()=>{
 const rows:Row[]=[{id:'a',chain:'Solana'},{id:'b',chain:' solana '},{id:'c',chain:'base'}]
 const capped=capByEntity(rows,{entityOf:chainOf,perEntity:1,limit:3})
 assert.equal(ids(capped.rows),'a,c,b')
 assert.equal(capped.deferred,1)
})

Deno.test('an accessor that throws costs the reader no rows',()=>{
 const rows=board('solana','base')
 const capped=capByEntity(rows,{entityOf:()=>{throw new Error('bad row')},perEntity:1,limit:2})
 assert.equal(capped.rows.length,2)
})

Deno.test('the quota is applied in rank order, so the best row of an entity is the one kept',()=>{
 const rows=board('solana','solana','base')
 const capped=capRankedBoard(rows,{entityOf:chainOf,perEntity:1,limit:2})
 assert.equal(ids(capped),'r0,r2')
})
