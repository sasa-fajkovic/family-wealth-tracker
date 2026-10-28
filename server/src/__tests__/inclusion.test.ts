import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify, parse } from 'yaml'
import type { Database, DataPoint } from '../models/index.js'
import type { SummaryResponse } from '../calc/summary.js'
import type { ProjectionBlock } from '../calc/projections.js'

const root = await mkdtemp(join(tmpdir(), 'wt-inclusion-'))
const yamlPath = join(root, 'database.yaml')
const csvPath = join(root, 'datapoints.csv')
process.env.DATA_FILE = yamlPath
process.env.DATA_POINTS_FILE = csvPath
process.env.LOGS_DIR = join(root, 'logs')
const { Hono } = await import('hono')
const { HTTPException } = await import('hono/http-exception')
const { encodeDataPoints } = await import('../storage/csv.js')
const { bootstrapDatabase } = await import('../bootstrap.js')
const app = new Hono()
app.onError((error, c) => {
  if (error instanceof RangeError) return c.json({ error: error.message }, 400)
  if (error instanceof HTTPException) return error.res ? error.getResponse() : c.json({ error: error.message }, error.status)
  return c.json({ error: error.message }, 500)
})
for (const route of ['assets', 'categories', 'persons', 'summary', 'projections', 'import', 'export']) {
  app.route(`/api/v1/${route}`, (await import(`../routes/${route}.js`)).default)
}
app.route('/api/v1/data-points', (await import('../routes/dataPoints.js')).default)
const stamp = '2024-01-01T00:00:00Z'
const now = new Date()
function month(offset = 0) {
  const date = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}
