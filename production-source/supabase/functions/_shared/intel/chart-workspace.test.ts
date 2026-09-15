import {assertEquals as eq,assertThrows,assertRejects} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {validateChartLayout,validateDrawing,chartAsset} from './chart-workspace-contract.ts'
import {chartWorkspaceService} from './chart-workspace-service.ts'
const orgId='00000000-0000-4000-8000-000000000001',userId='10000000-0000-4000-8000-000000000001',id='20000000-0000-4000-8000-000000000001'
const layout=()=>({schemaVersion:1,asset:'native:bitcoin',range:{from:1788998400000,to:1789084800000},studies:[],drawings:[]})
const drawing=()=>({id,tool:'text',anchors:[{t:1788998400000,price:100}],text:'<script>private words</script>'})
Deno.test('chart contract retains plain text but strips unrecognized ambient personal fields',()=>{
 const result=validateChartLayout({...layout(),drawings:[drawing()],portfolio:{quantity:123,notes:'Never implicitly saved'},userId:'spoofed'})
 eq(result.drawings[0].text,'<script>private words</script>');eq('portfolio' in result,false);eq('userId' in result,false)
})
Deno.test('chart identity rejects symbols, provider URLs and ambiguous arbitrary asset labels',()=>{
 for(const value of ['BTC','bitcoin','https://provider/private','market:coinmarketcap:0','market:evil:1'])assertThrows(()=>chartAsset(value))
 eq(chartAsset('native:bitcoin'),'native:bitcoin');eq(chartAsset('market:coinmarketcap:1'),'market:coinmarketcap:1')
})
Deno.test('drawings validate time/price anchors, lengths, colors, tool schemas and Fibonacci ratios',()=>{
 for(const patch of [{anchors:[{t:Infinity,price:1}]},{anchors:[{t:1788998400000,price:-1}]},{color:'url(javascript:x)'},{tool:'html'},{text:'a'.repeat(2001)},{anchors:[]}])assertThrows(()=>validateDrawing({...drawing(),...patch}))
 assertThrows(()=>validateDrawing({...drawing(),tool:'fibonacci',anchors:[...drawing().anchors,...drawing().anchors],ratios:[0,0]}))
})
Deno.test('study contracts reject invalid periods, prototype keys, unknown parameters and duplicate IDs',()=>{
 for(const studies of [[{id:'a',type:'rsi',params:{period:0}}],[{id:'a',type:'__proto__'}],[{id:'a',type:'rsi',params:{script:'x'}}],[{id:'a',type:'sma'},{id:'a',type:'ema'}]])assertThrows(()=>validateChartLayout({...layout(),studies}))
})
Deno.test('layout budgets and timezone/options are validated before persistence',()=>{
 for(const patch of [{timezone:'Not/AZone'},{scale:'symlog'},{volume:'true'},{range:{from:0,to:Infinity}},{drawings:Array.from({length:201},drawing)},{visibility:{portfolio:'true'}}])assertThrows(()=>validateChartLayout({...layout(),...patch}))
 eq(validateChartLayout({...layout(),timezone:'America/Chicago'}).timezone,'America/Chicago')
})
function dbMock(data:any,error:any=null){const calls:any[]=[];const query:any=new Proxy({}, {get:(_t,key)=>key==='then'?(resolve:any)=>Promise.resolve({data,error}).then(resolve):(...args:any[])=>{calls.push([key,...args]);return query}});return {calls,from:(name:string)=>{calls.push(['from',name]);return query},rpc:(name:string,args:any)=>{calls.push(['rpc',name,args]);return query}}}
Deno.test('layout reads are bounded and always scoped to the authenticated owner and organization',async()=>{
 const db=dbMock(Array.from({length:21},(_,i)=>({id:i}))),result=await chartWorkspaceService(db,{orgId,userId},{operation:'list',asset:'native:bitcoin',page:2})
 eq(result.layouts.length,20);eq(result.hasMore,true);eq(db.calls.some(c=>c[0]==='eq'&&c[1]==='user_id'&&c[2]===userId),true);eq(db.calls.some(c=>c[0]==='eq'&&c[1]==='org_id'&&c[2]===orgId),true);eq(db.calls.some(c=>c[0]==='range'&&c[1]===40&&c[2]===60),true)
})
Deno.test('chart service saves only validated state and ignores body ownership fields',async()=>{
 const db=dbMock({id,revision:1});await chartWorkspaceService(db,{orgId,userId},{operation:'save',operationId:id,revision:0,title:'Private research',userId:'spoofed',layout:{...layout(),portfolioNotes:'Must not persist'}})
 const args=db.calls[0][2];eq(args.p_user,userId);eq(args.p_org,orgId);eq('portfolioNotes' in args.p_state,false)
})
Deno.test('comparison library reads filter before pagination and retain authenticated ownership',async()=>{
 const db=dbMock([]);await chartWorkspaceService(db,{orgId,userId},{operation:'list',comparisons:true,page:1,userId:'spoofed'})
 for(const [key,value]of [['org_id',orgId],['user_id',userId]])eq(db.calls.some(c=>c[0]==='eq'&&c[1]===key&&c[2]===value),true)
 eq(db.calls.some(c=>c[0]==='not'&&c[1]==='state->comparison'&&c[2]==='is'&&c[3]===null),true)
 eq(db.calls.some(c=>c[0]==='range'&&c[1]===20&&c[2]===40),true)
})
Deno.test('conflict and inaccessible chart responses stay distinguishable without leaking another owner',async()=>{
 await assertRejects(()=>chartWorkspaceService(dbMock(null,{code:'40001'}),{orgId,userId},{operation:'delete',id,revision:1}),Error,'chart_revision_conflict')
 await assertRejects(()=>chartWorkspaceService(dbMock(null,{code:'PT409'}),{orgId,userId},{operation:'delete',id,revision:1}),Error,'chart_revision_conflict')
 await assertRejects(()=>chartWorkspaceService(dbMock(null),{orgId,userId},{operation:'get',id}),Error,'chart_layout_not_found')
 await assertRejects(()=>chartWorkspaceService(dbMock([]),{orgId,userId},{operation:'list',page:101}),Error,'invalid_chart_page')
})

