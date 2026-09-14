// Investor Intel — chain-capability registry (frontend mirror).
//
// Source of truth for which capabilities are available per chain. A
// matching server-side registry lives at supabase/functions/_shared/chains.ts.
// Features read capability status from here — behavior is NEVER hardcoded by
// token, customer, or chain.
//
// IMPORTANT: every capability defaults to 'unverified' and is treated as
// UNAVAILABLE until the P0 provider-coverage report (Birdeye / QuickNode /
// DFlow / Kamino / Grok) confirms it. A missing/unverified signal is never
// rendered as a positive signal.
//
// QuickNode multichain endpoint: https://www.quicknode.com/guides/quicknode-products/how-to-use-multichain-endpoint
// Supported chains: https://www.quicknode.com/chains

export const CAPABILITIES = [
  'market',     // price / market data
  'metadata',   // token / asset metadata
  'balances',   // wallet balances
  'tx',         // wallet transactions / activity
  'holders',    // holder data
  'liquidity',  // liquidity data
  'defi',       // DeFi data
  'execution',  // execution / quote data
  'alerts',     // on-chain alerts
  'narrative',  // narrative tracking
  'risk',       // risk scoring
  'portfolio',  // portfolio / holdings
  'social',     // social context
]

export const CAPABILITY_STATUS = {
  LIVE: 'live',
  LIMITED: 'limited',
  UNAVAILABLE: 'unavailable',
  UNVERIFIED: 'unverified',
}

