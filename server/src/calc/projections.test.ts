import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { compoundMonthlyRate, resolveGrowthRate, buildProjection } from './projections.js'
import type { Asset, Category, DataPoint } from '../models/index.js'

// ── Fixture helpers ────────────────────────────────────────────────────────────

function makeCategory(id: string, growth: number, color = '#000000'): Category {
  return { id, name: id, projected_yearly_growth: growth, color, type: 'asset' }
}

function makeAsset(id: string, categoryId = 'cat1', growth: number | null = null): Asset {
  return { id, name: id, category_id: categoryId, projected_yearly_growth: growth,
           person_id: 'test-person', created_at: '2024-01-01T00:00:00.000Z' }
}

function makeDP(assetId: string, yearMonth: string, value: number, updatedAt = '2024-01-01T00:00:00.000Z'): DataPoint {
  return { id: `dp-${assetId}-${yearMonth}`, asset_id: assetId, year_month: yearMonth,
           value, created_at: '2024-01-01T00:00:00.000Z', updated_at: updatedAt }
}

// ── compoundMonthlyRate ────────────────────────────────────────────────────────

describe('compoundMonthlyRate', () => {
  test('0% annual rate returns exactly 0', () => {
    assert.equal(compoundMonthlyRate(0), 0)
  })

  test('8% annual → ~0.006434 per month (not simple division 0.006667)', () => {
    const rate = compoundMonthlyRate(0.08)
    assert.ok(Math.abs(rate - 0.006434) < 0.000001, `expected ≈0.006434 got ${rate}`)
    assert.ok(rate < 0.00667, 'must be less than simple division 0.006667')
  })

  test('12-month compound at 8% annual equals seed * 1.08 within 0.01%', () => {
    const seed = 1000
    const monthlyRate = compoundMonthlyRate(0.08)
    let v = seed
    for (let i = 0; i < 12; i++) v = v * (1 + monthlyRate)
    assert.ok(Math.abs(v - 1080) < 0.01, `expected ≈1080 got ${v}`)
  })
})

// ── resolveGrowthRate ─────────────────────────────────────────────────────────

describe('resolveGrowthRate', () => {
  test('asset-level override wins over category rate', () => {
    const asset = makeAsset('a1', 'cat1', 0.10)
    const cat = makeCategory('cat1', 0.07)
    assert.equal(resolveGrowthRate(asset, [cat]), 0.10)
  })

  test('null asset growth inherits category projected_yearly_growth', () => {
    const asset = makeAsset('a1', 'cat1', null)
    const cat = makeCategory('cat1', 0.07)
    assert.equal(resolveGrowthRate(asset, [cat]), 0.07)
  })

  test('null asset growth with missing category defaults to 0', () => {
    const asset = makeAsset('a1', 'cat-missing', null)
    assert.equal(resolveGrowthRate(asset, []), 0)
  })

  test('explicit 0 override is NOT null — returns 0 not category rate', () => {
    const asset = makeAsset('a1', 'cat1', 0)  // explicit zero: projected_yearly_growth = 0
    const cat = makeCategory('cat1', 0.07)
    assert.equal(resolveGrowthRate(asset, [cat]), 0,
      'zero is a valid explicit override — must not fall through to category rate')
  })
})

// ── buildProjection ───────────────────────────────────────────────────────────

