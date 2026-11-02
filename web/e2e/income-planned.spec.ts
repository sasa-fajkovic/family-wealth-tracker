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
async function plannedPoint(page: Page, targetMonth: string, currentMonth: string, value = 500) {
  return page.evaluate(({ targetMonth, currentMonth, value }) => {
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
      const datasetIndex = datasets.findIndex(dataset => dataset.data[index] === value)
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
  }, { targetMonth, currentMonth, value })
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
  const total = page.getByText('Income in selected period', { exact: true }).locator('..')
  const average = page.getByText('Average per recorded month', { exact: true }).locator('..')
  await expect(total).toContainText('1.300,00')
  await expect(average).toContainText('650,00')
  await expect(page.getByText('Summary cards show income recorded in the selected period only.')).toBeVisible()
  await expect(page.getByText('Future entries hidden.')).toBeVisible()
  const toggle = page.getByRole('button', { name: 'Show future entries' })
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
  await expect(page.getByText(new RegExp(`Selected period: .*${month(0)}`))).toBeVisible()
  await expect(page.getByText(new RegExp(`Future timeline: ${month(1)}.*${month(3)}.*1 month with future entries`))).toBeVisible()
  await expect(total).toContainText('1.300,00')
  await expect(average).toContainText('650,00')
  await page.getByText('View chart data', { exact: true }).click()
  const chartTable = page.getByRole('table', { name: 'Chart values by month' })
  await expect(chartTable.getByRole('row').filter({ hasText: month(3) })).toContainText('500,00')
  await expect(chartTable.getByRole('row').filter({ hasText: month(3) })).toContainText('Future')
  for (const type of ['Trend', 'Stacked Area', 'Line']) {
    await page.getByTitle(type, { exact: true }).click()
    await expect.poll(() => plannedPoint(page, month(3), month(0))).toMatchObject({ value: 500, missing: [null, null], radius: 3, skipped: [true, true], spanGaps: false })
    const point = await plannedPoint(page, month(3), month(0))
    expect(point?.marker).toBe(point?.currentIndex)
  }
  await page.getByTitle('Pie', { exact: true }).click()
  await expect(toggle).toBeDisabled()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Choose a timeline chart to show future entries.')).toBeVisible()
  await expect(total).toContainText('1.300,00')
  await page.getByTitle('Trend', { exact: true }).click()
  await expect(toggle).toBeEnabled()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText(new RegExp(`Future timeline: ${month(1)}.*${month(3)}`))).toBeVisible()
})

test('timeline reports when selected sources have no planned income', async ({ page, request }) => {
  const { person, source } = await incomeSource(request, 'No future income')
  await create(request, 'data-points', { asset_id: source.id, year_month: month(0), value: 0 })
  await page.goto('/income')
  await page.getByRole('button', { name: person.name, exact: true }).click()
  await page.getByRole('button', { name: 'Show future entries' }).click()
  await expect(page.getByText('No future income entries for the selected sources.')).toBeVisible()
  await expect(page.getByText('Income in selected period', { exact: true }).locator('..')).toContainText('0,00')
  await expect(page.getByRole('button', { name: `Disable ${source.name}`, exact: true })).toContainText('0,00')
})

test('planned income controls fit 320px in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto('/income')
  for (let theme = 0; theme < 2; theme++) {
    await page.getByTitle('Pie', { exact: true }).click()
    await expect(page.getByText('Choose a timeline chart to show future entries.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Show future entries' })).toBeDisabled()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    await page.getByRole('button', { name: /Switch to (light|dark) mode/ }).click()
  }
})


