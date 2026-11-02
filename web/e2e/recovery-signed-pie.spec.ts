import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

async function create(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`/api/v1/${path}`, { data })
  expect(response.ok()).toBeTruthy()
  return response.json()
}
function month() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }
async function fixture(request: APIRequestContext, type = 'asset') {
  const suffix = `${Date.now()}-${Math.random()}`
  const person = await create(request, 'persons', { name: `Recovery person ${suffix}` })
  const category = await create(request, 'categories', { name: `Recovery category ${suffix}`, type, projected_yearly_growth: 0, color: '#14b8a6' })
  const asset = await create(request, 'assets', { name: `Recovery item ${suffix}`, person_id: person.id, category_id: category.id, projected_yearly_growth: null })
  return { person, category, asset }
}
async function block(page: Page, endpoint: string, status = 0) {
  let blocked = true
  await page.route(`**/api/v1/${endpoint}`, route => blocked ? (status ? route.fulfill({ status, body: 'Temporary failure' }) : route.abort()) : route.continue())
  return () => { blocked = false }
}

test('setup failures persist through chart reloads and recover independently', async ({ page, request }) => {
  const { person, category, asset } = await fixture(request)
  await create(request, 'data-points/batch', { items: [{ asset_id: asset.id, year_month: month(), value: 55 }] })
  for (const [path, button, error] of [
    ['/', 'Retry people and items', 'Could not load people and items'],
    ['/income', 'Retry people and items', 'Person filter and income drilldown unavailable'],
    ['/analytics', 'Retry person filter', 'Person filter unavailable'],
    ['/data-points', 'Retry item names', 'Could not load item names and filters'],
  ]) {
    const unblock = await block(page, 'persons', path === '/income' ? 500 : 0)
    await page.goto(path)
    await expect(page.getByText(error, { exact: false })).toBeVisible()
    if (path === '/') {
      await expect(page.getByText('No data to display', { exact: true })).toHaveCount(0)
      await expect(page.getByText('No active items to display', { exact: true })).toHaveCount(0)
    }
    if (['/', '/income', '/analytics'].includes(path)) {
      await page.getByRole('button', { name: '6M', exact: true }).click()
      await expect(page.getByText(error, { exact: false })).toBeVisible()
    }
    unblock()
    await page.getByRole('button', { name: button }).click()
    await expect(page.getByText(error, { exact: false })).toHaveCount(0)
    if (path !== '/data-points') await expect(page.getByRole('button', { name: person.name, exact: true })).toBeVisible()
    else {
      await page.getByRole('combobox', { name: 'Filter by item' }).click()
      await page.getByRole('option', { name: asset.name, exact: true }).click()
      const row = page.getByRole('row').filter({ hasText: asset.name })
      await expect(row).toContainText(person.name)
      await expect(row).toContainText(category.name)
    }
    await page.unrouteAll({ behavior: 'wait' })
  }
})

test('monthly retry preserves deep link and unsaved changes', async ({ page, request }) => {
  const { person, category, asset } = await fixture(request)
  const unblock = await block(page, 'assets')
  await page.goto(`/monthly-update?month=${month()}&person=${person.id}&category=${category.id}`)
  await expect(page.getByText('Could not load data:', { exact: false })).toBeVisible()
  unblock()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  const input = page.getByRole('spinbutton', { name: `Value for ${asset.name} in ${month()}` }).last()
  await expect(input).toBeVisible()
  await expect(page.getByText(person.name, { exact: true }).first()).toBeVisible()
  await input.fill('123')
  await page.getByRole('button', { name: 'Next month' }).click()
  await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible()
  await page.getByRole('button', { name: 'Stay', exact: true }).click()
  await expect(input).toHaveValue('123')
})

test('projection assumptions retry and closing-month hint', async ({ page, request }) => {
  const { asset, category, person } = await fixture(request)
  await create(request, 'data-points/batch', { items: [{ asset_id: asset.id, year_month: month(), value: 0 }] })
  expect((await request.put(`/api/v1/assets/${asset.id}`, { data: { name: asset.name, category_id: category.id, person_id: person.id, projected_yearly_growth: null, closed_at: month() } })).ok()).toBeTruthy()
  const unblock = await block(page, 'assets')
  await page.goto('/projections')
  await expect(page.getByText('Could not load growth assumptions:', { exact: false })).toBeVisible()
  unblock()
  await page.getByRole('button', { name: 'Retry assumptions' }).click()
  const row = page.locator('#assumptions-panel').getByText(asset.name, { exact: true }).locator('..')
  await expect(row).toContainText(`Closed in ${month()}; no future forecast.`)
})

test('income pie keeps signed totals and explains positive-only shares', async ({ page, request }) => {
  const { person, category, asset } = await fixture(request, 'cash-inflow')
  const negative = await create(request, 'assets', { name: `Negative ${Date.now()}`, person_id: person.id, category_id: category.id, projected_yearly_growth: null })
  await create(request, 'data-points/batch', { items: [ { asset_id: asset.id, year_month: month(), value: 1000 }, { asset_id: negative.id, year_month: month(), value: -200 } ] })
  await page.goto('/income')
  await page.getByRole('button', { name: person.name, exact: true }).click()
  await page.getByTitle('Pie', { exact: true }).click()
  await expect(page.getByText('Negative values are omitted', { exact: false })).toBeVisible()
  await page.getByText('View pie chart data').click()
  await expect(page.getByRole('row').filter({ hasText: negative.name })).toContainText('-200,00')
  await expect(page.getByText('Income in selected period').locator('..')).toContainText('800,00')
  const box = await page.locator('canvas').boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.click(box!.x + box!.width / 2 + Math.min(box!.width, box!.height) / 4, box!.y + box!.height / 2)
  await expect(page).toHaveURL(/monthly-update/)
  await expect(page.getByRole('spinbutton', { name: `Value for ${asset.name} in ${month()}` }).last()).toBeVisible()
  await page.goto('/income')
  await page.getByRole('button', { name: `Disable ${asset.name}` }).click()
  await expect(page.getByText('No positive values to show in the pie chart for this month.')).toBeVisible()
  await page.getByRole('button', { name: `Disable ${negative.name}` }).click()
  await expect(page.getByText('No positive values to show in the pie chart for this month.')).toBeVisible()
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await expect(page.getByText('Negative values are omitted', { exact: false })).toHaveCount(0)
  await expect(page.getByText('View pie chart data').locator('..')).toContainText('800,00')
  await create(request, 'data-points/batch', { items: [{ asset_id: negative.id, year_month: month(), value: 0 }] })
  await page.goto('/income')
  await page.getByRole('button', { name: person.name, exact: true }).click()
  await page.getByRole('button', { name: `Disable ${asset.name}` }).click()
  await expect(page.getByText('No positive values to show in the pie chart for this month.')).toBeVisible()
  await expect(page.getByText('Negative values are omitted', { exact: false })).toHaveCount(0)
})
