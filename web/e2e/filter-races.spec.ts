import { test, expect } from '@playwright/test'

for (const path of ['/', '/analytics', '/income']) {
  test(`latest range response wins on ${path}`, async ({ page, request }) => {
    if (path === '/income') {
      const person = await (await request.post('/api/v1/persons', { data: { name: `Race person ${Date.now()}` } })).json()
      const category = await (await request.post('/api/v1/categories', { data: { name: `Race category ${Date.now()}`, type: 'cash-inflow', projected_yearly_growth: 0, color: '#14b8a6' } })).json()
      await request.post('/api/v1/assets', { data: { name: `Race asset ${Date.now()}`, person_id: person.id, category_id: category.id, projected_yearly_growth: null } })
    }
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    let seen: (() => void) | undefined
    const started = new Promise<void>(resolve => { seen = resolve })
    await page.route('**/api/v1/summary?*', async route => {
      const range = new URL(route.request().url()).searchParams.get('range')
      const response = await route.fetch()
      const json = await response.json()
      if (range === '1y') { json.months[0] = '1111-01'; seen?.(); await gate }
      if (range === '6m') json.months[0] = '2222-01'
      await route.fulfill({ response, json })
    })
    await page.goto(path)
    await page.getByRole('button', { name: '1Y', exact: true }).click()
    await started
    const latest = page.waitForResponse(response => response.url().includes('/summary?range=6m'))
    await page.getByRole('button', { name: '6M', exact: true }).click()
    await latest
    const earlier = page.waitForResponse(response => response.url().includes('/summary?range=1y'))
    release?.()
    await earlier
    const tableSummary = page.locator('summary').filter({ hasText: path === '/' ? 'wealth trends' : path === '/analytics' ? 'analytics timeline' : 'chart data' }).first()
    await tableSummary.click()
    await expect(page.getByRole('rowheader', { name: '2222-01' }).first()).toBeVisible()
    await expect(page.getByRole('rowheader', { name: '1111-01' })).toHaveCount(0)
  })
}

test('latest projection response wins after rapid horizon changes', async ({ page }) => {
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  let seen: (() => void) | undefined
  const started = new Promise<void>(resolve => { seen = resolve })
  await page.route('**/api/v1/projections?*', async route => {
    const years = new URL(route.request().url()).searchParams.get('years')
    const response = await route.fetch()
    const json = await response.json()
    if (years === '5') { json.projection.asOf = '1111-01'; seen?.(); await gate }
    if (years === '20') json.projection.asOf = '2222-01'
    await route.fulfill({ response, json })
  })
  await page.goto('/projections')
  await page.getByRole('button', { name: '5Y', exact: true }).click()
  await started
  const latest = page.waitForResponse(response => response.url().includes('years=20'))
  await page.getByRole('button', { name: '20Y', exact: true }).click()
  await latest
  const earlier = page.waitForResponse(response => response.url().includes('years=5'))
  release?.()
  await earlier
  await expect(page.getByText(/^As of 2222-01\. Values compound/)).toBeVisible()
  await expect(page.getByText(/As of 1111-01/)).toHaveCount(0)
})

test('latest selected month wins when earlier month loads slowly', async ({ page, request }) => {
  const person = await (await request.post('/api/v1/persons', { data: { name: `Month race person ${Date.now()}` } })).json()
  const category = await (await request.post('/api/v1/categories', { data: { name: `Month race category ${Date.now()}`, type: 'asset', projected_yearly_growth: 0, color: '#6366f1' } })).json()
  const asset = await (await request.post('/api/v1/assets', { data: { name: `Month race asset ${Date.now()}`, person_id: person.id, category_id: category.id, projected_yearly_growth: null } })).json()
  for (const [year_month, value] of [['2026-04', 111], ['2026-05', 222]] as const) {
    await request.post('/api/v1/data-points', { data: { asset_id: asset.id, year_month, value } })
  }
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  let seen: (() => void) | undefined
  const started = new Promise<void>(resolve => { seen = resolve })
  await page.route('**/api/v1/data-points?year_month=2026-04', async route => { seen?.(); await gate; await route.continue() })
  await page.goto('/monthly-update?month=2026-03')
  await page.getByRole('combobox', { name: 'Select month' }).click()
  await page.getByRole('option', { name: 'April', exact: true }).click()
  await started
  await page.getByRole('combobox', { name: 'Select month' }).click()
  await page.getByRole('option', { name: 'May', exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: new RegExp(`Value for ${asset.name} in 2026-05`) }).last()).toHaveValue('222')
  const earlier = page.waitForResponse(response => response.url().includes('year_month=2026-04'))
  release?.()
  await earlier
  await expect(page.getByRole('spinbutton', { name: new RegExp(`Value for ${asset.name} in 2026-05`) }).last()).toHaveValue('222')
})

test('projection chart table includes both phases and follows category visibility', async ({ page, request }) => {
  const person = await (await request.post('/api/v1/persons', { data: { name: `Projection table person ${Date.now()}` } })).json()
  const category = await (await request.post('/api/v1/categories', { data: { name: `Projection table category ${Date.now()}`, type: 'asset', projected_yearly_growth: 0.05, color: '#6366f1' } })).json()
  const asset = await (await request.post('/api/v1/assets', { data: { name: `Projection table asset ${Date.now()}`, person_id: person.id, category_id: category.id, projected_yearly_growth: null } })).json()
  const today = new Date()
  await request.post('/api/v1/data-points', { data: { asset_id: asset.id, year_month: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`, value: 1000 } })
  await page.goto('/projections')
  await page.getByText('View projection chart data').click()
  const table = page.getByRole('table', { name: 'Historical and projected values for visible categories' })
  await expect(table.getByRole('columnheader', { name: category.name })).toBeVisible()
  await expect(table.getByText('Historical').first()).toBeVisible()
  await expect(table.getByText('Projected').first()).toBeVisible()
  await page.locator('#assumptions-panel').getByRole('button', { name: new RegExp(category.name) }).click()
  await expect(table.getByRole('columnheader', { name: category.name })).toHaveCount(0)
})

test('missing months and explicitly observed zero remain distinct in chart data', async ({ page, request }) => {
  const person = await (await request.post('/api/v1/persons', { data: { name: `Zero person ${Date.now()}` } })).json()
  const category = await (await request.post('/api/v1/categories', { data: { name: `Zero category ${Date.now()}`, type: 'asset', projected_yearly_growth: 0, color: '#6366f1' } })).json()
  const asset = await (await request.post('/api/v1/assets', { data: { name: `Zero asset ${Date.now()}`, person_id: person.id, category_id: category.id, projected_yearly_growth: null } })).json()
  await request.post('/api/v1/data-points', { data: { asset_id: asset.id, year_month: '2026-03', value: 0 } })
  await page.route('**/api/v1/summary?*', async route => {
    const response = await route.fetch()
    const json = await response.json()
    for (const series of json.asset_series) {
      series.observation_status = json.months.map((_: string, i: number) => i === 0 ? 'missing' : 'observed')
    }
    json.totals[0] = 0
    json.totals[1] = 0
    await route.fulfill({ response, json })
  })
  await page.goto('/')
  await page.getByText('View wealth trends data').click()
  const table = page.getByRole('table', { name: 'wealth trends values by month' })
  const rows = table.locator('tbody tr')
  await expect(rows.nth(0).locator('td').nth(1)).toHaveText('—')
  await expect(rows.nth(1).locator('td').nth(1)).toContainText('0,00')
})
