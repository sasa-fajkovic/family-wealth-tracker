import { expect, test, type APIRequestContext } from '@playwright/test'

async function create(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`/api/v1/${path}`, { data })
  expect(response.ok()).toBeTruthy()
  return response.json()
}

test('projection assumptions list inherited and overridden asset rates including future-only assets', async ({ page, request }) => {
  const suffix = Date.now()
  const person = await create(request, 'persons', { name: `Assumptions person ${suffix}` })
  const category = await create(request, 'categories', { name: `Assumptions wealth ${suffix}`, type: 'asset', projected_yearly_growth: 0.05, color: '#6366f1' })
  const incomeCategory = await create(request, 'categories', { name: `Assumptions income ${suffix}`, type: 'cash-inflow', projected_yearly_growth: 0, color: '#10b981' })
  const inherited = await create(request, 'assets', { name: `Inherited current ${suffix}`, person_id: person.id, category_id: category.id, projected_yearly_growth: null })
  const future = await create(request, 'assets', { name: `Inherited future ${suffix} with a long asset name for wrapping`, person_id: person.id, category_id: category.id, projected_yearly_growth: null })
  const override = await create(request, 'assets', { name: `Zero override ${suffix}`, person_id: person.id, category_id: category.id, projected_yearly_growth: 0 })
  const custom = await create(request, 'assets', { name: `Positive override ${suffix}`, person_id: person.id, category_id: category.id, projected_yearly_growth: 0.02 })
  const income = await create(request, 'assets', { name: `Income excluded ${suffix}`, person_id: person.id, category_id: incomeCategory.id, projected_yearly_growth: null })
  const now = new Date()
  const month = (offset: number) => { const date = new Date(now.getFullYear(), now.getMonth() + offset, 1); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` }
  await create(request, 'data-points/batch', { items: [
    { asset_id: inherited.id, year_month: month(0), value: 1000 },
    { asset_id: future.id, year_month: month(1), value: 700 },
    { asset_id: override.id, year_month: month(0), value: 50 },
  ] })
  await page.goto('/projections')
  const panel = page.locator('#assumptions-panel')
  const currentRow = panel.getByText(inherited.name, { exact: true }).locator('..')
  const futureRow = panel.getByText(future.name, { exact: true }).locator('..')
  const overrideRow = panel.getByText(override.name, { exact: true }).locator('..')
  const customRow = panel.getByText(custom.name, { exact: true }).locator('..')
  for (const name of [inherited.name, future.name, override.name, custom.name]) await expect(panel.getByText(name, { exact: true })).toHaveCount(1)
  for (const row of [currentRow, futureRow]) {
    await expect(row.locator('p').nth(1)).toHaveText(/Category rate\s*·\s*5\s*%\/yr/)
  }
  await expect(overrideRow.locator('p').nth(1)).toHaveText(/Asset override\s*·\s*0\s*%\/yr/)
  await expect(customRow.locator('p').nth(1)).toHaveText(/Asset override\s*·\s*2\s*%\/yr/)
  await expect(panel.getByText(income.name, { exact: true })).toHaveCount(0)
  await expect(page.getByText('Current category breakdown', { exact: true })).toBeVisible()
  await expect(page.getByText(/Only nonzero current balances are shown/)).toBeVisible()
  const breakdown = page.getByTestId('current-category-breakdown')
  const categoryRow = breakdown.getByRole('button', { name: new RegExp(category.name) }).locator('..')
  await categoryRow.getByRole('button', { name: '2 details', exact: true }).click()
  await expect(breakdown.getByText(inherited.name, { exact: true })).toBeVisible()
  await expect(breakdown.getByText(future.name, { exact: true })).toHaveCount(0)
  const response = await request.get('/api/v1/projections?years=10&scenario=base')
  expect(response.ok()).toBeTruthy()
  const projection = (await response.json()).projection
  const next = projection.months.indexOf(month(1))
  const categorySeries = projection.series.find((item: { category_id: string }) => item.category_id === category.id)
  expect(next).toBeGreaterThanOrEqual(0)
  expect(categorySeries.values[next]).toBeCloseTo(1000 * (1.05 ** (1 / 12)) + 700 + 50, 5)
  await page.getByRole('button', { name: '1.5× rates', exact: true }).click()
  await expect(currentRow.locator('p').nth(1)).toHaveText(/Category rate\s*·\s*7,5\s*%\/yr/)
  await expect(futureRow.locator('p').nth(1)).toHaveText(/Category rate\s*·\s*7,5\s*%\/yr/)
  await expect(overrideRow.locator('p').nth(1)).toHaveText(/Asset override\s*·\s*0\s*%\/yr/)
  await expect(customRow.locator('p').nth(1)).toHaveText(/Asset override\s*·\s*3\s*%\/yr/)
  await expect(futureRow.locator('p').first()).toHaveCSS('white-space', 'normal')
})
