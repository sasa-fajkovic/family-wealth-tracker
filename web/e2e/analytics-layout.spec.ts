import { test, expect, type APIRequestContext } from '@playwright/test'

async function create(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`/api/v1/${path}`, { data })
  expect(response.ok()).toBeTruthy()
  return response.json()
}

test('analytics drilldown and advanced charts use available space at desktop and mobile widths', async ({ page, request }) => {
  const suffix = Date.now()
  const people = []
  const categories = []
  for (let i = 0; i < 4; i++) people.push(await create(request, 'persons', { name: `Layout Person ${suffix} ${i}` }))
  for (let i = 0; i < 4; i++) categories.push(await create(request, 'categories', { name: `Layout Category ${suffix} ${i}`, type: 'asset', projected_yearly_growth: 0.05, color: ['#6366f1', '#10b981', '#f59e0b', '#3b82f6'][i] }))
  const now = new Date()
  const ym = (year: number) => `${year}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const longName = `Layout Asset ${suffix} 00 A very long investment account name with an extraordinarily long identifier ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`
  const items: { asset_id: string; year_month: string; value: number }[] = []
  for (let i = 0; i < 27; i++) {
    const asset = await create(request, 'assets', { name: i === 0 ? longName : `Layout Asset ${suffix} ${String(i).padStart(2, '0')}`, person_id: people[i % 4].id, category_id: categories[i < 5 ? 0 : 1 + ((i - 5) % 3)].id, projected_yearly_growth: null })
    items.push({ asset_id: asset.id, year_month: ym(now.getFullYear() - 4), value: 1000 + i * 100 })
    items.push({ asset_id: asset.id, year_month: ym(now.getFullYear()), value: 2000 + i * 100 })
  }
  await create(request, 'data-points/batch', { items })
  await page.goto('/analytics')
  await page.getByRole('button', { name: '10Y', exact: true }).click()
  await page.getByRole('button', { name: people[0].name, exact: true }).click()
  const period = page.getByText('Period Change', { exact: true }).locator('..')
  await expect(period).toContainText('7.000,00')
  await expect(period).toContainText(`Since ${ym(now.getFullYear() - 4)}`)
  await page.getByRole('button', { name: 'All', exact: true }).click()
  const drilldown = page.getByTestId('analytics-drilldown')
  await drilldown.getByRole('button', { name: new RegExp(`Layout Category ${suffix} 0`) }).click()
  const detail = page.getByTestId('analytics-drilldown-detail')
  for (let i = 0; i < 5; i++) await expect(detail.getByText(i === 0 ? longName : `Layout Asset ${suffix} ${String(i).padStart(2, '0')}`, { exact: true })).toBeVisible()
  await page.getByText('Explore more', { exact: true }).click()
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const drillBox = await drilldown.boundingBox()
    expect(drillBox).not.toBeNull()
    expect(drillBox!.width).toBeGreaterThanOrEqual(width - 70)
    const grid = page.getByTestId('analytics-explore-grid')
    const cards = grid.locator(':scope > div')
    await expect(cards).toHaveCount(6)
    for (let i = 0; i < 6; i += 2) {
      const first = await cards.nth(i).boundingBox()
      const second = await cards.nth(i + 1).boundingBox()
      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      if (width >= 1024) {
        expect(Math.abs(first!.y - second!.y)).toBeLessThan(2)
        expect(second!.x).toBeGreaterThan(first!.x + first!.width)
        expect(Math.abs(first!.width - second!.width)).toBeLessThan(2)
      } else {
        expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height)
        expect(Math.abs(first!.width - second!.width)).toBeLessThan(2)
      }
    }
    expect(await detail.evaluate(element => [element, ...element.querySelectorAll('*')].some(child => {
      const style = getComputedStyle(child)
      return ['auto', 'scroll'].includes(style.overflowY) && child.scrollHeight > child.clientHeight
    }))).toBe(false)
    if (width === 1440) {
      const normalRow = detail.getByText(`Layout Asset ${suffix} 01`, { exact: true }).locator('../..')
      const rowBox = await normalRow.boundingBox()
      expect(rowBox).not.toBeNull()
      expect(rowBox!.height).toBeLessThanOrEqual(84)
    }
    if (width === 390) {
      const name = detail.getByText(longName, { exact: true })
      const size = await name.evaluate(element => ({ height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(element).lineHeight), scrollWidth: element.scrollWidth, width: element.clientWidth, overflow: getComputedStyle(element).textOverflow }))
      expect(size.height).toBeGreaterThan(size.lineHeight * 1.5)
      expect(size.scrollWidth).toBeLessThanOrEqual(size.width)
      expect(size.overflow).not.toBe('ellipsis')
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  }
})

test('dashboard and analytics show period baseline from the summary contract', async ({ page }) => {
  await page.route('**/api/v1/summary?*', async route => {
    const response = await route.fetch()
    const json = await response.json()
    const available = new URL(route.request().url()).searchParams.get('range') !== '6m'
    json.period_delta_available = available
    json.period_start_month = available ? '2021-04' : null
    json.period_delta_abs = 1250
    await route.fulfill({ response, json })
  })
  for (const path of ['/', '/analytics']) {
    await page.goto(path)
    const card = page.getByText('Period Change', { exact: true }).locator('..')
    await expect(card).toContainText('1.250,00')
    await expect(card).toContainText('Since 2021-04')
    await page.getByRole('button', { name: '6M', exact: true }).click()
    await expect(card).toContainText('—')
    await expect(card.locator('p').nth(1)).toHaveClass(/text-gray-500/)
    await expect(card).not.toContainText('Since')
    await page.getByRole('button', { name: '3Y', exact: true }).click()
    await expect(card).toContainText('Since 2021-04')
  }
  await page.unrouteAll({ behavior: 'wait' })
})

test('analytics includes observed zero balances in drilldown and scatter baselines', async ({ page, request }) => {
  const suffix = Date.now()
  const person = await create(request, 'persons', { name: `Zero layout person ${suffix}` })
  const first = await create(request, 'categories', { name: `Zero baseline ${suffix}`, type: 'asset', projected_yearly_growth: 0, color: '#6366f1' })
  const second = await create(request, 'categories', { name: `Zero only ${suffix}`, type: 'asset', projected_yearly_growth: 0, color: '#10b981' })
  const changing = await create(request, 'assets', { name: `Zero then growth ${suffix}`, category_id: first.id, person_id: person.id, projected_yearly_growth: null })
  const zero = await create(request, 'assets', { name: `Zero balance ${suffix}`, category_id: second.id, person_id: person.id, projected_yearly_growth: null })
  const latestOnly = await create(request, 'assets', { name: `First this month ${suffix}`, category_id: first.id, person_id: person.id, projected_yearly_growth: null })
  const now = new Date()
  const month = (offset: number) => { const date = new Date(now.getFullYear(), now.getMonth() + offset, 1); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` }
  await create(request, 'data-points/batch', { items: [
    { asset_id: changing.id, year_month: month(-2), value: 0 },
    { asset_id: changing.id, year_month: month(-1), value: 100 },
    { asset_id: changing.id, year_month: month(0), value: 150 },
    { asset_id: zero.id, year_month: month(-2), value: 0 },
    { asset_id: latestOnly.id, year_month: month(0), value: 0 },
  ] })
  await page.goto('/analytics')
  await page.getByRole('button', { name: person.name, exact: true }).click()
  const drilldown = page.getByTestId('analytics-drilldown')
  await drilldown.getByRole('button', { name: new RegExp(`Zero baseline ${suffix}`) }).click()
  const latestRow = page.getByTestId('analytics-drilldown-detail').getByText(latestOnly.name, { exact: true }).locator('../..')
  await expect(latestRow).toContainText('— mo')
  await drilldown.getByRole('button', { name: new RegExp(`Zero only ${suffix}`) }).click()
  await expect(page.getByTestId('analytics-drilldown-detail').getByText(zero.name, { exact: true })).toBeVisible()
  await page.getByText('Explore more', { exact: true }).click()
  await page.getByText('View category performance data').click()
  const scatter = page.getByRole('table', { name: 'category performance chart data' })
  await expect(scatter.getByRole('row').filter({ hasText: first.name })).toContainText('150,00')
  await expect(scatter.getByRole('row').filter({ hasText: first.name }).locator('td').last()).toContainText('150,00')
})