// Chain registry (mirrors supabase/functions/_shared/chains.ts). Every
// Alchemy-enabled chain (+ Solana via Helius) is registered. `startingSupportLevel`
// is the conservative pre-probe default; the runtime level comes from
// investor_chain_capability_audit (loadChainSupportLevels). `tier`/namespace are
// unchanged for the original entries (other Intel pages depend on them).
// NOTE: `caip2Ref` mirrors supabase/functions/_shared/chains.ts — both registries
// MUST stay in sync. It is the CAIP-2 reference stored in entities.chain_id and is
// what chainIdFor() uses to reverse-map a saved entity back to its app chain id.
export const CHAINS = [
  { id: 'solana',      namespace: 'solana',  caip2Ref: 'mainnet',     label: 'Solana',      nativeSymbol: 'SOL',  tier: 'full', chainFamily: 'solana', evmChainId: null, nativeDecimals: 9, startingSupportLevel: 'balance_only', explorerTx: 'https://solscan.io/tx/', explorerAddress: 'https://solscan.io/account/' },
  { id: 'ethereum',    namespace: 'eip155',  caip2Ref: '1',           label: 'Ethereum',    nativeSymbol: 'ETH',  tier: 'full', chainFamily: 'evm', evmChainId: 1, nativeDecimals: 18, startingSupportLevel: 'balance_only', explorerTx: 'https://etherscan.io/tx/', explorerAddress: 'https://etherscan.io/address/' },
  { id: 'base',        namespace: 'eip155',  caip2Ref: '8453',        label: 'Base',        nativeSymbol: 'ETH',  tier: 'full', chainFamily: 'evm', evmChainId: 8453, nativeDecimals: 18, startingSupportLevel: 'balance_only', explorerTx: 'https://basescan.org/tx/', explorerAddress: 'https://basescan.org/address/' },
  { id: 'arbitrum',    namespace: 'eip155',  caip2Ref: '42161',       label: 'Arbitrum',    nativeSymbol: 'ETH',  tier: 'full', chainFamily: 'evm', evmChainId: 42161, nativeDecimals: 18, startingSupportLevel: 'balance_only', explorerTx: 'https://arbiscan.io/tx/', explorerAddress: 'https://arbiscan.io/address/' },
  { id: 'optimism',    namespace: 'eip155',  caip2Ref: '10',          label: 'Optimism',    nativeSymbol: 'ETH',  tier: 'full', chainFamily: 'evm', evmChainId: 10, nativeDecimals: 18, startingSupportLevel: 'balance_only', explorerTx: 'https://optimistic.etherscan.io/tx/', explorerAddress: 'https://optimistic.etherscan.io/address/' },
  { id: 'bnb',         namespace: 'eip155',  caip2Ref: '56',          label: 'BNB Chain',   nativeSymbol: 'BNB',  tier: 'full', chainFamily: 'evm', evmChainId: 56, nativeDecimals: 18, startingSupportLevel: 'balance_only', explorerTx: 'https://bscscan.com/tx/', explorerAddress: 'https://bscscan.com/address/' },
  { id: 'polygon',     namespace: 'eip155',  caip2Ref: '137',         label: 'Polygon',     nativeSymbol: 'POL',  tier: 'full', chainFamily: 'evm', evmChainId: 137, nativeDecimals: 18, startingSupportLevel: 'balance_only', explorerTx: 'https://polygonscan.com/tx/', explorerAddress: 'https://polygonscan.com/address/' },
  { id: 'avalanche',   namespace: 'eip155',  caip2Ref: '43114',       label: 'Avalanche',   nativeSymbol: 'AVAX', tier: 'full', chainFamily: 'evm', evmChainId: 43114, nativeDecimals: 18, startingSupportLevel: 'balance_only', explorerTx: 'https://snowtrace.io/tx/', explorerAddress: 'https://snowtrace.io/address/' },
  { id: 'hyperliquid', namespace: 'hyperliquid', caip2Ref: 'mainnet', label: 'Hyperliquid', nativeSymbol: 'HYPE', tier: 'specialized', chainFamily: 'evm', evmChainId: 999, nativeDecimals: 18, startingSupportLevel: 'balance_only', note: 'hyperevm', explorerTx: 'https://hyperevmscan.io/tx/', explorerAddress: 'https://hyperevmscan.io/address/' },
  { id: 'sei',         namespace: 'sei',     caip2Ref: 'pacific-1',   label: 'Sei',         nativeSymbol: 'SEI',  tier: 'full', chainFamily: 'evm', evmChainId: 1329, nativeDecimals: 18, startingSupportLevel: 'balance_only', note: 'sei_evm', explorerTx: 'https://seitrace.com/tx/', explorerAddress: 'https://seitrace.com/address/' },
  { id: 'sonic',       namespace: 'eip155',  caip2Ref: '146',         label: 'Sonic',       nativeSymbol: 'S',    tier: 'full', chainFamily: 'evm', evmChainId: 146, nativeDecimals: 18, startingSupportLevel: 'balance_only', explorerTx: 'https://sonicscan.org/tx/', explorerAddress: 'https://sonicscan.org/address/' },
  { id: 'metis',       namespace: 'eip155',  caip2Ref: '1088',        label: 'Metis',       nativeSymbol: 'METIS', tier: 'full', chainFamily: 'evm', evmChainId: 1088, nativeDecimals: 18, startingSupportLevel: 'balance_only', explorerTx: 'https://explorer.metis.io/tx/', explorerAddress: 'https://explorer.metis.io/address/' },
  { id: 'linea',       namespace: 'eip155',  caip2Ref: '59144',       label: 'Linea',       nativeSymbol: 'ETH',  tier: 'full', chainFamily: 'evm', evmChainId: 59144, nativeDecimals: 18, startingSupportLevel: 'balance_only', explorerTx: 'https://lineascan.build/tx/', explorerAddress: 'https://lineascan.build/address/' },
  { id: 'scroll',      namespace: 'eip155',  caip2Ref: '534352',      label: 'Scroll',      nativeSymbol: 'ETH',  tier: 'full', chainFamily: 'evm', evmChainId: 534352, nativeDecimals: 18, startingSupportLevel: 'balance_only', explorerTx: 'https://scrollscan.com/tx/', explorerAddress: 'https://scrollscan.com/address/' },
  { id: 'mantle',      namespace: 'eip155',  caip2Ref: '5000',        label: 'Mantle',      nativeSymbol: 'MNT',  tier: 'full', chainFamily: 'evm', evmChainId: 5000, nativeDecimals: 18, startingSupportLevel: 'balance_only', explorerTx: 'https://mantlescan.xyz/tx/', explorerAddress: 'https://mantlescan.xyz/address/' },
  { id: 'gnosis',      namespace: 'eip155',  caip2Ref: '100',         label: 'Gnosis',      nativeSymbol: 'XDAI', tier: 'full', chainFamily: 'evm', evmChainId: 100, nativeDecimals: 18, startingSupportLevel: 'balance_only', explorerTx: 'https://gnosisscan.io/tx/', explorerAddress: 'https://gnosisscan.io/address/' },
  { id: 'celo',        namespace: 'eip155',  caip2Ref: '42220',       label: 'Celo',        nativeSymbol: 'CELO', tier: 'full', chainFamily: 'evm', evmChainId: 42220, nativeDecimals: 18, startingSupportLevel: 'balance_only', explorerTx: 'https://celoscan.io/tx/', explorerAddress: 'https://celoscan.io/address/' },
  { id: 'zksync',      namespace: 'eip155',  caip2Ref: '324',         label: 'zkSync Era',  nativeSymbol: 'ETH',  tier: 'full', chainFamily: 'evm', evmChainId: 324, nativeDecimals: 18, startingSupportLevel: 'balance_only', explorerTx: 'https://explorer.zksync.io/tx/', explorerAddress: 'https://explorer.zksync.io/address/' },
  { id: 'blast',       namespace: 'eip155',  caip2Ref: '81457',       label: 'Blast',       nativeSymbol: 'ETH',  tier: 'full', chainFamily: 'evm', evmChainId: 81457, nativeDecimals: 18, startingSupportLevel: 'balance_only', explorerTx: 'https://blastscan.io/tx/', explorerAddress: 'https://blastscan.io/address/' },
  { id: 'opbnb',       namespace: 'eip155',  caip2Ref: '204',         label: 'opBNB',       nativeSymbol: 'BNB',  tier: 'full', chainFamily: 'evm', evmChainId: 204, nativeDecimals: 18, startingSupportLevel: 'balance_only', explorerTx: 'https://opbnb.bscscan.com/tx/', explorerAddress: 'https://opbnb.bscscan.com/address/' },
  { id: 'sui',         namespace: 'sui',     caip2Ref: 'mainnet',     label: 'Sui',         nativeSymbol: 'SUI',  tier: 'full', chainFamily: 'move', evmChainId: null, nativeDecimals: 9, startingSupportLevel: 'balance_only', explorerTx: 'https://suiscan.xyz/mainnet/tx/', explorerAddress: 'https://suiscan.xyz/mainnet/account/' },
  { id: 'aptos',       namespace: 'aptos',   caip2Ref: 'mainnet',     label: 'Aptos',       nativeSymbol: 'APT',  tier: 'specialized', chainFamily: 'move', evmChainId: null, nativeDecimals: 8, startingSupportLevel: 'balance_only', explorerTx: 'https://explorer.aptoslabs.com/txn/', explorerAddress: 'https://explorer.aptoslabs.com/account/' },
  { id: 'bitcoin',     namespace: 'bip122',  caip2Ref: 'mainnet',     label: 'Bitcoin',     nativeSymbol: 'BTC',  tier: 'specialized', chainFamily: 'bitcoin', evmChainId: null, nativeDecimals: 8, startingSupportLevel: 'balance_only', explorerTx: 'https://mempool.space/tx/', explorerAddress: 'https://mempool.space/address/' },
  { id: 'tron',        namespace: 'tron',    caip2Ref: 'mainnet',     label: 'Tron',        nativeSymbol: 'TRX',  tier: 'specialized', chainFamily: 'tron', evmChainId: null, nativeDecimals: 6, startingSupportLevel: 'balance_only', explorerTx: 'https://tronscan.org/#/transaction/', explorerAddress: 'https://tronscan.org/#/address/' },
  { id: 'injective',   namespace: 'injective', caip2Ref: 'injective-1', label: 'Injective', nativeSymbol: 'INJ',  tier: 'specialized', chainFamily: 'cosmos', evmChainId: null, nativeDecimals: 18, startingSupportLevel: 'coming_soon', explorerTx: 'https://explorer.injective.network/transaction/', explorerAddress: 'https://explorer.injective.network/account/' },
  { id: 'stellar',     namespace: 'stellar', caip2Ref: 'pubnet',      label: 'Stellar',     nativeSymbol: 'XLM',  tier: 'specialized', chainFamily: 'stellar', evmChainId: null, nativeDecimals: 7, startingSupportLevel: 'coming_soon', explorerTx: 'https://stellar.expert/explorer/public/tx/', explorerAddress: 'https://stellar.expert/explorer/public/account/' },
  { id: 'near',        namespace: 'near',    caip2Ref: 'mainnet',     label: 'NEAR',        nativeSymbol: 'NEAR', tier: 'specialized', chainFamily: 'other', evmChainId: null, nativeDecimals: 24, startingSupportLevel: 'coming_soon', explorerTx: 'https://nearblocks.io/txns/', explorerAddress: 'https://nearblocks.io/address/' },
  { id: 'ton',         namespace: 'ton',     caip2Ref: 'mainnet',     label: 'TON',         nativeSymbol: 'TON',  tier: 'specialized', chainFamily: 'other', evmChainId: null, nativeDecimals: 9, startingSupportLevel: 'coming_soon', explorerTx: 'https://tonviewer.com/transaction/', explorerAddress: 'https://tonviewer.com/' },
  { id: 'xrpl',        namespace: 'xrpl',    caip2Ref: 'mainnet',     label: 'XRP Ledger',  nativeSymbol: 'XRP',  tier: 'specialized', chainFamily: 'other', evmChainId: null, nativeDecimals: 6, startingSupportLevel: 'coming_soon', explorerTx: 'https://livenet.xrpl.org/transactions/', explorerAddress: 'https://livenet.xrpl.org/accounts/' },
  { id: 'zcash',       namespace: 'zcash',   caip2Ref: 'mainnet',     label: 'Zcash',       nativeSymbol: 'ZEC',  tier: 'specialized', privacyLimited: true, chainFamily: 'other', evmChainId: null, nativeDecimals: 8, startingSupportLevel: 'coming_soon', explorerTx: 'https://blockchair.com/zcash/transaction/', explorerAddress: 'https://blockchair.com/zcash/address/' },
  { id: 'taiko',       namespace: 'eip155',  caip2Ref: '167000',      label: 'Taiko',       nativeSymbol: 'ETH',  tier: 'specialized', chainFamily: 'evm', evmChainId: 167000, nativeDecimals: 18, startingSupportLevel: 'coming_soon', explorerTx: 'https://taikoscan.io/tx/', explorerAddress: 'https://taikoscan.io/address/' },
  { id: 'xdc',         namespace: 'eip155',  caip2Ref: '50',          label: 'XDC',         nativeSymbol: 'XDC',  tier: 'specialized', chainFamily: 'evm', evmChainId: 50, nativeDecimals: 18, startingSupportLevel: 'coming_soon', explorerTx: 'https://xdcscan.com/tx/', explorerAddress: 'https://xdcscan.com/address/' },
  { id: 'moonbeam',    namespace: 'eip155',  caip2Ref: '1284',        label: 'Moonbeam',    nativeSymbol: 'GLMR', tier: 'specialized', chainFamily: 'evm', evmChainId: 1284, nativeDecimals: 18, startingSupportLevel: 'coming_soon', explorerTx: 'https://moonbeam.moonscan.io/tx/', explorerAddress: 'https://moonbeam.moonscan.io/address/' },
  { id: 'moonriver',   namespace: 'eip155',  caip2Ref: '1285',        label: 'Moonriver',   nativeSymbol: 'MOVR', tier: 'specialized', chainFamily: 'evm', evmChainId: 1285, nativeDecimals: 18, startingSupportLevel: 'coming_soon', explorerTx: 'https://moonriver.moonscan.io/tx/', explorerAddress: 'https://moonriver.moonscan.io/address/' },
]

