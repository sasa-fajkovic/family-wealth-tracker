import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { DataPoint } from '../models/index.js'
import { readDataPoints, readDbAndDataPoints, mutateDataPoints } from '../storage/index.js'
import { zodErrorHook as hook } from '../util/zodHook.js'

const router = new Hono()

// Optional query params for listing — all params are additive and optional (backward-compat)
const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().min(0).optional(),
  person_id: z.string().optional(),
  asset_id: z.string().optional(),
  category_id: z.string().optional(),
  year_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'year_month must be YYYY-MM').optional(),
  sort: z.enum(['year_month', 'asset_id', 'value', 'created_at', 'updated_at']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
})

const createSchema = z.object({
  asset_id: z.string().min(1, 'asset_id is required'),
  // D-02/D-03: year_month is always provided by the client — validated format only, never server-computed
  year_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'year_month must be YYYY-MM'),
  value: z.number().finite('value must be a finite number'),
  notes: z.string().optional(),
}).strict()

const updateSchema = z.object({
  id: z.string().optional(),       // included only to detect and reject id change attempts
  asset_id: z.string().optional(), // included only to detect and reject asset_id change attempts
  year_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'year_month must be YYYY-MM'),
  value: z.number().finite('value must be a finite number'),
  notes: z.string().optional(),
}).strict()

// DP-01: GET data points with optional pagination and filtering.
// Without limit: returns a plain DataPoint[] (backward-compatible).
// With limit: returns { items: DataPoint[], total: number }.
// Filters (person_id, asset_id, category_id, year_month) and sort/order are applied server-side.
router.get('/', zValidator('query', listQuerySchema, hook), async (c) => {
  const {
    limit, offset = 0,
    person_id, asset_id, category_id, year_month,
    sort = 'year_month', order = 'desc',
  } = c.req.valid('query')

  const needsAssetJoin = person_id !== undefined || category_id !== undefined

  let dataPoints: DataPoint[]
  let assetMeta: Map<string, { person_id: string; category_id: string }> | null = null

  if (needsAssetJoin) {
    const { db, dataPoints: pts } = await readDbAndDataPoints()
    dataPoints = pts
    assetMeta = new Map(db.assets.map(a => [a.id, { person_id: a.person_id, category_id: a.category_id }]))
  } else {
    dataPoints = await readDataPoints()
  }

  // DP-01-PERF: filter first, sort the survivors. Otherwise the entire dataset
  // is sorted on every request even when filters trim it to a small slice.
  const filtered = dataPoints.filter(dp => {
    if (year_month !== undefined && dp.year_month !== year_month) return false
    if (asset_id !== undefined && dp.asset_id !== asset_id) return false
    if (assetMeta) {
      const meta = assetMeta.get(dp.asset_id)
      if (!meta) return false
      if (person_id !== undefined && meta.person_id !== person_id) return false
      if (category_id !== undefined && meta.category_id !== category_id) return false
    }
    return true
  })

  // Sort — numeric comparison for value, lexicographic for string fields
  filtered.sort((a, b) => {
    let cmp: number
    if (sort === 'value') {
      cmp = a.value - b.value
    } else if (sort === 'year_month') {
      cmp = a.year_month.localeCompare(b.year_month)
    } else if (sort === 'asset_id') {
      cmp = a.asset_id.localeCompare(b.asset_id)
    } else if (sort === 'created_at') {
      cmp = Date.parse(a.created_at) - Date.parse(b.created_at)
    } else {
      cmp = Date.parse(a.updated_at) - Date.parse(b.updated_at)
    }
    return order === 'desc' ? -cmp : cmp
  })

  const total = filtered.length

  if (limit !== undefined) {
    return c.json({ items: filtered.slice(offset, offset + limit), total })
  }

  // Backward compat: no limit → return plain sorted/filtered array
  return c.json(filtered)
})

// DP-02: POST — validate asset_id exists, generate UUID id, set both timestamps
router.post('/', zValidator('json', createSchema, hook), async (c) => {
  const body = c.req.valid('json')

  const now = new Date().toISOString()
  const point: DataPoint = {
    id: randomUUID(),
    ...body,
    created_at: now,
    updated_at: now,
  }
  await mutateDataPoints(
    (points, db) => {
      const asset = db.assets.find((a) => a.id === body.asset_id)
      if (!asset) {
        throw new HTTPException(404, { message: 'Asset not found' })
      }

      const category = db.categories.find((cat) => cat.id === asset.category_id)
      if (category?.type === 'liability' && body.value > 0) {
        throw new HTTPException(400, { message: 'Liability values must be zero or negative' })
      }

        if (points.some(p => p.asset_id === body.asset_id && p.year_month === body.year_month)) throw new HTTPException(409, { message: 'A data point already exists for this asset and month' })
      return [...points, point]
    },
    { action: 'datapoint.create', meta: { id: point.id, asset_id: point.asset_id, year_month: point.year_month } },
  )
  return c.json(point, 201)
})

