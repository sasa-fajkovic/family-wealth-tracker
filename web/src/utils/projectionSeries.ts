import type { ProjectionsResponse } from '../types'
import { hasObservation } from './observations'

export function visibleProjectionSeries(data: ProjectionsResponse, hidden: Set<string>) {
  const historical = data.historical.series
  const projected = data.projection.series
  const ids = new Set([...historical.map(series => series.category_id), ...projected.map(series => series.category_id)])
  return [...ids].filter(id => !hidden.has(id)).map(id => {
    const past = historical.find(series => series.category_id === id)
    const future = projected.find(series => series.category_id === id)
    const metadata = data.projection.asset_metadata?.filter(asset => asset.category_id === id)
    const canBridge = !metadata || metadata.every(asset => asset.effective_include_in_current_wealth === asset.effective_include_in_projections)
    return {
      id,
      canBridge,
      name: past?.category_name ?? future!.category_name,
      color: past?.color ?? future!.color,
      historical: data.historical.months.map((_, i) => past && hasObservation(data.historical, i, id) ? past.values[i] ?? 0 : null),
      projected: data.projection.months.map((_, i) => future && future.available?.[i] !== false ? future.values[i] ?? 0 : null),
    }
  })
}
