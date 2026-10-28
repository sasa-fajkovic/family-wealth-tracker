import { z } from 'zod'
import type { Database, DataPoint } from './index.js'

export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)
export const growthSchema = z.number().finite().min(-1)
const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/)
const name = z.string().trim().min(1)
const timestamp = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), 'Invalid timestamp')
export const categorySchema = z.object({
  id, name, projected_yearly_growth: growthSchema,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/), type: z.enum(['asset', 'cash-inflow', 'liability']),
}).strict().refine(c => c.type !== 'liability' || c.projected_yearly_growth <= 0, {
  message: 'Liability growth must be zero or negative', path: ['projected_yearly_growth'],
})
export const assetSchema = z.object({
  id, name, category_id: id, person_id: id,
  projected_yearly_growth: growthSchema.nullable(), notes: z.string().optional(), created_at: timestamp,
  show_from: monthSchema.optional(), show_until: monthSchema.optional(),
}).strict().refine(a => !a.show_from || !a.show_until || a.show_from <= a.show_until, {
  message: 'Invalid visibility window', path: ['show_until'],
})
export const pointSchema = z.object({
  id: z.string().min(1), asset_id: id, year_month: monthSchema,
  value: z.number().finite(), notes: z.string().optional(), created_at: timestamp, updated_at: timestamp,
}).strict()
export const databaseSchema = z.object({
  categories: z.array(categorySchema), assets: z.array(assetSchema),
  persons: z.array(z.object({ id, name }).strict()),
}).strict()

export interface ValidationIssue {
  row?: number
  record?: string
  field: string
  message: string
}

export class ValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(issues.map(issue => `${issue.field}: ${issue.message}`).join('; '))
    this.name = 'ValidationError'
  }
}

export function duplicateKeys(points: DataPoint[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const point of points) {
    const key = `${point.asset_id}|${point.year_month}`
    if (seen.has(key)) duplicates.add(key)
    seen.add(key)
  }
  return [...duplicates].sort()
}

export function validateDatabase(value: unknown): Database {
  const result = databaseSchema.safeParse(value)
  if (!result.success) throw new ValidationError(result.error.issues.map(issue => ({
    field: issue.path.map(String).join('.') || 'database', message: issue.message,
  })))
  const db = result.data
  for (const [collection, records] of Object.entries(db)) {
    const seen = new Set<string>()
    for (const record of records) {
      if (seen.has(record.id)) throw new ValidationError([{ record: record.id, field: `${collection}.id`, message: 'Duplicate entity id' }])
      seen.add(record.id)
    }
  }
  for (const asset of db.assets) {
    const category = db.categories.find(c => c.id === asset.category_id)
    if (!category) throw new ValidationError([{ record: asset.id, field: 'category_id', message: 'Asset references missing category' }])
    if (!db.persons.some(p => p.id === asset.person_id)) throw new ValidationError([{ record: asset.id, field: 'person_id', message: 'Asset references missing person' }])
    if (category.type === 'liability' && (asset.projected_yearly_growth ?? category.projected_yearly_growth) > 0) {
      throw new ValidationError([{ record: asset.id, field: 'projected_yearly_growth', message: 'Liability growth must be zero or negative' }])
    }
  }
  return db
}

export function validatePoints(points: DataPoint[], db?: Database, allowOrphans = false): void {
  const seen = new Set<string>()
  for (const [index, point] of points.entries()) {
    const result = pointSchema.safeParse(point)
    if (!result.success) throw new ValidationError(result.error.issues.map(issue => ({
      row: index + 2, record: typeof point?.id === 'string' ? point.id : undefined,
      field: issue.path.map(String).join('.') || 'record', message: issue.message,
    })))
    if (seen.has(point.id)) throw new ValidationError([{ row: index + 2, record: point.id, field: 'id', message: 'Duplicate data point id' }])
    seen.add(point.id)
    if (!db) continue
    const asset = db.assets.find(a => a.id === point.asset_id)
    if (!asset && !allowOrphans) throw new ValidationError([{ row: index + 2, record: point.id, field: 'asset_id', message: 'Referenced asset does not exist' }])
    const category = db.categories.find(c => c.id === asset?.category_id)
    if (category?.type === 'liability' && point.value > 0) throw new ValidationError([{ row: index + 2, record: point.id, field: 'value', message: 'Liability values must be zero or negative' }])
  }
}