Deno.test('comparison layouts preserve exact bounded identities, view and range without ambient positions',()=>{
 const comparison={assets:[{asset:'native:bitcoin',label:'Bitcoin',holdings:10},{asset:'market:coinmarketcap:1027',label:'Ethereum'}],arrangement:'2x2',priceScale:'independent',period:'1M',notes:'Not implicitly saved'}
 const result=validateChartLayout({...layout(),comparison})
 eq(result.comparison?.assets,[{asset:'native:bitcoin',label:'Bitcoin'},{asset:'market:coinmarketcap:1027',label:'Ethereum'}]);eq(result.comparison?.arrangement,'2x2');eq('notes' in result.comparison!,false)
})
Deno.test('comparison validation rejects ambiguous, duplicate, excess and mismatched lead identities',()=>{
 const valid={assets:[{asset:'native:bitcoin',label:'BTC'},{asset:'native:ethereum',label:'ETH'}]}
 for(const c of [{assets:[]},{assets:[...valid.assets,...valid.assets,valid.assets[0]]},{assets:[valid.assets[1],valid.assets[0]]},{assets:[valid.assets[0],valid.assets[0]]},{assets:[valid.assets[0],{asset:'BTC',label:'BTC'}]},{...valid,arrangement:'100x100'},{...valid,period:'100Y'}])assertThrows(()=>validateChartLayout({...layout(),comparison:c}))
})

Deno.test('named study templates preserve parameters and forbid drawings, comparison and personal overlay state',()=>{
 const template={...layout(),purpose:'study_template',studies:[{id:'trend',type:'ema',params:{period:55}}]}
 const result=validateChartLayout(template);eq(result.purpose,'study_template');eq(result.studies,template.studies)
 for(const patch of [{purpose:'unknown'},{studies:[]},{drawings:[drawing()]},{visibility:{portfolio:false}},{comparison:{assets:[{asset:'native:bitcoin',label:'BTC'},{asset:'native:ethereum',label:'ETH'}]}}])assertThrows(()=>validateChartLayout({...template,...patch}))
})
Deno.test('named template reads are bounded and bind ownership from the authenticated actor',async()=>{
 const db=dbMock([]);await chartWorkspaceService(db,{orgId,userId},{operation:'list',templates:true,page:1,userId:'another-owner',orgId:'another-org'})
 for(const [key,value]of [['org_id',orgId],['user_id',userId],['state->>purpose','study_template']])eq(db.calls.some(c=>c[0]==='eq'&&c[1]===key&&c[2]===value),true)
 eq(db.calls.some(c=>c[0]==='range'&&c[1]===20&&c[2]===40),true)
})

Deno.test('chart navigation binds verified ownership, clips the sentinel and strips unsupported identities',async()=>{
 const db=dbMock({assets:Array.from({length:21},(_,i)=>({asset:i?'market:coinmarketcap:1':'BTC',name:'Bitcoin',notes:'private'})),hasMore:true})
 const result=await chartWorkspaceService(db,{orgId,userId},{operation:'navigation_list',tab:'watchlist',userId:'spoofed',orgId:'spoofed'})
 eq(db.calls[0][2].p_user,userId);eq(db.calls[0][2].p_org,orgId);eq(db.calls[0][2].p_operation,'list');eq(result.assets.length,20);eq(result.assets[0].asset,null);eq('notes' in result.assets[1],false)
 await assertRejects(()=>chartWorkspaceService(db,{orgId,userId},{operation:'navigation_visit',asset:'BTC'}),Error,'invalid_chart_asset')
 await assertRejects(()=>chartWorkspaceService(db,{orgId,userId},{operation:'navigation_list',page:101}),Error,'invalid_chart_navigation')
})

