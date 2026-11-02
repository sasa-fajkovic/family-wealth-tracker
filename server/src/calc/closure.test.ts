import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isActiveInMonth, hasRecordedClosingZero } from './closure.js'
import { locfFill, aggregateSummary, observationCoverage } from './summary.js'
import { buildProjection } from './projections.js'
import type { Asset, Category, DataPoint } from '../models/index.js'

const category: Category = { id: 'stock', name: 'Stock', color: '#123456', type: 'asset', projected_yearly_growth: 0 }
const asset: Asset = { id: 'account', name: 'Account', category_id: 'stock', person_id: 'person', projected_yearly_growth: null, created_at: '2024-01-01T00:00:00Z' }
const point = (year_month: string, value: number, asset_id = 'account', updated_at = '2024-01-01T00:00:00Z'): DataPoint => ({ id: `${asset_id}-${year_month}-${updated_at}`, asset_id, year_month, value, created_at: '2024-01-01T00:00:00Z', updated_at })

for (const closed_at of [undefined, null]) {
  test(`legacy ${closed_at} closure remains open in all months`, () => {
    assert.equal(isActiveInMonth({ closed_at }, '2024-01'), true)
    assert.equal(isActiveInMonth({ closed_at }, '2099-12'), true)
  })
}

test('closing month is inclusive and the next month is inactive across a year boundary', () => {
  assert.equal(isActiveInMonth({ closed_at: '2024-12' }, '2024-11'), true)
  assert.equal(isActiveInMonth({ closed_at: '2024-12' }, '2024-12'), true)
  assert.equal(isActiveInMonth({ closed_at: '2024-12' }, '2025-01'), false)
})

test('an earlier carried zero is insufficient and duplicate closing records use latest timestamp instant', () => {
  const closed = { ...asset, closed_at: '2024-02' }
  assert.equal(hasRecordedClosingZero(closed, [point('2024-01', 0)]), false)
  const records = [point('2024-02', 100, 'account', '2024-02-02T01:00:00+02:00'), point('2024-02', 0, 'account', '2024-02-01T23:30:00Z')]
  assert.equal(hasRecordedClosingZero(closed, records), true)
  assert.equal(hasRecordedClosingZero(closed, records.reverse()), true)
})

test('closed stock preserves historical values and closing zero, then hides inactive metadata and current breakdown', () => {
  const closed = { ...asset, closed_at: '2024-02' }
  const months = ['2024-01', '2024-02', '2024-03', '2024-04']
  const points = [point('2024-01', 100), point('2024-02', 0), point('2024-03', 0)]
  const result = aggregateSummary([closed], [category], locfFill(months, points, [closed]), months, 'stock', points)
  assert.deepEqual(result.totals, [100, 0, 0, 0])
  assert.deepEqual(result.asset_series[0].observation_months, ['2024-01', '2024-02', null, null])
  assert.deepEqual(result.asset_series[0].observation_status, ['observed', 'observed', 'missing', 'missing'])
  assert.equal(result.asset_series[0].closed_at, '2024-02')
  assert.deepEqual(result.asset_breakdown, [])
  assert.deepEqual(result.coverage, { observed: 0, carried: 0, missing: 0, total: 0 })
  assert.deepEqual(observationCoverage([closed], [category], points, '2024-04'), result.coverage)
  assert.equal(result.period_delta_available, true)
  assert.equal(result.period_delta_abs, -100)
})

test('all-closed loan portfolio retains a known zero endpoint and available historical payoff change', () => {
  const closed = { ...asset, closed_at: '2024-02' }
  const debt: Category = { ...category, type: 'liability' }
  const months = ['2024-01', '2024-02', '2024-03']
  const points = [point('2024-01', -100), point('2024-02', 0)]
  const result = aggregateSummary([closed], [debt], locfFill(months, points, [closed]), months, 'stock', points)
  assert.equal(result.current_total, 0)
  assert.equal(result.period_delta_available, true)
  assert.equal(result.period_delta_pct_available, true)
  assert.equal(result.period_start_month, '2024-01')
  assert.equal(result.period_delta_abs, 100)
  assert.equal(result.period_delta_pct, -100)
  assert.equal(result.asset_series[0].observation_status[2], 'missing')
})

