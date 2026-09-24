import React from 'react'
import { useTranslation } from 'react-i18next'
import { receiptSentParameters } from '../lib/receipt-parameters'

/** The "Parameters" value of a receipt: what its call actually sent, from the
 * same request as its reproduce command (../lib/receipt-parameters.js). A long
 * id list reads as its count and first values ("rwa_id: 60 ids (2, 1, 5, …)"),
 * with the full list one click away in a disclosure. Plain text and a
 * <details>, never a chip. Renders the contents of a <dd>. */
export default function ReceiptParameters({ receipt }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const sent = receiptSentParameters(receipt)
  if (sent.state === 'not_recorded') return <span data-testid="receipt-parameters" data-state="not_recorded">{t('receipt_proof.missing_not_recorded', { defaultValue: 'Not recorded for this capture.' })}</span>
  if (!sent.entries.length) return <span data-testid="receipt-parameters" data-state="none">{t('common.none', { defaultValue: 'None' })}</span>
  const lists = sent.entries.filter(e => e.list)
  return (
    <div data-testid="receipt-parameters" data-state="sent">
      {sent.entries.map((e, i) => (
        <React.Fragment key={e.name}>
          {i > 0 ? ' · ' : ''}
          {e.list
            ? t(e.ids ? 'receipt.param_list_ids' : 'receipt.param_list_values', { name: e.name, count: e.count, first: e.preview.join(', '), defaultValue: e.ids ? '{{name}}: {{count}} ids ({{first}}, …)' : '{{name}}: {{count}} values ({{first}}, …)' })
            : `${e.name}=${e.value}`}
        </React.Fragment>
      ))}
      {sent.earlier && <span className="intel-analysis-caption block">{t('receipt.param_earlier_run', { defaultValue: 'Sent by the kept capture call from an earlier run, the same call the command below reproduces.' })}</span>}
      {lists.map(e => (
        <details key={e.name} className="mt-1" data-testid="receipt-parameters-full">
          <summary className="intel-text-link">{t('receipt.param_list_all', { name: e.name, count: e.count, defaultValue: 'All {{count}} {{name}} values' })}</summary>
          <code className="break-all block">{e.value}</code>
        </details>
      ))}
    </div>
  )
}