export const CHAIN_IDS = CHAINS.map((c) => c.id)

// Provider IDs mirrored from supabase/functions/_shared/chains.ts. This is
// display/reference data for future coverage UI only; it does not trigger calls.
export const CHAIN_PROVIDERS = {
  solana: { dexscreener: 'solana', geckoterminal: 'solana', birdeye: 'solana', coingeckoPlatform: 'solana', explorerToken: 'https://solscan.io/token/' },
  ethereum: { dexscreener: 'ethereum', geckoterminal: 'eth', birdeye: 'ethereum', coingeckoPlatform: 'ethereum', explorerToken: 'https://etherscan.io/token/' },
  base: { dexscreener: 'base', geckoterminal: 'base', birdeye: 'base', coingeckoPlatform: 'base', explorerToken: 'https://basescan.org/token/' },
  arbitrum: { dexscreener: 'arbitrum', geckoterminal: 'arbitrum', birdeye: 'arbitrum', coingeckoPlatform: 'arbitrum-one', explorerToken: 'https://arbiscan.io/token/' },
  bnb: { dexscreener: 'bsc', geckoterminal: 'bsc', birdeye: 'bsc', coingeckoPlatform: 'binance-smart-chain', explorerToken: 'https://bscscan.com/token/' },
  polygon: { dexscreener: 'polygon', geckoterminal: 'polygon_pos', birdeye: 'polygon', coingeckoPlatform: 'polygon-pos', explorerToken: 'https://polygonscan.com/token/' },
  avalanche: { dexscreener: 'avalanche', geckoterminal: 'avax', birdeye: 'avalanche', coingeckoPlatform: 'avalanche', explorerToken: 'https://snowtrace.io/token/' },
  sui: { dexscreener: 'sui', geckoterminal: 'sui-network', birdeye: 'sui', coingeckoPlatform: 'sui', explorerToken: 'https://suiscan.xyz/mainnet/coin/' },
  optimism: { dexscreener: 'optimism', geckoterminal: 'optimism', birdeye: null, coingeckoPlatform: 'optimistic-ethereum', explorerToken: 'https://optimistic.etherscan.io/token/' },
  blast: { dexscreener: 'blast', geckoterminal: 'blast', birdeye: null, coingeckoPlatform: 'blast', explorerToken: 'https://blastscan.io/token/' },
  linea: { dexscreener: 'linea', geckoterminal: 'linea', birdeye: null, coingeckoPlatform: 'linea', explorerToken: 'https://lineascan.build/token/' },
  scroll: { dexscreener: 'scroll', geckoterminal: 'scroll', birdeye: null, coingeckoPlatform: 'scroll', explorerToken: 'https://scrollscan.com/token/' },
  mantle: { dexscreener: 'mantle', geckoterminal: 'mantle', birdeye: null, coingeckoPlatform: 'mantle', explorerToken: 'https://mantlescan.xyz/token/' },
  zksync: { dexscreener: 'zksync', geckoterminal: 'zksync', birdeye: null, coingeckoPlatform: 'zksync', explorerToken: 'https://explorer.zksync.io/address/' },
  sonic: { dexscreener: 'sonic', geckoterminal: 'sonic', birdeye: null, coingeckoPlatform: 'sonic', explorerToken: 'https://sonicscan.org/token/' },
  gnosis: { dexscreener: 'gnosischain', geckoterminal: 'xdai', birdeye: null, coingeckoPlatform: 'xdai', explorerToken: 'https://gnosisscan.io/token/' },
  celo: { dexscreener: 'celo', geckoterminal: 'celo', birdeye: null, coingeckoPlatform: 'celo', explorerToken: 'https://celoscan.io/token/' },
  opbnb: { dexscreener: 'opbnb', geckoterminal: 'opbnb', birdeye: null, coingeckoPlatform: 'opbnb', explorerToken: 'https://opbnb.bscscan.com/token/' },
  metis: { dexscreener: 'metis', geckoterminal: 'metis', birdeye: null, coingeckoPlatform: 'metis-andromeda', explorerToken: 'https://explorer.metis.io/token/' },
}

