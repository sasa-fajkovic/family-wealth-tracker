import { test, expect } from '@playwright/test'

test('dashboard links to missing entries for its person and current month', async ({ page, request }) => {
  const suffix = Date.now()
  const create = async (path: string, data: unknown) => {
    const response = await request.post(`/api/v1/${path}`, { data })
    expect(response.ok()).toBeTruthy()
    return response.json()
  }
  const person = await create('persons', { name: `Missing person ${suffix}` })
  const other = await create('persons', { name: `Other person ${suffix}` })
  const category = await create('categories', { name: `Missing category ${suffix}`, type: 'asset', projected_yearly_growth: 0, color: '#6366f1' })
  const saved = await create('assets', { name: `Saved ${suffix}`, person_id: person.id, category_id: category.id, projected_yearly_growth: null })
  const missing = await create('assets', { name: `Missing ${suffix}`, person_id: person.id, category_id: category.id, projected_yearly_growth: null })
  const otherAsset = await create('assets', { name: `Other ${suffix}`, person_id: other.id, category_id: category.id, projected_yearly_growth: null })
  await create('data-points', { asset_id: saved.id, year_month: '2026-05', value: 0 })
  await page.route('**/api/v1/summary?*', async route => {
    const response = await route.fetch()
    const json = await response.json()
    json.current_month = '2026-05'
    json.monthly_coverage = { observed: 1, carried: 0, missing: 1, total: 2 }
    await route.fulfill({ response, json })
  })
  await page.goto('/')
  await page.getByRole('button', { name: person.name, exact: true }).click()
  const link = page.getByRole('link', { name: 'Update missing' })
  await expect(link).toHaveAttribute('href', /month=2026-05/)
  await link.click()
  await expect(page.getByLabel('Missing only')).toBeChecked()
  await expect(page.getByRole('spinbutton', { name: new RegExp(`Value for ${missing.name} in 2026-05`) }).last()).toBeVisible()
  await expect(page.getByRole('spinbutton', { name: new RegExp(`Value for ${saved.name}`) })).toHaveCount(0)
  await expect(page.getByRole('spinbutton', { name: new RegExp(`Value for ${otherAsset.name}`) })).toHaveCount(0)
})

test('projection rate sensitivity labels explain assumptions and retain API scenarios', async ({ page }) => {
  await page.goto('/projections')
  await expect(page.getByText(/Income is not invested, and expenses, taxes and inflation are not modeled/)).toBeVisible()
  for (const [label, scenario] of [['0.5× rates', 'conservative'], ['1× rates', 'base'], ['1.5× rates', 'aggressive']] as const) {
    const response = page.waitForResponse(result => result.url().includes(`/projections?`) && result.url().includes(`scenario=${scenario}`))
    await page.getByRole('button', { name: label, exact: true }).click()
    await response
  }
  await expect(page.getByText(/From latest data month/)).toHaveCount(0)
})

test('tablet navigation and page layouts fit in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 })
  for (const path of ['/', '/analytics', '/income', '/projections', '/monthly-update', '/data-points', '/admin']) {
    await page.goto(path)
    for (let i = 0; i < 2; i++) {
      await expect(page.getByRole('button', { name: 'Open navigation menu' })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768)
      await page.getByRole('button', { name: /Switch to (light|dark) mode/ }).click()
    }
  }
})
