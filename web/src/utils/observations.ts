import type { SummaryResponse } from '../types'

export function hasObservation(data: SummaryResponse, index: number, id?: string, type?: SummaryResponse['series'][number]['category_type']): boolean {
  if (index < 0 || index >= data.months.length) return false
  return data.asset_series.some(series =>
    (!id || series.category_id === id) &&
    (!type || series.category_type === type) &&
    (series.observation_status?.[index] ?? 'observed') !== 'missing',
  )
}
