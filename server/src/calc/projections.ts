// server/src/calc/projections.ts
import type { Asset, Category, DataPoint } from '../models/index.js'
import { toMonthKey, monthRange } from './utils.js'

// ── addOneMonth (private) ─────────────────────────────────────────────────────
// Integer carry loop — DST-safe, no new Date().
function addOneMonth(ym: string): string {
  let [y, m] = ym.split('-').map(Number)
  m++
  if (m > 12) { m = 1; y++ }
  return toMonthKey(y, m)
}

// ── currentMonthKey (private) ─────────────────────────────────────────────────
// toMonthKey with integer parts — NEVER toISOString().slice(0,7)
function currentMonthKey(): string {
  const now = new Date()
  return toMonthKey(now.getFullYear(), now.getMonth() + 1)
}

// ── compoundMonthlyRate ───────────────────────────────────────────────────────

/**
 * Convert an annual growth rate to a per-month compound factor.
 *
 * Formula: (1 + r)^(1/12) - 1
 *
 * PROJ-02: NEVER use annualRate / 12 (simple division understates compounding
 * by ~2% over 10 years at 7% — a meaningful error for a retirement planning tool).
 *
 * @param annualRate  Decimal annual rate, e.g. 0.08 for 8%
 * @returns           Monthly compound rate, e.g. ≈0.006434 for 8% annual
 */
export function compoundMonthlyRate(annualRate: number): number {
  if (!Number.isFinite(annualRate) || annualRate < -1) throw new RangeError('Effective annual growth must be finite and at least -100%')
  return Math.pow(1 + annualRate, 1 / 12) - 1
}

// ── resolveGrowthRate ─────────────────────────────────────────────────────────

/**
 * Determine the effective annual growth rate for an asset.
 *
 * PROJ-03: Inheritance rules:
 *   1. Asset has projected_yearly_growth !== null  → use asset-level rate
 *   2. Asset has null                              → look up category rate
 *   3. Category not found                         → default to 0
 *
 * CRITICAL: Check must be `!== null`, NOT falsy.
 * `projected_yearly_growth: 0` is a valid explicit override (no growth).
 * A falsy check would silently inherit the category rate for zero-growth assets.
 */
export function resolveGrowthRate(asset: Asset, categories: Category[]): number {
  if (asset.projected_yearly_growth !== null) {
    return asset.projected_yearly_growth
  }
  const cat = categories.find(c => c.id === asset.category_id)
  return cat?.projected_yearly_growth ?? 0
}

// ── ProjectionSeries / ProjectionBlock ────────────────────────────────────────

export interface ProjectionSeries {
  category_id: string
  category_name: string
  color: string
  values: number[]   // length === months.length
}

export interface ProjectionBlock {
  asOf: string
  method: 'compound-growth-with-planned-interpolation'
  months: string[]
  series: ProjectionSeries[]
  totals: number[]
}

// ── buildProjection ───────────────────────────────────────────────────────────

/**
 * Build a compound-growth projection for years * 12 months.
 *
 * PROJ-04: Projection starts the month after `asOf`, carrying the latest observed balance to that anchor.
 *
 * PROJ-02: Monthly rate = compoundMonthlyRate(annualRate) — NEVER annualRate/12.
 * PROJ-03: Growth rate per asset via resolveGrowthRate (asset override or category default).
 *
 * Seed selection per asset:
 *   1. Find the lexicographically greatest year_month among the asset's data points.
 *   2. Among data points with that year_month, pick the one with the greatest updated_at
 *      (ISO 8601 strings compare correctly — same upsert rule as locfFill).
 *   3. If the asset has no data points, seed = 0.
 *
 * Planned values (data points after the anchor) are used as-is. Months between two known
 * values (seed or planned) are interpolated linearly; growth applies only after the last one.
 * Assets that only have planned values stay 0 until their first planned month.
 *
 * @param rateMultiplier  Scenario multiplier applied to every resolved growth rate.
 *   1.0 = base (default, preserves current behaviour).
 *   0.5 = conservative (half the stored rates).
 *   1.5 = aggressive (1.5× the stored rates).
 *   Any non-negative value is accepted; callers are responsible for sensible bounds.
 */