export function chainProviders(appId) { return CHAIN_PROVIDERS[appId] || null }

export function getChain(id) {
  return CHAINS.find((c) => c.id === id) || null
}

// Reverse-map an entity's CAIP namespace + reference to our app chain id (mirrors
// the server chainIdFor in supabase/functions/_shared/chains.ts). EVM chains share
// the 'eip155' namespace, so caip2Ref disambiguates (Base vs Ethereum); the
// unknown or absent references stay unresolved instead of selecting a network.
export function chainIdFor(ns, ref) {
  if (!ns || !ref) return null
  const exact = CHAINS.find((c) => c.namespace === ns && c.caip2Ref === ref)
  if (exact) return exact.id
  if (ns === 'eip155' && /^[1-9]\d*$/.test(ref)) return CHAINS.find((c) => c.evmChainId === Number(ref))?.id || null
  return null
}

export function isEvmFamily(chainId) {
  const c = getChain(chainId)
  return c?.chainFamily === 'evm' || (c?.evmChainId != null)
}

// ── Paste-any-token address helpers (mirror server _shared/investor-portfolio/addresses.ts) ──
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
export const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

// Detect the address family from its shape. EVM (0x-prefixed hex) is unambiguous
// and checked first; any other in-range base58 string is treated as Solana.
// Returns null when the value matches neither (caller can fall back to a picker).
export function detectAddressKind(value) {
  const v = String(value || '').trim()
  if (EVM_ADDRESS_RE.test(v)) return 'evm'
  if (SOLANA_ADDRESS_RE.test(v)) return 'solana'
  return null
}

