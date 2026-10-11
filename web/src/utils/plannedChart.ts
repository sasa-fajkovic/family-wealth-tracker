import { Chart as ChartJS, type ChartType, type Plugin, type ScriptableContext, type ScriptableLineSegmentContext } from 'chart.js'
import type { SummaryResponse } from '../types/index'

export interface PlannedMarkerOptions {
  /** Index of today's month; the marker is drawn between it and the next (planned) month. */
  index?: number
  dark?: boolean
}

declare module 'chart.js' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface PluginOptionsByType<TType extends ChartType> {
    plannedMarker?: PlannedMarkerOptions
  }
}

/** Index of today's month in a summary; months after it are planned. */
export function todayIndex(summary: Pick<SummaryResponse, 'months' | 'current_month'>): number {
  const idx = summary.current_month ? summary.months.indexOf(summary.current_month) : -1
  return idx >= 0 ? idx : summary.months.length - 1
}

/** Line `segment` options: dashed once the line runs into planned months. */
export function plannedSegment(today: number) {
  return {
    borderDash: (ctx: ScriptableLineSegmentContext) => (ctx.p1DataIndex > today ? [6, 4] : undefined),
  }
}

/** Scriptable point radius: hides point markers on planned months so the dashed line stays readable. */
export function plannedPointRadius(today: number, radius = 3) {
  return (ctx: ScriptableContext<'line'>) => (ctx.dataIndex > today ? 0 : radius)
}

/** Scriptable bar colour: faded for planned months. */
export function plannedBarColor(color: string, today: number, alpha = 'cc', plannedAlpha = '44') {
  return (ctx: ScriptableContext<'bar'>) => color + (ctx.dataIndex > today ? plannedAlpha : alpha)
}

export const plannedMarkerPlugin: Plugin = {
  id: 'plannedMarker',
  afterDraw(chart, _args, opts: PlannedMarkerOptions) {
    const idx = opts?.index
    const count = chart.data.labels?.length ?? 0
    const xScale = chart.scales['x']
    if (idx == null || idx < 0 || idx >= count - 1 || !xScale) return
    const { ctx, chartArea } = chart
    const midX = (xScale.getPixelForValue(idx) + xScale.getPixelForValue(idx + 1)) / 2
    const dark = !!opts.dark

    ctx.save()
    ctx.beginPath()
    ctx.moveTo(midX, chartArea.top)
    ctx.lineTo(midX, chartArea.bottom)
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 4])
    ctx.stroke()
    ctx.font = '10px ui-sans-serif,system-ui,sans-serif'
    ctx.fillStyle = dark ? 'rgba(161,161,170,0.85)' : 'rgba(107,114,128,0.85)'
    ctx.textBaseline = 'top'
    ctx.textAlign = 'right'
    ctx.fillText('Today', midX - 5, chartArea.top + 4)
    ctx.textAlign = 'left'
    ctx.fillText('Planned', midX + 5, chartArea.top + 4)
    ctx.restore()
  },
}

ChartJS.register(plannedMarkerPlugin)
