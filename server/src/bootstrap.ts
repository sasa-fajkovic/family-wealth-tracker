import { access, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parse, stringify } from 'yaml'
import writeFileAtomic from 'write-file-atomic'
import { DB_PATH, CSV_PATH, recoverPendingTransaction, mutateDbAndDataPoints } from './storage/index.js'
import { decodeDataPoints, encodeDataPoints } from './storage/csv.js'
import { validateDatabase, validatePoints, duplicateKeys, ValidationError } from './models/validation.js'
import { SEED_CATEGORIES } from './models/seed.js'
import type { Database, Category, DataPoint } from './models/index.js'
import { auditLog } from './audit/index.js'

// Pre-v2 shape used during migration only. The runtime YAML may still contain
// `track_only` and an inline `dataPoints` array on installations older than v2;
// these are rewritten to the canonical Database shape on first boot.
type LegacyCategory = Category & { track_only?: boolean }
type LegacyDatabase = Omit<Database, 'categories'> & {
  categories: LegacyCategory[]
  dataPoints?: DataPoint[]
}

export async function bootstrapDatabase(): Promise<void> {
  await recoverPendingTransaction()
  // Check if the database file already exists
  let fileExists = true
  try {
    await access(DB_PATH)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') {
      // The data directory exists but the running user (uid 1000 / `node`) has
      // no permission to read it. Most commonly happens on bind-mounted host
      // volumes whose ownership doesn't match the container user — e.g. files
      // created as root via SSH. The Docker entrypoint normally chown's /data
      // at startup; reaching this branch means that fix-up was skipped or failed
      // (read-only mount, custom --user, non-root entrypoint, etc.).
      console.error(
        `Error: Cannot access ${DB_PATH} (${code}).\n` +
        `The data directory is not readable by the container user (uid 1000).\n` +
        `Fix on the host: chown -R 1000:1000 <host_path_mounted_at_/data>\n` +
        `(see README "Permissions" section for details).`,
      )
      process.exit(1)
    }
    if (code !== 'ENOENT') throw err
    fileExists = false
  }

  if (!fileExists) {
    const csv = await readFile(CSV_PATH, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    })
    if (decodeDataPoints(csv).length) throw new Error('Database configuration is missing while data points exist; restore database.yaml before startup')
    // First run — create the directory (e.g. /data might not exist in dev) and write seed data
    await mkdir(dirname(DB_PATH), { recursive: true })
    const initial: Database = {
      categories: SEED_CATEGORIES,
      assets: [],
      persons: [],
    }
    // writeFileAtomic: temp-file + rename — never writes directly to DB_PATH (STOR-03)
    await writeFileAtomic(DB_PATH, stringify(initial, { lineWidth: 0 }))
    console.log(`Initialized database at ${DB_PATH} with ${SEED_CATEGORIES.length} seed categories`)
    await auditLog('database.init', { path: DB_PATH, seed_categories: SEED_CATEGORIES.length })
    return
  }

  // File exists — validate it can be parsed before the server accepts any requests.
  // Decision D-01: if YAML is corrupt, crash with a clear message rather than silently
  // continuing with empty state (which would overwrite real user data on the next write).
  const raw = await readFile(DB_PATH, 'utf8')
  try {
    parse(raw)
  } catch (err) {
    throw new Error(`Failed to parse database at ${DB_PATH}: ${(err as Error).message}`)
  }

  const current = parse(raw) as LegacyDatabase
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Database root must be an object')
  if (current.dataPoints !== undefined && !Array.isArray(current.dataPoints)) throw new Error('Legacy dataPoints must be an array')
  const { dataPoints: legacyPoints, ...config } = current
  if (!Array.isArray(config.categories)) throw new ValidationError([{ field: 'categories', message: 'Expected an array' }])
  const categories = config.categories.map((cat, index) => {
    if (!cat || typeof cat !== 'object' || Array.isArray(cat)) throw new ValidationError([{ field: `categories.${index}`, message: 'Expected an object' }])
    if (cat.track_only !== undefined && typeof cat.track_only !== 'boolean') throw new Error('Legacy track_only must be boolean')
    const { track_only, ...rest } = cat
    return { ...rest, type: cat.type === undefined ? (track_only ? 'cash-inflow' : 'asset') : cat.type }
  })
  const db = validateDatabase({ ...config, categories })
  const csvRaw = await readFile(CSV_PATH, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  })
  const csvPoints = decodeDataPoints(csvRaw)
  const points = legacyPoints ?? csvPoints
  validatePoints(points, db, true)
  if (legacyPoints !== undefined && csvPoints.length) {
    const canonical = (records: DataPoint[]) => encodeDataPoints([...records].sort((a, b) => a.id.localeCompare(b.id)))
    if (canonical(legacyPoints) !== canonical(csvPoints)) {
      throw new Error('Legacy YAML dataPoints conflict with existing datapoints.csv; preserve both files and reconcile them explicitly before startup')
    }
  }
  const duplicates = duplicateKeys(points)
  const orphanCount = points.filter(point => !db.assets.some(asset => asset.id === point.asset_id)).length
  if (duplicates.length || orphanCount) {
    console.warn(`Compatibility report: ${duplicates.length} duplicate asset/month keys, ${orphanCount} orphan data points. Existing records were preserved; repair explicitly before editing conflicts.`)
    await auditLog('database.compatibility', { duplicate_keys: duplicates.length, orphan_data_points: orphanCount })
  }
  if (legacyPoints !== undefined || current.categories.some(category => category.type === undefined || 'track_only' in category)) {
    await mutateDbAndDataPoints(() => ({ db, points }), {
      action: 'database.migrate', meta: { data_points_migrated: legacyPoints?.length ?? 0 },
    })
  }
}
