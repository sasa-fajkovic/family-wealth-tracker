import { test, expect } from '@playwright/test'

test('admin creates and edits people, categories and assets without server-owned fields', async ({ page }) => {
  const suffix = String(Date.now())
  const captured: { method: string; path: string; body: Record<string, unknown> }[] = []
  await page.route(/\/api\/v1\/(persons|categories|assets)(\/[^?]+)?$/, async route => {
    const request = route.request()
    if (request.method() === 'POST' || request.method() === 'PUT') captured.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postDataJSON() })
    await route.continue()
  })
  await page.goto('/admin')
  await page.getByRole('tab', { name: 'People' }).click()
  await page.getByRole('button', { name: 'Add Person' }).click()
  await page.getByRole('dialog').getByRole('textbox').first().fill(`UI Person ${suffix}`)
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(`UI Person ${suffix}`)).toBeVisible()
  await page.getByRole('tab', { name: 'Categories' }).click()
  await page.getByRole('button', { name: 'Add Category' }).click()
  await page.getByRole('dialog').getByRole('textbox').first().fill(`UI Category ${suffix}`)
  await page.getByRole('dialog').getByRole('spinbutton').fill('5')
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(`UI Category ${suffix}`)).toBeVisible()
  await page.getByRole('tab', { name: 'Assets' }).click()
  await page.getByRole('button', { name: 'Add Asset' }).click()
  await page.getByRole('dialog').getByRole('textbox').first().fill(`UI Asset ${suffix}`)
  await page.getByRole('dialog').getByRole('textbox').nth(2).fill('A note to clear')
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(`UI Asset ${suffix}`)).toBeVisible()
  for (const kind of ['Person', 'Category', 'Asset']) {
    await page.getByRole('tab', { name: kind === 'Person' ? 'People' : `${kind === 'Category' ? 'Categories' : 'Assets'}` }).click()
    await page.getByRole('button', { name: `Edit ${kind.toLowerCase()} UI ${kind} ${suffix}` }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox').first().fill(`UI ${kind} edited ${suffix}`)
    if (kind === 'Asset') await dialog.getByRole('textbox').nth(2).fill('')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('tabpanel').filter({ visible: true }).getByText(`UI ${kind} edited ${suffix}`)).toBeVisible()
  }
  expect(captured).toHaveLength(6)
  expect(captured.find(operation => operation.method === 'PUT' && operation.path.includes('/assets/'))?.body.notes).toBe('')
  for (const operation of captured) {
    expect(operation.body).not.toHaveProperty('id')
    expect(operation.body).not.toHaveProperty('created_at')
  }
})
