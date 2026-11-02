import { expect, test, type APIRequestContext } from '@playwright/test'

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

test('bubble changes distinguish a missing prior observation from a recorded zero', async ({ page, request }) => {
  const suffix = Date.now()
  const missingName = `Bubble missing ${suffix}`
  const person = await create(request, 'persons', { name: missingName })
  const rows = []
  for (const [name, previous, current, type] of [
    [`Bubble zero ${suffix}`, 0, 100, 'asset'],
    [missingName, null, 200, 'asset'],
    [`Bubble growth ${suffix}`, 50, 70, 'asset'],
    [`Bubble debt ${suffix}`, -40, -25, 'liability'],
  ] as const) {
    const category = await create(request, 'categories', { name, type, projected_yearly_growth: 0, color: '#6366f1' })
    const asset = await create(request, 'assets', { name: `${name} item`, category_id: category.id, person_id: person.id, projected_yearly_growth: null })
    if (previous !== null) await create(request, 'data-points', { asset_id: asset.id, year_month: month(-1), value: previous })
    await create(request, 'data-points', { asset_id: asset.id, year_month: month(0), value: current })
    rows.push({ name, previous, current, category, asset })
  }
  const summary = await (await request.get(`/api/v1/summary?range=1y&person=${person.id}`)).json()
  const missing = summary.asset_series.find((series: { asset_id: string }) => series.asset_id === rows[1].asset.id)
  expect(missing.values.slice(-2)).toEqual([0, 200])
  expect(missing.observation_status.slice(-2)).toEqual(['missing', 'observed'])
  expect(rows[1].category.id).toBe(person.id)
  await page.goto('/analytics')
  await page.getByRole('button', { name: person.name, exact: true }).click()
  await page.getByRole('button', { name: '1Y', exact: true }).click()
  await page.getByText('Explore more', { exact: true }).click()
  await page.getByText('View portfolio bubble map data', { exact: true }).click()
  const table = page.getByRole('table', { name: 'portfolio bubble map chart data', exact: true })
  for (const [index, expected] of [[0, '+100,00'], [1, '—'], [2, '+20,00'], [3, '+15,00']] as const) {
    const row = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: rows[index].name, exact: true }) })
    await expect(row.getByRole('cell').nth(1)).toContainText(expected)
  }
  await expect.poll(() => page.evaluate(() => {
    const root = document.getElementById('root')
    const seen = new Set<object>()
    const seenCharts = new Set<object>()
    const datasets: { label: string; data: { x: number; y: number }[] }[] = []
    function visit(node: unknown): void {
      if (!node || typeof node !== 'object' || seen.has(node)) return
      seen.add(node)
      const component = Reflect.get(node, 'component')
      if (component && typeof component === 'object') {
        const exposed = Reflect.get(component, 'exposed')
        const ref = exposed && Reflect.get(exposed, 'chart')
        const chart = ref && Reflect.get(ref, 'value')
        if (chart?.canvas?.isConnected && chart.config.type === 'bubble' && !seenCharts.has(chart)) {
          seenCharts.add(chart)
          datasets.push(...chart.data.datasets)
        }
        visit(Reflect.get(component, 'subTree'))
      }
      const children = Reflect.get(node, 'children')
      if (Array.isArray(children)) children.forEach(visit)
    }
    if (root) visit(Reflect.get(root, '_vnode'))
    return datasets.map(dataset => ({ label: dataset.label, x: dataset.data[0].x, y: dataset.data[0].y }))
  })).toEqual([
    { label: rows[0].name, x: 100, y: 100 },
    { label: rows[2].name, x: 70, y: 20 },
    { label: rows[3].name, x: 25, y: 15 },
  ])
})

test('bubble map explains unavailable monthly changes without inventing zeroes', async ({ page, request }) => {
  const suffix = Date.now()
  const person = await create(request, 'persons', { name: `New portfolio ${suffix}` })
  const names = [`First category ${suffix}`, `Second category ${suffix}`]
  for (const name of names) {
    const category = await create(request, 'categories', { name, type: 'asset', projected_yearly_growth: 0, color: '#6366f1' })
    const asset = await create(request, 'assets', { name: `${name} item`, category_id: category.id, person_id: person.id, projected_yearly_growth: null })
    await create(request, 'data-points', { asset_id: asset.id, year_month: month(0), value: 100 })
  }
  await page.goto('/analytics')
  await page.getByRole('button', { name: person.name, exact: true }).click()
  await page.getByText('Explore more', { exact: true }).click()
  await expect(page.getByText('A value change needs a known balance in both months.', { exact: true })).toBeVisible()
  await page.getByText('View portfolio bubble map data', { exact: true }).click()
  const table = page.getByRole('table', { name: 'portfolio bubble map chart data', exact: true })
  for (const name of names) {
    const row = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) })
    await expect(row.getByRole('cell').nth(1)).toHaveText('—')
  }
})
