import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { resizeChart } from '../src/utils/resizeChart'

const require = createRequire(import.meta.url)
const chartUmd = join(dirname(require.resolve('chart.js')), 'chart.umd.js')

for (const queuedWidth of [438, 300, null]) {
  test(`chart repair handles ${queuedWidth === null ? 'an unfinished animation without a size change' : `a stranded ${queuedWidth}px resize`}`, async ({ page }) => {
    await page.setContent('<div id="parent" style="width:646px;height:280px"><canvas width="646" height="280" style="max-width:100%"></canvas></div>')
    await page.evaluate(() => {
      const browser = window as unknown as { resizeTestFrames: FrameRequestCallback[] }
      browser.resizeTestFrames = []
      window.requestAnimationFrame = callback => { browser.resizeTestFrames.push(callback); return browser.resizeTestFrames.length }
      window.cancelAnimationFrame = () => {}
    })
    await page.addScriptTag({ path: chartUmd })
    const chart = await page.evaluateHandle((width) => {
      const browser = window as unknown as { Chart: typeof import('chart.js').Chart; resizeTestFrames: FrameRequestCallback[] }
      const canvas = document.querySelector('canvas')!
      const parent = document.querySelector<HTMLElement>('#parent')!
      let clock = Date.now()
      Date.now = () => clock
      const instance = new browser.Chart(canvas, {
        type: 'bar', data: { labels: ['A', 'B'], datasets: [{ data: [100, 200] }] },
        options: { responsive: false, maintainAspectRatio: false, animation: { duration: 1000 } },
      })
      const frame = (time: number) => {
        const callback = browser.resizeTestFrames.shift()
        if (!callback) throw new Error('Expected a Chart.js animation frame')
        clock = time
        callback(time)
      }
      const tick = clock + (width === null ? 500 : 100000)
      frame(tick)
      if (width !== null) {
        parent.style.width = '438px'
        instance.resize(width, 280)
        frame(tick + 1)
      }
      return instance
    }, queuedWidth)
    const dimensions = () => page.evaluate(() => {
      const canvas = document.querySelector('canvas')!
      return { parent: canvas.parentElement!.getBoundingClientRect().width, displayed: canvas.getBoundingClientRect().width, bitmap: canvas.width / devicePixelRatio }
    })
    if (queuedWidth !== null) {
      expect(await dimensions()).toEqual({ parent: 438, displayed: 438, bitmap: 646 })
    } else {
      const before = await chart.evaluate(instance => ({ bar: instance.getDatasetMeta(0).data[0].y, target: instance.scales.y.getPixelForValue(100) }))
      expect(Math.abs(before.bar - before.target)).toBeGreaterThan(1)
    }
    await page.evaluate(resizeChart, chart)
    if (queuedWidth !== null) {
      expect(await dimensions()).toEqual({ parent: 438, displayed: 438, bitmap: 438 })
    } else {
      const after = await chart.evaluate(instance => ({ bar: instance.getDatasetMeta(0).data[0].y, target: instance.scales.y.getPixelForValue(100) }))
      expect(after.bar).toBeCloseTo(after.target, 5)
      expect(await dimensions()).toEqual({ parent: 646, displayed: 646, bitmap: 646 })
    }
    await chart.evaluate(instance => instance.destroy())
    await chart.dispose()
  })
}