test('planned-only sources can be excluded and re-enabled without changing actual cards', async ({ page, request }) => {
  const { person, source } = await incomeSource(request, 'Future toggle')
  const category = await create(request, 'categories', { name: `Actual category ${Date.now()}`, type: 'cash-inflow', projected_yearly_growth: 0, color: '#14b8a6' })
  const actual = await create(request, 'assets', { name: `Actual source ${Date.now()}`, category_id: category.id, person_id: person.id, projected_yearly_growth: null })
  await create(request, 'data-points/batch', { items: [
    { asset_id: actual.id, year_month: month(0), value: 300 },
    { asset_id: source.id, year_month: month(3), value: 500 },
  ] })
  await page.goto('/income')
  await page.getByRole('button', { name: person.name, exact: true }).click()
  const toggle = page.getByRole('button', { name: 'Show future entries' })
  const sourceToggle = page.getByRole('button', { name: `Disable ${source.name}` })
  await expect(sourceToggle).toHaveCount(0)
  const total = page.getByText('Income in selected period', { exact: true }).locator('..')
  await expect(total).toContainText('300,00')
  await toggle.click()
  await expect(sourceToggle).toBeVisible()
  await expect(sourceToggle).toContainText('Future only')
  await expect(sourceToggle).toContainText('—')
  await expect(sourceToggle).not.toContainText('0,00')
  await expect.poll(() => plannedPoint(page, month(3), month(0))).not.toBeNull()
  await sourceToggle.click()
  await expect(page.getByRole('button', { name: `Enable ${source.name}` })).toBeVisible()
  await expect(page.getByText('No future income entries for the selected sources.')).toBeVisible()
  await expect(total).toContainText('300,00')
  await toggle.click()
  await expect(page.getByRole('button', { name: `Enable ${source.name}` })).toHaveCount(0)
  await toggle.click()
  await page.getByRole('button', { name: `Enable ${source.name}` }).click()
  await expect.poll(() => plannedPoint(page, month(3), month(0))).not.toBeNull()
  await expect(total).toContainText('300,00')
})

test('observed zero income remains visible in line and area charts for all and individual people', async ({ page, request }) => {
  const { person, source } = await incomeSource(request, 'Zero timeline')
  await create(request, 'data-points/batch', { items: [
    { asset_id: source.id, year_month: month(0), value: 0 },
    { asset_id: source.id, year_month: month(3), value: 0 },
  ] })
  await page.goto('/income')
  await page.getByRole('button', { name: 'Show future entries' }).click()
  for (const grouping of ['All', person.name]) {
    await page.getByRole('button', { name: grouping, exact: true }).click()
    for (const type of ['Line', 'Stacked Area']) {
      await page.getByTitle(type, { exact: true }).click()
      await expect.poll(() => plannedPoint(page, month(3), month(0), 0)).toMatchObject({ value: 0, missing: [null, null], radius: 3, skipped: [true, true], spanGaps: false })
    }
  }
})

test('income grouping keeps missing values distinct when person and asset IDs collide', async ({ page, request }) => {
  const suffix = Date.now()
  const collisionName = `Collision ${suffix}`
  const otherPerson = await create(request, 'persons', { name: collisionName })
  const person = await create(request, 'persons', { name: `Owner ${suffix}` })
  const category = await create(request, 'categories', { name: `Income collision category ${suffix}`, type: 'cash-inflow', projected_yearly_growth: 0, color: '#14b8a6' })
  const first = await create(request, 'assets', { name: collisionName, category_id: category.id, person_id: person.id, projected_yearly_growth: null })
  const second = await create(request, 'assets', { name: `Other source ${suffix}`, category_id: category.id, person_id: otherPerson.id, projected_yearly_growth: null })
  const third = await create(request, 'assets', { name: `Owner other source ${suffix}`, category_id: category.id, person_id: person.id, projected_yearly_growth: null })
  await create(request, 'data-points/batch', { items: [
    { asset_id: first.id, year_month: month(-1), value: 10 },
    { asset_id: second.id, year_month: month(0), value: 20 },
    { asset_id: third.id, year_month: month(0), value: 30 },
  ] })
  await page.goto('/income')
  await page.getByTitle('Line', { exact: true }).click()
  await page.getByText('View chart data', { exact: true }).click()
  const table = page.getByRole('table', { name: 'Chart values by month' })
  async function cell(column: string, targetMonth: string) {
    await expect(table.locator('thead th').getByText(column, { exact: true })).toBeVisible()
    const headers = await table.locator('thead th').allTextContents()
    const index = headers.indexOf(column)
    expect(index).toBeGreaterThan(1)
    return table.locator('tbody tr').filter({ hasText: targetMonth }).locator('td').nth(index - 1)
  }
  await expect(await cell(otherPerson.name, month(-1))).toHaveText('—')
  await expect(await cell(otherPerson.name, month(0))).toContainText('20,00')
  await page.getByRole('button', { name: person.name, exact: true }).click()
  await page.getByText('View chart data', { exact: true }).click()
  await expect(await cell(first.name, month(-1))).toContainText('10,00')
  await expect(await cell(first.name, month(0))).toHaveText('—')
  await expect(await cell(third.name, month(0))).toContainText('30,00')
})

