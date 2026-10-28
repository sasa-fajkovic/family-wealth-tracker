// Import routes — replace database.yaml or datapoints.csv with an uploaded file.
//
// Safety pipeline (executed under dbMutex so no other request can race):
//  1. Read uploaded body, enforce a size cap.
//  2. Validate parseability + minimal schema. On failure: 400, no side-effects.
//  3. Validate referential integrity against the LIVE state. If broken, return
//     409 with a conflict report unless ?force=true was passed (matches the
//     existing delete-asset / delete-category force pattern in this codebase).
//  4. Snapshot the live file's bytes and write a backup with a deterministic
//     name derived from the target identity (NOT the uploaded filename) plus a
//     seconds-resolution timestamp + UUID suffix to avoid collisions and
//     filename-injection.
//  5. Read the backup back and verify byte-length + SHA-256 against the
//     in-memory snapshot. Refuse to overwrite the live file if verification
//     fails.
//  6. writeFileAtomic the new content over the live file.
//  7. Audit-log success only after step 6 returns.

import { validationException } from '../util/validationException.js'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { parse, stringify } from 'yaml'
import writeFileAtomic from 'write-file-atomic'
import { DB_PATH, CSV_PATH, recoverPendingTransaction } from '../storage/index.js'
import { dbMutex } from '../storage/mutex.js'
import { decodeDataPoints, encodeDataPoints } from '../storage/csv.js'
import { auditLog } from '../audit/index.js'
import { validateDatabase as validateDatabaseShape, validatePoints, duplicateKeys } from '../models/validation.js'
import type { Database, DataPoint } from '../models/index.js'

const router = new Hono()

const MAX_YAML_BYTES = 5 * 1024 * 1024   // 5 MB
const MAX_CSV_BYTES = 20 * 1024 * 1024   // 20 MB

interface ImportSummary {
  ok: true
  backup: string
  bytes: number
  hash: string
  counts: Record<string, number>
}

interface OrphanReport {
  needs_force: true
  message: string
  orphans: { kind: string; ids: string[] }[]
}

async function readUpload(c: Context, maxBytes: number): Promise<{ buf: Buffer; filename: string | null }> {
  // Hono's parseBody handles multipart automatically; for raw body we use req.arrayBuffer.
  const ct = c.req.header('content-type') ?? ''
  if (ct.includes('multipart/form-data')) {
    const body = await c.req.parseBody()
    const file = body['file']
    if (!(file instanceof File)) {
      throw new HTTPException(400, { message: 'Missing "file" field in multipart body' })
    }
    if (file.size > maxBytes) {
      throw new HTTPException(413, { message: `File exceeds ${maxBytes} bytes` })
    }
    const buf = Buffer.from(await file.arrayBuffer())
    return { buf, filename: file.name || null }
  }
  // Fallback: raw body upload
  const ab = await c.req.arrayBuffer()
  if (ab.byteLength > maxBytes) {
    throw new HTTPException(413, { message: `File exceeds ${maxBytes} bytes` })
  }
  return { buf: Buffer.from(ab), filename: null }
}

function checkExtension(filename: string | null, allowed: string[]): void {
  if (!filename) return  // Raw body upload — no name to check
  const lower = filename.toLowerCase()
  if (!allowed.some(ext => lower.endsWith(ext))) {
    throw new HTTPException(400, { message: `Unsupported file extension. Expected ${allowed.join(' or ')}` })
  }
}