describe('buildProjection', () => {
  test('years=1 generates exactly 12 projection months', () => {
    const cat = makeCategory('cat1', 0.08)
    const asset = makeAsset('a1', 'cat1')
    const dp = makeDP('a1', '2024-03', 1000)
    const result = buildProjection([asset], [cat], [dp], 1)
    assert.equal(result.months.length, 12, 'years=1 must produce 12 months')
  })

  test('years=30 generates exactly 360 projection months', () => {
    const cat = makeCategory('cat1', 0.07)
    const asset = makeAsset('a1', 'cat1')
    const dp = makeDP('a1', '2024-01', 5000)
    const result = buildProjection([asset], [cat], [dp], 30)
    assert.equal(result.months.length, 360, 'years=30 must produce 360 months')
  })

  test('projection starts after asOf even when observations are stale', () => {
    const cat = makeCategory('cat1', 0.07)
    const asset = makeAsset('a1', 'cat1')
    const dp = makeDP('a1', '2024-06', 1000)
    const result = buildProjection([asset], [cat], [dp], 1, 1, '2025-05')
    assert.equal(result.months[0], '2025-06')
    assert.equal(result.asOf, '2025-05')
  })

  test('December boundary: projection months[0] after 2024-12 is 2025-01', () => {
    const cat = makeCategory('cat1', 0.05)
    const asset = makeAsset('a1', 'cat1')
    const dp = makeDP('a1', '2024-12', 2000)
    const result = buildProjection([asset], [cat], [dp], 1, 1, '2024-12')
    assert.equal(result.months[0], '2025-01', 'December to January rollover must work')
  })

  test('12-month compound at 8% annual: final value = seed * 1.08 within 0.01', () => {
    const seed = 10000
    const cat = makeCategory('cat1', 0.08)
    const asset = makeAsset('a1', 'cat1', null)  // inherits 0.08 from category
    const dp = makeDP('a1', '2024-01', seed)
    const result = buildProjection([asset], [cat], [dp], 1)
    const finalValue = result.series[0].values[11]  // last of 12 months
    assert.ok(Math.abs(finalValue - seed * 1.08) < 0.01,
      `expected ≈${seed * 1.08} got ${finalValue}`)
  })

  test('asset with no data points: all projected values are 0 (seed=0)', () => {
    const cat = makeCategory('cat1', 0.08)
    const asset = makeAsset('a1', 'cat1')
    // No data points for asset
    const result = buildProjection([asset], [cat], [], 1)
    const allZero = result.series[0].values.every(v => v === 0)
    assert.ok(allZero, 'zero seed * any growth rate = 0 for all months')
  })

  test('seed upsert: among same year_month DPs, latest updated_at wins', () => {
    const cat = makeCategory('cat1', 0.0)
    const asset = makeAsset('a1', 'cat1', 0)  // explicit 0% override
    // Two DPs for same month — later updated_at should win
    const earlyDP = makeDP('a1', '2024-03', 500,  '2024-03-01T00:00:00.000Z')
    const lateDP  = makeDP('a1', '2024-03', 9999, '2024-03-15T00:00:00.000Z')
    const result = buildProjection([asset], [cat], [earlyDP, lateDP], 1)
    // With 0% growth, value[0] = seed * (1 + 0)^1 = seed * 1 = seed
    assert.ok(Math.abs(result.series[0].values[0] - 9999) < 0.001,
      `seed must be 9999 (later updated_at wins), got ${result.series[0].values[0]}`)
  })

  test('empty category (no assets) produces all-zero values[] entry in series', () => {
    const cat1 = makeCategory('cat1', 0.08)
    const cat2 = makeCategory('cat2', 0.07)  // no assets
    const asset = makeAsset('a1', 'cat1')
    const dp = makeDP('a1', '2024-01', 5000)
    const result = buildProjection([asset], [cat1, cat2], [dp], 1)
    assert.equal(result.series.length, 2, 'series must have one entry per category')
    const cat2Series = result.series.find(s => s.category_id === 'cat2')!
    assert.ok(cat2Series, 'cat2 series must exist even with no assets')
    assert.ok(cat2Series.values.every(v => v === 0), 'empty category must have all-zero values')
  })

  test('totals[i] equals sum of all series values at index i', () => {
    const cat1 = makeCategory('cat1', 0.0)
    const cat2 = makeCategory('cat2', 0.0)
    const a1 = makeAsset('a1', 'cat1', 0)
    const a2 = makeAsset('a2', 'cat2', 0)
    const dp1 = makeDP('a1', '2024-01', 1000)
    const dp2 = makeDP('a2', '2024-01', 2000)
    const result = buildProjection([a1, a2], [cat1, cat2], [dp1, dp2], 1)
    // With 0% growth: values stay at seed each month
    // totals[0] should equal series[0].values[0] + series[1].values[0]
    const expectedTotal = result.series.reduce((sum, s) => sum + s.values[0], 0)
    assert.ok(Math.abs(result.totals[0] - expectedTotal) < 0.001,
      `totals[0] must equal sum of series values at index 0`)
  })
})

// ── rateMultiplier (scenario) ──────────────────────────────────────────────────

