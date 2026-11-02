import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import type { Database, DataPoint } from '../models/index.js'

const root = await mkdtemp(join(tmpdir(), 'wt-transaction-'))
const yamlPath = join(root, 'database.yaml')
const csvPath = join(root, 'datapoints.csv')
process.env.DATA_FILE = yamlPath
process.env.DATA_POINTS_FILE = csvPath
process.env.LOGS_DIR = join(root, 'logs')
const { encodeDataPoints } = await import('./csv.js')
const { mutateDbAndDataPoints, readDbAndDataPoints, recoverPendingTransaction, TRANSACTION_PATH } = await import('./index.js')
const { bootstrapDatabase } = await import('../bootstrap.js')
const db: Database = {
  categories: [{ id: 'stock', name: 'Stock', projected_yearly_growth: 0, color: '#123456', type: 'asset' }],
  persons: [{ id: 'alice', name: 'Alice' }],
  assets: [{ id: 'account', name: 'Account', category_id: 'stock', person_id: 'alice', projected_yearly_growth: null, created_at: '2024-01-01T00:00:00Z' }],
}
const points: DataPoint[] = [{ id: 'p1', asset_id: 'account', year_month: '2024-01', value: 10, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' }]
const before = { yaml: stringify(db), csv: encodeDataPoints(points) }
const nextDb: Database = { ...db, assets: [] }
const afterPair = { yaml: stringify(nextDb), csv: encodeDataPoints([]) }
function payload() {
  return { version: 1, targets: { yaml: yamlPath, csv: csvPath }, before: { ...before }, after: { ...afterPair } }
}
async function stage(value = payload(), corrupt = false) {
  const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex')
  await writeFile(TRANSACTION_PATH, JSON.stringify({ ...value, hash: corrupt ? 'wrong' : hash }))
}
async function assertPair(pair: typeof before) {
  assert.equal(await readFile(yamlPath, 'utf8'), pair.yaml)
  assert.equal(await readFile(csvPath, 'utf8'), pair.csv)
}
beforeEach(async () => {
  await rm(root, { recursive: true, force: true })
  await mkdir(root)
  await writeFile(yamlPath, before.yaml)
  await writeFile(csvPath, before.csv)
})
after(() => rm(root, { recursive: true, force: true }))

for (const boundary of ['staged', 'yaml-renamed', 'both-renamed']) {
  test(`startup rolls forward a transaction interrupted at ${boundary} and replay is idempotent`, async () => {
    await stage()
    if (boundary !== 'staged') await writeFile(yamlPath, afterPair.yaml)
    if (boundary === 'both-renamed') await writeFile(csvPath, afterPair.csv)
    await bootstrapDatabase()
    await assertPair(afterPair)
    await assert.rejects(access(TRANSACTION_PATH), { code: 'ENOENT' })
    await recoverPendingTransaction()
    await assertPair(afterPair)
  })
}

test('regular paired mutation persists consistent files and removes its durable manifest', async () => {
  await mutateDbAndDataPoints(() => ({ db: nextDb, points: [] }))
  await assertPair(afterPair)
  await assert.rejects(access(TRANSACTION_PATH), { code: 'ENOENT' })
})

test('corrupt manifest checksum leaves both existing files and recovery evidence intact', async () => {
  await stage(payload(), true)
  await assert.rejects(bootstrapDatabase, /Invalid pending database transaction/)
  await assertPair(before)
  await access(TRANSACTION_PATH)
})

test('manifest cannot reference another database or CSV destination', async () => {
  const altered = payload()
  altered.targets.csv = join(root, 'another.csv')
  await stage(altered)
  await assert.rejects(recoverPendingTransaction, /Invalid pending database transaction/)
  await assertPair(before)
  await assert.rejects(access(altered.targets.csv), { code: 'ENOENT' })
})

test('manifest validation rejects malformed staged state before touching either file', async () => {
  const altered = payload()
  altered.after.yaml = 'null'
  await stage(altered)
  await assert.rejects(recoverPendingTransaction)
  await assertPair(before)
})

test('recovery refuses unexpected live edits and preserves old and new bytes in the manifest', async () => {
  await stage()
  await writeFile(csvPath, 'operator-edited-file')
  await assert.rejects(recoverPendingTransaction, /Live files conflict/)
  assert.equal(await readFile(yamlPath, 'utf8'), before.yaml)
  assert.equal(await readFile(csvPath, 'utf8'), 'operator-edited-file')
  const manifest = JSON.parse(await readFile(TRANSACTION_PATH, 'utf8'))
  assert.deepEqual(manifest.before, before)
  assert.deepEqual(manifest.after, afterPair)
})

test('failed staging cannot overwrite the prior pair', async () => {
  await mkdir(TRANSACTION_PATH)
  await assert.rejects(mutateDbAndDataPoints(() => ({ db: nextDb, points: [] })))
  await assertPair(before)
})

test('a consistent read completes an interrupted transaction before returning', async () => {
  await stage()
  await writeFile(yamlPath, afterPair.yaml)
  const result = await readDbAndDataPoints()
  assert.deepEqual(result.db, nextDb)
  assert.deepEqual(result.dataPoints, [])
})

async function runMutationChild(interruption: 'crash' | 'staging-failure') {
  const code = `
    import fs from 'node:fs'
    const rename = fs.rename
    fs.rename = (from, to, callback) => {
      if (${JSON.stringify(interruption)} === 'staging-failure' && to === process.env.DATA_FILE + '.transaction.json') {
        callback(Object.assign(new Error('injected staging failure'), { code: 'ENOSPC' }))
        return
      }
      rename(from, to, error => {
        if (!error && ${JSON.stringify(interruption)} === 'crash' && to === fs.realpathSync(process.env.DATA_FILE)) process.kill(process.pid, 'SIGKILL')
        callback(error)
      })
    }
    const { mutateDbAndDataPoints } = await import('./src/storage/index.ts')
    try {
      await mutateDbAndDataPoints(db => ({ db: { ...db, assets: [] }, points: [] }))
      process.exitCode = 2
    } catch (error) {
      if (error.code !== 'ENOSPC') throw error
      process.exitCode = 0
    }
  `
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), env: { ...process.env } })
    let stderr = ''
    child.stderr.on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }))
  })
}

test('a real mutation killed after the first live rename recovers the durable new pair', async () => {
  const result = await runMutationChild('crash')
  assert.equal(result.signal, 'SIGKILL', result.stderr)
  assert.equal(await readFile(yamlPath, 'utf8'), afterPair.yaml)
  assert.equal(await readFile(csvPath, 'utf8'), before.csv)
  const manifest = JSON.parse(await readFile(TRANSACTION_PATH, 'utf8'))
  assert.deepEqual(manifest.before, before)
  assert.deepEqual(manifest.after, afterPair)
  await bootstrapDatabase()
  await assertPair(afterPair)
  await assert.rejects(access(TRANSACTION_PATH), { code: 'ENOENT' })
})

test('a real mutation with a failed manifest rename leaves the old pair untouched', async () => {
  const result = await runMutationChild('staging-failure')
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.signal, null)
  await assertPair(before)
  await assert.rejects(access(TRANSACTION_PATH), { code: 'ENOENT' })
})
