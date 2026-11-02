import type { Asset, Category } from '../models/index.js'

export function resolveInclusion(asset: Asset, category: Category | undefined) {
  const wealth = category?.type !== 'cash-inflow'
  return {
    effective_include_in_current_wealth: wealth && (asset.include_in_current_wealth ?? category?.include_in_current_wealth ?? true),
    effective_include_in_projections: wealth && (asset.include_in_projections ?? category?.include_in_projections ?? true),
  }
}