describe('buildProjection rateMultiplier', () => {
  test('base (multiplier=1.0) matches default behaviour', () => {
    const cat = makeCategory('cat1', 0.08)
    const asset = makeAsset('a1', 'cat1', null)
    const dp = makeDP('a1', '2024-01', 10000)
    const base = buildProjection([asset], [cat], [dp], 1)
    const explicit = buildProjection([asset], [cat], [dp], 1, 1.0)
    assert.ok(Math.abs(base.series[0].values[11] - explicit.series[0].values[11]) < 0.0001,
      'explicit 1.0 multiplier must equal no-arg default')
  })

  test('conservative (0.5×) produces lower values than base', () => {
    const seed = 10000
    const cat = makeCategory('cat1', 0.08)
    const asset = makeAsset('a1', 'cat1', null)
    const dp = makeDP('a1', '2024-01', seed)
    const base = buildProjection([asset], [cat], [dp], 1, 1.0)
    const conservative = buildProjection([asset], [cat], [dp], 1, 0.5)
    assert.ok(conservative.series[0].values[11] < base.series[0].values[11],
      'conservative must produce lower final value than base')
    // 0.5 × 8% = 4% annual → after 12 months ≈ seed * 1.04
    assert.ok(Math.abs(conservative.series[0].values[11] - seed * 1.04) < 0.1,
      'conservative 0.5×8% ≈ 4% annual growth')
  })

  test('aggressive (1.5×) produces higher values than base', () => {
    const seed = 10000
    const cat = makeCategory('cat1', 0.08)
    const asset = makeAsset('a1', 'cat1', null)
    const dp = makeDP('a1', '2024-01', seed)
    const base = buildProjection([asset], [cat], [dp], 1, 1.0)
    const aggressive = buildProjection([asset], [cat], [dp], 1, 1.5)
    assert.ok(aggressive.series[0].values[11] > base.series[0].values[11],
      'aggressive must produce higher final value than base')
    // 1.5 × 8% = 12% annual → after 12 months ≈ seed * 1.12
    assert.ok(Math.abs(aggressive.series[0].values[11] - seed * 1.12) < 0.1,
      'aggressive 1.5×8% ≈ 12% annual growth')
  })

  test('zero growth rate is unaffected by any multiplier', () => {
    const cat = makeCategory('cat1', 0.0)
    const asset = makeAsset('a1', 'cat1', 0) // explicit 0%
    const dp = makeDP('a1', '2024-01', 5000)
    const conservative = buildProjection([asset], [cat], [dp], 1, 0.5)
    const aggressive = buildProjection([asset], [cat], [dp], 1, 1.5)
    // 0 × any multiplier = 0, so seed stays constant
    assert.ok(Math.abs(conservative.series[0].values[0] - 5000) < 0.001,
      'zero growth with conservative: value stays at seed')
    assert.ok(Math.abs(aggressive.series[0].values[0] - 5000) < 0.001,
      'zero growth with aggressive: value stays at seed')
  })
})

describe('buildProjection floors values at 0', () => {
  test('asset with steep negative rate never goes below 0 (cars depreciate to 0, not negative)', () => {
    const cat = makeCategory('vehicles', -0.20) // -20%/yr depreciation
    const asset = makeAsset('car', 'vehicles')
    const dp = makeDP('car', '2024-01', 10000)
    const proj = buildProjection([asset], [cat], [dp], 30, 1.0) // 30 years far past asymptote
    for (const v of proj.series[0].values) {
      assert.ok(v >= 0, `expected non-negative asset value, got ${v}`)
    }
    // sanity: still trending down — last value is much smaller than seed
    assert.ok(proj.series[0].values.at(-1)! < 100)
  })

  test('rejects invalid and scenario-adjusted effective rates', () => {
    const asset = makeAsset('car', 'vehicles')
    const dp = makeDP('car', '2024-01', 10000)
    for (const rate of [-1.5, NaN, Infinity]) {
      assert.throws(() => buildProjection([asset], [makeCategory('vehicles', rate)], [dp], 1), RangeError)
    }
    assert.throws(() => buildProjection([asset], [makeCategory('vehicles', -0.8)], [dp], 1, 1.5), RangeError)
    assert.equal(compoundMonthlyRate(-1), -1)
  })

  test('liability with positive growth rate never crosses above 0 (debt cannot become surplus)', () => {
    const cat: Category = { id: 'loan', name: 'loan', projected_yearly_growth: 0.05,
                            color: '#ff0000', type: 'liability' }
    const asset = makeAsset('mortgage', 'loan')
    const dp = makeDP('mortgage', '2024-01', -1000) // small remaining balance
    const proj = buildProjection([asset], [cat], [dp], 30, 1.0)
    for (const v of proj.series[0].values) {
      assert.ok(v <= 0, `expected non-positive liability value, got ${v}`)
    }
  })
})

