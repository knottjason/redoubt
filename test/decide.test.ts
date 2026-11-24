import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createService } from '../src/server/decide.ts'
import { openDecisions } from '../src/server/decisions.ts'
import { openPlugins } from '../src/server/plugins.ts'
import { parseNetworks } from '../src/shared/net.ts'

test('every decision goes through the same checks', () => {
  const dec = openDecisions(':memory:', 'a')
  const p = openPlugins(dec.db)
  dec.db.exec(`INSERT INTO plugins (site, url, key, name, version, kinds, rules) VALUES ('a', 'http://192.0.2.1', 'k', 'x', '1', '["block.pair","block.remote","rule.disable","rule.silence"]', 0)`)
  const s = createService(dec, p, { site: 'a', internal: parseNetworks('192.0.2.0/24'), neverBlock: parseNetworks('198.51.100.53') })
  const b = { site: 'a', action: 'block' as const, sid: 1, signature: 'x', user: 'example' }
  const kinds = () => (dec.db.prepare("SELECT kind || ' ' || machine || ' ' || remote AS t FROM entries").all() as { t: string }[]).map((r) => r.t)
  assert.ok('error' in s.decide({ ...b, src: '192.0.2.9', dst: '10.0.0.1' }))
  assert.ok('error' in s.decide({ ...b, src: '198.51.100.53', dst: '192.0.2.9' }))
  assert.ok('error' in s.decide({ ...b, site: 'b', src: '192.0.2.9', dst: '203.0.113.5' }))
  assert.equal(dec.history().length, 0)
  s.decide({ ...b, src: '192.0.2.9', dst: '203.0.113.5' })
  s.decide({ ...b, src: '203.0.113.6', dst: '192.0.2.9' })
  s.decide({ ...b, src: '192.0.2.9', dst: '198.51.100.53' })
  assert.deepEqual(kinds(), ['block.pair 192.0.2.9 203.0.113.5', 'block.remote  203.0.113.6', 'block.pair 192.0.2.9 198.51.100.53'])
  assert.ok('error' in s.setRule({ sid: 5, on: true, signature: 'x', user: 'example' }))
  assert.ok('error' in s.setRule({ sid: 5, on: false, signature: 'x', machine: '203.0.113.5', user: 'example' }))
  const r = s.setRule({ sid: 5, on: false, signature: 'x', user: 'example' })
  assert.ok('id' in r && r.enforced)
  assert.ok('error' in s.setRule({ sid: 5, on: false, signature: 'x', user: 'example' }))
  assert.equal(s.undo('id' in r ? r.id : 0, 'example'), true)
})
