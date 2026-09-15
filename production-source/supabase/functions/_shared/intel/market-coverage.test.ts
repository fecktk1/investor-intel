import {assertEquals} from 'jsr:@std/assert@1'
import {MARKET_COVERAGE_SECTIONS,marketCoverage} from './market-coverage.ts'

const state=(coverage:{sections:{key:string;state:string;reason?:string}[]})=>Object.fromEntries(coverage.sections.map((s)=>[s.key,s.reason?`${s.state}:${s.reason}`:s.state]))

// 1. CoinMarketCap-verified major with a verified exchange identity.
const verified={price:64000,quoteReason:null,candles:[{t:1,c:64000}],cexCoverage:'available',
 dex:{liquidityUsd:1_200_000},canonicalAssetKey:'bip122:native:BTC',
 ecosystemNarratives:{status:'available',asset_narratives:[{slug:'store-of-value'}],ecosystem_narratives:[]},
 marketCap:{market_cap:1e12,fdv:1e12,circulating_supply:19_700_000,market_cap_source:'coinmarketcap'},
 displayName:'Bitcoin',imageUrl:'https://img.test/btc.png',signal:{direction:'up'},orderbook:{providerCount:3}}

// 2. CoinGecko asset with NO verified exchange pair and no chart history.
const coingecko={price:0.83,quoteReason:null,candles:[],chartReason:'no_completed_candles',cexCoverage:'unverified',
 dex:null,onchain:{liquidity_usd:null},canonicalAssetKey:'eip155:1:0xabcdef0123456789abcdef0123456789abcdef01',
 ecosystemNarratives:{status:'missing',asset_narratives:[],ecosystem_narratives:[]},
 marketCap:{market_cap:41_000_000,fdv:null,circulating_supply:null,market_cap_source:'coingecko'},
 displayName:'Some Token',imageUrl:null,signal:null,orderbook:null}

// 3. Pasted contract with a live pool but nothing else.
const contract={price:0.0042,quoteReason:null,candles:[{t:1,c:0.0042}],cexCoverage:'unverified',
 dex:null,canonicalAssetKey:'solana:So11111111111111111111111111111111111111112',
 contract:{chain:'solana',address:'So11111111111111111111111111111111111111112',liquidityUsd:90_000,sources:[]},
 ecosystemNarratives:{status:'missing',asset_narratives:[],ecosystem_narratives:[]},
 marketCap:{market_cap:4_000_000,fdv:4_200_000,circulating_supply:null,market_cap_source:'contract'},
 displayName:'Pepe',imageUrl:'https://img.test/p.png',signal:null,orderbook:null}

Deno.test('Coverage reports the same twelve sections for every identity',()=>{
 for(const [detail,kind,cmcId] of [[verified,'cmc','1'],[coingecko,'coingecko',null],[contract,'contract',null]] as const){
  const coverage=marketCoverage(detail,{identityKind:kind,cmcId})
  assertEquals(coverage.sections.map((s)=>s.key),[...MARKET_COVERAGE_SECTIONS])
  assertEquals(coverage.totalCount,12)
  assertEquals(coverage.availableCount,coverage.sections.filter((s)=>s.state==='available').length)
  for(const s of coverage.sections)assertEquals(s.state==='available'?s.reason===undefined:typeof s.reason==='string',true,s.key)
 }
})

Deno.test('Coverage for a CoinMarketCap-verified asset with an exchange identity',()=>{
 const coverage=marketCoverage(verified,{identityKind:'cmc',cmcId:'1'})
 assertEquals(state(coverage),{quote:'available',candles:'available',venues:'available',derivatives:'available',liquidity:'available',
  contract:'not_applicable:native_asset',rwa:'unavailable:no_rwa_classification',narrative:'available',supply:'available',
  metadata:'available',signals:'available',orderbook:'available'})
 assertEquals(coverage.availableCount,10)
})

Deno.test('Coverage for a CoinGecko asset without a verified exchange pair',()=>{
 const coverage=marketCoverage(coingecko,{identityKind:'coingecko',cmcId:null})
 assertEquals(state(coverage),{quote:'available',candles:'unavailable:no_completed_candles',venues:'unavailable:no_verified_exchange_pair',
  derivatives:'unavailable:no_coinmarketcap_listing',liquidity:'unavailable:no_dex_pool_observed',contract:'available',
  rwa:'unavailable:no_rwa_classification',narrative:'unavailable:no_narrative_coverage',supply:'unavailable:no_supply_data',
  metadata:'available',signals:'unavailable:no_verified_exchange_pair',orderbook:'unavailable:no_verified_exchange_pair'})
 assertEquals(coverage.availableCount,3)
})

Deno.test('Coverage for a contract-only identity marks real-world-asset terms not applicable',()=>{
 const coverage=marketCoverage(contract,{identityKind:'contract',cmcId:null})
 assertEquals(state(coverage),{quote:'available',candles:'available',venues:'unavailable:no_verified_exchange_pair',
  derivatives:'unavailable:no_coinmarketcap_listing',liquidity:'available',contract:'available',rwa:'not_applicable:contract_identity',
  narrative:'unavailable:no_narrative_coverage',supply:'unavailable:no_supply_data',metadata:'available',
  signals:'unavailable:no_verified_exchange_pair',orderbook:'unavailable:no_verified_exchange_pair'})
 assertEquals(coverage.availableCount,5)
})

Deno.test('Coverage carries the quote reason and is deterministic',()=>{
 const detail={...contract,price:null,quoteReason:'no_dex_pair_found'}
 const first=marketCoverage(detail,{identityKind:'contract'}),second=marketCoverage(detail,{identityKind:'contract'})
 assertEquals(first,second)
 assertEquals(first.sections[0],{key:'quote',state:'unavailable',reason:'no_dex_pair_found'})
})
