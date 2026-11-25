import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.CLICKHOUSE_PASSWORD ??= 'x'

test('a remote is named by what it was contacted as, whoever opened the connection', async () => {
  const { siteNames } = await import('../src/server/data.ts')
  const s = siteNames([{ src: '192.0.2.9', dst: '203.0.113.5', name: 'out.example.com' }, { src: '203.0.113.6', dst: '192.0.2.9', name: 'in.example.com' }])
  assert.equal(s('192.0.2.9', '203.0.113.5'), 'out.example.com')
  assert.equal(s('192.0.2.9', '203.0.113.6'), 'in.example.com')
  assert.equal(s('192.0.2.10', '203.0.113.5'), '')
})
