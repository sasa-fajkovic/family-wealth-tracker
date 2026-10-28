import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify, parse } from 'yaml'
import type { Database, DataPoint } from '../models/index.js'

const root = await mkdtemp(join(tmpdir(), 'wt-integrity-'))
const yamlPath = join(root, 'database.yaml')
const csvPath = join(root, 'datapoints.csv')
process.env.DATA_FILE = yamlPath
process.env.DATA_POINTS_FILE = csvPath
process.env.LOGS_DIR = join(root, 'logs')
const { Hono } = await import('hono')
const { HTTPException } = await import('hono/http-exception')
const { encodeDataPoints, decodeDataPoints } = await import('../storage/csv.js')
const { readDbAndDataPoints } = await import('../storage/index.js')
const { bootstrapDatabase } = await import('../bootstrap.js')
const app = new Hono()
app.onError((error, c) => {
  if (error instanceof RangeError) return c.json({ error: error.message }, 400)
  if (error instanceof HTTPException) return error.res ? error.getResponse() : c.json({ error: error.message }, error.status)
  return c.json({ error: error.message }, 500)
})
for (const route of ['assets', 'categories', 'persons', 'summary', 'projections', 'import']) {
  app.route(`/api/v1/${route}`, (await import(`../routes/${route}.js`)).default)
}
app.route('/api/v1/data-points', (await import('../routes/dataPoints.js')).default)
const stamp = '2024-01-01T00:00:00Z'
const current = new Date()
const month = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`
function seed(): Database {
  return {
    categories: [
      { id: 'stock', name: 'Stock', projected_yearly_growth: 0.05, color: '#123456', type: 'asset' },
      { id: 'debt', name: 'Debt', projected_yearly_growth: -0.05, color: '#123456', type: 'liability' },
      { id: 'income', name: 'Income', projected_yearly_growth: 0, color: '#123456', type: 'cash-inflow' },
    ],
    persons: [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }],
    assets: [
      { id: 'account', name: 'Account', category_id: 'stock', person_id: 'alice', projected_yearly_growth: null, created_at: stamp },
      { id: 'loan', name: 'Loan', category_id: 'debt', person_id: 'bob', projected_yearly_growth: null, created_at: stamp },
    ],
  }
}
function point(id = 'p1', asset_id = 'account', year_month = '2024-01', value = 10): DataPoint {
  return { id, asset_id, year_month, value, notes: 'keep this note', created_at: stamp, updated_at: stamp }
}
async function reset(db = seed(), points = [point()]) {
  await rm(root, { recursive: true, force: true })
  await mkdir(root)
  await writeFile(yamlPath, stringify(db))
  await writeFile(csvPath, encodeDataPoints(points))
}
const json = (path: string, body: unknown, method = 'POST') => app.request(`/api/v1/${path}`, {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const upload = (kind: 'database' | 'datapoints', raw: string, query = '') => app.request(`/api/v1/import/${kind}${query}`, { method: 'POST', body: raw })
async function bytes() { return [await readFile(yamlPath, 'utf8'), await readFile(csvPath, 'utf8')] }
async function tree() {
  return (await readdir(root, { recursive: true })).sort()
}
beforeEach(() => reset())
after(() => rm(root, { recursive: true, force: true }))

test('batch preserves omitted notes, clears explicit empty notes, and audits final counts', async () => {
  let response = await json('data-points/batch', { items: [
    { asset_id: 'account', year_month: '2024-01', value: 20 },
    { asset_id: 'account', year_month: '2024-02', value: 30 },
    { asset_id: 'missing', year_month: '2024-02', value: 1 },
  ] })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { created: 1, updated: 1, skipped: 0, failed: 1,
    errors: [{ asset_id: 'missing', year_month: '2024-02', error: 'Asset not found' }] })
  let points = (await readDbAndDataPoints()).dataPoints
  assert.equal(points.find(p => p.id === 'p1')?.notes, 'keep this note')
  const log = await readFile(join(root, 'logs', `${month}.log`), 'utf8')
  const entry = JSON.parse(log.trim())
  assert.deepEqual([entry.created, entry.updated, entry.failed], [1, 1, 1])
  response = await json('data-points/batch', { items: [{ asset_id: 'account', year_month: '2024-01', value: 0, notes: '' }] })
  assert.equal(response.status, 200)
  points = (await readDbAndDataPoints()).dataPoints
  assert.equal(points.find(p => p.id === 'p1')?.notes, undefined)
  assert.equal(points.find(p => p.id === 'p1')?.value, 0)
})

test('point PUT preserves omitted notes and rejects destination collisions', async () => {
  await writeFile(csvPath, encodeDataPoints([point(), point('p2', 'account', '2024-02', 4)]))
  assert.equal((await json('data-points/p1', { year_month: '2024-01', value: 5 }, 'PUT')).status, 200)
  assert.equal((await readDbAndDataPoints()).dataPoints[0].notes, 'keep this note')
  const before = await bytes()
  assert.equal((await json('data-points/p1', { year_month: '2024-02', value: 5 }, 'PUT')).status, 409)
  assert.deepEqual(await bytes(), before)
})

test('duplicate batch keys fail without writing any state', async () => {
  const before = await bytes()
  const item = { asset_id: 'account', year_month: '2024-02', value: 5 }
  assert.equal((await json('data-points/batch', { items: [item, item] })).status, 409)
  assert.deepEqual(await bytes(), before)
  assert.deepEqual(await tree(), ['database.yaml', 'datapoints.csv'])
})

test('legacy duplicate month keys stay intact and batch reports a repair conflict', async () => {
  await writeFile(csvPath, encodeDataPoints([point(), point('p2')]))
  const before = await readFile(csvPath, 'utf8')
  const response = await json('data-points/batch', { items: [{ asset_id: 'account', year_month: '2024-01', value: 8 }] })
  const result = await response.json() as { failed: number; updated: number; errors: { error: string }[] }
  assert.deepEqual([result.failed, result.updated], [1, 0])
  assert.match(result.errors[0].error, /manual repair/)
  assert.equal(await readFile(csvPath, 'utf8'), before)
})

for (const [route, body] of [
  ['persons', { name: 'New person' }],
  ['categories', { name: 'New category', projected_yearly_growth: 0, color: '#123456', type: 'asset' }],
  ['assets', { name: 'New account', category_id: 'stock', person_id: 'alice', projected_yearly_growth: null }],
  ['data-points', { asset_id: 'account', year_month: '2024-02', value: 1 }],
] as const) {
  test(`concurrent ${route} creates keep exactly one record`, async () => {
    const responses = await Promise.all([json(route, body), json(route, body)])
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 409])
  })
}

test('asset creation and category deletion cannot leave stale references', async () => {
  const results = await Promise.all([
    json('assets', { name: 'Race', category_id: 'stock', person_id: 'alice', projected_yearly_growth: null }),
    app.request('/api/v1/categories/stock?reassign_to=income', { method: 'DELETE' }),
  ])
  assert.ok([201, 404].includes(results[0].status))
  assert.equal(results[1].status, 200)
  const { db } = await readDbAndDataPoints()
  assert.ok(db.assets.every(asset => db.categories.some(category => category.id === asset.category_id)))
})

test('point creation and asset deletion cannot leave orphan points', async () => {
  const responses = await Promise.all([
    json('data-points', { asset_id: 'account', year_month: '2024-02', value: 9 }),
    app.request('/api/v1/assets/account?force=true', { method: 'DELETE' }),
  ])
  assert.ok([201, 404].includes(responses[0].status))
  assert.equal(responses[1].status, 200)
  const { db, dataPoints } = await readDbAndDataPoints()
  assert.ok(dataPoints.every(p => db.assets.some(asset => asset.id === p.asset_id)))
})

for (const [route, id] of [['categories', 'stock'], ['persons', 'alice']] as const) {
  test(`${route} cannot reassign assets to the record being deleted`, async () => {
    const before = await bytes()
    assert.equal((await app.request(`/api/v1/${route}/${id}?reassign_to=${id}`, { method: 'DELETE' })).status, 400)
    assert.deepEqual(await bytes(), before)
  })
}

test('asset create and update validate both live references', async () => {
  const body = { name: 'Invalid', category_id: 'stock', person_id: 'absent', projected_yearly_growth: null }
  assert.equal((await json('assets', body)).status, 404)
  assert.equal((await json('assets/account', body, 'PUT')).status, 404)
  assert.equal((await json('assets/account', { ...body, person_id: 'alice', category_id: 'absent' }, 'PUT')).status, 404)
})

for (const invalidMonth of ['2024-00', '2024-13', '2024-1', '2024-01-01']) {
  test(`rejects invalid month ${invalidMonth} across CRUD, batch and CSV`, async () => {
    const body = { asset_id: 'account', year_month: invalidMonth, value: 1 }
    assert.equal((await json('data-points', body)).status, 400)
    assert.equal((await json('data-points/p1', body, 'PUT')).status, 400)
    assert.equal((await json('data-points/batch', { items: [body] })).status, 400)
    assert.equal((await upload('datapoints', encodeDataPoints([point('invalid', 'account', invalidMonth)]))).status, 400)
  })
}

test('rejects below -100% rates and positive effective liability overrides', async () => {
  const body = { name: 'Invalid', category_id: 'stock', person_id: 'alice', projected_yearly_growth: -1.01 }
  assert.equal((await json('assets', body)).status, 400)
  assert.equal((await json('assets', { ...body, category_id: 'debt', projected_yearly_growth: 0.01 })).status, 400)
  assert.equal((await json('categories', { name: 'Invalid', type: 'asset', color: '#123456', projected_yearly_growth: -1.01 })).status, 400)
})

test('category type changes cannot turn existing positive balances into liabilities', async () => {
  const before = await bytes()
  assert.equal((await json('categories/stock', { name: 'Stock', projected_yearly_growth: 0, color: '#123456', type: 'liability' }, 'PUT')).status, 400)
  assert.deepEqual(await bytes(), before)
})

test('CSV preview reports additions/replacements/removals with zero side effects', async () => {
  const before = await bytes()
  const files = await tree()
  const incoming = [point('p1', 'account', '2024-01', 20), point('p2', 'account', '2024-02', 10)]
  const result = await (await upload('datapoints', encodeDataPoints(incoming), '?preview=true')).json() as { changes: unknown; counts: unknown }
  assert.deepEqual(result.changes, { data_points: { added: 1, replaced: 1, removed: 0 } })
  assert.deepEqual(result.counts, { data_points: 2 })
  assert.deepEqual(await bytes(), before)
  assert.deepEqual(await tree(), files)
  const removed = await (await upload('datapoints', encodeDataPoints([]), '?preview=true')).json() as { changes: unknown }
  assert.deepEqual(removed.changes, { data_points: { added: 0, replaced: 0, removed: 1 } })
})

test('YAML preview reports entity changes and forceable orphans without writing', async () => {
  const db = seed()
  db.assets = db.assets.filter(asset => asset.id !== 'account')
  db.persons.push({ id: 'carol', name: 'Carol' })
  const before = await bytes()
  const result = await (await upload('database', stringify(db), '?preview=true')).json() as { changes: Record<string, unknown>; needs_force: boolean }
  assert.deepEqual(result.changes.assets, { added: 0, replaced: 1, removed: 1 })
  assert.deepEqual(result.changes.persons, { added: 1, replaced: 2, removed: 0 })
  assert.equal(result.needs_force, true)
  assert.deepEqual(await bytes(), before)
  assert.deepEqual(await tree(), ['database.yaml', 'datapoints.csv'])
  assert.equal((await upload('database', stringify(db))).status, 409)
})

test('duplicate CSV preview reports conflicts which force cannot bypass', async () => {
  const raw = encodeDataPoints([point(), point('p2')])
  const before = await bytes()
  const result = await (await upload('datapoints', raw, '?preview=true')).json() as { conflicts: { kind: string }[] }
  assert.equal(result.conflicts[0].kind, 'duplicate_asset_month')
  assert.equal((await upload('datapoints', raw, '?force=true')).status, 400)
  assert.deepEqual(await bytes(), before)
})

test('force never bypasses liability signs, malformed records, or duplicate IDs', async () => {
  const before = await bytes()
  const cases = [encodeDataPoints([point('p1', 'loan', '2024-02', 10)]), encodeDataPoints([point(), point()]), encodeDataPoints([{ ...point(), updated_at: 'yesterday' }])]
  for (const raw of cases) assert.equal((await upload('datapoints', raw, '?force=true')).status, 400)
  const db = seed()
  db.persons.push(db.persons[0])
  assert.equal((await upload('database', stringify(db), '?force=true')).status, 400)
  assert.deepEqual(await bytes(), before)
})

test('YAML import validates complete record shapes and existing liability values', async () => {
  const before = await bytes()
  const db = seed()
  db.categories[0].type = 'liability'
  db.categories[0].projected_yearly_growth = 0
  assert.equal((await upload('database', stringify(db), '?force=true')).status, 400)
  for (const field of ['name', 'created_at', 'person_id', 'projected_yearly_growth']) {
    const invalid = JSON.parse(JSON.stringify(seed()))
    delete invalid.assets[0][field]
    assert.equal((await upload('database', stringify(invalid))).status, 400)
  }
  assert.deepEqual(await bytes(), before)
})

test('monthly coverage includes visible income and all persons only when unfiltered', async () => {
  const db = seed()
  db.assets.push(
    { ...db.assets[0], id: 'income-job', category_id: 'income', name: 'Income' },
    { ...db.assets[0], id: 'future', name: 'Future', show_from: '9999-12' },
    { ...db.assets[0], id: 'ended', name: 'Ended', show_until: '2000-01' },
  )
  await reset(db, [point('current', 'account', month, 0), point('income', 'income-job', month, -5)])
  const result = await (await app.request('/api/v1/summary')).json() as { monthly_coverage: unknown; coverage: { total: number } }
  assert.deepEqual(result.monthly_coverage, { observed: 2, carried: 0, missing: 1, total: 3 })
  assert.equal(result.coverage.total, 4)
  const filtered = await (await app.request('/api/v1/summary?person=alice')).json() as { monthly_coverage: unknown }
  assert.deepEqual(filtered.monthly_coverage, { observed: 2, carried: 0, missing: 0, total: 2 })
})

test('invalid projection scenario rate yields 400 with files unchanged', async () => {
  const db = seed()
  db.categories[0].projected_yearly_growth = -0.8
  await reset(db)
  const before = await bytes()
  const response = await app.request('/api/v1/projections?scenario=aggressive')
  assert.equal(response.status, 400)
  assert.match((await response.json() as { error: string }).error, /at least -100%/)
  assert.deepEqual(await bytes(), before)
})

test('startup rejects malformed YAML/CSV without replacing existing bytes', async () => {
  for (const invalid of ['categories: [', 'null', 'categories: []\nassets: []']) {
    await writeFile(yamlPath, invalid)
    const before = await bytes()
    await assert.rejects(bootstrapDatabase)
    assert.deepEqual(await bytes(), before)
  }
  await writeFile(yamlPath, stringify(seed()))
  await writeFile(csvPath, 'id,asset_id,year_month,value,notes,created_at,updated_at\ninvalid,row\n')
  const before = await bytes()
  await assert.rejects(bootstrapDatabase)
  assert.deepEqual(await bytes(), before)
})

test('startup compatibility reports duplicates and orphans without rewriting data', async () => {
  await writeFile(csvPath, encodeDataPoints([point(), point('p2'), point('p3', 'missing')]))
  const before = await bytes()
  await bootstrapDatabase()
  assert.deepEqual(await bytes(), before)
  const entry = JSON.parse((await readFile(join(root, 'logs', `${month}.log`), 'utf8')).trim())
  assert.deepEqual([entry.duplicate_keys, entry.orphan_data_points], [1, 1])
})

test('startup refuses to seed missing YAML when existing CSV contains data or malformed rows', async () => {
  await rm(yamlPath)
  const original = await readFile(csvPath, 'utf8')
  await assert.rejects(bootstrapDatabase, /configuration is missing/)
  assert.equal(await readFile(csvPath, 'utf8'), original)
  await assert.rejects(readFile(yamlPath), { code: 'ENOENT' })
  await writeFile(csvPath, 'invalid')
  await assert.rejects(bootstrapDatabase, /CSV header/)
  await assert.rejects(readFile(yamlPath), { code: 'ENOENT' })
})

test('startup migrates legacy inline points and category type as a pair', async () => {
  const db = seed()
  const legacy = { ...db, categories: db.categories.map(({ type, ...category }) => ({ ...category, track_only: type === 'cash-inflow' })), dataPoints: [point('legacy')] }
  await writeFile(yamlPath, stringify(legacy))
  await writeFile(csvPath, encodeDataPoints([]))
  await bootstrapDatabase()
  const result = parse(await readFile(yamlPath, 'utf8'))
  assert.equal(result.dataPoints, undefined)
  assert.equal(result.categories[2].type, 'cash-inflow')
  assert.equal(decodeDataPoints(await readFile(csvPath, 'utf8'))[0].id, 'legacy')
  const before = await bytes()
  await bootstrapDatabase()
  assert.deepEqual(await bytes(), before)
})

test('CSV validation responses identify row, record and field without a Zod dump', async () => {
  const response = await upload('datapoints', encodeDataPoints([{ ...point(), year_month: '2024-13' }]))
  assert.equal(response.status, 400)
  const body = await response.json() as { error: string; issues: { row: number; record: string; field: string }[] }
  assert.equal(body.issues[0].row, 2)
  assert.equal(body.issues[0].record, 'p1')
  assert.equal(body.issues[0].field, 'year_month')
  assert.ok(!body.error.startsWith('['))
})

test('YAML validation responses identify the invalid record field', async () => {
  const db = seed()
  db.assets[0].projected_yearly_growth = -2
  const response = await upload('database', stringify(db))
  assert.equal(response.status, 400)
  const body = await response.json() as { issues: { field: string }[] }
  assert.equal(body.issues[0].field, 'assets.0.projected_yearly_growth')
})

test('startup initializes only an empty or absent data store', async () => {
  await rm(yamlPath)
  await rm(csvPath)
  await bootstrapDatabase()
  assert.equal(parse(await readFile(yamlPath, 'utf8')).assets.length, 0)
})

test('simultaneous person deletion and asset creation preserve live person references', async () => {
  const results = await Promise.all([
    json('assets', { name: 'Race', category_id: 'stock', person_id: 'alice', projected_yearly_growth: null }),
    app.request('/api/v1/persons/alice?reassign_to=bob', { method: 'DELETE' }),
  ])
  assert.ok([201, 404].includes(results[0].status))
  assert.equal(results[1].status, 200)
  const { db } = await readDbAndDataPoints()
  assert.ok(db.assets.every(asset => db.persons.some(person => person.id === asset.person_id)))
})

test('CRUD rejects unknown fields, whitespace names and names producing empty IDs', async () => {
  for (const body of [{ name: ' ' }, { name: '!!!' }, { name: 'New', invented: 'unexpected' }]) {
    assert.equal((await json('persons', body)).status, 400)
  }
  assert.equal((await json('data-points', { asset_id: 'account', year_month: '2024-03', value: 1, invented: true })).status, 400)
})

for (const inline of [[point('conflicting')], []]) {
  test(`startup preserves conflicting populated CSV and ${inline.length ? 'populated' : 'empty'} legacy YAML points`, async () => {
    await writeFile(yamlPath, stringify({ ...seed(), dataPoints: inline }))
    const before = await bytes()
    await assert.rejects(bootstrapDatabase, /conflict with existing datapoints.csv/)
    assert.deepEqual(await bytes(), before)
    assert.deepEqual(await tree(), ['database.yaml', 'datapoints.csv'])
  })
}

test('startup accepts matching dual-source legacy points and finalizes migration', async () => {
  await writeFile(yamlPath, stringify({ ...seed(), dataPoints: [point()] }))
  const originalCsv = await readFile(csvPath, 'utf8')
  await bootstrapDatabase()
  assert.equal(await readFile(csvPath, 'utf8'), originalCsv)
  assert.equal(parse(await readFile(yamlPath, 'utf8')).dataPoints, undefined)
})

for (const categories of ['invalid', {}, null, [null], ['invalid']]) {
  test(`startup reports invalid categories ${JSON.stringify(categories)} without writes`, async () => {
    await writeFile(yamlPath, stringify({ ...seed(), categories }))
    const before = await bytes()
    await assert.rejects(bootstrapDatabase, /categories/)
    assert.deepEqual(await bytes(), before)
  })
}

for (const type of [null, '', false, 0, 'unknown']) {
  test(`startup rejects explicit invalid category type ${JSON.stringify(type)} without coercing or rewriting it`, async () => {
    const db = seed()
    await writeFile(yamlPath, stringify({ ...db, categories: [{ ...db.categories[0], type }] }))
    const before = await bytes()
    await assert.rejects(bootstrapDatabase, /categories.0.type/)
    assert.deepEqual(await bytes(), before)
    assert.deepEqual(await tree(), ['database.yaml', 'datapoints.csv'])
  })
}

for (const track_only of [null, 'false', 0]) {
  test(`startup rejects invalid legacy track_only ${JSON.stringify(track_only)} without coercion`, async () => {
    const db = seed()
    await writeFile(yamlPath, stringify({ ...db, categories: [{ ...db.categories[0], track_only }] }))
    const before = await bytes()
    await assert.rejects(bootstrapDatabase, /track_only must be boolean/)
    assert.deepEqual(await bytes(), before)
  })
}

for (const [type, track_only, expected] of [
  [undefined, false, 'asset'], [undefined, true, 'cash-inflow'],
  ['asset', true, 'asset'], ['cash-inflow', false, 'cash-inflow'],
] as const) {
  test(`startup canonicalizes legacy flag ${track_only} with type ${type} to ${expected}`, async () => {
    const db = seed()
    await reset({ ...db, assets: [], categories: [{ ...db.categories[0], projected_yearly_growth: 0 }] }, [])
    await writeFile(yamlPath, stringify({ ...db, assets: [], categories: [{ ...db.categories[0], projected_yearly_growth: 0, type, track_only }] }))
    await bootstrapDatabase()
    const stored = parse(await readFile(yamlPath, 'utf8'))
    assert.equal(stored.categories[0].type, expected)
    assert.equal('track_only' in stored.categories[0], false)
    const before = await bytes()
    await bootstrapDatabase()
    assert.deepEqual(await bytes(), before)
  })
}
