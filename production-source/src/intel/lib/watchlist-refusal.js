// Investor Intel — why a watchlist add was refused, in the reader's language.
//
// The resolver answers with a machine code and the chain it refused against,
// never an English sentence, so the page is free to say it in whichever locale
// the member reads. An add that fails for any other reason keeps its own
// message; this only replaces the codes we own.

/** @param {(key: string, opts?: object) => string} t  the `intel` namespace */
export function refusalMessage(t, error) {
  const code = error?.code || null
  if (code === 'entity_address_shape') {
    const details = error.details || {}
    const head = t('watchlist.address_not_on_chain', {
      chain: details.chainLabel || details.chain || '',
      defaultValue: 'That identifier is not an address on {{chain}}. Choose the chain the address belongs to, then add it again.',
    })
    const hint = details.looksLike === 'evm'
      ? t('watchlist.address_looks_evm', { defaultValue: 'It looks like an EVM contract address: 0x followed by 40 characters.' })
      : details.looksLike === 'solana'
        ? t('watchlist.address_looks_solana', { defaultValue: 'It looks like a Solana mint.' })
        : details.looksLike === 'tron'
          ? t('watchlist.address_looks_tron', { defaultValue: 'It looks like a Tron address.' })
          : ''
    return hint ? `${head} ${hint}` : head
  }
  if (code === 'resolve_failed') {
    return t('watchlist.resolve_failed', { defaultValue: 'That identifier could not be resolved. Check it and add it again.' })
  }
  return error?.message || ''
}
