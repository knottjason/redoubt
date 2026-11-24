import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
  const d = openDecisions(':memory:', 'a')
  const base = { site: 'a', sid: 1, machine: '192.0.2.9', remote: '203.0.113.5', signature: 'Example', user: 'example' }
  const id = d.add({ ...base, action: 'allow' })
  assert.equal(decisionFor(d.active(), 'a', 1, '192.0.2.9', '203.0.113.5')?.action, 'allow')
  assert.equal(decisionFor(d.active(), 'a', 1, '192.0.2.9', '203.0.113.6'), undefined)
  assert.equal(d.undo(id, 'example'), true)
  assert.equal(d.undo(id, 'example'), false)
  const m = d.add({ ...base, sid: 5, action: 'allow_machine' })
  assert.equal(decisionFor(d.active(), 'a', 5, '192.0.2.9', '203.0.113.99')?.action, 'allow_machine')
  assert.equal(decisionFor(d.active(), 'a', 5, '192.0.2.10', '203.0.113.99'), undefined)
  d.undo(m, 'example')
  d.undo(d.add({ ...base, sid: 6, action: 'allow_all' }), 'example')
  d.add({ ...base, action: 'silence_machine' })
  assert.equal(decisionFor(d.active(), 'a', 1, '192.0.2.9', '203.0.113.6')?.action, 'silence_machine')
  assert.equal(decisionFor(d.active(), 'a', 1, '192.0.2.10', '203.0.113.6'), undefined)
  d.add({ ...base, action: 'silence_all' })
  assert.equal(decisionFor(d.active(), 'a', 1, '192.0.2.10', '203.0.113.6')?.action, 'silence_all')
  assert.equal(decisionFor(d.active(), 'a', 2, '192.0.2.9', '203.0.113.5'), undefined)
  assert.equal(decisionFor(d.active(), 'b', 1, '192.0.2.9', '203.0.113.5'), undefined)
  assert.equal(d.history().length, 5)
})

test('decisions made before sites existed move to this site, once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'redoubt-'))
  const old = new DatabaseSync(join(dir, 'decisions.sqlite'))
  old.exec(`CREATE TABLE decisions (id INTEGER PRIMARY KEY, action TEXT NOT NULL, sid INTEGER NOT NULL, machine TEXT NOT NULL, remote TEXT NOT NULL,
    signature TEXT NOT NULL, user TEXT NOT NULL, created TEXT NOT NULL, undone TEXT, undone_by TEXT);
    INSERT INTO decisions (action, sid, machine, remote, signature, user, created) VALUES ('allow', 1, '192.0.2.9', '203.0.113.5', 'x', 'example', 'now')`)
  old.close()
  assert.equal(openDecisions(dir, 'a').history()[0]?.site, 'a')
  assert.equal(openDecisions(dir, 'b').history()[0]?.site, 'a')
})

test('a decision keeps its reason, and so does undoing it', () => {
  const d = openDecisions(':memory:', 'a')
  const id = d.add({ site: 'a', action: 'block', sid: 1, machine: '192.0.2.9', remote: '203.0.113.5', signature: 'Example', user: 'example (agent)', reason: 'On a threat list' })
  assert.equal(d.get(id)?.reason, 'On a threat list')
  d.undo(id, 'example', 'False positive')
  assert.equal(d.get(id)?.undo_reason, 'False positive')
  assert.equal(d.get(d.add({ site: 'a', action: 'allow', sid: 1, machine: '192.0.2.9', remote: '203.0.113.5', signature: 'Example', user: 'example' }))?.reason, null)
})