Deno.test('structured outcome assumptions survive validated layout saves without ambient fields or forged results',()=>{
 const outcome={version:'outcome-1',spec:{direction:'long',trigger:'close_above',entry:100,stop:90,target:120,quantity:0.125,feeBps:4.5,slippageBps:2,start:1788998400123,portfolio:'private'},at:1789084800000,intervalMs:3600000,knownOnly:false,source:'Synthetic USD',profit:'forged'}
 const saved=validateChartLayout({...layout(),drawings:[{...drawing(),outcome}]}).drawings[0]
 eq(saved.outcome?.spec.start,1788998400123);eq(saved.outcome?.spec.quantity,0.125);eq('portfolio' in saved.outcome!.spec,false);eq('profit' in saved.outcome!,false)
 for(const patch of [{version:'future'}, {at:1},{intervalMs:0},{source:'x'.repeat(121)},{knownOnly:'false'},{spec:{...outcome.spec,stop:110}}])assertThrows(()=>validateDrawing({...drawing(),outcome:{...outcome,...patch}}))
 assertThrows(()=>validateDrawing({...drawing(),tool:'horizontal',outcome}))
})

Deno.test('replay layouts retain exact cutoff and recording rules without arbitrary private fields',()=>{
 const result=validateChartLayout({...layout(),replay:{at:1788998400123.5,knownOnly:true,notes:'Not serialized'}})
 eq(result.replay,{at:1788998400123.5,knownOnly:true})
 for(const replay of [{at:-1,knownOnly:false},{at:Infinity,knownOnly:false},{at:1788998400123,knownOnly:'yes'}])assertThrows(()=>validateChartLayout({...layout(),replay}))
 assertThrows(()=>validateChartLayout({...layout(),replay:{at:1788998400123,knownOnly:false},comparison:{assets:[{asset:'native:bitcoin',label:'BTC'},{asset:'native:ethereum',label:'ETH'}]}}))
})

Deno.test('tools added with the docked toolbar keep their own anchor counts and dash styles',()=>{
 const anchor={t:1788998400000,price:100},second={t:1789084800000,price:120}
 for(const tool of ['horizontal_ray','vertical','arrow_up','arrow_down','price_label'])eq(validateDrawing({...drawing(),tool,anchors:[anchor]}).tool,tool)
 for(const tool of ['extended','measure'])eq(validateDrawing({...drawing(),tool,anchors:[anchor,second]}).anchors.length,2)
 eq(validateDrawing({...drawing(),tool:'channel',anchors:[anchor,second,second]}).anchors.length,3)
 for(const patch of [{tool:'channel',anchors:[anchor,second]},{tool:'vertical',anchors:[anchor,second]},{tool:'extended',anchors:[anchor]}])assertThrows(()=>validateDrawing({...drawing(),...patch}))
 eq(validateDrawing({...drawing(),dash:'dashed'}).dash,'dashed')
 eq('dash' in validateDrawing(drawing()),false)
 assertThrows(()=>validateDrawing({...drawing(),dash:'wavy'}))
})
Deno.test('a post drawing accepts only a public status address and stores it in one canonical form',()=>{
 const post=(url:unknown)=>validateDrawing({...drawing(),tool:'tweet',url})
 eq(post('https://twitter.com/forge/status/1899?ref_src=x').url,'https://x.com/forge/status/1899')
 eq(post('https://www.x.com/forge/statuses/1899').url,'https://x.com/forge/status/1899')
 for(const url of [undefined,'','http://x.com/forge/status/1','https://evil.com/x.com/forge/status/1','javascript:alert(1)','https://x.com/forge/status/abc','https://x.com/forge'])assertThrows(()=>post(url))
 assertThrows(()=>validateDrawing({...drawing(),url:'https://x.com/forge/status/1899'}))
 // A post card keeps the size the member gave it, within the chart's bounds;
 // no other drawing carries a size, because its anchors size it.
 eq(post('https://x.com/forge/status/1899').box,undefined)
 eq(validateDrawing({...drawing(),tool:'tweet',url:'https://x.com/forge/status/1899',box:{width:320,height:180}}).box,{width:320,height:180})
 for(const box of [{width:100,height:180},{width:320,height:20},{width:2000,height:180},{width:320.5,height:180},{width:'320',height:180},{height:180},'wide'])assertThrows(()=>validateDrawing({...drawing(),tool:'tweet',url:'https://x.com/forge/status/1899',box}))
 assertThrows(()=>validateDrawing({...drawing(),box:{width:320,height:180}}))
})

