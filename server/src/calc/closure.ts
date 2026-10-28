import type { Asset, DataPoint } from '../models/index.js'

export function isActiveInMonth(asset: Pick<Asset, 'closed_at'>, month: string): boolean {
  return !asset.closed_at || month <= asset.closed_at
}

export function hasRecordedClosingZero(asset: Pick<Asset, 'id' | 'closed_at'>, points: DataPoint[]): boolean {
  if (!asset.closed_at) return false
  const closing = points.filter(point => point.asset_id === asset.id && point.year_month === asset.closed_at)
    .reduce<DataPoint | undefined>((latest, point) => !latest || Date.parse(point.updated_at) >= Date.parse(latest.updated_at) ? point : latest, undefined)
  return closing?.value === 0
}
