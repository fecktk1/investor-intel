// Investor Intel: the parameters a receipt's call actually SENT.
//
// A receipt drawer shows "Parameters" beside "Reproduce this call". Both must
// describe the same request. Reviewers found a capture receipt reading
// "Parameters: None" above a curl that sent rwa_id=<60 ids>&convert=USD: the
// capture receipt kept its request only in proof.request (which the curl reads)
// while the row read receipt.parameters, which a capture receipt never filled.
//
// So the parameters are taken from the SAME request the reproduce command is
// built from (cmcReproduceRequest in cmc-reproduce.ts), with convert=USD added
// exactly when the transport adds it (cmcAddsConvert, GET only, as
// cmcReproduceCommand does). The row can therefore never say "None" beside a
// command that carries query parameters (asserted by test against the command
// itself). A receipt with no exact request falls back to its own parameters,
// and a capture that recorded no request says so instead of "None".

import { cmcReproduceRequest } from '../../../supabase/functions/_shared/market-assets/cmc-reproduce.ts'
import { CMC_CAPABILITIES, cmcAddsConvert } from '../../../supabase/functions/_shared/market-assets/cmc-capabilities.ts'

/** A comma list longer than this is shown as its count and first values. */
export const PARAM_LIST_PREVIEW = 3

function entry(name, value) {
  const text = String(value)
  const items = text.includes(',') ? text.split(',').map(s => s.trim()).filter(Boolean) : null
  if (items && items.length > PARAM_LIST_PREVIEW) {
    return { name, value: text, list: true, count: items.length, preview: items.slice(0, PARAM_LIST_PREVIEW), ids: /(^|_)ids?$/i.test(name) }
  }
  return { name, value: text, list: false, count: 1, preview: [text], ids: false }
}

/**
 * The parameters behind one receipt, ready to draw.
 *   state    'sent'          entries are what the call sent
 *            'none'          the call sent none (its command carries none)
 *            'not_recorded'  a capture or stored figure that kept no request
 *   source   'request'  taken from the reproduce request (same as the command)
 *            'receipt'  taken from receipt.parameters (no exact request)
 *   earlier  the request is a capture call kept from an EARLIER run than the
 *            one the receipt describes (its command is labelled the same way)
 *   entries  [{ name, value, list, count, preview, ids }] in the order sent
 */
export function receiptSentParameters(receipt) {
  if (!receipt || typeof receipt !== 'object') return { state: 'none', source: 'receipt', earlier: false, entries: [] }
  const request = cmcReproduceRequest(receipt)
  let pairs
  if (request) {
    pairs = Object.entries(request.parameters)
    if (CMC_CAPABILITIES[request.capability]?.method !== 'POST' && cmcAddsConvert(request.capability) && !pairs.some(([k]) => k === 'convert')) pairs.push(['convert', 'USD'])
  } else {
    const own = receipt.parameters && typeof receipt.parameters === 'object' && !Array.isArray(receipt.parameters) ? receipt.parameters : {}
    pairs = Object.entries(own).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])
  }
  const earlier = !!request && request.meaning === 'capture_call' && receipt.proof?.inRun === false
  const entries = pairs.map(([k, v]) => entry(k, v))
  if (entries.length) return { state: 'sent', source: request ? 'request' : 'receipt', earlier, entries }
  const cmc = receipt.provider == null || receipt.provider === 'coinmarketcap'
  const unrecorded = !request && cmc && (receipt.origin === 'capture' || receipt.origin === 'stored')
  return { state: unrecorded ? 'not_recorded' : 'none', source: request ? 'request' : 'receipt', earlier, entries }
}

/** The name=value pairs a GET reproduce command sends, parsed from the command
 * itself (its --data-urlencode arguments, shell quoting undone). Used by tests
 * to hold the drawer to the command; never used to build either. */
export function commandQueryPairs(command) {
  const out = []
  const re = /--data-urlencode '((?:[^']|'\\'')*)'/g
  let m
  while ((m = re.exec(String(command || '')))) {
    const pair = m[1].replaceAll("'\\''", "'")
    const at = pair.indexOf('=')
    out.push(at < 0 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)])
  }
  return out
}
