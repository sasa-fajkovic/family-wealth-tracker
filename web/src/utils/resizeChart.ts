import type { Chart } from 'chart.js'

/** Finish any queued resize and animation before measuring the current container. */
export function resizeChart(chart: Pick<Chart, 'stop' | 'update' | 'resize'>): void {
  chart.stop()
  chart.update('none')
  chart.resize()
}