function buildBackupName(targetBasename: string): string {
  // Trusted name: derived from the target file we're replacing, not the upload.
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}_${pad(now.getMinutes())}_${pad(now.getSeconds())}`
  // Random suffix prevents any chance of collision (sub-second double-import).
  const suffix = randomUUID().slice(0, 8)
  return `backup_${stamp}_${suffix}_${targetBasename}`
}

async function writeBackupAndVerify(targetPath: string, originalBytes: Buffer): Promise<{ path: string; hash: string }> {
  const backupName = buildBackupName(basename(targetPath))
  const backupPath = resolve(dirname(targetPath), backupName)

  // Use 'wx' so an exceedingly unlikely collision fails cleanly rather than overwriting an existing backup.
  await writeFile(backupPath, originalBytes, { flag: 'wx' })

  const verify = await readFile(backupPath)
  if (verify.length !== originalBytes.length) {
    throw new HTTPException(500, { message: `Backup verification failed: size mismatch (${verify.length} vs ${originalBytes.length})` })
  }
  const expected = createHash('sha256').update(originalBytes).digest('hex')
  const actual = createHash('sha256').update(verify).digest('hex')
  if (actual !== expected) {
    throw new HTTPException(500, { message: 'Backup verification failed: hash mismatch' })
  }
  return { path: backupPath, hash: expected }
}

async function readOriginal(targetPath: string): Promise<Buffer> {
  try {
    return await readFile(targetPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0)
    throw err
  }
}

// ── Database (YAML) import ───────────────────────────────────────────────────

function validateDatabase(raw: string): Database {
  let parsed: unknown
  try {
    parsed = parse(raw)
  } catch (err) {
    throw validationException(err, 'Invalid YAML')
  }
  try { return validateDatabaseShape(parsed) } catch (error) {
    throw validationException(error, 'Invalid database')
  }
}

function replacementCounts(current: { id: string }[], incoming: { id: string }[]) {
  const existing = new Set(current.map(record => record.id))
  const next = new Set(incoming.map(record => record.id))
  return {
    added: incoming.filter(record => !existing.has(record.id)).length,
    replaced: incoming.filter(record => existing.has(record.id)).length,
    removed: current.filter(record => !next.has(record.id)).length,
  }
}

function findOrphanedDataPoints(newDb: Database, currentPoints: DataPoint[]): string[] {
  const newAssetIds = new Set(newDb.assets.map(a => a.id))
  const orphans = new Set<string>()
  for (const dp of currentPoints) {
    if (!newAssetIds.has(dp.asset_id)) orphans.add(dp.asset_id)
  }
  return [...orphans].sort()
}

router.post('/database', async (c) => {
  const force = c.req.query('force') === 'true'
  const preview = c.req.query('preview') === 'true'
  const { buf, filename } = await readUpload(c, MAX_YAML_BYTES)
  checkExtension(filename, ['.yaml', '.yml'])

  const text = buf.toString('utf8')
  const newDb = validateDatabase(text)

  return dbMutex.runExclusive(async () => {
    await recoverPendingTransaction()
    // Referential integrity: imported assets must cover existing data points (else orphan).
    const currentCsvRaw = await readFile(CSV_PATH, 'utf8').catch(err => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw err
    })
    const currentPoints = currentCsvRaw ? decodeDataPoints(currentCsvRaw) : []
    try { validatePoints(currentPoints, newDb, true) } catch (error) {
      throw validationException(error, 'Database conflicts with existing data points')
    }
    const orphans = findOrphanedDataPoints(newDb, currentPoints)
    if (preview) {
      const current = validateDatabaseShape(parse((await readOriginal(DB_PATH)).toString('utf8')))
      return c.json({ preview: true,
        counts: { categories: newDb.categories.length, assets: newDb.assets.length, persons: newDb.persons.length },
        changes: { categories: replacementCounts(current.categories, newDb.categories), assets: replacementCounts(current.assets, newDb.assets), persons: replacementCounts(current.persons, newDb.persons) },
        conflicts: [], orphans: orphans.length ? [{ kind: 'asset_id', ids: orphans }] : [], needs_force: orphans.length > 0,
      })
    }
    if (orphans.length > 0 && !force) {
      const report: OrphanReport = {
        needs_force: true,
        message: `Importing this database would orphan data points referencing ${orphans.length} asset(s) no longer in the file. Pass ?force=true to proceed (existing data points will be kept but won't show up in the UI until matching assets are restored).`,
        orphans: [{ kind: 'asset_id', ids: orphans }],
      }
      return c.json(report, 409)
    }

    // Snapshot current live file, write+verify backup, then atomically replace.
    const original = await readOriginal(DB_PATH)
    const backup = original.length > 0 ? await writeBackupAndVerify(DB_PATH, original) : null

    // Re-stringify through `yaml` so we always write canonical formatting (instead of the raw upload bytes).
    await writeFileAtomic(DB_PATH, stringify(newDb, { lineWidth: 0 }))

    const summary: ImportSummary = {
      ok: true,
      backup: backup ? basename(backup.path) : '(no prior file — no backup taken)',
      bytes: original.length,
      hash: backup ? backup.hash : '',
      counts: {
        categories: newDb.categories.length,
        assets: newDb.assets.length,
        persons: newDb.persons.length,
      },
    }
    await auditLog('database.import', {
      backup: summary.backup,
      original_bytes: summary.bytes,
      ...summary.counts,
      forced: force,
      orphan_count: orphans.length,
    })
    return c.json(summary)
  })
})

