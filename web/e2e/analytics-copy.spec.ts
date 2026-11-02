import { expect, test, type APIRequestContext } from '@playwright/test'

async function create(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`/api/v1/${path}`, { data })
  expect(response.ok()).toBeTruthy()
  return response.json()
}
function date(offset: number) {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth() + offset, 1)
}
function month(offset: number) {
  const value = date(offset)
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`
}
function monthLabel(offset: number) {
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(date(offset))
}

test('analytics names calendar-month value changes and selected-period income explicitly', async ({ page, request }) => {
  const suffix = Date.now()
  const person = await create(request, 'persons', { name: `Label person ${suffix}` })
  const wealth = await create(request, 'categories', { name: `Label property ${suffix}`, type: 'asset', projected_yearly_growth: 0, color: '#6366f1' })
  const income = await create(request, 'categories', { name: `Label income ${suffix}`, type: 'cash-inflow', projected_yearly_growth: 0, color: '#14b8a6' })
  const changed = await create(request, 'assets', { name: `Updated balance ${suffix}`, category_id: wealth.id, person_id: person.id, projected_yearly_growth: null })
  const carried = await create(request, 'assets', { name: `Earlier balance ${suffix}`, category_id: wealth.id, person_id: person.id, projected_yearly_growth: null })
  const latest = await create(request, 'assets', { name: `New balance ${suffix}`, category_id: wealth.id, person_id: person.id, projected_yearly_growth: null })
  const salary = await create(request, 'assets', { name: `Recorded income ${suffix}`, category_id: income.id, person_id: person.id, projected_yearly_growth: null })
  await create(request, 'data-points/batch', { items: [
    { asset_id: changed.id, year_month: month(-3), value: 180000 },
    { asset_id: changed.id, year_month: month(0), value: 200000 },
    { asset_id: carried.id, year_month: month(-3), value: 100 },
    { asset_id: latest.id, year_month: month(0), value: 50 },
    { asset_id: salary.id, year_month: month(-2), value: 100 },
    { asset_id: salary.id, year_month: month(0), value: 200 },
  ] })
  await page.goto('/analytics')
  await page.getByRole('button', { name: '1Y', exact: true }).click()
  await page.getByRole('button', { name: person.name, exact: true }).click()
  const detail = page.getByTestId('analytics-drilldown-detail')
  const changedRow = detail.getByText(changed.name, { exact: true }).locator('../..')
  await expect(changedRow).toContainText(`Change vs ${monthLabel(-1)}`)
  await expect(changedRow).toContainText('+20.000,00')
  await expect(changedRow).toContainText(`Value recorded in ${monthLabel(0)}`)
  await expect(changedRow).not.toContainText(`Change vs ${monthLabel(-3)}`)
  const carriedRow = detail.getByText(carried.name, { exact: true }).locator('../..')
  await expect(carriedRow).toContainText(`Using value recorded in ${monthLabel(-3)}`)
  await expect(carriedRow).toContainText(`Change vs ${monthLabel(-1)}`)
  await expect(carriedRow).toContainText('+0,00')
  await expect(detail.getByText(latest.name, { exact: true }).locator('../..')).toContainText('Unavailable')
  await expect(detail).not.toContainText(' mo')
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  }
  await page.getByLabel('Category detail type').getByRole('button', { name: 'Income', exact: true }).click()
  await expect(page.getByText(`Income totals for ${monthLabel(-11)} to ${monthLabel(0)}. Future entries are excluded.`)).toBeVisible()
  const incomeRow = detail.getByText(salary.name, { exact: true }).locator('../..')
  await expect(incomeRow).toContainText('300,00')
  await expect(incomeRow).toContainText('Income in selected period')
  await expect(incomeRow).not.toContainText('Change vs')
  await page.goto('/')
  const coverage = page.getByRole('link', { name: 'Monthly entries: 3/4 recorded', exact: true }).locator('..')
  await expect(coverage).toContainText('1 using an earlier recorded value')
  await expect(coverage).toContainText('0 with no value available')
  await expect(page.getByText(/1 item uses an earlier recorded value/)).toBeVisible()
})