test('a closing month still appears in endpoint breakdown and completion', () => {
  const closed = { ...asset, closed_at: '2024-02' }
  const points = [point('2024-01', 100), point('2024-02', 0)]
  const months = ['2024-01', '2024-02']
  const result = aggregateSummary([closed], [category], locfFill(months, points, [closed]), months, 'stock', points)
  assert.equal(result.asset_breakdown.length, 1)
  assert.equal(result.asset_breakdown[0].value, 0)
  assert.deepEqual(result.coverage, { observed: 1, carried: 0, missing: 0, total: 1 })
})

test('closed income retains period income and source breakdown, including recorded zero, but not active completion', () => {
  const closed = { ...asset, closed_at: '2024-02' }
  const income: Category = { ...category, type: 'cash-inflow' }
  const points = [point('2024-01', 100), point('2024-02', 200), point('2024-03', 0)]
  const months = ['2024-01', '2024-02', '2024-03']
  const result = aggregateSummary([closed], [income], locfFill(months, points, [closed], 'flow'), months, 'flow', points)
  assert.deepEqual(result.totals, [100, 200, 0])
  assert.equal(result.current_total, 300)
  assert.equal(result.asset_breakdown[0].value, 300)
  assert.deepEqual(result.asset_series[0].observation_status, ['observed', 'observed', 'missing'])
  assert.equal(result.coverage.total, 0)
  const later = ['2024-03', '2024-04']
  const inactive = aggregateSummary([closed], [income], locfFill(later, points, [closed], 'flow'), later, 'flow', points)
  assert.equal(inactive.current_total, 0)
  assert.deepEqual(inactive.asset_breakdown, [])
})

test('future closure projects through the closing zero and is unavailable afterward without changing current state early', () => {
  const closed = { ...asset, closed_at: '2024-03' }
  const points = [point('2024-01', 100), point('2024-03', 0)]
  const result = buildProjection([closed], [category], points, 1, 1, '2024-01')
  assert.deepEqual(result.totals.slice(0, 4), [50, 0, 0, 0])
  assert.deepEqual(result.available.slice(0, 4), [true, true, false, false])
  assert.equal(result.asset_metadata[0].closed_at, '2024-03')
  assert.equal(result.asset_metadata[0].projection_start_month, '2024-02')
  assert.equal(isActiveInMonth(closed, '2024-01'), true)
})

test('past closures are omitted from assumptions metadata while a closure at asOf has no future contribution', () => {
  const closed = { ...asset, closed_at: '2024-02' }
  const points = [point('2024-01', 100), point('2024-02', 0)]
  const boundary = buildProjection([closed], [category], points, 1, 1, '2024-02')
  assert.equal(boundary.asset_metadata.length, 1)
  assert.equal(boundary.asset_metadata[0].projection_start_month, null)
  assert.ok(boundary.available.every(value => value === false))
  const past = buildProjection([closed], [category], points, 1, 1, '2024-03')
  assert.deepEqual(past.asset_metadata, [])
  assert.ok(past.totals.every(value => value === 0))
  assert.ok(past.available.every(value => value === false))
})

test('projection-only closure waits for an explicit future closing zero and never realizes ignored estimates', () => {
  const closed = { ...asset, closed_at: '2024-03', include_in_current_wealth: false }
  const result = buildProjection([closed], [category], [point('2024-01', 999), point('2024-03', 0)], 1, 1, '2024-01')
  assert.deepEqual(result.totals.slice(0, 3), [0, 0, 0])
  assert.deepEqual(result.available.slice(0, 3), [false, true, false])
  assert.equal(result.asset_metadata[0].projection_start_month, '2024-03')
})