// DP-BATCH: POST /batch — upsert multiple data points atomically.
// Creates missing data points and updates existing ones for the given (asset_id, year_month) pairs.
// Returns per-item error details alongside aggregate counts.
const batchUpsertSchema = z.object({
  items: z.array(z.object({
    asset_id: z.string().min(1, 'asset_id is required'),
    year_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'year_month must be YYYY-MM'),
    value: z.number().finite('value must be a finite number'),
    notes: z.string().optional(),
  }).strict()).min(1, 'items must not be empty').max(500, 'too many items (max 500)'),
}).strict()

router.post('/batch', zValidator('json', batchUpsertSchema, hook), async (c) => {
  const { items } = c.req.valid('json')
  const keys = items.map(item => `${item.asset_id}|${item.year_month}`)
  if (new Set(keys).size !== keys.length) throw new HTTPException(409, { message: 'Duplicate asset/month keys in batch' })
  const errors: { asset_id: string; year_month: string; error: string }[] = []
  let created = 0
  let updated = 0
  await mutateDataPoints((points, db) => {
    const result = [...points]
    const now = new Date().toISOString()
    for (const item of items) {
      const asset = db.assets.find(a => a.id === item.asset_id)
      const category = db.categories.find(cat => cat.id === asset?.category_id)
      const matches = points.filter(p => p.asset_id === item.asset_id && p.year_month === item.year_month)
      const error = !asset ? 'Asset not found' : category?.type === 'liability' && item.value > 0
        ? 'Liability values must be zero or negative' : matches.length > 1 ? 'Existing duplicate asset/month keys require manual repair' : null
      if (error) { errors.push({ asset_id: item.asset_id, year_month: item.year_month, error }); continue }
      const existing = matches[0]
      if (existing) {
        result[result.findIndex(p => p.id === existing.id)] = { ...existing, value: item.value,
          ...(item.notes !== undefined ? { notes: item.notes } : {}), updated_at: now }
        updated++
      } else {
        result.push({ id: randomUUID(), ...item, created_at: now, updated_at: now })
        created++
      }
    }
    return result
  }, { action: 'datapoint.batch', meta: () => ({ created, updated, failed: errors.length }) })
  return c.json({ created, updated, skipped: 0, failed: errors.length, errors })
})

// DP-03: PUT — update year_month/value/notes; refresh updated_at; block id and asset_id changes
router.put('/:id', zValidator('json', updateSchema, hook), async (c) => {
  const paramId = c.req.param('id')
  const body = c.req.valid('json')

  if (body.id !== undefined && body.id !== paramId) {
    throw new HTTPException(400, { message: 'id cannot be changed' })
  }

  let updated!: DataPoint
  await mutateDataPoints((points, db) => {
    const existing = points.find(p => p.id === paramId)
    if (!existing) throw new HTTPException(404, { message: 'Data point not found' })
    if (body.asset_id !== undefined && body.asset_id !== existing.asset_id) throw new HTTPException(400, { message: 'asset_id cannot be changed' })
    const asset = db.assets.find(a => a.id === existing.asset_id)
    if (!asset) throw new HTTPException(404, { message: 'Asset not found' })
    const category = db.categories.find(cat => cat.id === asset.category_id)
    if (category?.type === 'liability' && body.value > 0) throw new HTTPException(400, { message: 'Liability values must be zero or negative' })
    if (points.some(p => p.id !== paramId && p.asset_id === existing.asset_id && p.year_month === body.year_month)) throw new HTTPException(409, { message: 'A data point already exists for this asset and month' })
    updated = { ...existing, year_month: body.year_month, value: body.value,
      ...(body.notes !== undefined ? { notes: body.notes } : {}), updated_at: new Date().toISOString() }
    return points.map(p => p.id === paramId ? updated : p)
  }, { action: 'datapoint.update', meta: () => ({ id: paramId, asset_id: updated.asset_id, year_month: updated.year_month }) })
  return c.json(updated)
})

// DP-04: DELETE — no referential integrity check, delete unconditionally
router.delete('/:id', async (c) => {
  const id = c.req.param('id')

  await mutateDataPoints(points => {
    if (!points.some(p => p.id === id)) throw new HTTPException(404, { message: 'Data point not found' })
    return points.filter(p => p.id !== id)
  }, { action: 'datapoint.delete', meta: { id } })
  return c.json({ success: true })
})

export default router
