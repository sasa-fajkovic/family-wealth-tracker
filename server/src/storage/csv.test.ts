import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeDataPoints, encodeDataPoints } from './csv.js'

const header = 'id,asset_id,year_month,value,notes,created_at,updated_at\n'
const stamp = '2024-01-01T00:00:00Z'
const row = `p1,account,2024-01,1,note,${stamp},${stamp}\n`
for (const [name, raw] of [
  ['short row', header + 'bad,row\n'],
  ['long row', header + row.trim() + ',extra\n'],
  ['unterminated quote', header + `p1,account,2024-01,1,"note,${stamp},${stamp}`],
  ['quote in unquoted field', header + row.replace('note', 'a"b')],
  ['characters after closing quote', header + row.replace('note', '"note"extra')],
  ['second quoted field without delimiter', header + row.replace('note', '"note""')],
  ['blank value', header + row.replace(',1,', ', ,')],
  ['hexadecimal value', header + row.replace(',1,', ',0xff,')],
  ['invalid UTC offset', header + row.replaceAll(stamp, '2024-01-01T00:00:00+99:99')],
  ['non-numeric value', header + row.replace(',1,', ',abc,')],
  ['nonfinite value', header + row.replace(',1,', ',1e999,')],
  ['invalid date', header + row.replaceAll(stamp, 'yesterday')],
] as const) {
  test(`CSV rejects ${name} instead of dropping or changing a row`, () => assert.throws(() => decodeDataPoints(raw)))
}

test('CSV preserves escaped quotes, commas, newlines and explicit zero/negative values', () => {
  const points = [0, -15].map((value, i) => ({ id: `p${i}`, asset_id: 'account', year_month: `2024-0${i + 1}`, value,
    notes: 'a "quote", and\na newline', created_at: stamp, updated_at: stamp }))
  assert.deepEqual(decodeDataPoints(encodeDataPoints(points)), points)
})

test('CSV quotes identifiers when re-encoding accepted legacy record IDs', () => {
  const point = { id: 'legacy,"id', asset_id: 'account', year_month: '2024-01', value: 1, created_at: stamp, updated_at: stamp }
  assert.deepEqual(decodeDataPoints(encodeDataPoints([point])), [point])
})
