import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isInternal, orient, parseNetworks } from '../src/shared/net.ts'
import { decisionFor, openDecisions } from '../src/server/decisions.ts'

const own = parseNetworks('192.0.2.0/24')

test('internal addresses are recognised, including ones not configured', () => {
  for (const a of ['192.0.2.9', '10.1.2.3', '172.31.0.1', '192.168.1.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '224.0.0.1', '255.255.255.255', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', 'garbage', ''])
    assert.equal(isInternal(a, own), true, a)
  for (const a of ['203.0.113.5', '198.51.100.7', '172.32.0.1', '8.8.8.8', '2001:4860::8888', '::ffff:203.0.113.5']) assert.equal(isInternal(a, own), false, a)
})

test('orientation puts our side first', () => {
  assert.deepEqual(orient('192.0.2.9', '203.0.113.5', own), { machine: '192.0.2.9', remote: '203.0.113.5', direction: 'out' })
  assert.deepEqual(orient('203.0.113.5', '192.0.2.9', own), { machine: '192.0.2.9', remote: '203.0.113.5', direction: 'in' })
  assert.equal(orient('192.0.2.9', '192.0.2.1', own).direction, 'internal')
})

test('decisions cover what they should, and undo works', () => {
  const d = openDecisions(':memory:')
  const base = { sid: 1, machine: '192.0.2.9', remote: '203.0.113.5', signature: 'Example', user: 'example' }
  const id = d.add({ ...base, action: 'allow' })
  assert.equal(decisionFor(d.active(), 1, '192.0.2.9', '203.0.113.5')?.action, 'allow')
  assert.equal(decisionFor(d.active(), 1, '192.0.2.9', '203.0.113.6'), undefined)
  assert.equal(d.undo(id, 'example'), true)
  assert.equal(d.undo(id, 'example'), false)
  d.add({ ...base, action: 'silence_machine' })
  assert.equal(decisionFor(d.active(), 1, '192.0.2.9', '203.0.113.6')?.action, 'silence_machine')
  assert.equal(decisionFor(d.active(), 1, '192.0.2.10', '203.0.113.6'), undefined)
  d.add({ ...base, action: 'silence_all' })
  assert.equal(decisionFor(d.active(), 1, '192.0.2.10', '203.0.113.6')?.action, 'silence_all')
  assert.equal(decisionFor(d.active(), 2, '192.0.2.9', '203.0.113.5'), undefined)
  assert.equal(d.history().length, 3)
})
