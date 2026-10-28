import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

async function create(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`/api/v1/${path}`, { data })
  expect(response.ok()).toBeTruthy()
  return response.json()
}
function month(offset: number) {
  const now = new Date()
  const date = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}
async function plannedPoint(page: Page, targetMonth: string, currentMonth: string) {
  return page.evaluate(({ targetMonth, currentMonth }) => {
    const root = document.getElementById('root')
    if (!root) return null
    const seen = new Set<object>()
    const charts: object[] = []
    function visit(node: unknown): void {
      if (!node || typeof node !== 'object' || seen.has(node)) return
      seen.add(node)
      const component = Reflect.get(node, 'component')
      if (component && typeof component === 'object') {
        const exposed = Reflect.get(component, 'exposed')
        if (exposed && typeof exposed === 'object') {
          const ref = Reflect.get(exposed, 'chart')
          const chart = ref && typeof ref === 'object' ? Reflect.get(ref, 'value') : null
          if (chart && typeof chart === 'object' && Reflect.get(chart, 'canvas')?.isConnected) charts.push(chart)
        }
        visit(Reflect.get(component, 'subTree'))
      }
      const children = Reflect.get(node, 'children')
      if (Array.isArray(children)) children.forEach(visit)
    }
    visit(Reflect.get(root, '_vnode'))
    for (const chart of charts) {
      const chartData = Reflect.get(chart, 'data')
      const labels: string[] = chartData?.labels ?? []
      const index = labels.indexOf(targetMonth)
      if (index < 2) continue
      const datasets: { data: (number | null)[] }[] = chartData.datasets
      const datasetIndex = datasets.findIndex(dataset => dataset.data[index] === 500)
      if (datasetIndex < 0) continue
      const getMeta = Reflect.get(chart, 'getDatasetMeta')
      const points = getMeta.call(chart, datasetIndex).data
      return {
        value: datasets[datasetIndex].data[index],
        missing: [datasets[datasetIndex].data[index - 2], datasets[datasetIndex].data[index - 1]],
        radius: points[index].options.radius,
        skipped: [points[index - 2].skip, points[index - 1].skip],
        spanGaps: Reflect.get(chart, 'options').spanGaps === true,
        marker: Reflect.get(chart, 'options').plugins.plannedMarker.index,
        currentIndex: labels.indexOf(currentMonth),
      }
    }
    return null
  }, { targetMonth, currentMonth })
}

async function incomeSource(request: APIRequestContext, prefix: string) {
  const suffix = Date.now()
  const person = await create(request, 'persons', { name: `${prefix} person ${suffix}` })
  const category = await create(request, 'categories', { name: `${prefix} category ${suffix}`, type: 'cash-inflow', projected_yearly_growth: 0, color: '#14b8a6' })
  const source = await create(request, 'assets', { name: `${prefix} source ${suffix}`, category_id: category.id, person_id: person.id, projected_yearly_growth: null })
  return { person, source }
}

test('planned income appears on timeline while cards stay actual and pie preserves toggle state', async ({ page, request }) => {
  const { person, source } = await incomeSource(request, 'Planned income')
  await create(request, 'data-points/batch', { items: [
    { asset_id: source.id, year_month: month(-1), value: 300 },
    { asset_id: source.id, year_month: month(0), value: 1000 },
    { asset_id: source.id, year_month: month(3), value: 500 },
  ] })
  await page.goto('/income')
  await page.getByRole('button', { name: '1Y', exact: true }).click()
  await page.getByRole('button', { name: person.name, exact: true }).click()
  const total = page.getByText('Total Income', { exact: true }).locator('..')
  const average = page.getByText('Avg / Month', { exact: true }).locator('..')
  await expect(total).toContainText('1.300,00')
  await expect(average).toContainText('650,00')
  await expect(page.getByText('Summary cards show actual income only.')).toBeVisible()
  await expect(page.getByText('Planned income hidden.')).toBeVisible()
  const toggle = page.getByRole('button', { name: 'Show planned' })
  await page.getByTitle('Pie', { exact: true }).click()
  await expect(toggle).toBeDisabled()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await page.getByTitle('Trend', { exact: true }).click()
  await expect(toggle).toBeEnabled()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  const response = page.waitForResponse(result => {
    const url = new URL(result.url())
    return url.pathname.endsWith('/summary') && url.searchParams.get('tracking') === 'true' && url.searchParams.get('planned') === 'true' && url.searchParams.get('person') === person.id
  })
  await toggle.click()
  await response
  await expect(page.getByText(new RegExp(`Actual: .*${month(0)}`))).toBeVisible()
  await expect(page.getByText(new RegExp(`Planned timeline: ${month(1)}.*${month(3)}.*1 month with planned entries`))).toBeVisible()
  await expect(total).toContainText('1.300,00')
  await expect(average).toContainText('650,00')
  await page.getByText('View chart data', { exact: true }).click()
  const chartTable = page.getByRole('table', { name: 'Chart values by month' })
  await expect(chartTable.getByRole('row').filter({ hasText: month(3) })).toContainText('500,00')
  await expect(chartTable.getByRole('row').filter({ hasText: month(3) })).toContainText('Planned')
  for (const type of ['Trend', 'Stacked Area', 'Line']) {
    await page.getByTitle(type, { exact: true }).click()
    await expect.poll(() => plannedPoint(page, month(3), month(0))).toMatchObject({ value: 500, missing: [null, null], radius: 3, skipped: [true, true], spanGaps: false })
    const point = await plannedPoint(page, month(3), month(0))
    expect(point?.marker).toBe(point?.currentIndex)
  }
  await page.getByTitle('Pie', { exact: true }).click()
  await expect(toggle).toBeDisabled()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Choose a timeline chart to show planned income.')).toBeVisible()
  await expect(total).toContainText('1.300,00')
  await page.getByTitle('Trend', { exact: true }).click()
  await expect(toggle).toBeEnabled()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText(new RegExp(`Planned timeline: ${month(1)}.*${month(3)}`))).toBeVisible()
})

test('timeline reports when selected sources have no planned income', async ({ page, request }) => {
  const { person, source } = await incomeSource(request, 'No future income')
  await create(request, 'data-points', { asset_id: source.id, year_month: month(0), value: 0 })
  await page.goto('/income')
  await page.getByRole('button', { name: person.name, exact: true }).click()
  await page.getByRole('button', { name: 'Show planned' }).click()
  await expect(page.getByText('No planned income for the selected sources.')).toBeVisible()
  await expect(page.getByText('Total Income', { exact: true }).locator('..')).toContainText('0,00')
})

test('planned income controls fit 320px in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto('/income')
  for (let theme = 0; theme < 2; theme++) {
    await page.getByTitle('Pie', { exact: true }).click()
    await expect(page.getByText('Choose a timeline chart to show planned income.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Show planned' })).toBeDisabled()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    await page.getByRole('button', { name: /Switch to (light|dark) mode/ }).click()
  }
})
