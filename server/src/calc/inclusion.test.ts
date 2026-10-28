import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveInclusion } from './inclusion.js'
import { buildProjection, compoundMonthlyRate } from './projections.js'
import type { Asset, Category, DataPoint } from '../models/index.js'

const category: Category = { id: 'stock', name: 'Stock', type: 'asset', color: '#123456', projected_yearly_growth: 0 }
const asset: Asset = { id: 'account', name: 'Account', category_id: 'stock', person_id: 'person', projected_yearly_growth: null, created_at: '2024-01-01T00:00:00Z' }
const point = (year_month: string, value: number, asset_id = 'account'): DataPoint => ({ id: `${asset_id}-${year_month}`, asset_id, year_month, value, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' })

for (const [flags, overrides, expected] of [
  [{}, {}, [true, true]],
  [{ include_in_current_wealth: false, include_in_projections: false }, {}, [false, false]],
  [{ include_in_current_wealth: false, include_in_projections: true }, { include_in_current_wealth: null, include_in_projections: null }, [false, true]],
  [{ include_in_current_wealth: true, include_in_projections: false }, { include_in_current_wealth: null, include_in_projections: null }, [true, false]],
  [{ include_in_current_wealth: false, include_in_projections: false }, { include_in_current_wealth: true, include_in_projections: true }, [true, true]],
  [{ include_in_current_wealth: true, include_in_projections: true }, { include_in_current_wealth: false, include_in_projections: false }, [false, false]],
  [{ include_in_current_wealth: false, include_in_projections: false }, { include_in_current_wealth: true, include_in_projections: false }, [true, false]],
  [{ include_in_current_wealth: false, include_in_projections: false }, { include_in_current_wealth: false, include_in_projections: true }, [false, true]],
] as const) {
  test(`inclusion inheritance ${JSON.stringify(flags)} / ${JSON.stringify(overrides)}`, () => {
    const resolved = resolveInclusion({ ...asset, ...overrides }, { ...category, ...flags })
    assert.deepEqual([resolved.effective_include_in_current_wealth, resolved.effective_include_in_projections], expected)
  })
}

for (const current of [false, true]) for (const projected of [false, true]) {
  test(`projection matrix current=${current} projection=${projected}`, () => {
    const configured = { ...category, include_in_current_wealth: current, include_in_projections: projected }
    const result = buildProjection([asset], [configured], [point('2024-06', 100), point('2024-08', 300)], 1, 1, '2024-06')
    assert.deepEqual(result.series[0].values.slice(0, 3), projected ? current ? [200, 300, 300] : [0, 300, 300] : [0, 0, 0])
    assert.deepEqual(result.series[0].available.slice(0, 3), projected ? current ? [true, true, true] : [false, true, true] : [false, false, false])
    assert.deepEqual(result.available, result.series[0].available)
    assert.equal(result.asset_metadata[0].projection_start_month, projected ? current ? '2024-07' : '2024-08' : null)
  })
}

test('projection-only ignores every past and asOf value without interpolating before the first future point', () => {
  const configured = { ...category, include_in_current_wealth: false }
  const result = buildProjection([asset], [configured], [point('2024-01', 99999), point('2024-06', 88888), point('2024-09', 300), point('2024-11', 500)], 1, 1, '2024-06')
  assert.deepEqual(result.totals.slice(0, 6), [0, 0, 300, 400, 500, 500])
  assert.deepEqual(result.available.slice(0, 6), [false, false, true, true, true, true])
  assert.deepEqual(result.asset_metadata[0], { asset_id: 'account', category_id: 'stock', closed_at: null, effective_include_in_current_wealth: false, effective_include_in_projections: true, projection_start_month: '2024-09' })
})

test('projection-only explicit zero at the next-month boundary is available and subsequent plans interpolate', () => {
  const result = buildProjection([asset], [{ ...category, include_in_current_wealth: false }], [point('2024-06', 999), point('2024-07', 0), point('2024-09', 400)], 1, 1, '2024-06')
  assert.deepEqual(result.totals.slice(0, 4), [0, 200, 400, 400])
  assert.deepEqual(result.available.slice(0, 4), [true, true, true, true])
  assert.equal(result.asset_metadata[0].projection_start_month, '2024-07')
})

test('projection-only with no future point remains unknown zero for the full horizon', () => {
  const result = buildProjection([asset], [{ ...category, include_in_current_wealth: false }], [point('2024-01', 100), point('2024-06', 200)], 1, 1, '2024-06')
  assert.ok(result.totals.every(value => value === 0))
  assert.ok(result.available.every(value => value === false))
  assert.equal(result.asset_metadata[0].projection_start_month, null)
})

test('a first future point beyond the horizon never seeds or creates a leading ramp', () => {
  const result = buildProjection([asset], [{ ...category, include_in_current_wealth: false }], [point('2024-06', 100), point('2026-01', 200)], 1, 1, '2024-06')
  assert.ok(result.totals.every(value => value === 0))
  assert.ok(result.available.every(value => value === false))
  assert.equal(result.asset_metadata[0].projection_start_month, '2026-01')
})

test('normal current balances remain available while a same-category projection-only asset waits', () => {
  const later: Asset = { ...asset, id: 'later', include_in_current_wealth: false }
  const result = buildProjection([asset, later], [category], [point('2024-06', 100), point('2024-06', 99999, 'later'), point('2024-09', 300, 'later')], 1, 1, '2024-06')
  assert.deepEqual(result.totals.slice(0, 4), [100, 100, 400, 400])
  assert.deepEqual(result.available.slice(0, 4), [true, true, true, true])
})

test('projection-only liabilities wait for the first future liability value and compound from it', () => {
  const debt: Category = { ...category, type: 'liability', projected_yearly_growth: -0.12, include_in_current_wealth: false }
  const result = buildProjection([asset], [debt], [point('2024-06', -999), point('2024-08', -300)], 1, 0.5, '2024-06')
  assert.deepEqual(result.totals.slice(0, 2), [0, -300])
  assert.ok(Math.abs(result.totals[2] - -300 * (1 + compoundMonthlyRate(-0.06))) < 0.000001)
  assert.deepEqual(result.available.slice(0, 3), [false, true, true])
})

test('income is never a wealth or projection contribution even with explicit enabled overrides', () => {
  const income: Category = { ...category, type: 'cash-inflow', include_in_current_wealth: true, include_in_projections: true }
  const configured = { ...asset, include_in_current_wealth: true, include_in_projections: true }
  assert.deepEqual(resolveInclusion(configured, income), { effective_include_in_current_wealth: false, effective_include_in_projections: false })
  const result = buildProjection([configured], [income], [point('2024-06', 100), point('2024-08', 200)], 1, 1, '2024-06')
  assert.ok(result.totals.every(value => value === 0))
  assert.ok(result.available.every(value => value === false))
})

test('advancing asOf past a projection-only plan never realizes it as current wealth automatically', () => {
  const configured = { ...asset, include_in_current_wealth: false, include_in_projections: true }
  const points = [point('2024-06', 999), point('2024-07', 300)]
  const before = JSON.stringify({ configured, points })
  const first = buildProjection([configured], [category], points, 1, 1, '2024-06')
  assert.equal(first.totals[0], 300)
  assert.equal(first.available[0], true)
  const next = buildProjection([configured], [category], points, 1, 1, '2024-07')
  assert.ok(next.totals.every(value => value === 0))
  assert.ok(next.available.every(value => value === false))
  assert.equal(next.asset_metadata[0].projection_start_month, null)
  assert.equal(next.asset_metadata[0].effective_include_in_current_wealth, false)
  assert.equal(JSON.stringify({ configured, points }), before)
})
