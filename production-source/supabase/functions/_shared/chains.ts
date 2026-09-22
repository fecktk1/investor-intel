// Investor Intel — chain-capability registry (server, canonical).
//
// Mirrors the frontend src/intel/lib/chains.js but is the authoritative source
// for entity resolution and capability gating. Behavior is NEVER hardcoded by
// token, customer, or chain — features read capability status from here merged
// with runtime overrides from the chain_capabilities table.
//
// Every capability defaults to 'unverified' (treated as UNAVAILABLE) until the
// P0 provider-coverage report confirms it. A missing/unverified signal is never
// a positive signal.

export type CapabilityStatus = 'live' | 'limited' | 'unavailable' | 'unverified'

export const CAPABILITIES = [
  'market', 'metadata', 'balances', 'tx', 'holders', 'liquidity', 'defi',
  'execution', 'alerts', 'narrative', 'risk', 'portfolio', 'social',
] as const
export type Capability = typeof CAPABILITIES[number]

export type ChainFamily = 'evm' | 'solana' | 'move' | 'bitcoin' | 'tron' | 'cosmos' | 'stellar' | 'other'
export type SupportLevel = 'full_history_pnl' | 'beta_history' | 'balance_only' | 'coming_soon' | 'unsupported'
export type AddressFormat = 'evm_hex' | 'base58' | 'sui_hex' | 'bip122' | 'tron_base58' | 'cosmos_bech32' | 'stellar' | 'cardano_policy' | 'other'

export type ChainDef = {
  id: string
  namespace: string   // CAIP-2 namespace (or documented extension)
  caip2Ref: string    // CAIP-2 reference (chain id / network)
  label: string
  nativeSymbol: string
  tier: 'full' | 'specialized'
  privacyLimited?: boolean
  // ── Portfolio-tracker descriptors (additive; markets/entity code ignores these) ──
  chainFamily?: ChainFamily
  evmChainId?: number | null        // EVM chains incl. HyperEVM (999) + Sei-EVM (1329)
  alchemyNetwork?: string | null    // Alchemy Data/RPC network slug, when supported
  quicknodeNetwork?: string | null  // QuickNode multichain subdomain slug, when verified
  etherscanChainId?: number | null  // Etherscan V2 chainid, when supported
  nativeName?: string
  nativeDecimals?: number
  addressFormat?: AddressFormat
  startingSupportLevel?: SupportLevel  // conservative pre-probe default (matches migration 184 seed)
  explorerTx?: string | null           // append signature / tx hash
  explorerAddress?: string | null      // append wallet address
  explorerToken?: string | null        // append mint / contract
}