describe('buildProjection planned values', () => {
  test('anchor ignores data points after asOf', () => {
    const cat = makeCategory('cat1', 0)
    const asset = makeAsset('a1', 'cat1')
    const proj = buildProjection([asset], [cat], [makeDP('a1', '2024-06', 100), makeDP('a1', '2030-01', 500)], 1, 1.0, '2024-06')
    assert.equal(proj.months[0], '2024-07')
  })

  test('interpolates from seed to planned value, then grows from the last planned value', () => {
    const cat = makeCategory('cat1', 0.12)
    const asset = makeAsset('a1', 'cat1')
    const proj = buildProjection([asset], [cat], [makeDP('a1', '2024-06', 1000), makeDP('a1', '2024-09', 4000)], 1, 1.0, '2024-06')
    const v = proj.series[0].values
    assert.equal(v[0], 2000)
    assert.equal(v[1], 3000)
    assert.equal(v[2], 4000)
    assert.ok(Math.abs(v[3] - 4000 * (1 + compoundMonthlyRate(0.12))) < 0.001)
  })

  test('asset with only future data points is 0 until its first planned month', () => {
    const cat: Category = { id: 'loan', name: 'loan', projected_yearly_growth: -0.04, color: '#ff0000', type: 'liability' }
    const now = makeAsset('now', 'loan')
    const later = makeAsset('later', 'loan')
    const proj = buildProjection([now, later], [cat],
      [makeDP('now', '2024-06', -100), makeDP('later', '2024-08', -90000), makeDP('later', '2024-09', -89000)], 1, 1.0, '2024-06')
    const v = proj.series[0].values
    assert.ok(v[0] > -100 && v[0] < -99)
    assert.ok(v[1] < -90000 && v[1] > -90100)
    assert.ok(v[2] < -89000 && v[2] > -89100)
  })

  test('latest updated_at wins among planned values in the same month', () => {
    const cat = makeCategory('cat1', 0)
    const asset = makeAsset('a1', 'cat1')
    const proj = buildProjection([asset], [cat], [
      makeDP('a1', '2024-06', 1),
      makeDP('a1', '2024-07', 2, '2024-01-01T00:00:00.000Z'),
      makeDP('a1', '2024-07', 3, '2024-02-01T00:00:00.000Z'),
    ], 1, 1.0, '2024-06')
    assert.equal(proj.series[0].values[0], 3)
  })
})

describe('projection numeric and timestamp integrity', () => {
  test('rejects overflow while accumulating assets within a category', () => {
    const assets = [makeAsset('a1'), makeAsset('a2')]
    const points = assets.map(asset => makeDP(asset.id, '2024-01', 1e308))
    assert.throws(() => buildProjection(assets, [makeCategory('cat1', 0)], points, 1), /finite numeric range/)
  })

  test('rejects overflow while totaling different categories', () => {
    const assets = [makeAsset('a1', 'cat1'), makeAsset('a2', 'cat2')]
    const points = assets.map(asset => makeDP(asset.id, '2024-01', 1e308))
    assert.throws(() => buildProjection(assets, [makeCategory('cat1', 0), makeCategory('cat2', 0)], points, 1), /finite numeric range/)
  })

  test('compares seed and planned timestamps by instant across UTC offsets', () => {
    const asset = makeAsset('a1')
    const points = [
      makeDP('a1', '2024-01', 100, '2024-01-02T01:00:00+02:00'),
      makeDP('a1', '2024-01', 200, '2024-01-01T23:30:00Z'),
      makeDP('a1', '2024-03', 300, '2024-01-02T01:00:00+02:00'),
      makeDP('a1', '2024-03', 400, '2024-01-01T23:30:00Z'),
    ]
    const projection = buildProjection([asset], [makeCategory('cat1', 0)], points, 1, 1, '2024-01')
    assert.deepEqual(projection.series[0].values.slice(0, 3), [300, 400, 400])
    assert.equal(projection.method, 'compound-growth-with-planned-interpolation')
  })
})
