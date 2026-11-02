import { expect, test } from '@playwright/test'

test('monthly mobile cards wrap long asset and metadata names without overflow', async ({ page, request }) => {
  const suffix = String(Date.now())
  const create = async (path: string, data: unknown) => {
    const response = await request.post(`/api/v1/${path}`, { data })
    expect(response.ok()).toBeTruthy()
    return response.json()
  }
  const personName = `Person${suffix}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`
  const categoryName = `Category${suffix}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`
  const assetName = `Asset${suffix}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ`
  const person = await create('persons', { name: personName })
  const category = await create('categories', { name: categoryName, type: 'asset', projected_yearly_growth: 0.05, color: '#6366f1' })
  await create('assets', { name: assetName, category_id: category.id, person_id: person.id, projected_yearly_growth: null })
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto('/monthly-update')
  const card = page.getByTestId('monthly-row').filter({ hasText: assetName }).first()
  const name = card.getByText(assetName, { exact: true })
  const metadata = card.getByText(`${categoryName} · ${personName}`, { exact: true })
  for (let theme = 0; theme < 2; theme++) {
    for (const text of [name, metadata]) {
      await expect(text).toBeVisible()
      const geometry = await text.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(element).lineHeight), textOverflow: getComputedStyle(element).textOverflow }))
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width)
      expect(geometry.height).toBeGreaterThan(geometry.lineHeight)
      expect(geometry.textOverflow).not.toBe('ellipsis')
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    await page.getByRole('button', { name: /Switch to (light|dark) mode/ }).click()
  }
})
