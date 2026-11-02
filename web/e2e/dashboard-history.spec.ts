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

for (const kind of ['income', 'closed debt', 'recorded zero'] as const) {
  test(`dashboard retains ${kind} history independently of the current value`, async ({ page, request }) => {
    const suffix = `${kind} ${Date.now()}`
    const person = await create(request, 'persons', { name: `Trend history ${suffix}` })
    const category = await create(request, 'categories', {
      name: `History ${suffix}`, type: kind === 'income' ? 'cash-inflow' : 'liability',
      projected_yearly_growth: 0, color: '#6366f1',
    })
    const asset = await create(request, 'assets', {
      name: `History item ${suffix}`, category_id: category.id, person_id: person.id, projected_yearly_growth: null,
    })
    await create(request, 'data-points/batch', { items: [
      { asset_id: asset.id, year_month: month(-2), value: kind === 'income' ? 700 : -500 },
      { asset_id: asset.id, year_month: month(-1), value: kind === 'income' ? 900 : 0 },
      ...(kind === 'recorded zero' ? [{ asset_id: asset.id, year_month: month(0), value: 0 }] : []),
    ] })
    if (kind === 'closed debt') {
      const response = await request.put(`/api/v1/assets/${asset.id}`, { data: {
        name: asset.name, category_id: category.id, person_id: person.id,
        projected_yearly_growth: null, closed_at: month(-1),
      } })
      expect(response.ok()).toBeTruthy()
    }
    await page.goto('/')
    await page.getByRole('button', { name: person.name, exact: true }).click()
    await page.getByRole('button', { name: '1Y', exact: true }).click()
    const card = page.getByTestId(`dashboard-${kind === 'income' ? 'income' : 'liabilities'}-trend`)
    await expect(card.locator('canvas')).toBeVisible()
    await expect(card.getByText('No data yet', { exact: true })).toHaveCount(0)
    await expect(card.locator('p.tabular-nums')).toHaveText(kind === 'recorded zero' ? '0,00 €' : '—')
    const tableKind = kind === 'income' ? 'income trend' : 'wealth trends'
    await page.getByText(`View ${tableKind} data`, { exact: true }).click()
    const table = page.getByRole('table', { name: `${tableKind} values by month`, exact: true })
    const historicRow = table.getByRole('row').filter({
      has: page.getByRole('rowheader', { name: month(-2), exact: true }),
    })
    await expect(historicRow).toContainText(kind === 'income' ? '700,00' : '-500,00')
    const emptyCard = page.getByTestId('dashboard-assets-trend')
    await expect(emptyCard.getByText('No data yet', { exact: true })).toBeVisible()
    await expect(emptyCard.locator('canvas')).toHaveCount(0)
  })
}
