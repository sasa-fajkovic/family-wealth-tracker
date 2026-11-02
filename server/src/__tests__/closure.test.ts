import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify, parse } from 'yaml'
import type { Asset, Database, DataPoint } from '../models/index.js'
import type { SummaryResponse } from '../calc/summary.js'
import type { ProjectionBlock } from '../calc/projections.js'

const root = await mkdtemp(join(tmpdir(), 'wt-closure-'))
const yamlPath = join(root, 'database.yaml')
const csvPath = join(root, 'datapoints.csv')
process.env.DATA_FILE = yamlPath
process.env.DATA_POINTS_FILE = csvPath
process.env.LOGS_DIR = join(root, 'logs')
const { Hono } = await import('hono')
const { HTTPException } = await import('hono/http-exception')
const { encodeDataPoints } = await import('../storage/csv.js')
const { bootstrapDatabase } = await import('../bootstrap.js')
const { validatePoints } = await import('../models/validation.js')
const { readDbAndDataPoints } = await import('../storage/index.js')
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
      { id: 'debt', name: 'Debt', projected_yearly_growth: 0, color: '#123456', type: 'liability' },
      { id: 'income', name: 'Income', projected_yearly_growth: 0, color: '#123456', type: 'cash-inflow' },
    ],
    persons: [{ id: 'alice', name: 'Alice' }],
    assets: [
      { id: 'account', name: 'Account', category_id: 'stock', person_id: 'alice', projected_yearly_growth: null, created_at: stamp },
      { id: 'loan', name: 'Loan', category_id: 'debt', person_id: 'alice', projected_yearly_growth: null, created_at: stamp },
      { id: 'salary', name: 'Salary', category_id: 'income', person_id: 'alice', projected_yearly_growth: null, created_at: stamp },
    ],
  }
}
function point(id: string, asset_id: string, year_month: string, value: number): DataPoint {
  return { id, asset_id, year_month, value, created_at: stamp, updated_at: stamp }
}
function points() {
  return [point('account-old', 'account', month(-2), 100), point('account-close', 'account', month(-1), 0),
    point('loan-old', 'loan', month(-2), -50), point('loan-close', 'loan', month(-1), 0),
    point('salary-old', 'salary', month(-2), 100), point('salary-close', 'salary', month(-1), 250)]
}
async function reset(db = seed(), values = points()) {
  await rm(root, { recursive: true, force: true })
  await mkdir(root)
  await writeFile(yamlPath, stringify(db))
  await writeFile(csvPath, encodeDataPoints(values))
}
const json = (path: string, body: unknown, method = 'POST') => app.request(`/api/v1/${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
function body(id = 'account', changes: Record<string, unknown> = {}) {
  const record = seed().assets.find(asset => asset.id === id)!
  return { name: record.name, category_id: record.category_id, person_id: record.person_id, projected_yearly_growth: null, ...changes }
}
const close = (id = 'account', closed_at: string | null = month(-1)) => json(`assets/${id}`, body(id, { closed_at }), 'PUT')
async function bytes() { return [await readFile(yamlPath, 'utf8'), await readFile(csvPath, 'utf8')] }
async function get<T>(path: string): Promise<T> {
  const response = await app.request(`/api/v1/${path}`)
  assert.equal(response.status, 200)
  return await response.json() as T
}
beforeEach(() => reset())
after(() => rm(root, { recursive: true, force: true }))

for (const id of ['account', 'loan', 'salary']) {
  test(`${id} closure preserves every observation and all unrelated metadata`, async () => {
    const before = await readFile(csvPath, 'utf8')
    assert.equal((await close(id)).status, 200)
    const stored = parse(await readFile(yamlPath, 'utf8')) as Database
    const expected = seed()
    expected.assets.find(asset => asset.id === id)!.closed_at = month(-1)
    assert.deepEqual(stored, expected)
    assert.equal(await readFile(csvPath, 'utf8'), before)
    assert.equal((await get<Asset[]>('assets')).length, 3)
    assert.equal((await get<DataPoint[]>('data-points')).length, 6)
  })
}

test('stock closure requires an explicit zero at the exact closing month, not a carried zero', async () => {
  for (const closing of [month(-2), month()]) {
    const before = await bytes()
    const response = await close('account', closing)
    assert.equal(response.status, 400)
    const error = await response.json() as { issues: { record: string; field: string }[] }
    assert.equal(error.issues[0].record, 'account')
    assert.equal(error.issues[0].field, 'closed_at')
    assert.deepEqual(await bytes(), before)
  }
})

test('closing rejects existing later nonzero observations, including future plans', async () => {
  for (const offset of [0, 3]) {
    await reset(seed(), [...points(), point('later', 'account', month(offset), 1)])
    const before = await bytes()
    assert.equal((await close()).status, 400)
    assert.deepEqual(await bytes(), before)
  }
})

for (const invalid of ['', '2024-00', '2024-13', '2024-1', false]) {
  test(`closed_at rejects invalid ${JSON.stringify(invalid)} instead of coercing it`, async () => {
    const before = await bytes()
    assert.equal((await json('assets/account', body('account', { closed_at: invalid }), 'PUT')).status, 400)
    assert.deepEqual(await bytes(), before)
  })
}

test('creating an already-closed stock item cannot invent its missing closing zero', async () => {
  const before = await bytes()
  assert.equal((await json('assets', body('account', { name: 'New closed item', closed_at: month(-1) }))).status, 400)
  assert.deepEqual(await bytes(), before)
})

test('closed zero cannot be deleted, moved, or made nonzero until the item is reopened', async () => {
  assert.equal((await close()).status, 200)
  const before = await bytes()
  assert.equal((await app.request('/api/v1/data-points/account-close', { method: 'DELETE' })).status, 400)
  assert.equal((await json('data-points/account-close', { year_month: month(-2), value: 0 }, 'PUT')).status, 409)
  assert.equal((await json('data-points/account-close', { year_month: month(-3), value: 0 }, 'PUT')).status, 400)
  assert.equal((await json('data-points/account-close', { year_month: month(-1), value: 5 }, 'PUT')).status, 400)
  assert.deepEqual(await bytes(), before)
  assert.equal((await close('account', null)).status, 200)
  assert.equal((await app.request('/api/v1/data-points/account-close', { method: 'DELETE' })).status, 200)
})

test('later nonzero POST and batch changes reject atomically while explicit later zero remains accessible in history', async () => {
  assert.equal((await close()).status, 200)
  const before = await bytes()
  assert.equal((await json('data-points', { asset_id: 'account', year_month: month(), value: 5 })).status, 400)
  assert.equal((await json('data-points/batch', { items: [
    { asset_id: 'loan', year_month: month(), value: -10 },
    { asset_id: 'account', year_month: month(), value: 5 },
  ] })).status, 400)
  assert.deepEqual(await bytes(), before)
  assert.equal((await json('data-points', { asset_id: 'account', year_month: month(), value: 0 })).status, 201)
  assert.equal((await get<DataPoint[]>('data-points?asset_id=account')).length, 3)
  const result = await get<SummaryResponse & { monthly_coverage: { total: number } }>('summary?range=1y')
  assert.ok(!result.asset_breakdown.some(asset => asset.asset_id === 'account'))
  assert.equal(result.monthly_coverage.total, 2)
})

test('old PUT payloads preserve closure, and reopening clears only the date', async () => {
  assert.equal((await close()).status, 200)
  assert.equal((await json('assets/account', body(), 'PUT')).status, 200)
  assert.equal((await get<Asset[]>('assets')).find(asset => asset.id === 'account')!.closed_at, month(-1))
  assert.equal((await close('account', null)).status, 200)
  const stored = parse(await readFile(yamlPath, 'utf8')) as Database
  const expected = seed()
  expected.assets[0].closed_at = null
  assert.deepEqual(stored, expected)
  assert.equal((await json('data-points', { asset_id: 'account', year_month: month(), value: 5 })).status, 201)
})

test('closed income keeps historical period total and source breakdown but rejects later activity', async () => {
  assert.equal((await close('salary')).status, 200)
  const result = await get<SummaryResponse & { monthly_coverage: { total: number } }>('summary?tracking=true&range=1y')
  assert.equal(result.current_total, 350)
  assert.equal(result.asset_breakdown.find(asset => asset.asset_id === 'salary')?.value, 350)
  assert.equal(result.coverage.total, 0)
  assert.equal(result.monthly_coverage.total, 2)
  const before = await bytes()
  assert.equal((await json('data-points', { asset_id: 'salary', year_month: month(), value: 50 })).status, 400)
  assert.deepEqual(await bytes(), before)
})

test('future closure remains active now, projects to recorded future zero, and stops afterward', async () => {
  await reset(seed(), [point('current', 'account', month(), 100), point('future-close', 'account', month(2), 0)])
  assert.equal((await close('account', month(2))).status, 200)
  const current = await get<SummaryResponse & { monthly_coverage: { total: number } }>('summary?range=1y')
  assert.equal(current.current_total, 100)
  assert.ok(current.asset_breakdown.some(asset => asset.asset_id === 'account'))
  assert.equal(current.monthly_coverage.total, 3)
  const result = await get<{ projection: ProjectionBlock }>('projections?years=1')
  const stock = result.projection.series.find(category => category.category_id === 'stock')!
  assert.deepEqual(stock.values.slice(0, 3), [50, 0, 0])
  assert.deepEqual(stock.available.slice(0, 3), [true, true, false])
  assert.equal(result.projection.asset_metadata.find(asset => asset.asset_id === 'account')!.closed_at, month(2))
})

test('past closure hides current rows and projection assumptions without erasing historical asset series or changing inclusion', async () => {
  assert.equal((await close('loan')).status, 200)
  const result = await get<SummaryResponse & { monthly_coverage: { total: number } }>('summary?range=1y&planned=true')
  assert.ok(!result.asset_breakdown.some(asset => asset.asset_id === 'loan'))
  const series = result.asset_series.find(asset => asset.asset_id === 'loan')!
  assert.equal(series.values[result.months.indexOf(month(-2))], -50)
  assert.equal(series.values[result.months.indexOf(month(-1))], 0)
  assert.equal(series.observation_status[result.months.indexOf(month())], 'missing')
  assert.equal(result.monthly_coverage.total, 2)
  const projection = await get<{ historical: SummaryResponse; projection: ProjectionBlock }>('projections?years=1')
  assert.ok(!projection.projection.asset_metadata.some(asset => asset.asset_id === 'loan'))
  assert.ok(projection.historical.asset_series.some(asset => asset.asset_id === 'loan'))
  const stored = (await get<Asset[]>('assets')).find(asset => asset.id === 'loan')!
  assert.equal(stored.include_in_current_wealth, undefined)
  assert.equal(stored.include_in_projections, undefined)
})

test('category changes and reassignment cannot turn closed nonzero income into an invalid stock closure', async () => {
  assert.equal((await close('salary')).status, 200)
  const before = await bytes()
  assert.equal((await json('categories/income', { name: 'Income', type: 'asset', projected_yearly_growth: 0, color: '#123456' }, 'PUT')).status, 400)
  assert.equal((await app.request('/api/v1/categories/income?reassign_to=stock', { method: 'DELETE' })).status, 400)
  assert.deepEqual(await bytes(), before)
})

test('CSV import and force cannot remove a closing zero or introduce any post-closure nonzero', async () => {
  assert.equal((await close()).status, 200)
  const before = await bytes()
  const invalid = [points().filter(point => point.id !== 'account-close'), points().map(point => point.id === 'account-close' ? { ...point, value: 1 } : point), [...points(), point('late', 'account', month(), 1)]]
  for (const records of invalid) for (const query of ['', '?force=true', '?preview=true']) {
    const response = await app.request(`/api/v1/import/datapoints${query}`, { method: 'POST', body: encodeDataPoints(records) })
    assert.equal(response.status, 400)
    assert.deepEqual(await bytes(), before)
  }
})

test('YAML import rejects invalid closure even with force and roundtrips valid closure without touching CSV', async () => {
  const db = seed()
  db.assets[0].closed_at = month()
  const before = await bytes()
  assert.equal((await app.request('/api/v1/import/database?force=true', { method: 'POST', body: stringify(db) })).status, 400)
  assert.deepEqual(await bytes(), before)
  db.assets[0].closed_at = month(-1)
  assert.equal((await app.request('/api/v1/import/database', { method: 'POST', body: stringify(db) })).status, 200)
  const exported = await app.request('/api/v1/export/database')
  assert.deepEqual(parse(await exported.text()), db)
  assert.equal(await readFile(csvPath, 'utf8'), before[1])
})

test('startup preserves legacy/open bytes and rejects invalid closed state without rewriting it', async () => {
  const original = await bytes()
  await bootstrapDatabase()
  assert.deepEqual(await bytes(), original)
  const db = seed()
  db.assets[0].closed_at = month()
  await writeFile(yamlPath, stringify(db))
  const invalid = await bytes()
  await assert.rejects(bootstrapDatabase, /explicit zero balance/)
  assert.deepEqual(await bytes(), invalid)
  db.assets[0].closed_at = month(-1)
  await writeFile(yamlPath, stringify(db))
  const valid = await bytes()
  await bootstrapDatabase()
  assert.deepEqual(await bytes(), valid)
})

test('closing and deleting its zero race safely under the mutation lock', async () => {
  const responses = await Promise.all([close(), app.request('/api/v1/data-points/account-close', { method: 'DELETE' })])
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 400])
  const { db, dataPoints } = await readDbAndDataPoints()
  validatePoints(dataPoints, db)
})
