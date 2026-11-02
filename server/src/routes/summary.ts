// server/src/routes/summary.ts
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { readDbAndDataPoints } from '../storage/index.js'
import { isActiveInMonth } from '../calc/closure.js'
import { resolveInclusion } from '../calc/inclusion.js'
import { monthRange } from '../calc/utils.js'
import { getRangeBounds } from '../calc/ranges.js'
import { locfFill, aggregateSummary, observationCoverage } from '../calc/summary.js'
import { deriveMonthBounds } from '../util/monthBounds.js'
import { zodErrorHook as hook } from '../util/zodHook.js'

const router = new Hono()

// SUM-01: accepted range values — zod enum enforces the allowlist
const rangeValues = ['ytd', '6m', '1y', '2y', '3y', '5y', '10y', 'max'] as const
const querySchema = z.object({
  range: z.enum(rangeValues).default('1y'),
  person: z.string().optional(),
  tracking: z.string().optional(),  // 'true' = cash-inflow view (cash-inflow categories only)
  planned: z.string().optional(),   // 'true' = extend timelines past today to the last planned data point
})

router.get('/', zValidator('query', querySchema, hook), async (c) => {
  const { range, person, tracking, planned } = c.req.valid('query')
  const trackingMode = tracking === 'true'
  const { db, dataPoints } = await readDbAndDataPoints()

  // Filter categories by tracking mode: wealth view shows asset+liability; cash-inflow view shows only cash-inflow
  const relevantCategories = db.categories.filter(cat =>
    trackingMode ? cat.type === 'cash-inflow' : cat.type !== 'cash-inflow',
  )
  const relevantCategoryIds = new Set(relevantCategories.map(cat => cat.id))

  // Filter assets by category, then optionally by person
  let filteredAssets = db.assets.filter(a => relevantCategoryIds.has(a.category_id))
  if (!trackingMode) filteredAssets = filteredAssets.filter(asset => resolveInclusion(asset, db.categories.find(category => category.id === asset.category_id)).effective_include_in_current_wealth)
  if (person) filteredAssets = filteredAssets.filter(a => a.person_id === person)

  // Compute date range from data points belonging to filtered assets only
  const filteredAssetIds = new Set(filteredAssets.map(a => a.id))
  const relevantDPs = dataPoints.filter(dp => filteredAssetIds.has(dp.asset_id))

  const { latestMonth, earliestMonth, currentMonth } = deriveMonthBounds(relevantDPs)

  const { startYM, endYM } = getRangeBounds(range, latestMonth, earliestMonth, currentMonth)
  const months = monthRange(startYM, endYM)
  const fillMode = trackingMode ? 'flow' : 'stock'
  const locfData = locfFill(months, dataPoints, filteredAssets, fillMode)
  const monthlyAssets = db.assets.filter(asset => isActiveInMonth(asset, currentMonth) && (!person || asset.person_id === person)
    && (!asset.show_from || asset.show_from <= currentMonth) && (!asset.show_until || asset.show_until >= currentMonth))
  const monthly_coverage = observationCoverage(monthlyAssets, db.categories, dataPoints, currentMonth)
  const response = { monthly_coverage, ...aggregateSummary(filteredAssets, relevantCategories, locfData, months, fillMode, dataPoints), current_month: endYM }

  if (planned === 'true' && latestMonth > endYM) {
    // Headline numbers and breakdowns stay as of today; only the timelines extend into planned months.
    const plannedMonths = monthRange(startYM, latestMonth)
    const ext = aggregateSummary(filteredAssets, relevantCategories, locfFill(plannedMonths, dataPoints, filteredAssets, fillMode), plannedMonths, fillMode, dataPoints)
    Object.assign(response, { months: ext.months, series: ext.series, totals: ext.totals, asset_series: ext.asset_series })
  }

  return c.json(response)
})

export default router