// Canonical token-address form: EVM lowercased (stable storage/dedupe, matches the
// entity resolver + birdeye-client); Solana and others left as-is (case-significant).
export function normalizeAddressForChain(chainId, addr) {
  const a = String(addr || '').trim()
  return isEvmFamily(chainId) ? a.toLowerCase() : a
}

// App-style `chain:address` ref — the synthetic-entity / Degen drill-in form that
// AssetBreakdownPage understands (NOT the CAIP canonical_ref_key from the resolver).
export function assetRef(chainId, addr) {
  return `${chainId}:${normalizeAddressForChain(chainId, addr)}`
}

export function explorerTxUrl(chainId, sigOrHash) {
  const base = getChain(chainId)?.explorerTx
  return base && sigOrHash ? base + sigOrHash : null
}
export function explorerAddressUrl(chainId, addr) {
  // `evm` is the persisted sentinel for a wallet scanned across every EVM
  // chain. Use Ethereum as its representative address explorer; never fall
  // through to a Solana explorer for a 0x address.
  const normalizedChainId = chainId === 'evm' ? 'ethereum' : chainId === 'bsc' ? 'bnb' : chainId
  const base = getChain(normalizedChainId)?.explorerAddress
  return base && addr ? base + addr : null
}

// Runtime support levels per chain, from investor_chain_capability_audit:
//   { [chainId]: { supportLevel, probeStatus, ... } }. Falls back to {} (→ the
// registry's startingSupportLevel). The wallet-import UI groups chains by this.
export async function loadChainSupportLevels(supabase) {
  try {
    const { data } = await supabase
      .from('investor_chain_capability_audit')
      .select('chain, support_level, probe_status, balance_supported, tx_history_supported, cost_basis_supported, caveat')
    const map = {}
    for (const r of data || []) {
      map[r.chain] = {
        supportLevel: r.support_level,
        probeStatus: r.probe_status,
        balanceSupported: r.balance_supported,
        txHistorySupported: r.tx_history_supported,
        costBasisSupported: r.cost_basis_supported,
        caveat: r.caveat,
      }
    }
    return map
  } catch { return {} }
}

