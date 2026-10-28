import { expect, test } from '@playwright/test'

test('monthly period controls remain aligned and usable across viewport sizes and themes', async ({ page }) => {
  await page.goto('/monthly-update?month=2026-05')
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (let theme = 0; theme < 2; theme++) {
      for (const name of ['Previous month', 'Next month', 'Previous year', 'Next year', 'This month']) {
        const button = page.getByRole('button', { name, exact: true })
        await expect(button).toBeVisible()
        const box = await button.boundingBox()
        expect(box!.height).toBe(44)
        expect(box!.width).toBeGreaterThanOrEqual(44)
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      }
      for (const name of ['Select month', 'Jump to year']) {
        const field = page.getByLabel(name, { exact: true })
        await expect(field).toBeVisible()
        const box = await field.boundingBox()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      await page.getByRole('button', { name: /Switch to (dark|light) mode/ }).click()
    }
  }
})

test('monthly navigation works by keyboard and retains the year on stay', async ({ page, request }) => {
  const suffix = Date.now()
  const create = async (path: string, data: unknown) => {
    const response = await request.post(`/api/v1/${path}`, { data })
    expect(response.ok()).toBeTruthy()
    return response.json()
  }
  const person = await create('persons', { name: `Navigator person ${suffix}` })
  const category = await create('categories', { name: `Navigator category ${suffix}`, type: 'asset', projected_yearly_growth: 0.05, color: '#6366f1' })
  const asset = await create('assets', { name: `Navigator asset ${suffix}`, person_id: person.id, category_id: category.id, projected_yearly_growth: null })
  await page.goto('/monthly-update?month=2026-05')
  const previous = page.getByRole('button', { name: 'Previous month' })
  await previous.focus()
  await expect(previous).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('spinbutton', { name: new RegExp(`Value for ${asset.name} in 2026-04`) }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Next month' }).click()
  const value = page.getByRole('spinbutton', { name: new RegExp(`Value for ${asset.name} in 2026-05`) }).last()
  await value.fill('25')
  const year = page.getByRole('spinbutton', { name: 'Jump to year' })
  await year.fill('2025')
  await year.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible()
  await page.getByRole('button', { name: 'Stay', exact: true }).click()
  await expect(year).toHaveValue('2026')
  await expect(value).toHaveValue('25')
})