export function buildProjection(
  assets: Asset[],
  categories: Category[],
  dataPoints: DataPoint[],
  years: number,
  rateMultiplier = 1.0,
  asOf = currentMonthKey(),
): ProjectionBlock {
  const latestMonth = asOf

  // 2. Build months array: years*12 months starting one month after latestMonth
  //    PROJ-04: projStart = addOneMonth(latestMonth) — never latestMonth itself
  const projStart = addOneMonth(latestMonth)

  // Compute projEnd via integer carry arithmetic — no new Date()
  let [ey, em] = projStart.split('-').map(Number)
  em += years * 12 - 1
  while (em > 12) { em -= 12; ey++ }
  const projEnd = toMonthKey(ey, em)

  const months = monthRange(projStart, projEnd)  // length === years * 12

  // 3. Build series: one per category (mirrors aggregateSummary categories.map pattern)
  const series: ProjectionSeries[] = categories.map(cat => {
    const catAssets = assets.filter(a => a.category_id === cat.id)
    const values: number[] = Array(months.length).fill(0)

    for (const asset of catAssets) {
      // Find this asset's projection seed
      const assetDPs = dataPoints.filter(dp => dp.asset_id === asset.id && dp.year_month <= latestMonth)
      const planned = new Map<string, DataPoint>()
      for (const dp of dataPoints) {
        if (dp.asset_id !== asset.id || dp.year_month <= latestMonth) continue
        const prev = planned.get(dp.year_month)
        if (!prev || Date.parse(dp.updated_at) > Date.parse(prev.updated_at)) planned.set(dp.year_month, dp)
      }
      let seed = 0
      if (assetDPs.length > 0) {
        const latestYM = assetDPs.reduce(
          (best, dp) => (dp.year_month > best ? dp.year_month : best),
          assetDPs[0].year_month
        )
        const bestDP = assetDPs
          .filter(dp => dp.year_month === latestYM)
          .reduce((a, b) => (Date.parse(a.updated_at) > Date.parse(b.updated_at) ? a : b))
        seed = bestDP.value
      }

      const annualRate = resolveGrowthRate(asset, categories) * rateMultiplier
      const monthlyRate = compoundMonthlyRate(annualRate)
      // Safety clamps by category type:
      //  - assets cannot be worth less than 0 (a depreciating car bottoms out at 0)
      //  - liabilities cannot be worth more than 0 (a paid-off debt bottoms out at 0;
      //    they're stored as negative numbers, so 0 is the "fully paid" ceiling)

      const finite = (x: number) => {
        if (!Number.isFinite(x)) throw new RangeError('Projection exceeds finite numeric range')
        return x
      }
      const clamp = cat.type === 'liability'
        ? (x: number) => (finite(x) < 0 ? x : 0)
        : cat.type === 'asset'
          ? (x: number) => (finite(x) > 0 ? x : 0)
          : (x: number) => finite(x)
      const plannedValues = months.map(m => planned.get(m)?.value)
      const nextPlanned = (from: number) => plannedValues.findIndex((x, j) => j >= from && x !== undefined)
      let v = seed
      let prevI = assetDPs.length > 0 ? -1 : null
      let prevV = seed
      let nextI = nextPlanned(0)
      for (let i = 0; i < months.length; i++) {
        if (i === nextI) {
          v = prevV = plannedValues[i]!
          prevI = i
          nextI = nextPlanned(i + 1)
        } else if (nextI !== -1 && prevI !== null) {
          v = prevV + (plannedValues[nextI]! - prevV) * (i - prevI) / (nextI - prevI)
        } else {
          v = clamp(v * (1 + monthlyRate))
        }
        if (!Number.isFinite(v)) throw new RangeError('Projection exceeds finite numeric range')
        values[i] += v
        if (!Number.isFinite(values[i])) throw new RangeError('Projection exceeds finite numeric range')
      }
    }

    return { category_id: cat.id, category_name: cat.name, color: cat.color, values }
  })

  // 4. totals[i] = sum across all categories for month i
  const totals = months.map((_, i) =>
    series.reduce((sum, s) => sum + s.values[i], 0)
  )

  if (totals.some(value => !Number.isFinite(value))) throw new RangeError('Projection exceeds finite numeric range')
  return { months, series, totals, asOf, method: 'compound-growth-with-planned-interpolation' }
}