// Effective support level for a chain: runtime audit row wins, else the
// registry's conservative starting level.
export function supportLevelFor(chainId, supportMap) {
  return supportMap?.[chainId]?.supportLevel || getChain(chainId)?.startingSupportLevel || 'coming_soon'
}

export const SUPPORT_GROUP_ORDER = ['full_history_pnl', 'beta_history', 'balance_only', 'coming_soon', 'unsupported']

// Effective capability status for a (chain, capability). Until the P0
// provider-coverage report populates verified statuses (via chain_capabilities
// + the server registry), everything resolves to 'unverified' — which the UI
// must treat as unavailable, never as a positive signal.
//
// `overrides` is the verified coverage map once available:
//   { [chainId]: { [capability]: 'live' | 'limited' | 'unavailable' } }
export function capabilityStatus(chainId, capability, overrides) {
  const fromOverride = overrides?.[chainId]?.[capability]
  if (fromOverride) return fromOverride
  return CAPABILITY_STATUS.UNVERIFIED
}

export function isCapabilityUsable(chainId, capability, overrides) {
  const s = capabilityStatus(chainId, capability, overrides)
  return s === CAPABILITY_STATUS.LIVE || s === CAPABILITY_STATUS.LIMITED
}

// Load verified coverage from chain_capabilities into an overrides map:
//   { [chainId]: { [capability]: status } }. Falls back to {} (→ unverified).
export async function loadChainCoverage(supabase) {
  try {
    const { data } = await supabase.from('chain_capabilities').select('chain, capability, status')
    const map = {}
    for (const r of data || []) { (map[r.chain] ||= {})[r.capability] = r.status }
    return map
  } catch { return {} }
}
