import { describe, it, expect, vi } from 'vitest'

// portfolio-api pulls in the app Supabase client; the CSV helpers never touch it.
vi.mock('../../../lib/supabase', () => ({ getAuthenticatedAccessToken: async () => null, supabase: {} }))

const {
  buildTableCsv, tableCsvFilename, tableCsvColumns, exportAllowedFrom,
  UNIVERSE_TYPE_CSV_COLUMNS, RWA_LIST_CSV_COLUMNS,
} = await import('../table-csv.js')

const cols = [
  { key: 'name', label: 'Name', value: (r) => r.name },
  { key: 'price', label: 'Price (USD)', cmcRaw: true, value: (r) => r.price },
  { key: 'premium', label: 'Premium bps', value: (r) => r.premium },
]
const lines = (csv) => csv.split('\n')

describe('buildTableCsv', () => {
  it('writes the column labels as the header row', () => {
    expect(lines(buildTableCsv({ columns: cols, rows: [] }))[0]).toBe('Name,Price (USD),Premium bps')
  })

  it('blanks cmcRaw columns when exportAllowed is false or missing, and for anything but true', () => {
    const rows = [{ name: 'Gold', price: 2400.5, premium: 12 }]
    for (const exportAllowed of [false, undefined, null, 'true', 1]) {
      expect(lines(buildTableCsv({ columns: cols, rows, exportAllowed }))[1]).toBe('Gold,,12')
    }
  })

  it('keeps cmcRaw columns when exportAllowed is exactly true', () => {
    expect(lines(buildTableCsv({ columns: cols, rows: [{ name: 'Gold', price: 2400.5, premium: -3 }], exportAllowed: true }))[1]).toBe('Gold,2400.5,-3')
  })

  it('writes null and undefined as empty cells', () => {
    expect(lines(buildTableCsv({ columns: cols, rows: [{ name: null, price: undefined }], exportAllowed: true }))[1]).toBe(',,')
  })

  it('defuses spreadsheet formulas, including tab and carriage return openers', () => {
    const rows = ['=SUM(A1)', '+1+1', '-2+cmd', '@A1', '\tx', '\r=1', '  =x'].map((name) => ({ name }))
    const out = lines(buildTableCsv({ columns: [cols[0]], rows }))
    expect(out[1]).toBe("'=SUM(A1)")
    expect(out[2]).toBe("'+1+1")
    expect(out[3]).toBe("'-2+cmd")
    expect(out[4]).toBe("'@A1")
    expect(out[5]).toBe("'\tx")
    // A CR forces quoting as well as the prefix.
    expect(buildTableCsv({ columns: [cols[0]], rows: [rows[5]] })).toBe(`Name\n"'\r=1"`)
    expect(out.at(-1)).toBe("'  =x")
  })

  it('keeps signed numbers and numeric strings as numbers', () => {
    expect(lines(buildTableCsv({ columns: [cols[2]], rows: [{ premium: -12.5 }, { premium: '-4' }] })).slice(1)).toEqual(['-12.5', '-4'])
  })

  it('quotes commas, quotes and line breaks', () => {
    expect(lines(buildTableCsv({ columns: [cols[0]], rows: [{ name: 'A, "B"' }] }))[1]).toBe('"A, ""B"""')
  })

  it('appends captured_at and source when the rows carry them', () => {
    const csv = buildTableCsv({ columns: [cols[0]], rows: [{ name: 'Gold', capturedAt: '2026-09-22T10:00:00Z', source: { provider: 'coinmarketcap' } }] })
    expect(lines(csv)).toEqual(['Name,captured_at,source', 'Gold,2026-09-22T10:00:00Z,coinmarketcap'])
    expect(lines(buildTableCsv({ columns: [cols[0]], rows: [{ name: 'Gold' }] }))[0]).toBe('Name')
    expect(tableCsvColumns([{ key: 'source', label: 'Src' }], [{ source: 'x' }]).map((c) => c.label)).toEqual(['Src'])
  })
})

describe('tableCsvFilename', () => {
  const now = new Date('2026-09-22T12:34:56Z')
  it('uses the as-of time, or today', () => {
    expect(tableCsvFilename('rwa-universe', '2026-09-21T07:07:00.000Z', now)).toBe('rwa-universe-2026-09-21T07-07-00.csv')
    expect(tableCsvFilename('rwa-universe', null, now)).toBe('rwa-universe-2026-09-22.csv')
  })
  it('sanitises the view and a non-date as-of', () => {
    expect(tableCsvFilename('../etc/pass wd<>', null, now)).toBe('etc-pass-wd-2026-09-22.csv')
    expect(tableCsvFilename('', 'page 2/../x', now)).toBe('table-page-2-.-x.csv')
    expect(tableCsvFilename('a:b\\c', undefined, now)).toMatch(/^a-b-c-2026-09-22\.csv$/)
  })
})

describe('column specs', () => {
  it('reads the source policy flag fail closed', () => {
    expect(exportAllowedFrom({ sourcePolicy: { exportAllowed: true } })).toBe(true)
    expect(exportAllowedFrom({ sourcePolicy: { exportAllowed: 'true' } })).toBe(false)
    expect(exportAllowedFrom({})).toBe(false)
    expect(exportAllowedFrom(null)).toBe(false)
  })

  it('universe export keeps counts and our own change, blanks CMC money without a licence', () => {
    const row = { type: 'commodity', typeLabel: 'Commodities', assetCount: 40, assetsScanned: 40, assetsWithTokens: 12, totalMarketValueUsd: 1e9, volume24hUsd: 5e6, change24hPct: 1.5, change24hSource: 'our_snapshots', capturedAt: '2026-09-22T07:00:00Z', source: 'coinmarketcap' }
    const [head, body] = lines(buildTableCsv({ columns: UNIVERSE_TYPE_CSV_COLUMNS, rows: [row] }))
    expect(head.split(',').at(-2)).toBe('captured_at')
    expect(body).toBe('commodity,Commodities,40,40,12,,,,1.5,our_snapshots,,,,2026-09-22T07:00:00Z,coinmarketcap')
    expect(lines(buildTableCsv({ columns: UNIVERSE_TYPE_CSV_COLUMNS, rows: [row], exportAllowed: true }))[1]).toContain(',1000000000,5000000,')
  })

  it('rwa list export blanks the three tokenised money columns without a licence', () => {
    const row = { rwa_id: 7, name: 'Alphabet', symbol: 'GOOGL', asset_type: 'stock', has_tokens: true, quote: { average_tokenized_price: 180, tokenized_market_cap: 2e6, tokenized_volume_24h: 3e4, last_updated: '2026-09-22T06:00:00Z' } }
    expect(lines(buildTableCsv({ columns: RWA_LIST_CSV_COLUMNS, rows: [row] }))[1]).toBe('7,Alphabet,GOOGL,stock,true,,,,2026-09-22T06:00:00Z')
    expect(lines(buildTableCsv({ columns: RWA_LIST_CSV_COLUMNS, rows: [row], exportAllowed: true }))[1]).toBe('7,Alphabet,GOOGL,stock,true,180,2000000,30000,2026-09-22T06:00:00Z')
  })
})
