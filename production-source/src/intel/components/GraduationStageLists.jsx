import React from 'react'
import BoardTableHeader, { BOARD_CELL_CLASS } from './BoardTableHeader'
import { AssetName, BondingProgress, ContractCell, ValueCell, chainLabel, num, padLabel, stamp } from './GraduationCells'
import { fmtNum } from '../lib/market-format'

// The three stage lists of the NEWEST capture.
//
// The funnel above counts each stage; these tables name the contracts in it.
// `contracts` is a BOUNDED SAMPLE of the stage, drawn so no single launchpad can
// fill the board, and the caption says how much of the stage it is rather than
// letting a reader take twenty-five rows for the whole of a stage of two hundred.
//
// This reads with ONE capture. Stage membership, the pad, the chain, the bonding
// curve, the valuation and the migration pool are all facts of a single
// observation; nothing here waits on a second one.

export const STAGE_ORDER = ['newCreations', 'aboutGraduates', 'graduates']

export default function GraduationStageLists({ funnel = [], stageLabel, emptyNote = null, near = 80, t }) {
  const byStage = new Map((Array.isArray(funnel) ? funnel : []).filter(row => row?.stage).map(row => [row.stage, row]))

  return (
    <div className="space-y-4" data-testid="graduation-stage-lists">
      {STAGE_ORDER.map(stage => {
        const entry = byStage.get(stage)
        const contracts = Array.isArray(entry?.contracts) ? entry.contracts : []
        const count = num(entry?.count) ?? 0
        const graduates = stage === 'graduates'
        const columns = [
          t('graduation.col_symbol', { defaultValue: 'Symbol' }),
          t('graduation.col_name', { defaultValue: 'Name' }),
          t('graduation.col_launchpad', { defaultValue: 'Launchpad' }),
          t('graduation.col_chain', { defaultValue: 'Chain' }),
          t('graduation.col_contract', { defaultValue: 'Contract' }),
          t('graduation.col_progress', { defaultValue: 'Bonding progress' }),
          t('graduation.col_value', { defaultValue: 'Market cap or FDV' }),
          ...(graduates ? [t('graduation.col_migration_pool', { defaultValue: 'Migration pool' })] : []),
          t('graduation.col_first_seen', { defaultValue: 'First seen (UTC)' }),
        ]
        const valueIndex = 6
        const span = columns.length
        const caption = `${t('graduation.stage_caption', {
          stage: stageLabel(stage), shown: fmtNum(contracts.length), count: fmtNum(count),
          defaultValue: '{{stage}}: {{shown}} of the {{count}} contracts the newest capture placed at this stage, drawn so no single launchpad fills the list.',
        })}${entry?.contractsTruncated
          ? ` ${t('graduation.stage_truncated', { defaultValue: 'The stage is larger than the sample, so this is a bounded view of it and never the whole stage.' })}`
          : ''}`

        return (
          <div className="overflow-x-auto" key={stage}>
            <table className="w-full text-[12px]" data-testid={`graduation-stage-${stage}`}>
              <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">{caption}</caption>
              <thead>
                <BoardTableHeader columns={columns} numeric={[valueIndex]} />
              </thead>
              <tbody>
                {contracts.length ? contracts.map((row, index) => (
                  <tr key={`${row?.chain}-${row?.contractAddress}-${index}`}>
                    <th scope="row" className={`text-left font-normal text-[var(--fg-2)] ${BOARD_CELL_CLASS}`}>
                      <AssetName row={row} t={t} />
                    </th>
                    <td className={BOARD_CELL_CLASS}>{row?.name || '—'}</td>
                    <td className={BOARD_CELL_CLASS}>{padLabel(row) || '—'}</td>
                    <td className={BOARD_CELL_CLASS}>{chainLabel(row?.chain)}</td>
                    <td className={BOARD_CELL_CLASS}><ContractCell row={row} t={t} /></td>
                    <td className={BOARD_CELL_CLASS}><BondingProgress pct={row?.graduationPct} near={near} t={t} /></td>
                    <td className={`intel-number ${BOARD_CELL_CLASS}`}><ValueCell row={row} t={t} /></td>
                    {graduates
                      ? <td className={BOARD_CELL_CLASS}>
                        {row?.migrationPool
                          ? <code title={row.migrationPool} className="font-mono text-[var(--fg-2)]">{row.migrationPool.length <= 16 ? row.migrationPool : `${row.migrationPool.slice(0, 8)}…${row.migrationPool.slice(-6)}`}</code>
                          : '—'}
                      </td>
                      : null}
                    <td className={BOARD_CELL_CLASS}>{stamp(row?.firstSeenAt)}</td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan={span} className="py-2 text-[var(--fg-4)]">
                      {emptyNote || t('graduation.stage_list_empty', { defaultValue: 'The newest capture placed no contract at this stage.' })}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}
