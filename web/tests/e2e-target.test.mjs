import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveE2ETarget } from '../e2e-target.mjs'

test('default target starts the isolated local server', () => {
  assert.deepEqual(resolveE2ETarget({}), { baseURL: 'http://localhost:4173', startServer: true })
})

test('an explicit local target skips webServer only after synthetic-data acknowledgement', () => {
  for (const baseURL of ['http://localhost:5000', 'http://127.0.0.1:5000', 'http://[::1]:5000']) {
    assert.throws(() => resolveE2ETarget({ BASE_URL: baseURL }), /E2E_ALLOW_SYNTHETIC_DATA=1/)
    assert.deepEqual(resolveE2ETarget({ BASE_URL: baseURL, E2E_ALLOW_SYNTHETIC_DATA: '1' }), {
      baseURL, startServer: false,
    })
  }
})

test('remote targets remain forbidden even with the synthetic-data acknowledgement', () => {
  for (const BASE_URL of ['https://example.com', 'https://localhost.example.com', 'http://192.168.1.2', 'http://localhost@production.example']) {
    assert.throws(() => resolveE2ETarget({ BASE_URL, E2E_ALLOW_SYNTHETIC_DATA: '1' }), /forbidden/)
  }
})

test('invalid schemes, credentials and non-origin targets cannot redirect CRUD requests', () => {
  for (const BASE_URL of ['', 'not-a-url', 'file://localhost/', 'http://user:secret@localhost', 'http://localhost/proxy', 'http://localhost/?proxy=production', 'http://localhost/#production']) {
    assert.throws(() => resolveE2ETarget({ BASE_URL, E2E_ALLOW_SYNTHETIC_DATA: '1' }))
  }
})