function seed(): Database {
  return {
    categories: [
      { id: 'stock', name: 'Stock', projected_yearly_growth: 0, color: '#123456', type: 'asset' },
      { id: 'debt', name: 'Debt', projected_yearly_growth: 0, color: '#123456', type: 'liability', include_in_current_wealth: false, include_in_projections: false },
      { id: 'income', name: 'Income', projected_yearly_growth: 0, color: '#123456', type: 'cash-inflow' },
    ],
    persons: [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }],
    assets: [
      { id: 'account', name: 'Account', category_id: 'stock', person_id: 'alice', projected_yearly_growth: null, created_at: stamp },
      { id: 'loan', name: 'Loan', category_id: 'debt', person_id: 'bob', projected_yearly_growth: null, created_at: stamp },
      { id: 'salary', name: 'Salary', category_id: 'income', person_id: 'alice', projected_yearly_growth: null, created_at: stamp },
    ],
  }
}
function point(id: string, asset_id: string, year_month: string, value: number): DataPoint {
  return { id, asset_id, year_month, value, created_at: stamp, updated_at: stamp }
}
function points() {
  return [point('current', 'account', month(), 100), point('planned', 'account', month(3), 700), point('debt', 'loan', month(), -50), point('income', 'salary', month(), 9000)]
}
async function reset(db = seed(), values = points()) {
  await rm(root, { recursive: true, force: true })
  await mkdir(root)
  await writeFile(yamlPath, stringify(db))
  await writeFile(csvPath, encodeDataPoints(values))
}
async function get<T>(path: string): Promise<T> {
  const response = await app.request(`/api/v1/${path}`)
  assert.equal(response.status, 200)
  return await response.json() as T
}
const json = (path: string, body: unknown, method = 'POST') => app.request(`/api/v1/${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const summary = () => get<SummaryResponse & { monthly_coverage: { total: number } }>('summary?range=10y')
const projections = () => get<{ historical: SummaryResponse; projection: ProjectionBlock }>('projections?years=1')
beforeEach(() => reset())
after(() => rm(root, { recursive: true, force: true }))

for (const current of [false, true]) for (const projected of [false, true]) {
  test(`route classification matrix current=${current} projected=${projected} leaves inventory/monthly/history intact`, async () => {
    const db = seed()
    Object.assign(db.categories[0], { include_in_current_wealth: current, include_in_projections: projected })
    await reset(db)
    const wealth = await summary()
    assert.equal(wealth.current_total, current ? 100 : 0)
    assert.equal(wealth.gross_assets, current ? 100 : 0)
    assert.equal(wealth.asset_breakdown.some(asset => asset.asset_id === 'account'), current)
    assert.equal(wealth.category_breakdown.find(category => category.category_id === 'stock')?.value, current ? 100 : 0)
    assert.equal(wealth.monthly_coverage.total, 3)
    assert.equal((await get<unknown[]>('assets')).length, 3)
    assert.equal((await get<unknown[]>('data-points')).length, 4)
    const result = await projections()
    assert.equal(result.historical.current_total, current ? 100 : 0)
    assert.deepEqual(result.projection.totals.slice(0, 3), projected ? current ? [300, 500, 700] : [0, 0, 700] : [0, 0, 0])
    assert.deepEqual(result.projection.available.slice(0, 3), projected ? current ? [true, true, true] : [false, false, true] : [false, false, false])
  })
}

test('explicit asset true overrides disabled category on both route filters', async () => {
  const db = seed()
  Object.assign(db.categories[0], { include_in_current_wealth: false, include_in_projections: false })
  Object.assign(db.assets[0], { include_in_current_wealth: true, include_in_projections: true })
  await reset(db)
  assert.equal((await summary()).current_total, 100)
  const result = await projections()
  assert.equal(result.historical.current_total, 100)
  assert.deepEqual(result.projection.totals.slice(0, 3), [300, 500, 700])
  assert.equal(result.projection.asset_metadata[0].effective_include_in_current_wealth, true)
  assert.equal(result.projection.asset_metadata[0].effective_include_in_projections, true)
})

test('explicit asset false overrides enabled category and null restores inheritance', async () => {
  const db = seed()
  Object.assign(db.categories[0], { include_in_current_wealth: true, include_in_projections: true })
  Object.assign(db.assets[0], { include_in_current_wealth: false, include_in_projections: false })
  await reset(db)
  assert.equal((await summary()).current_total, 0)
  assert.ok((await projections()).projection.totals.every(value => value === 0))
  const body = { name: 'Account', category_id: 'stock', person_id: 'alice', projected_yearly_growth: null, include_in_current_wealth: null, include_in_projections: null }
  assert.equal((await json('assets/account', body, 'PUT')).status, 200)
  assert.equal((await summary()).current_total, 100)
  assert.deepEqual((await projections()).projection.totals.slice(0, 3), [300, 500, 700])
})

test('new category defaults enabled and new assets default to explicit null inheritance', async () => {
  const response = await json('categories', { name: 'New', type: 'asset', projected_yearly_growth: 0, color: '#123456' })
  assert.equal(response.status, 201)
  const category = await response.json() as { include_in_current_wealth: boolean; include_in_projections: boolean }
  assert.deepEqual([category.include_in_current_wealth, category.include_in_projections], [true, true])
  const created = await json('assets', { name: 'New', category_id: 'new', person_id: 'alice', projected_yearly_growth: null })
  assert.equal(created.status, 201)
  const asset = await created.json() as { include_in_current_wealth: null; include_in_projections: null }
  assert.deepEqual([asset.include_in_current_wealth, asset.include_in_projections], [null, null])
})

test('PUT omission preserves category settings and explicit asset overrides', async () => {
  const db = seed()
  Object.assign(db.categories[0], { include_in_current_wealth: false, include_in_projections: true })
  Object.assign(db.assets[0], { include_in_current_wealth: true, include_in_projections: false })
  await reset(db)
  assert.equal((await json('categories/stock', { name: 'Stock', type: 'asset', projected_yearly_growth: 0, color: '#123456' }, 'PUT')).status, 200)
  assert.equal((await json('assets/account', { name: 'Account', category_id: 'stock', person_id: 'alice', projected_yearly_growth: null }, 'PUT')).status, 200)
  const stored = parse(await readFile(yamlPath, 'utf8')) as Database
  assert.deepEqual([stored.categories[0].include_in_current_wealth, stored.categories[0].include_in_projections], [false, true])
  assert.deepEqual([stored.assets[0].include_in_current_wealth, stored.assets[0].include_in_projections], [true, false])
})

test('income settings do not change income history or admit income to wealth/projections', async () => {
  const db = seed()
  Object.assign(db.categories[2], { include_in_current_wealth: false, include_in_projections: false })
  Object.assign(db.assets[2], { include_in_current_wealth: true, include_in_projections: true })
  await reset(db)
  assert.equal((await summary()).current_total, 100)
  const income = await get<SummaryResponse>('summary?tracking=true&range=1y')
  assert.equal(income.current_total, 9000)
  assert.ok(income.asset_breakdown.some(asset => asset.asset_id === 'salary'))
  assert.ok(!(await projections()).projection.asset_metadata.some(asset => asset.asset_id === 'salary'))
})

test('current exclusion applies to historical wealth and planned summary without hiding records or changing person scope', async () => {
  const db = seed()
  db.assets[0].include_in_current_wealth = false
  db.assets[1].include_in_current_wealth = true
  await reset(db, [...points(), point('old', 'account', month(-12), 50)])
  const hidden = await get<SummaryResponse>('summary?range=10y&person=alice&planned=true')
  assert.ok(hidden.totals.every(value => value === 0))
  assert.ok(!hidden.asset_series.some(asset => asset.asset_id === 'account'))
  const debt = await get<SummaryResponse>('summary?range=10y&person=bob')
  assert.equal(debt.current_total, -50)
  assert.equal(debt.total_liabilities, -50)
  assert.equal((await get<unknown[]>('data-points?person_id=alice')).length, 4)
})

test('legacy missing flags default effectively enabled without any startup/import/export format rewrite', async () => {
  const db = seed()
  const beforeYaml = await readFile(yamlPath, 'utf8')
  const beforeCsv = await readFile(csvPath, 'utf8')
  await bootstrapDatabase()
  assert.equal(await readFile(yamlPath, 'utf8'), beforeYaml)
  assert.equal(await readFile(csvPath, 'utf8'), beforeCsv)
  assert.equal((await summary()).current_total, 100)
  assert.equal((await projections()).projection.asset_metadata[0].effective_include_in_projections, true)
  const exported = await app.request('/api/v1/export/database')
  assert.equal(await exported.text(), beforeYaml)
  const imported = await app.request('/api/v1/import/database', { method: 'POST', body: stringify(db) })
  assert.equal(imported.status, 200)
  const stored = parse(await readFile(yamlPath, 'utf8')) as Database
  assert.equal('include_in_current_wealth' in stored.categories[0], false)
  assert.equal('include_in_projections' in stored.assets[0], false)
})

test('flagged YAML roundtrip preserves independent flags/nullable overrides and CSV bytes', async () => {
  const db = seed()
  Object.assign(db.categories[0], { include_in_current_wealth: false, include_in_projections: true })
  Object.assign(db.assets[0], { include_in_current_wealth: true, include_in_projections: false })
  Object.assign(db.assets[1], { include_in_current_wealth: null, include_in_projections: null })
  const csv = await readFile(csvPath, 'utf8')
  const imported = await app.request('/api/v1/import/database', { method: 'POST', body: stringify(db) })
  assert.equal(imported.status, 200)
  const exported = await app.request('/api/v1/export/database')
  const result = parse(await exported.text())
  assert.deepEqual(result, db)
  assert.equal(await readFile(csvPath, 'utf8'), csv)
  assert.ok(!JSON.stringify(result).includes('effective_include'))
  const before = await readFile(yamlPath, 'utf8')
  await bootstrapDatabase()
  assert.equal(await readFile(yamlPath, 'utf8'), before)
})

for (const invalid of ['false', 0, null]) {
  test(`category flag rejects ${JSON.stringify(invalid)} in CRUD/import/startup without touching files`, async () => {
    const before = await readFile(yamlPath, 'utf8')
    const response = await json('categories/stock', { name: 'Stock', type: 'asset', projected_yearly_growth: 0, color: '#123456', include_in_current_wealth: invalid }, 'PUT')
    assert.equal(response.status, 400)
    const db = { ...seed(), categories: [{ ...seed().categories[0], include_in_current_wealth: invalid }, ...seed().categories.slice(1)] }
    assert.equal((await app.request('/api/v1/import/database', { method: 'POST', body: stringify(db) })).status, 400)
    assert.equal(await readFile(yamlPath, 'utf8'), before)
    await writeFile(yamlPath, stringify(db))
    const invalidBytes = await readFile(yamlPath, 'utf8')
    await assert.rejects(bootstrapDatabase, /include_in_current_wealth/)
    assert.equal(await readFile(yamlPath, 'utf8'), invalidBytes)
  })
}

test('asset flag rejects nonboolean nonnull values in CRUD/import and preview remains side-effect free', async () => {
  const before = await readFile(yamlPath, 'utf8')
  const body = { name: 'Account', category_id: 'stock', person_id: 'alice', projected_yearly_growth: null, include_in_projections: 'false' }
  assert.equal((await json('assets/account', body, 'PUT')).status, 400)
  const db = seed()
  db.categories[0].include_in_current_wealth = false
  const beforeFiles = (await readdir(root)).sort()
  const response = await app.request('/api/v1/import/database?preview=true', { method: 'POST', body: stringify(db) })
  assert.equal(response.status, 200)
  assert.equal(await readFile(yamlPath, 'utf8'), before)
  assert.deepEqual((await readdir(root)).sort(), beforeFiles)
})

for (const invalid of ['false', 0]) {
  test(`asset override ${JSON.stringify(invalid)} is rejected in import/startup without rewriting bytes`, async () => {
    const db = { ...seed(), assets: [{ ...seed().assets[0], include_in_projections: invalid }, ...seed().assets.slice(1)] }
    const before = await readFile(yamlPath, 'utf8')
    assert.equal((await app.request('/api/v1/import/database', { method: 'POST', body: stringify(db) })).status, 400)
    assert.equal(await readFile(yamlPath, 'utf8'), before)
    await writeFile(yamlPath, stringify(db))
    const invalidBytes = await readFile(yamlPath, 'utf8')
    await assert.rejects(bootstrapDatabase, /include_in_projections/)
    assert.equal(await readFile(yamlPath, 'utf8'), invalidBytes)
  })
}
