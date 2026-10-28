import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { readDb, mutateDb } from '../storage/index.js'
import type { Category } from '../models/index.js'
import { toSlug } from '../util/slug.js'
import { zodErrorHook as hook } from '../util/zodHook.js'

const router = new Hono()

const baseSchema = z.object({
  name: z.string().trim().min(1, 'name is required').refine(v => toSlug(v).length > 0, 'name must produce a nonempty id'),
  projected_yearly_growth: z.number().finite().min(-1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be a 6-digit hex color'),
  type: z.enum(['asset', 'cash-inflow', 'liability']),
  include_in_current_wealth: z.boolean().optional(),
  include_in_projections: z.boolean().optional(),
}).strict()

const liabilityGrowthCheck = (d: { type: string; projected_yearly_growth: number }) =>
  !(d.type === 'liability' && d.projected_yearly_growth > 0)
const liabilityGrowthMsg = { message: 'Liability growth rate must be zero or negative', path: ['projected_yearly_growth'] }

const createSchema = baseSchema.refine(liabilityGrowthCheck, liabilityGrowthMsg)
// id is optional here only to detect change attempts in PUT — not required on create
const updateSchema = baseSchema.extend({ id: z.string().optional() }).refine(liabilityGrowthCheck, liabilityGrowthMsg)

// CAT-01: GET all categories. The bootstrap migration backfills `type` on
// pre-v2 records, so by the time requests are served every category is
// guaranteed to carry the discriminant.
router.get('/', async (c) => {
  const db = await readDb()
  return c.json(db.categories)
})

// CAT-02: POST — validate, generate slug id, persist
router.post('/', zValidator('json', createSchema, hook), async (c) => {
  const body = c.req.valid('json')
  const id = toSlug(body.name)

  const category: Category = { include_in_current_wealth: true, include_in_projections: true, id, ...body }
  await mutateDb(
    (db) => {
      if (db.categories.find((cat) => cat.id === id)) {
        throw new HTTPException(409, { message: `Category with id '${id}' already exists` })
      }

      return { ...db, categories: [...db.categories, category] }
    },
    { action: 'category.create', meta: { id: category.id, name: category.name } },
  )
  return c.json(category, 201)
})

// CAT-03: PUT — full update; reject id change attempts
router.put('/:id', zValidator('json', updateSchema, hook), async (c) => {
  const paramId = c.req.param('id')
  const body = c.req.valid('json')

  if (body.id !== undefined && body.id !== paramId) {
    throw new HTTPException(400, { message: 'id cannot be changed' })
  }

  let updated!: Category
  await mutateDb(
    (db) => {
      const idx = db.categories.findIndex((cat) => cat.id === paramId)
      if (idx === -1) throw new HTTPException(404, { message: 'Category not found' })

      // Destructure _id out so updateData never contains id (noUnusedLocals: _ prefix is exempt)
      const { id: _id, ...updateData } = body
      updated = { ...db.categories[idx], ...updateData, id: paramId }
      const cats = [...db.categories]
      cats[idx] = updated
      return { ...db, categories: cats }
    },
    { action: 'category.update', meta: () => ({ id: paramId, name: updated.name }) },
  )
  return c.json(updated)
})

// CAT-04: DELETE /categories/:id?reassign_to=<category_id>
// Assets in this category are reassigned to reassign_to before the category is removed.
router.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const reassignTo = c.req.query('reassign_to')
  await mutateDb(db => {
    if (!db.categories.some(record => record.id === id)) throw new HTTPException(404, { message: 'Category not found' })
    const affected = db.assets.filter(a => a.category_id === id)
    if (affected.length && !reassignTo) throw new HTTPException(409, { res: c.json({ needs_reassign: true, assets: affected }, 409) })
    if (reassignTo && (reassignTo === id || !db.categories.some(record => record.id === reassignTo))) throw new HTTPException(400, { message: 'Invalid reassign_to category' })
    return { ...db, categories: db.categories.filter(record => record.id !== id),
      assets: db.assets.map(a => a.category_id === id ? { ...a, category_id: reassignTo! } : a) }
  }, { action: 'category.delete', meta: { id, reassigned_to: reassignTo ?? null } })
  return c.json({ success: true })
})

export default router
