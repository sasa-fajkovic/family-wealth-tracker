// web/src/types/index.ts
// Pure type definitions — no imports, no runtime code.
// Mirrors server/src/models/index.ts and server/src/calc/summary.ts exactly.

// ── Domain Models ─────────────────────────────────────────────────────────────

export interface Category {
  id: string                       // URL-safe slug, immutable after create
  name: string
  projected_yearly_growth: number  // decimal, e.g. 0.08 = 8% annual
  color: string                    // hex, e.g. '#6366f1'
  type: 'asset' | 'cash-inflow' | 'liability'
  include_in_current_wealth?: boolean
  include_in_projections?: boolean
}

export interface Asset {
  id: string                               // URL-safe slug, immutable after create
  name: string
  category_id: string
  include_in_current_wealth?: boolean | null
  include_in_projections?: boolean | null
  effective_include_in_current_wealth?: boolean
  effective_include_in_projections?: boolean
  projected_yearly_growth: number | null   // null = inherit from parent Category (NOT optional ?)
  notes?: string
  person_id: string                                // required; every asset must belong to a person
  closed_at?: string | null               // YYYY-MM; active through this month
  created_at: string                       // ISO 8601 timestamp, immutable
  show_from?: string                       // YYYY-MM, inclusive lower bound (Monthly Update visibility)
  show_until?: string                      // YYYY-MM, inclusive upper bound (Monthly Update visibility)
}

export interface DataPoint {
  id: string        // UUID v4
  asset_id: string
  // YYYY-MM — built from getFullYear()/getMonth(), NEVER toISOString() (UTC shift bug)
  year_month: string
  value: number     // EUR float
  notes?: string
  created_at: string
  updated_at: string
}

export interface Person {
  id: string    // URL-safe slug, e.g. 'sasa', 'matea'
  name: string  // Display name, e.g. 'Sasa', 'Matea'
}

// ── API Request Payloads ───────────────────────────────────────────────────────
// Used by the API client create/update functions.

export interface CreateCategoryPayload {
  include_in_current_wealth?: boolean
  include_in_projections?: boolean
  name: string
  projected_yearly_growth: number
  color: string
  type: 'asset' | 'cash-inflow' | 'liability'
}

export interface UpdateCategoryPayload {
  include_in_current_wealth?: boolean
  include_in_projections?: boolean
  name: string
  projected_yearly_growth: number
  color: string
  type: 'asset' | 'cash-inflow' | 'liability'
}

export interface CreateAssetPayload {
  include_in_current_wealth?: boolean | null
  include_in_projections?: boolean | null
  name: string
  category_id: string
  projected_yearly_growth: number | null
  notes?: string
  person_id: string
  show_from?: string | null   // YYYY-MM or null/undefined to clear
  show_until?: string | null
}

export interface UpdateAssetPayload {
  closed_at?: string | null
  include_in_current_wealth?: boolean | null
  include_in_projections?: boolean | null
  name: string
  category_id: string
  projected_yearly_growth: number | null
  notes?: string
  person_id: string
  show_from?: string | null
  show_until?: string | null
}

export interface CreatePersonPayload {
  name: string
}

export interface UpdatePersonPayload {
  name: string
}

// ── Summary API ────────────────────────────────────────────────────────────────
// Mirrors server/src/calc/summary.ts SummaryResponse exactly.

export type RangeKey = 'ytd' | '6m' | '1y' | '2y' | '3y' | '5y' | '10y' | 'max'

export interface SummaryResponse {
  months: string[]
  /** Today's month; with `planned`, months/series/totals/asset_series run past it. */
  current_month?: string
  series: {
    category_id: string
    category_name: string
    color: string
    category_type: 'asset' | 'cash-inflow' | 'liability'
    values: number[]
  }[]
  totals: number[]
  current_total: number
  gross_assets: number
  total_liabilities: number
  monthly_delta_abs: number
  period_delta_abs: number
  period_delta_pct: number
  period_start_month: string | null
  period_delta_available: boolean
  period_delta_pct_available: boolean
  category_breakdown: {
    category_id: string
    category_name: string
    color: string
    category_type: 'asset' | 'cash-inflow' | 'liability'
    value: number
    pct_of_total: number
  }[]
  monthly_coverage?: { observed: number; carried: number; missing: number; total: number }
  coverage: { observed: number; carried: number; missing: number; total: number }
  asset_series: {
    closed_at: string | null
    asset_id: string
    asset_name: string
    category_id: string
    category_name: string
    color: string
    category_type: 'asset' | 'cash-inflow' | 'liability'
    person_id: string
    values: number[]
    observation_months: (string | null)[]
    observation_status: ('observed' | 'carried' | 'missing')[]
  }[]
  asset_breakdown: {
    closed_at: string | null
    asset_id: string
    asset_name: string
    category_id: string
    category_name: string
    color: string
    category_type: 'asset' | 'cash-inflow' | 'liability'
    person_id: string
    value: number
    pct_of_total: number
    monthly_delta_abs: number
    period_delta_abs: number
    period_delta_pct: number
    period_start_month: string | null
    period_delta_available: boolean
    period_delta_pct_available: boolean
    observation_month: string | null
    observation_status: 'observed' | 'carried' | 'missing'
  }[]
}

// ── Projections API ────────────────────────────────────────────────────────────

export type ProjectionScenario = 'conservative' | 'base' | 'aggressive'

export interface ProjectionsResponse {
  historical: SummaryResponse
  projection: {
    asOf: string
    method: 'compound-growth-with-planned-interpolation'
    months: string[]
    series: { category_id: string; category_name: string; color: string; values: number[]; available?: boolean[] }[]
    totals: number[]
    available?: boolean[]
    asset_metadata?: { asset_id: string; category_id: string; closed_at: string | null; effective_include_in_current_wealth: boolean; effective_include_in_projections: boolean; projection_start_month: string | null }[]
  }
}
