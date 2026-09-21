// Investor Intel — how a pasted address that no catalogue carries is named.
//
// The suggest read answers such an address with one row per chain it could be
// read on, carrying the chain and the contract route and nothing else: no
// symbol, no project name, because nothing has named the token yet. Rendered as
// an ordinary suggestion that reads as a nameless asset among named ones, which
// is not what it is. It is the OFFER to open that contract's own page, so both
// surfaces that show it (the Markets search field and the asset page's identity
// choice) name it as that offer, in words, in the reader's language.

import { getChain } from './chains'

export function isUncataloguedContract(row) {
  return row?.match === 'contract' && row?.sourceProvider === 'contract' && !row?.symbol && !row?.displayName
}

/** "Open this contract on Solana" — the chain named the way chains.js names it,
 *  and only ever the chain the row itself carries. */
export function uncataloguedContractLabel(row, t) {
  const chain = getChain(row?.chain)?.label || row?.chain || ''
  return chain
    ? t('markets.suggest_open_contract', { chain, defaultValue: 'Open this contract on {{chain}}' })
    : t('markets.suggest_unnamed', { defaultValue: 'Unnamed contract' })
}
