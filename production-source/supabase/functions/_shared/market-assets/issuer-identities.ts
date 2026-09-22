// Reviewed 2026-09-10 against the issuer's mainnet table and CMC UCID 3408.
// https://developers.circle.com/stablecoins/usdc-contract-addresses
// https://coinmarketcap.com/currencies/usd-coin/
// https://www.coingecko.com/en/coins/usdc (API ID: usd-coin)
// Only Circle-issued deployments, never bridged lookalikes or ticker aliases.
const circleUsdc=new Set([
 'eip155:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
 'eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
 'eip155:42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831',
 'eip155:43114:0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
 'eip155:10:0x0b2c639c533813f4aa9d7837caf62653d097ff85',
 'eip155:137:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
 'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
])
export function issuerCmcIdentity(canonical:string){
 return circleUsdc.has(canonical)?{id:'3408',slug:'usd-coin',source:'https://developers.circle.com/stablecoins/usdc-contract-addresses',reviewedAt:'2026-09-10',quoteBasis:'Asset-wide market reference; not a chain-specific executable quote.'}:null
}

export function issuerCmcRepresentations(id:string){
 return id==='3408'?[...circleUsdc].map(canonicalAssetKey=>({canonicalAssetKey,...issuerCmcIdentity(canonicalAssetKey)!})):[]
}

/** Reviewed cross-provider identity, never a symbol or mutable display-name join. */
export function issuerProviderCmcId(provider:string,id:string):string|null {
 return (provider==='coinmarketcap'&&id==='3408')||(provider==='coingecko'&&id==='usd-coin')?'3408':null
}
