import {assertEquals as eq,assertThrows} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {comparisonAssetSubjects} from './comparison-subjects.ts'
Deno.test('comparison evidence uses each CMC identity even when tickers collide',()=>{
 const r=comparisonAssetSubjects([{canonicalKey:'market:coinmarketcap:42019',symbol:'SAME',orgId:'private',userId:'private'},{canonicalKey:'market:coinmarketcap:42018',symbol:'SAME'}])!
 eq(r.map(s=>s.providerId),['42019','42018']);eq(r.every(s=>s.sourceProvider==='coinmarketcap'&&s.orgId===null&&s.userId===null),true)
})
Deno.test('manual comparison keeps the two registered native identities distinct',()=>{
 const r=comparisonAssetSubjects([{ref:'bip122:native:BTC',symbol:'BTC'},{ref:'eip155:1:native',symbol:'ETH'}])!
 eq(r.map(s=>s.providerId),['bitcoin','ethereum'])
 assertThrows(()=>comparisonAssetSubjects([{ref:'native:bitcoin'},{ref:'bip122:native:BTC'}]),Error,'duplicate_comparison_asset')
})
Deno.test('explicit malformed or conflicting baskets fail instead of falling back to symbols',()=>{
 for(const assets of [[],[{symbol:'BTC'},{symbol:'ETH'}],[{canonicalKey:'market:coinmarketcap:1',providerId:'1027'},{ref:'native:ethereum'}],[{canonicalKey:'market:coinmarketcap:not-an-id'},{ref:'native:ethereum'}]])assertThrows(()=>comparisonAssetSubjects(assets))
 eq(comparisonAssetSubjects(undefined),null)
})
Deno.test('contract evidence uses exact chain/address and preserves case-sensitive Solana identity',()=>{
 const mint='So11111111111111111111111111111111111111112',address='0x'+'a'.repeat(40)
 const r=comparisonAssetSubjects([{ref:`solana:${mint}`,symbol:'SAME'},{ref:`eip155:8453:${address}`,symbol:'SAME'}])!
 eq(r.map(s=>[s.chain,s.tokenAddress]),[['solana',mint],['base',address]])
})
