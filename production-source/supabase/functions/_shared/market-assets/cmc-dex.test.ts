import { cmcDexPoolRefusal } from './cmc-dex.ts'

Deno.test('a refused pool page names the first refused row, its rule and its legs, and nothing else', () => {
  const asked = '0x45804880de22913dafe09f4980848ece6ecbaf78'
  const good = { addr: '0x9c4fe5ffd9a9fc5678cfbd93aa2d4fd684b67c4c', t0: { addr: asked, sym: 'PAXG' }, t1: { addr: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', sym: 'WETH' }, exn: 'Uniswap v2' }
  const stranger = { addr: '0x' + 'a'.repeat(64), t0: { addr: '0xdac17f958d2ee523a2206206994597c13d831ec7', sym: 'USDT' }, t1: { addr: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', sym: 'USDC' }, exn: 'Curve' }
  const out = cmcDexPoolRefusal({ data: [good, stranger] }, { platform: 'ethereum', address: asked })
  if (out.index !== 1 || out.rule !== 'asked_contract_not_a_leg' || (out.t0 as { sym: string }).sym !== 'USDT' || out.exn !== 'Curve') throw new Error(JSON.stringify(out))
  const clean = cmcDexPoolRefusal({ data: [good] }, { platform: 'ethereum', address: asked })
  if (clean.rule !== 'none_found') throw new Error(JSON.stringify(clean))
})