// Every Alchemy-enabled chain (+ Solana via Helius) is registered. `tier`/namespace/
// caip2Ref are unchanged for the original entries (markets/entity resolution depend
// on them). startingSupportLevel is conservative; the portfolio-capability-probe
// promotes/degrades it at runtime (investor_chain_capability_audit + chain_capabilities).
export const CHAINS: ChainDef[] = [
  { id: 'solana',      namespace: 'solana',      caip2Ref: 'mainnet', label: 'Solana',      nativeSymbol: 'SOL',  tier: 'full',
    chainFamily: 'solana', evmChainId: null, alchemyNetwork: 'solana-mainnet', quicknodeNetwork: 'solana-mainnet', etherscanChainId: null, nativeName: 'Solana', nativeDecimals: 9, addressFormat: 'base58', startingSupportLevel: 'balance_only',
    explorerTx: 'https://solscan.io/tx/', explorerAddress: 'https://solscan.io/account/', explorerToken: 'https://solscan.io/token/' },
  { id: 'ethereum',    namespace: 'eip155',      caip2Ref: '1',       label: 'Ethereum',    nativeSymbol: 'ETH',  tier: 'full',
    chainFamily: 'evm', evmChainId: 1, alchemyNetwork: 'eth-mainnet', quicknodeNetwork: 'ethereum', etherscanChainId: 1, nativeName: 'Ethereum', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://etherscan.io/tx/', explorerAddress: 'https://etherscan.io/address/', explorerToken: 'https://etherscan.io/token/' },
  { id: 'base',        namespace: 'eip155',      caip2Ref: '8453',    label: 'Base',        nativeSymbol: 'ETH',  tier: 'full',
    chainFamily: 'evm', evmChainId: 8453, alchemyNetwork: 'base-mainnet', quicknodeNetwork: 'base-mainnet', etherscanChainId: 8453, nativeName: 'Ether', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://basescan.org/tx/', explorerAddress: 'https://basescan.org/address/', explorerToken: 'https://basescan.org/token/' },
  { id: 'arbitrum',    namespace: 'eip155',      caip2Ref: '42161',   label: 'Arbitrum',    nativeSymbol: 'ETH',  tier: 'full',
    chainFamily: 'evm', evmChainId: 42161, alchemyNetwork: 'arb-mainnet', etherscanChainId: 42161, nativeName: 'Ether', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://arbiscan.io/tx/', explorerAddress: 'https://arbiscan.io/address/', explorerToken: 'https://arbiscan.io/token/' },
  { id: 'optimism',    namespace: 'eip155',      caip2Ref: '10',      label: 'Optimism',    nativeSymbol: 'ETH',  tier: 'full',
    chainFamily: 'evm', evmChainId: 10, alchemyNetwork: 'opt-mainnet', etherscanChainId: 10, nativeName: 'Ether', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://optimistic.etherscan.io/tx/', explorerAddress: 'https://optimistic.etherscan.io/address/', explorerToken: 'https://optimistic.etherscan.io/token/' },
  { id: 'bnb',         namespace: 'eip155',      caip2Ref: '56',      label: 'BNB Chain',   nativeSymbol: 'BNB',  tier: 'full',
    chainFamily: 'evm', evmChainId: 56, alchemyNetwork: 'bnb-mainnet', quicknodeNetwork: 'bsc', etherscanChainId: 56, nativeName: 'BNB', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://bscscan.com/tx/', explorerAddress: 'https://bscscan.com/address/', explorerToken: 'https://bscscan.com/token/' },
  { id: 'polygon',     namespace: 'eip155',      caip2Ref: '137',     label: 'Polygon',     nativeSymbol: 'POL',  tier: 'full',
    chainFamily: 'evm', evmChainId: 137, alchemyNetwork: 'polygon-mainnet', etherscanChainId: 137, nativeName: 'Polygon', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://polygonscan.com/tx/', explorerAddress: 'https://polygonscan.com/address/', explorerToken: 'https://polygonscan.com/token/' },
  { id: 'avalanche',   namespace: 'eip155',      caip2Ref: '43114',   label: 'Avalanche',   nativeSymbol: 'AVAX', tier: 'full',
    chainFamily: 'evm', evmChainId: 43114, alchemyNetwork: 'avax-mainnet', quicknodeNetwork: 'avalanche-mainnet', etherscanChainId: 43114, nativeName: 'Avalanche', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://snowtrace.io/tx/', explorerAddress: 'https://snowtrace.io/address/', explorerToken: 'https://snowtrace.io/token/' },
  { id: 'hyperliquid', namespace: 'hyperliquid', caip2Ref: 'mainnet', label: 'Hyperliquid', nativeSymbol: 'HYPE', tier: 'specialized',
    chainFamily: 'evm', evmChainId: 999, alchemyNetwork: 'hyperliquid-mainnet', etherscanChainId: null, nativeName: 'Hyperliquid', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://hyperevmscan.io/tx/', explorerAddress: 'https://hyperevmscan.io/address/', explorerToken: 'https://hyperevmscan.io/token/' },
  { id: 'sei',         namespace: 'sei',         caip2Ref: 'pacific-1', label: 'Sei',       nativeSymbol: 'SEI',  tier: 'full',
    chainFamily: 'evm', evmChainId: 1329, alchemyNetwork: 'sei-mainnet', etherscanChainId: 1329, nativeName: 'Sei', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://seitrace.com/tx/', explorerAddress: 'https://seitrace.com/address/', explorerToken: 'https://seitrace.com/token/' },
  { id: 'sonic',       namespace: 'eip155',      caip2Ref: '146',     label: 'Sonic',       nativeSymbol: 'S',    tier: 'full',
    chainFamily: 'evm', evmChainId: 146, alchemyNetwork: 'sonic-mainnet', etherscanChainId: 146, nativeName: 'Sonic', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://sonicscan.org/tx/', explorerAddress: 'https://sonicscan.org/address/', explorerToken: 'https://sonicscan.org/token/' },
  { id: 'metis',       namespace: 'eip155',      caip2Ref: '1088',    label: 'Metis',       nativeSymbol: 'METIS', tier: 'full',
    chainFamily: 'evm', evmChainId: 1088, alchemyNetwork: 'metis-mainnet', etherscanChainId: null, nativeName: 'Metis', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://explorer.metis.io/tx/', explorerAddress: 'https://explorer.metis.io/address/', explorerToken: 'https://explorer.metis.io/token/' },
  { id: 'linea',       namespace: 'eip155',      caip2Ref: '59144',   label: 'Linea',       nativeSymbol: 'ETH',  tier: 'full',
    chainFamily: 'evm', evmChainId: 59144, alchemyNetwork: 'linea-mainnet', etherscanChainId: 59144, nativeName: 'Ether', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://lineascan.build/tx/', explorerAddress: 'https://lineascan.build/address/', explorerToken: 'https://lineascan.build/token/' },
  { id: 'scroll',      namespace: 'eip155',      caip2Ref: '534352',  label: 'Scroll',      nativeSymbol: 'ETH',  tier: 'full',
    chainFamily: 'evm', evmChainId: 534352, alchemyNetwork: 'scroll-mainnet', etherscanChainId: 534352, nativeName: 'Ether', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://scrollscan.com/tx/', explorerAddress: 'https://scrollscan.com/address/', explorerToken: 'https://scrollscan.com/token/' },
  { id: 'mantle',      namespace: 'eip155',      caip2Ref: '5000',    label: 'Mantle',      nativeSymbol: 'MNT',  tier: 'full',
    chainFamily: 'evm', evmChainId: 5000, alchemyNetwork: 'mantle-mainnet', etherscanChainId: 5000, nativeName: 'Mantle', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://mantlescan.xyz/tx/', explorerAddress: 'https://mantlescan.xyz/address/', explorerToken: 'https://mantlescan.xyz/token/' },
  { id: 'gnosis',      namespace: 'eip155',      caip2Ref: '100',     label: 'Gnosis',      nativeSymbol: 'XDAI', tier: 'full',
    chainFamily: 'evm', evmChainId: 100, alchemyNetwork: 'gnosis-mainnet', etherscanChainId: 100, nativeName: 'xDai', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://gnosisscan.io/tx/', explorerAddress: 'https://gnosisscan.io/address/', explorerToken: 'https://gnosisscan.io/token/' },
  { id: 'celo',        namespace: 'eip155',      caip2Ref: '42220',   label: 'Celo',        nativeSymbol: 'CELO', tier: 'full',
    chainFamily: 'evm', evmChainId: 42220, alchemyNetwork: 'celo-mainnet', etherscanChainId: 42220, nativeName: 'Celo', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://celoscan.io/tx/', explorerAddress: 'https://celoscan.io/address/', explorerToken: 'https://celoscan.io/token/' },
  { id: 'zksync',      namespace: 'eip155',      caip2Ref: '324',     label: 'zkSync Era',  nativeSymbol: 'ETH',  tier: 'full',
    chainFamily: 'evm', evmChainId: 324, alchemyNetwork: 'zksync-mainnet', etherscanChainId: 324, nativeName: 'Ether', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://explorer.zksync.io/tx/', explorerAddress: 'https://explorer.zksync.io/address/', explorerToken: 'https://explorer.zksync.io/address/' },
  { id: 'blast',       namespace: 'eip155',      caip2Ref: '81457',   label: 'Blast',       nativeSymbol: 'ETH',  tier: 'full',
    chainFamily: 'evm', evmChainId: 81457, alchemyNetwork: 'blast-mainnet', etherscanChainId: 81457, nativeName: 'Ether', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://blastscan.io/tx/', explorerAddress: 'https://blastscan.io/address/', explorerToken: 'https://blastscan.io/token/' },
  { id: 'opbnb',       namespace: 'eip155',      caip2Ref: '204',     label: 'opBNB',       nativeSymbol: 'BNB',  tier: 'full',
    chainFamily: 'evm', evmChainId: 204, alchemyNetwork: 'opbnb-mainnet', etherscanChainId: 204, nativeName: 'BNB', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://opbnb.bscscan.com/tx/', explorerAddress: 'https://opbnb.bscscan.com/address/', explorerToken: 'https://opbnb.bscscan.com/token/' },
  { id: 'sui',         namespace: 'sui',         caip2Ref: 'mainnet', label: 'Sui',         nativeSymbol: 'SUI',  tier: 'full',
    chainFamily: 'move', evmChainId: null, alchemyNetwork: 'sui-mainnet', etherscanChainId: null, nativeName: 'Sui', nativeDecimals: 9, addressFormat: 'sui_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://suiscan.xyz/mainnet/tx/', explorerAddress: 'https://suiscan.xyz/mainnet/account/', explorerToken: 'https://suiscan.xyz/mainnet/coin/' },
  { id: 'aptos',       namespace: 'aptos',       caip2Ref: 'mainnet', label: 'Aptos',       nativeSymbol: 'APT',  tier: 'specialized',
    chainFamily: 'move', evmChainId: null, alchemyNetwork: 'aptos-mainnet', etherscanChainId: null, nativeName: 'Aptos', nativeDecimals: 8, addressFormat: 'sui_hex', startingSupportLevel: 'balance_only',
    explorerTx: 'https://explorer.aptoslabs.com/txn/', explorerAddress: 'https://explorer.aptoslabs.com/account/', explorerToken: 'https://explorer.aptoslabs.com/account/' },
  { id: 'bitcoin',     namespace: 'bip122',      caip2Ref: 'mainnet', label: 'Bitcoin',     nativeSymbol: 'BTC',  tier: 'specialized',
    chainFamily: 'bitcoin', evmChainId: null, alchemyNetwork: 'bitcoin-mainnet', quicknodeNetwork: 'btc', etherscanChainId: null, nativeName: 'Bitcoin', nativeDecimals: 8, addressFormat: 'bip122', startingSupportLevel: 'balance_only',
    explorerTx: 'https://mempool.space/tx/', explorerAddress: 'https://mempool.space/address/', explorerToken: null },
  { id: 'tron',        namespace: 'tron',        caip2Ref: 'mainnet', label: 'Tron',        nativeSymbol: 'TRX',  tier: 'specialized',
    chainFamily: 'tron', evmChainId: null, alchemyNetwork: 'tron-mainnet', etherscanChainId: null, nativeName: 'Tron', nativeDecimals: 6, addressFormat: 'tron_base58', startingSupportLevel: 'balance_only',
    explorerTx: 'https://tronscan.org/#/transaction/', explorerAddress: 'https://tronscan.org/#/address/', explorerToken: 'https://tronscan.org/#/token20/' },
  { id: 'injective',   namespace: 'injective',   caip2Ref: 'injective-1', label: 'Injective', nativeSymbol: 'INJ', tier: 'specialized',
    chainFamily: 'cosmos', evmChainId: null, alchemyNetwork: 'injective-mainnet', etherscanChainId: null, nativeName: 'Injective', nativeDecimals: 18, addressFormat: 'cosmos_bech32', startingSupportLevel: 'coming_soon',
    explorerTx: 'https://explorer.injective.network/transaction/', explorerAddress: 'https://explorer.injective.network/account/', explorerToken: null },
  { id: 'stellar',     namespace: 'stellar',     caip2Ref: 'pubnet',  label: 'Stellar',     nativeSymbol: 'XLM',  tier: 'specialized',
    chainFamily: 'stellar', evmChainId: null, alchemyNetwork: 'stellar-mainnet', etherscanChainId: null, nativeName: 'Stellar Lumens', nativeDecimals: 7, addressFormat: 'stellar', startingSupportLevel: 'coming_soon',
    explorerTx: 'https://stellar.expert/explorer/public/tx/', explorerAddress: 'https://stellar.expert/explorer/public/account/', explorerToken: null },
  { id: 'near',        namespace: 'near',        caip2Ref: 'mainnet', label: 'NEAR',        nativeSymbol: 'NEAR', tier: 'specialized',
    chainFamily: 'other', evmChainId: null, alchemyNetwork: null, etherscanChainId: null, nativeName: 'NEAR', nativeDecimals: 24, addressFormat: 'other', startingSupportLevel: 'coming_soon',
    explorerTx: 'https://nearblocks.io/txns/', explorerAddress: 'https://nearblocks.io/address/', explorerToken: null },
  { id: 'ton',         namespace: 'ton',         caip2Ref: 'mainnet', label: 'TON',         nativeSymbol: 'TON',  tier: 'specialized',
    chainFamily: 'other', evmChainId: null, alchemyNetwork: null, etherscanChainId: null, nativeName: 'Toncoin', nativeDecimals: 9, addressFormat: 'other', startingSupportLevel: 'coming_soon',
    explorerTx: 'https://tonviewer.com/transaction/', explorerAddress: 'https://tonviewer.com/', explorerToken: null },
  { id: 'xrpl',        namespace: 'xrpl',        caip2Ref: 'mainnet', label: 'XRP Ledger',  nativeSymbol: 'XRP',  tier: 'specialized',
    chainFamily: 'other', evmChainId: null, alchemyNetwork: null, etherscanChainId: null, nativeName: 'XRP', nativeDecimals: 6, addressFormat: 'other', startingSupportLevel: 'coming_soon',
    explorerTx: 'https://livenet.xrpl.org/transactions/', explorerAddress: 'https://livenet.xrpl.org/accounts/', explorerToken: null },
  // Cardano identifies a native asset by its minting policy id, optionally with
  // the hex asset name (`<policy>.<assetName>`) — there is no contract address.
  { id: 'cardano',     namespace: 'cardano',     caip2Ref: 'mainnet', label: 'Cardano',     nativeSymbol: 'ADA',  tier: 'specialized',
    chainFamily: 'other', evmChainId: null, alchemyNetwork: null, etherscanChainId: null, nativeName: 'Cardano', nativeDecimals: 6, addressFormat: 'cardano_policy', startingSupportLevel: 'coming_soon',
    explorerTx: 'https://cardanoscan.io/transaction/', explorerAddress: 'https://cardanoscan.io/address/', explorerToken: 'https://cardanoscan.io/token/' },
  { id: 'zcash',       namespace: 'zcash',       caip2Ref: 'mainnet', label: 'Zcash',       nativeSymbol: 'ZEC',  tier: 'specialized', privacyLimited: true,
    chainFamily: 'other', evmChainId: null, alchemyNetwork: null, etherscanChainId: null, nativeName: 'Zcash', nativeDecimals: 8, addressFormat: 'other', startingSupportLevel: 'coming_soon',
    explorerTx: 'https://blockchair.com/zcash/transaction/', explorerAddress: 'https://blockchair.com/zcash/address/', explorerToken: null },
  { id: 'taiko',       namespace: 'eip155',      caip2Ref: '167000',  label: 'Taiko',       nativeSymbol: 'ETH',  tier: 'specialized',
    chainFamily: 'evm', evmChainId: 167000, alchemyNetwork: null, etherscanChainId: 167000, nativeName: 'Ether', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'coming_soon',
    explorerTx: 'https://taikoscan.io/tx/', explorerAddress: 'https://taikoscan.io/address/', explorerToken: 'https://taikoscan.io/token/' },
  { id: 'xdc',         namespace: 'eip155',      caip2Ref: '50',      label: 'XDC',         nativeSymbol: 'XDC',  tier: 'specialized',
    chainFamily: 'evm', evmChainId: 50, alchemyNetwork: null, etherscanChainId: 50, nativeName: 'XDC', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'coming_soon',
    explorerTx: 'https://xdcscan.com/tx/', explorerAddress: 'https://xdcscan.com/address/', explorerToken: 'https://xdcscan.com/token/' },
  { id: 'moonbeam',    namespace: 'eip155',      caip2Ref: '1284',    label: 'Moonbeam',    nativeSymbol: 'GLMR', tier: 'specialized',
    chainFamily: 'evm', evmChainId: 1284, alchemyNetwork: null, etherscanChainId: 1284, nativeName: 'Glimmer', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'coming_soon',
    explorerTx: 'https://moonbeam.moonscan.io/tx/', explorerAddress: 'https://moonbeam.moonscan.io/address/', explorerToken: 'https://moonbeam.moonscan.io/token/' },
  { id: 'moonriver',   namespace: 'eip155',      caip2Ref: '1285',    label: 'Moonriver',   nativeSymbol: 'MOVR', tier: 'specialized',
    chainFamily: 'evm', evmChainId: 1285, alchemyNetwork: null, etherscanChainId: 1285, nativeName: 'Moonriver', nativeDecimals: 18, addressFormat: 'evm_hex', startingSupportLevel: 'coming_soon',
    explorerTx: 'https://moonriver.moonscan.io/tx/', explorerAddress: 'https://moonriver.moonscan.io/address/', explorerToken: 'https://moonriver.moonscan.io/token/' },
]

export const CHAIN_IDS = CHAINS.map((c) => c.id)

// Native-token CoinGecko ids per chain, for the "chains you follow" performance
// strip on Market Pulse. L2s without their own token map to their gas/economic
// token (Base → ETH). Hardcoded; fetched once (shared) by the regime cron.
export const CHAIN_COINGECKO: Record<string, string> = {
  bitcoin: 'bitcoin', ethereum: 'ethereum', solana: 'solana', base: 'ethereum',
  arbitrum: 'ethereum', bnb: 'binancecoin', polygon: 'matic-network', avalanche: 'avalanche-2',
  sui: 'sui', sei: 'sei-network', injective: 'injective-protocol', near: 'near',
  hyperliquid: 'hyperliquid', tron: 'tron', ton: 'the-open-network', xrpl: 'ripple', zcash: 'zcash',
  cardano: 'cardano',
}

export function getChain(id: string): ChainDef | null {
  return CHAINS.find((c) => c.id === id) || null
}
// Reverse-map an entity's CAIP namespace+reference to our chain id.
export function chainIdFor(ns: string | null, ref: string | null): string | null {
  if (!ns || !ref) return null
  const exact = CHAINS.find((c) => c.namespace === ns && c.caip2Ref === ref)
  if (exact) return exact.id
  // Historical app namespaces also describe known EVM networks (e.g. HyperEVM
  // and Sei). Resolve their explicit numeric ID, never the first EVM chain.
  if (ns === 'eip155' && /^[1-9]\d*$/.test(ref)) return CHAINS.find((c) => c.evmChainId === Number(ref))?.id || null
  return null
}
export function isEvm(chainId: string): boolean {
  return getChain(chainId)?.namespace === 'eip155'
}

// ─── Provider / explorer map (SINGLE SOURCE OF TRUTH) ────────────────────────
// Per-chain ids for the external data providers + the block-explorer token URL.
// memecoin/normalize.ts (DexScreener/GeckoTerminal maps) and
// intel-providers.birdeyeChainFor() derive from this — do not duplicate.
export type ChainProviders = {
  dexscreener: string | null       // DexScreener chainId
  geckoterminal: string | null     // GeckoTerminal network id
  birdeye: string | null           // Birdeye chain id
  coingeckoPlatform: string | null // CoinGecko asset-platform id (contract → CG id lookup)
  explorerToken: string | null     // explorer base; append the token address
}
export const CHAIN_PROVIDERS: Record<string, ChainProviders> = {
  solana:    { dexscreener: 'solana',    geckoterminal: 'solana',      birdeye: 'solana',    coingeckoPlatform: 'solana',              explorerToken: 'https://solscan.io/token/' },
  ethereum:  { dexscreener: 'ethereum',  geckoterminal: 'eth',         birdeye: 'ethereum',  coingeckoPlatform: 'ethereum',            explorerToken: 'https://etherscan.io/token/' },
  base:      { dexscreener: 'base',      geckoterminal: 'base',        birdeye: 'base',      coingeckoPlatform: 'base',                explorerToken: 'https://basescan.org/token/' },
  arbitrum:  { dexscreener: 'arbitrum',  geckoterminal: 'arbitrum',    birdeye: 'arbitrum',  coingeckoPlatform: 'arbitrum-one',        explorerToken: 'https://arbiscan.io/token/' },
  bnb:       { dexscreener: 'bsc',       geckoterminal: 'bsc',         birdeye: 'bsc',       coingeckoPlatform: 'binance-smart-chain', explorerToken: 'https://bscscan.com/token/' },
  polygon:   { dexscreener: 'polygon',   geckoterminal: 'polygon_pos', birdeye: 'polygon',   coingeckoPlatform: 'polygon-pos',         explorerToken: 'https://polygonscan.com/token/' },
  avalanche: { dexscreener: 'avalanche', geckoterminal: 'avax',        birdeye: 'avalanche', coingeckoPlatform: 'avalanche',           explorerToken: 'https://snowtrace.io/token/' },
  sui:       { dexscreener: 'sui',       geckoterminal: 'sui-network', birdeye: 'sui',       coingeckoPlatform: 'sui',                 explorerToken: 'https://suiscan.xyz/mainnet/coin/' },
  // ── Broad EVM L2 coverage (on-demand enrichment). GeckoTerminal network ids
  //    verified against the live /networks API; DexScreener slugs are the chains'
  //    standard URL slugs. birdeye stays null (Birdeye chain coverage is gated /
  //    probed separately). normalize.ts derives DEXSCREENER_CHAIN/GECKOTERMINAL_NETWORK
  //    from these automatically — no other map to update.
  optimism:  { dexscreener: 'optimism',    geckoterminal: 'optimism', birdeye: null, coingeckoPlatform: 'optimistic-ethereum', explorerToken: 'https://optimistic.etherscan.io/token/' },
  blast:     { dexscreener: 'blast',       geckoterminal: 'blast',    birdeye: null, coingeckoPlatform: 'blast',                explorerToken: 'https://blastscan.io/token/' },
  linea:     { dexscreener: 'linea',       geckoterminal: 'linea',    birdeye: null, coingeckoPlatform: 'linea',                explorerToken: 'https://lineascan.build/token/' },
  scroll:    { dexscreener: 'scroll',      geckoterminal: 'scroll',   birdeye: null, coingeckoPlatform: 'scroll',               explorerToken: 'https://scrollscan.com/token/' },
  mantle:    { dexscreener: 'mantle',      geckoterminal: 'mantle',   birdeye: null, coingeckoPlatform: 'mantle',               explorerToken: 'https://mantlescan.xyz/token/' },
  zksync:    { dexscreener: 'zksync',      geckoterminal: 'zksync',   birdeye: null, coingeckoPlatform: 'zksync',               explorerToken: 'https://explorer.zksync.io/address/' },
  sonic:     { dexscreener: 'sonic',       geckoterminal: 'sonic',    birdeye: null, coingeckoPlatform: 'sonic',                explorerToken: 'https://sonicscan.org/token/' },
  gnosis:    { dexscreener: 'gnosischain', geckoterminal: 'xdai',     birdeye: null, coingeckoPlatform: 'xdai',                 explorerToken: 'https://gnosisscan.io/token/' },
  celo:      { dexscreener: 'celo',        geckoterminal: 'celo',     birdeye: null, coingeckoPlatform: 'celo',                 explorerToken: 'https://celoscan.io/token/' },
  opbnb:     { dexscreener: 'opbnb',       geckoterminal: 'opbnb',    birdeye: null, coingeckoPlatform: 'opbnb',                explorerToken: 'https://opbnb.bscscan.com/token/' },
  metis:     { dexscreener: 'metis',       geckoterminal: 'metis',    birdeye: null, coingeckoPlatform: 'metis-andromeda',      explorerToken: 'https://explorer.metis.io/token/' },
}

export function chainProviders(appId: string): ChainProviders | null { return CHAIN_PROVIDERS[appId] || null }
export function birdeyeChainForApp(appId: string): string | null { return CHAIN_PROVIDERS[appId]?.birdeye || null }

/** Canonical token-address form: EVM lowercased; Solana/others left as-is. */
export function normalizeTokenAddress(appId: string, addr: string): string {
  if (!addr) return addr
  return isEvm(appId) ? String(addr).trim().toLowerCase() : String(addr).trim()
}

/** Block-explorer token URL for (chain, address), or null when unknown. Prefers
 *  the markets CHAIN_PROVIDERS map (8 chains), falling back to the registry's
 *  per-chain explorerToken so portfolio chains beyond those 8 also resolve. */
export function explorerTokenUrl(appId: string, addr: string): string | null {
  const base = CHAIN_PROVIDERS[appId]?.explorerToken ?? getChain(appId)?.explorerToken ?? null
  return base && addr ? base + addr : null
}

// ── Portfolio-tracker helpers (additive; markets/entity code keeps using isEvm) ──

/** EVM-family per the portfolio registry — includes HyperEVM (999) and Sei-EVM
 *  (1329) whose CAIP namespace is NOT eip155. Distinct from isEvm() (strict
 *  eip155 namespace, used by markets/entity resolution); do not conflate. */
export function isEvmFamily(chainId: string): boolean {
  const c = getChain(chainId)
  return c?.chainFamily === 'evm' || c?.evmChainId != null
}
export function evmChainIdFor(chainId: string): number | null { return getChain(chainId)?.evmChainId ?? null }
export function alchemyNetworkFor(chainId: string): string | null { return getChain(chainId)?.alchemyNetwork ?? null }
export function etherscanChainIdFor(chainId: string): number | null { return getChain(chainId)?.etherscanChainId ?? null }
export function quicknodeNetworkFor(chainId: string): string | null { return getChain(chainId)?.quicknodeNetwork ?? null }
export function startingSupportLevel(chainId: string): SupportLevel {
  return getChain(chainId)?.startingSupportLevel ?? 'coming_soon'
}

export type QuickNodeRpcFamily = 'evm' | 'solana' | 'bitcoin' | 'unsupported'
export type QuickNodeEndpointParts = { endpointName: string; tokenId: string }
export type QuickNodeRpcConfig = {
  endpointName?: string | null
  tokenId?: string | null
  multichainUrl?: string | null
}

export function quicknodeRpcFamilyFor(chainId: string): QuickNodeRpcFamily {
  const c = getChain(chainId)
  if (!c?.quicknodeNetwork) return 'unsupported'
  if (c.chainFamily === 'solana') return 'solana'
  if (c.chainFamily === 'bitcoin') return 'bitcoin'
  if (c.chainFamily === 'evm' || c.evmChainId != null) return 'evm'
  return 'unsupported'
}

export function parseQuickNodeSolanaRpcUrl(raw: string | null | undefined): QuickNodeEndpointParts | null {
  const value = String(raw || '').trim()
  if (!value) return null
  try {
    const u = new URL(value)
    const host = u.hostname.toLowerCase()
    const suffix = '.solana-mainnet.quiknode.pro'
    if (!host.endsWith(suffix)) return null
    const endpointName = host.slice(0, -suffix.length)
    const tokenId = u.pathname.split('/').filter(Boolean)[0] || ''
    if (!endpointName || !tokenId) return null
    return { endpointName, tokenId }
  } catch {
    return null
  }
}

export function quicknodeRpcUrl(
  chainId: string,
  parts: QuickNodeEndpointParts | null | undefined,
): string | null {
  if (!parts?.endpointName || !parts?.tokenId) return null
  const network = quicknodeNetworkFor(chainId)
  if (!network) return null
  const base = chainId === 'ethereum'
    ? `https://${parts.endpointName}.quiknode.pro/${parts.tokenId}`
    : `https://${parts.endpointName}.${network}.quiknode.pro/${parts.tokenId}`
  return chainId === 'avalanche' ? `${base}/ext/bc/C/rpc` : base
}

function injectQuickNodeToken(rawUrl: string, tokenId: string | null | undefined): string | null {
  const value = String(rawUrl || '').trim()
  if (!value) return null
  const token = String(tokenId || '').trim()
  const withToken = token ? value.replaceAll('{TOKEN_ID}', token).replaceAll('{TOKEN}', token) : value
  if (!token || withToken !== value) return withToken
  try {
    const u = new URL(withToken)
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts.length === 0) u.pathname = `/${token}`
    return u.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

export function quicknodeRpcUrlFromConfig(chainId: string, config: QuickNodeRpcConfig | null | undefined): string | null {
  const network = quicknodeNetworkFor(chainId)
  if (!network || !config) return null
  const tokenId = config.tokenId || null
  if (config.multichainUrl) {
    const templated = config.multichainUrl
      .replaceAll('{NETWORK_NAME}', network)
      .replaceAll('{NETWORK}', network)
      .replaceAll('{CHAIN}', network)
    const url = injectQuickNodeToken(templated, tokenId)
    if (!url) return null
    return chainId === 'avalanche' && !url.includes('/ext/bc/C/rpc') ? `${url}/ext/bc/C/rpc` : url
  }
  return quicknodeRpcUrl(chainId, config.endpointName && tokenId ? { endpointName: config.endpointName, tokenId } : null)
}

export function quicknodeStateProbeMethod(chainId: string): string | null {
  const family = quicknodeRpcFamilyFor(chainId)
  if (family === 'evm') return 'eth_blockNumber'
  if (family === 'solana') return 'getSlot'
  if (family === 'bitcoin') return 'getblockcount'
  return null
}

/** Block-explorer URL for a transaction (Solana signature / EVM hash). */
export function explorerTxUrl(chainId: string, sigOrHash: string | null | undefined): string | null {
  const base = getChain(chainId)?.explorerTx
  return base && sigOrHash ? base + sigOrHash : null
}
/** Block-explorer URL for a wallet address / account. */
export function explorerAddressUrl(chainId: string, addr: string | null | undefined): string | null {
  const base = getChain(chainId)?.explorerAddress
  return base && addr ? base + addr : null
}

/** All chains whose registry start (or runtime override) makes them importable
 *  in the wallet UI — i.e. not 'coming_soon'/'unsupported' by static default.
 *  Runtime support level comes from investor_chain_capability_audit. */
export const PORTFOLIO_CHAIN_IDS = CHAINS
  .filter((c) => c.startingSupportLevel && c.startingSupportLevel !== 'coming_soon' && c.startingSupportLevel !== 'unsupported')
  .map((c) => c.id)

// Coverage overrides loaded from chain_capabilities:
//   { [chainId]: { [capability]: status } }
export type CoverageMap = Record<string, Partial<Record<Capability, CapabilityStatus>>>

export async function loadCoverage(supabase: any): Promise<CoverageMap> {
  const map: CoverageMap = {}
  try {
    const { data, error } = await supabase
      .from('chain_capabilities')
      .select('chain, capability, status')
    if (error || !data) return map
    for (const row of data) {
      ;(map[row.chain] ||= {})[row.capability as Capability] = row.status
    }
  } catch (_e) {
    // Coverage load must never break a request — fall back to unverified.
  }
  return map
}

// Effective status for a (chain, capability). Until the provider-coverage
// report populates chain_capabilities, everything is 'unverified' — which the
// product treats as unavailable, never as a positive signal.
export function capabilityStatus(
  chainId: string,
  capability: Capability,
  coverage?: CoverageMap,
): CapabilityStatus {
  return coverage?.[chainId]?.[capability] ?? 'unverified'
}

export function isCapabilityUsable(
  chainId: string,
  capability: Capability,
  coverage?: CoverageMap,
): boolean {
  const s = capabilityStatus(chainId, capability, coverage)
  return s === 'live' || s === 'limited'
}