// ── Datapoints (CSV) import ──────────────────────────────────────────────────

router.post('/datapoints', async (c) => {
  const force = c.req.query('force') === 'true'
  const preview = c.req.query('preview') === 'true'
  const { buf, filename } = await readUpload(c, MAX_CSV_BYTES)
  checkExtension(filename, ['.csv'])

  const text = buf.toString('utf8')
  let parsed: DataPoint[]
  try {
    parsed = decodeDataPoints(text)
  } catch (err) {
    throw validationException(err, 'Invalid CSV')
  }

  return dbMutex.runExclusive(async () => {
    await recoverPendingTransaction()
    // Referential integrity: imported data points must reference assets that exist NOW.
    const currentDbRaw = await readFile(DB_PATH, 'utf8')
    const currentDb = validateDatabaseShape(parse(currentDbRaw))
    try {
      validatePoints(parsed, currentDb, true)
    } catch (error) {
      throw validationException(error, 'Invalid CSV')
    }
    const liveAssetIds = new Set(currentDb.assets.map(a => a.id))
    const unknownIds = new Set<string>()
    for (const dp of parsed) {
      if (!liveAssetIds.has(dp.asset_id)) unknownIds.add(dp.asset_id)
    }
    const duplicates = duplicateKeys(parsed)
    const conflicts = duplicates.length ? [{ kind: 'duplicate_asset_month', ids: duplicates }] : []
    const orphans = unknownIds.size ? [{ kind: 'asset_id', ids: [...unknownIds].sort() }] : []
    if (preview) {
      const current = decodeDataPoints((await readOriginal(CSV_PATH)).toString('utf8'))
      return c.json({ preview: true, counts: { data_points: parsed.length },
        changes: { data_points: replacementCounts(current, parsed) }, conflicts, orphans, needs_force: unknownIds.size > 0 })
    }
    if (duplicates.length) throw new HTTPException(400, { message: 'Duplicate asset/month keys in CSV; repair explicitly before importing' })
    if (unknownIds.size > 0 && !force) {
      const report: OrphanReport = {
        needs_force: true,
        message: `CSV references ${unknownIds.size} asset_id(s) not present in the current database.yaml. Either import a matching database.yaml first, or pass ?force=true.`,
        orphans: [{ kind: 'asset_id', ids: [...unknownIds].sort() }],
      }
      return c.json(report, 409)
    }

    const original = await readOriginal(CSV_PATH)
    const backup = original.length > 0 ? await writeBackupAndVerify(CSV_PATH, original) : null

    // Re-encode through encoder for canonical output.
    await writeFileAtomic(CSV_PATH, encodeDataPoints(parsed))

    const summary: ImportSummary = {
      ok: true,
      backup: backup ? basename(backup.path) : '(no prior file — no backup taken)',
      bytes: original.length,
      hash: backup ? backup.hash : '',
      counts: { data_points: parsed.length },
    }
    await auditLog('datapoints.import', {
      backup: summary.backup,
      original_bytes: summary.bytes,
      data_points: parsed.length,
      forced: force,
      unknown_asset_count: unknownIds.size,
    })
    return c.json(summary)
  })
})

export default router