// ── The working state: what the chart looked like when the member last left it ──

Deno.test('a working state carries the chart size and layout preset, and a layout without them is unchanged',()=>{
 const working=validateChartLayout({...layout(),size:'tall',preset:'Momentum',interval:'30m'})
 eq(working.size,'tall');eq(working.preset,'Momentum');eq(working.interval,'30m')
 // Absent stays absent, so a layout saved before either field existed still validates to the object it always did.
 const plain=validateChartLayout(layout());eq('size' in plain,false);eq('preset' in plain,false)
 // One minute and one month are different widths and neither is folded into the other.
 eq(validateChartLayout({...layout(),interval:'1m'}).interval,'1m');eq(validateChartLayout({...layout(),interval:'1mo'}).interval,'1mo')
 for(const patch of [{size:'enormous'},{size:1},{preset:'Whatever'},{preset:true},{interval:'3s'}])assertThrows(()=>validateChartLayout({...layout(),...patch}))
})

Deno.test('a working state read is bound to the authenticated member, organization and asset',async()=>{
 const db=dbMock({asset:'native:bitcoin',state:layout(),revision:4,updated_at:'2026-09-14T00:00:00.000Z'})
 const result=await chartWorkspaceService(db,{orgId,userId},{operation:'working_get',asset:'native:bitcoin',userId:'spoofed',orgId:'another-org'})
 for(const [key,value]of [['org_id',orgId],['user_id',userId],['asset','native:bitcoin']])eq(db.calls.some(c=>c[0]==='eq'&&c[1]===key&&c[2]===value),true)
 eq(db.calls.some(c=>c[0]==='from'&&c[1]==='intel_chart_working_states'),true)
 eq(result.working?.revision,4);eq(result.working?.updatedAt,'2026-09-14T00:00:00.000Z')
 // A member who has never left a chart here gets null rather than an error.
 eq((await chartWorkspaceService(dbMock(null),{orgId,userId},{operation:'working_get',asset:'native:bitcoin'})).working,null)
 await assertRejects(()=>chartWorkspaceService(dbMock(null),{orgId,userId},{operation:'working_get',asset:'BTC'}),Error,'invalid_chart_asset')
})

Deno.test('a working state save validates the state, binds ownership and carries the revision it was written against',async()=>{
 const db=dbMock({revision:5,updatedAt:'2026-09-15T00:00:00.000Z',applied:true})
 const result=await chartWorkspaceService(db,{orgId,userId},{operation:'working_save',asset:'native:bitcoin',revision:4,userId:'spoofed',state:{...layout(),size:'tall',preset:'Custom',portfolioNotes:'Must not persist'}})
 const args=db.calls[0][2]
 eq(db.calls[0][1],'intel_save_chart_working_state');eq(args.p_user,userId);eq(args.p_org,orgId);eq(args.p_asset,'native:bitcoin');eq(args.p_revision,4)
 eq('portfolioNotes' in args.p_state,false);eq(args.p_state.size,'tall');eq(result.revision,5)
 // The row is keyed on the asset, so a state naming another chart is refused rather than filed under the wrong one.
 await assertRejects(()=>chartWorkspaceService(dbMock({}),{orgId,userId},{operation:'working_save',asset:'native:ethereum',revision:0,state:layout()}),Error,'invalid_chart_working_asset')
 for(const revision of [-1,1.5,'4',null])await assertRejects(()=>chartWorkspaceService(dbMock({}),{orgId,userId},{operation:'working_save',asset:'native:bitcoin',revision,state:layout()}),Error,'invalid_chart_working_revision')
 await assertRejects(()=>chartWorkspaceService(dbMock({}),{orgId,userId},{operation:'working_save',asset:'native:bitcoin',revision:0,state:{...layout(),drawings:Array.from({length:201},drawing)}}),Error,'chart_layout_limit')
 await assertRejects(()=>chartWorkspaceService(dbMock(null,{code:'PGRST301'}),{orgId,userId},{operation:'working_save',asset:'native:bitcoin',revision:0,state:layout()}),Error,'chart_storage_unavailable')
})

// A saved layout on the ALL range is twenty years wide. The old ten-year cap
// refused it, so the layout could be drawn but never saved.
Deno.test('a saved layout may span the widest chart range and no wider',()=>{
 const DAY=86400000,from=1788998400000
 const wide=validateChartLayout({...layout(),range:{from,to:from+7301*DAY}})
 eq(wide.range.to-wide.range.from,7301*DAY)
 assertThrows(()=>validateChartLayout({...layout(),range:{from,to:from+7302*DAY}}))
})