test('wealth category observations ignore matching person and asset IDs', async ({ page, request }) => {
  const suffix = Date.now()
  const personName = `Collision person ${suffix}`
  const assetName = `Collision asset ${suffix}`
  const person = await create(request, 'persons', { name: personName })
  const targetPerson = await create(request, 'persons', { name: `Wealth owner ${suffix}` })
  const categoryPerson = await create(request, 'categories', { name: personName, type: 'asset', projected_yearly_growth: 0, color: '#14b8a6' })
  const categoryAsset = await create(request, 'categories', { name: assetName, type: 'asset', projected_yearly_growth: 0, color: '#6366f1' })
  const otherCategory = await create(request, 'categories', { name: `Wealth other ${suffix}`, type: 'asset', projected_yearly_growth: 0, color: '#f59e0b' })
  const target1 = await create(request, 'assets', { name: `Target one ${suffix}`, category_id: categoryPerson.id, person_id: targetPerson.id, projected_yearly_growth: null })
  const target2 = await create(request, 'assets', { name: `Target two ${suffix}`, category_id: categoryAsset.id, person_id: targetPerson.id, projected_yearly_growth: null })
  const unrelated = await create(request, 'assets', { name: assetName, category_id: otherCategory.id, person_id: person.id, projected_yearly_growth: null })
  await create(request, 'data-points/batch', { items: [
    { asset_id: target1.id, year_month: month(0), value: 10 },
    { asset_id: target2.id, year_month: month(0), value: 20 },
    { asset_id: unrelated.id, year_month: month(-1), value: 30 },
  ] })
  await page.goto('/')
  await page.getByText('View wealth trends data').click()
  const table = page.getByRole('table', { name: 'wealth trends values by month' })
  const headers = await table.locator('thead th').allTextContents()
  for (const name of [personName, assetName]) {
    const index = headers.indexOf(name)
    expect(index).toBeGreaterThan(2)
    await expect(table.locator('tbody tr').filter({ hasText: month(-1) }).locator('td').nth(index - 1)).toHaveText('—')
  }
})


test('dashboard trend card values distinguish no entry from recorded zero', async ({ page, request }) => {
  const { person, source } = await incomeSource(request, 'Dashboard zero')
  await create(request, 'data-points', { asset_id: source.id, year_month: month(0), value: 0 })
  const category = await create(request, 'categories', { name: `Dashboard empty wealth ${Date.now()}`, type: 'asset', projected_yearly_growth: 0, color: '#14b8a6' })
  await create(request, 'assets', { name: `Dashboard empty asset ${Date.now()}`, category_id: category.id, person_id: person.id, projected_yearly_growth: null })
  await page.goto('/')
  await page.getByRole('button', { name: person.name, exact: true }).click()
  const assetsCard = page.getByRole('button', { name: /Assets Trend/ }).locator('../../..')
  const incomeCard = page.getByRole('button', { name: /Income Trend/ }).locator('../../..')
  await expect(assetsCard).toContainText('No data yet')
  await expect(assetsCard.locator('p').first()).toHaveText('—')
  await expect(incomeCard.locator('p').first()).toContainText('0,00')
})
