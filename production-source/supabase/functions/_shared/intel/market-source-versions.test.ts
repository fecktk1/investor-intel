import {assertEquals as eq,assertRejects} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {normalizeMarketSourceVersions,readMarketSourceVersions,retainMarketSourceVersions,securityVersionChanges,type MarketSourceVersion} from './market-source-versions.ts'
const now=Date.parse('2026-09-12T04:00:00Z'),address='0x'+'a'.repeat(40),params={platformName:'base',address},provenance={fetchedAt:new Date(now).toISOString(),expiresAt:new Date(now+3600000).toISOString()},policy={historical:true,retainUntil:new Date(now+30*86400000).toISOString(),aiAllowed:true,exportAllowed:false}
const body=()=>({data:[{tokenContractAddress:address,platformId:199,exist:true,securityLevel:0,securityItems:[{code:'x',des:'source text',isHit:false,riskyLevel:0}]}]})
Deno.test('undated security versions preserve false/zero, exclude wallets, and never manufacture observedAt',async()=>{
 const source=body();(source.data[0] as any).creatorAddress='private-profiling-not-in-scope'
 const [v]=await normalizeMarketSourceVersions('dexSecurity',source,params,provenance,policy)
 eq(v.subject,`eip155:8453:${address}`);eq(v.document.level,0);eq(v.document.items[0].hit,false);eq(v.document.items[0].level,0);eq('creatorAddress' in v.document,false);eq('observedAt' in v,false)
 const [retry]=await normalizeMarketSourceVersions('dexSecurity',source,params,provenance,policy);eq(retry.id,v.id)
 const [later]=await normalizeMarketSourceVersions('dexSecurity',source,params,{...provenance,fetchedAt:new Date(now+1000).toISOString()},policy);eq(later.contentHash,v.contentHash);eq(later.id===v.id,false)
 await assertRejects(()=>normalizeMarketSourceVersions('dexSecurity',{data:[{...source.data[0],platformId:1}]},params,provenance,policy),Error,'invalid_security_identity')
 eq(await normalizeMarketSourceVersions('dexSecurity',source,params,provenance,{...policy,historical:false}),[])
})
Deno.test('RWA relationships use exact ids and exclude conflicting issuer relationships, quotes and private values',async()=>{
 const input={data:{rwa_assets:[{rwa_id:1,name:'Gold',tokens:[{crypto_id:4705,issuer_id:'pax',issuer_name:'Paxos',name:'PAXG',symbol:'PAXG',price:4000,market_cap:2},{crypto_id:5,issuer_id:'a'},{crypto_id:5,issuer_id:'b'},{symbol:'PAXG',issuer_id:'pax'}]}]}}
 const rows=await normalizeMarketSourceVersions('rwaQuotes',input,{rwa_id:'1'},provenance,policy);eq(rows.length,1);eq(rows[0].subject,'market:coinmarketcap:4705');eq(rows[0].document.rwaId,'1');eq(rows[0].document.issuerId,'pax');eq('price' in rows[0].document,false);eq('market_cap' in rows[0].document,false)
})
Deno.test('risk comparison distinguishes changed values, missing coverage, duplicate codes and first-recorded time',()=>{
 const version=(items:any[],time=now):MarketSourceVersion=>({id:String(time),subject:`eip155:8453:${address}`,family:'security',contentHash:'hash',document:{items},sourceReference:{},fetchedAt:new Date(time).toISOString(),recordedAt:new Date(time+100).toISOString(),expiresAt:provenance.expiresAt,retainUntil:policy.retainUntil,aiAllowed:true,exportAllowed:false})
 const old=version([{code:'x',hit:true,level:1},{code:'gone',hit:true}],now-1000),current=version([{code:'x',hit:false,level:0},{code:'new',hit:false},{code:'dup',hit:true},{code:'dup',hit:false}])
 const r=securityVersionChanges([old,current]);eq(r.status,'compared');eq(r.changes.map(c=>[c.code,c.kind]),[['x','reported_change'],['gone','coverage_removed'],['new','coverage_added']]);eq(r.changes[0].after.hit,false);eq(r.changes[0].after.level,0);eq(r.current?.recordedAt,current.recordedAt)
 eq(securityVersionChanges([current]).status,'baseline_needed');eq(securityVersionChanges([current,{...old,subject:'other'}]).status,'incompatible')
})
Deno.test('source reads are bounded and permission scoped; storage failures are not empty coverage',async()=>{
 const calls:any[]=[];let failed=false
 const db={from(table:string){const q:any=new Proxy({},{get:(_,method)=>method==='then'?(resolve:any)=>Promise.resolve({data:[],error:failed?{message:'denied'}:null}).then(resolve):(...args:any[])=>{calls.push([table,method,...args]);if(method==='maybeSingle')return Promise.resolve({data:{config:{CMC_ALLOW_HISTORICAL_RETENTION:'true',CMC_ALLOW_AI_PROCESSING:'true'}},error:null});return q}});return q},rpc(){return Promise.resolve({error:{message:'offline'}})}}
 eq((await readMarketSourceVersions(db,'market:coinmarketcap:4705','rwa_relationship',now)).status,'missing');eq(calls.some(c=>c[1]==='limit'&&c[2]===11),true);eq(calls.some(c=>c[1]==='eq'&&c[2]==='ai_allowed'&&c[3]===true),true)
 failed=true;eq((await readMarketSourceVersions(db,'market:coinmarketcap:4705','rwa_relationship',now)).status,'error')
 await assertRejects(()=>retainMarketSourceVersions(db,[{retainUntil:policy.retainUntil}],now),Error,'source_version_storage_unavailable')
})
Deno.test('security history includes top-level classifications and declares ambiguous source codes',()=>{
 const version=(document:any,time:number):MarketSourceVersion=>({id:String(time),subject:`eip155:8453:${address}`,family:'security',contentHash:'hash',document,sourceReference:{},fetchedAt:new Date(time).toISOString(),recordedAt:new Date(time+100).toISOString(),expiresAt:provenance.expiresAt,retainUntil:policy.retainUntil,aiAllowed:true,exportAllowed:false})
 const previous=version({exists:true,level:2,items:[{code:'dup',hit:true},{code:'dup',hit:false}]},now-1000)
 const current=version({exists:false,level:0,items:[{code:'dup',hit:false}]},now)
 const compared=securityVersionChanges([previous,current])
 eq(compared.changes.map(c=>[c.code,c.before?.value,c.after?.value]),[['Source coverage',true,false],['Source classification',2,0]])
 eq(compared.ambiguousCodes,['dup'])
})
Deno.test('RWA source bounds fail explicitly and conflicting cross-underlying identities are withheld',async()=>{
 const quote=(rows:any[])=>({data:{rwa_assets:rows}})
 await assertRejects(()=>normalizeMarketSourceVersions('rwaQuotes',quote(Array.from({length:21},(_,i)=>({rwa_id:i+1,tokens:[]}))),{},provenance,policy),Error,'source_relationship_input_limit')
 await assertRejects(()=>normalizeMarketSourceVersions('rwaQuotes',quote([{rwa_id:1,tokens:Array.from({length:501},()=>({crypto_id:1,issuer_id:'a'}))}]),{},provenance,policy),Error,'source_relationship_input_limit')
 const rows=await normalizeMarketSourceVersions('rwaQuotes',quote([{rwa_id:1,tokens:[{crypto_id:1,issuer_id:'a'},{crypto_id:2,issuer_id:'b'}]},{rwa_id:2,tokens:[{crypto_id:1,issuer_id:'a'}]}]),{},provenance,policy)
 eq(rows.length,1);eq(rows[0].subject,'market:coinmarketcap:2')
})
