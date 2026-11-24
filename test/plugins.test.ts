import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { z } from 'zod'
import { createPlugin, type Plugin } from '../plugins/lib/serve.ts'
import { suricata, type Tools } from '../plugins/suricata/suricata.ts'
import { openDecisions } from '../src/server/decisions.ts'
import { call, openPlugins, wants } from '../src/server/plugins.ts'
import { signRequest } from '../src/shared/plugin.ts'

const key = 'k'.repeat(40)
const tmp = () => mkdtempSync(join(tmpdir(), 'redoubt-'))
async function start(plugin: Plugin, stateDir = tmp(), port = 0) {
  const s = createPlugin(plugin, { key, stateDir })
  await new Promise<void>((r) => s.listen(port, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, stop: () => new Promise((r) => { s.closeAllConnections(); s.close(r) }) }
}
function fake() {
  const f = { got: [] as string[][], fail: new Set<number>(), plugin: undefined as unknown as Plugin }
  f.plugin = {
    describe: { name: 'Fake', version: '1', kinds: ['rule.disable', 'rule.silence'], rules: false },
    async apply(e) { f.got.push(e.map((x) => `${x.kind}:${x.sid}`)); return { results: e.map((x) => f.fail.has(x.sid!) ? { id: x.id, ok: false, error: 'no' } : { id: x.id, ok: true }) } },
    async health() { return { healthy: true, message: 'fine' } },
  }
  return f
}
const d = { site: 'a', action: 'rule_off' as const, sid: 1, machine: '', remote: '', signature: 'x', user: 'example' }

test('wrong keys, replays and forged replies are refused', async () => {
  const f = fake()
  const s = await start(f.plugin)
  const any = z.any()
  await assert.rejects(call({ url: s.url, key: 'w'.repeat(40) }, 'describe', {}, any), /refused the key/)
  const [time, nonce, path] = [String(Date.now()), 'a'.repeat(32), '/redoubt/v1/describe']
  const headers = { 'x-redoubt-time': time, 'x-redoubt-nonce': nonce, 'x-redoubt-signature': signRequest(key, time, nonce, path, '{}') }
  const send = (h = headers, body = '{}') => fetch(s.url + path, { method: 'POST', body, headers: h }).then((r) => r.status)
  assert.equal(await send(), 200)
  assert.equal(await send(), 401)
  assert.equal(await send(headers, '{"a":1}'), 401)
  const old = String(Date.now() - 120_000)
  assert.equal(await send({ 'x-redoubt-time': old, 'x-redoubt-nonce': 'b'.repeat(32), 'x-redoubt-signature': signRequest(key, old, 'b'.repeat(32), path, '{}') }), 401)
  await s.stop()
})

test('a decision is delivered, survives an outage, and is taken away on undo', async () => {
  const f = fake()
  const dir = tmp()
  let s = await start(f.plugin, dir)
  const port = Number(new URL(s.url).port)
  const dec = openDecisions(':memory:', 'a')
  const p = openPlugins(dec.db)
  await p.add('a', s.url, key)
  await assert.rejects(p.add('a', s.url, key), /already handles/)
  const id = dec.add(d)
  assert.equal(p.request('a', id, wants(d, 'out')!), true)
  assert.equal(p.request('b', id, wants(d, 'out')!), false)
  assert.equal(p.states().get(id)?.state, 'requested')
  await s.stop()
  await p.deliverDue()
  assert.equal(p.states().get(id)?.state, 'requested')
  assert.match(p.states().get(id)!.error, /reach/)
  s = await start(f.plugin, dir, port)
  dec.db.exec('UPDATE plugins SET next_try = 0')
  await p.deliverDue()
  assert.equal(p.states().get(id)?.state, 'active')
  f.fail.add(2)
  const bad = dec.add({ ...d, sid: 2 })
  p.request('a', bad, wants({ ...d, sid: 2 }, 'out')!)
  await p.deliverDue()
  assert.equal(p.states().get(bad)?.state, 'failed')
  assert.equal(p.states().get(id)?.state, 'active')
  p.undo(id)
  assert.equal(p.states().get(id)?.state, 'removing')
  assert.throws(() => p.remove(1), /Undo/)
  await p.deliverDue()
  assert.equal(p.states().get(id)?.state, 'removed')
  assert.deepEqual(f.got.at(-1), ['rule.disable:2'])
  await s.stop()
})

test('a change made by hand on the device is noticed and put right', async () => {
  const f = fake()
  const dir = tmp()
  let s = await start(f.plugin, dir)
  const port = Number(new URL(s.url).port)
  const dec = openDecisions(':memory:', 'a')
  const p = openPlugins(dec.db)
  await p.add('a', s.url, key)
  p.request('a', dec.add(d), wants(d, 'out')!)
  await p.deliverDue()
  await s.stop()
  const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...st, ids: [] }))
  s = await start(f.plugin, dir, port)
  await p.checkAll()
  await p.deliverDue()
  assert.equal(f.got.length, 2)
  await p.checkAll()
  assert.equal(p.list()[0]?.dirty, 0)
  await s.stop()
})

test('a Redoubt that lost its data, or another Redoubt, cannot undo everything', async () => {
  const f = fake()
  const s = await start(f.plugin)
  const any = z.any()
  const send = (instance: string, revision: number) => call({ url: s.url, key }, 'apply', { instance, revision, entries: [] }, any)
  await send('one', 5)
  await assert.rejects(send('one', 4), /behind/)
  await assert.rejects(send('two', 9), /another Redoubt/)
  await assert.rejects(call({ url: s.url, key }, 'apply', { instance: 'one', revision: 6, entries: [{ id: 'x', kind: 'block.pair' }] }, any), /Cannot do/)
  await s.stop()
})

const line = (sid: number, on: boolean) => `${on ? '' : '# '}alert tcp any any -> any any (msg:"EX rule ${sid}"; classtype:misc-activity; sid:${sid}; rev:1;)\n`
function sensor() {
  const root = tmp()
  const p = { rules: join(root, 'rules'), own: join(root, 'own'), disable: join(root, 'disable.conf'), enable: join(root, 'enable.conf') }
  mkdirSync(p.rules)
  const live = join(p.rules, 'suricata.rules')
  writeFileSync(live, line(1, true) + line(2, true) + line(3, false))
  const t = { builds: 0, reloads: 0, failed: 0, wreck: false }
  const tools: Tools = {
    async build(dis, en, out) {
      t.builds++
      const off = readFileSync(dis, 'utf8').split('\n')
      const on = readFileSync(en, 'utf8').split('\n')
      writeFileSync(join(out, 'suricata.rules'), t.wreck ? '' : [1, 2, 3].map((n) => line(n, on.includes(String(n)) || (n !== 3 && !off.includes(String(n))))).join(''))
    },
    async reload() { t.reloads++; const failed = t.failed; t.failed = 0; return { loaded: 2, failed } },
  }
  return { p, t, live, s: suricata(p, tools), on: () => readFileSync(live, 'utf8').split('\n').filter((l) => l.startsWith('alert')).map((l) => Number(/sid:(\d+)/.exec(l)![1])) }
}

test('Suricata: rules turn off and on, machines are silenced, and undo restores', async () => {
  const x = sensor()
  const base = { label: 'x' }
  assert.deepEqual((await x.s.apply([])).results, [])
  assert.equal(x.t.reloads, 0)
  const r = await x.s.apply([
    { ...base, id: 'a', kind: 'rule.disable', sid: 1 }, { ...base, id: 'b', kind: 'rule.enable', sid: 3 }, { ...base, id: 'c', kind: 'rule.silence', sid: 2, machine: '192.0.2.9' },
    { ...base, id: 'd', kind: 'rule.disable', sid: 99 }, { ...base, id: 'e', kind: 'rule.silence', sid: 2, machine: '192.0.2.9\nsuppress gen_id 1, sig_id 1' }])
  assert.deepEqual(r.results.map((y) => [y.id, y.ok]), [['a', true], ['b', true], ['c', true], ['d', false], ['e', false]])
  assert.deepEqual(x.on(), [2, 3])
  const t = readFileSync(join(x.p.own, 'threshold.config'), 'utf8')
  assert.match(t, /^suppress gen_id 1, sig_id 2, track by_either, ip 192\.0\.2\.9$/m)
  assert.equal(t.match(/suppress/g)?.length, 1)
  await x.s.apply([{ ...base, id: 'a', kind: 'rule.disable', sid: 1 }, { ...base, id: 'b', kind: 'rule.enable', sid: 3 }])
  assert.equal(x.t.builds, 1)
  await x.s.apply([])
  assert.deepEqual(x.on(), [1, 2])
  assert.deepEqual((await x.s.rules!({ find: 'RULE 3', state: 'off', offset: 0, limit: 10 })).rows.map((y) => y.sid), [3])
})

test('Suricata: a bad rebuild changes nothing, and a failed load is put back', async () => {
  const x = sensor()
  x.t.wreck = true
  await assert.rejects(x.s.apply([{ id: 'a', kind: 'rule.disable', sid: 1, label: 'x' }]), /look wrong/)
  assert.deepEqual(x.on(), [1, 2])
  assert.equal(x.t.reloads, 0)
  x.t.wreck = false
  x.t.failed = 3
  await assert.rejects(x.s.apply([{ id: 'a', kind: 'rule.disable', sid: 1, label: 'x' }, { id: 'c', kind: 'rule.silence', sid: 2, machine: '192.0.2.9', label: 'x' }]), /could not load/)
  assert.deepEqual(x.on(), [1, 2])
  assert.doesNotMatch(readFileSync(join(x.p.own, 'threshold.config'), 'utf8'), /suppress/)
  assert.equal(x.t.reloads, 2)
  await x.s.apply([{ id: 'a', kind: 'rule.disable', sid: 1, label: 'x' }])
  assert.deepEqual(x.on(), [2])
})

test('Suricata: a new download is applied once, keeps choices, and a bad one is put back', async () => {
  const x = sensor()
  const root = join(x.p.own, '..')
  const p = { ...x.p, incoming: join(root, 'in'), cache: join(root, 'cache') }
  mkdirSync(p.incoming)
  mkdirSync(p.cache)
  const cached = join(p.cache, `${'a'.repeat(32)}-emerging.rules.tar.gz`)
  const incoming = join(p.incoming, 'emerging.rules.tar.gz')
  writeFileSync(cached, 'old')
  let failed = 0
  const t = { builds: 0 }
  const s = suricata(p, {
    async build(dis, _en, out) {
      t.builds++
      const off = readFileSync(dis, 'utf8').split('\n')
      const n = readFileSync(cached, 'utf8') === 'old' ? [1, 2, 3] : [1, 2, 3, 4]
      writeFileSync(join(out, 'suricata.rules'), n.map((k) => line(k, !off.includes(String(k)))).join(''))
    },
    async reload() { const f = failed; failed = 0; return { loaded: 3, failed: f } },
  })
  const run = s.background!.run
  await run()
  assert.equal(t.builds, 0)
  await s.apply([{ id: 'a', kind: 'rule.disable', sid: 1, label: 'x' }])
  writeFileSync(incoming, 'bad')
  failed = 2
  await assert.rejects(run(), /could not load/)
  assert.equal(readFileSync(cached, 'utf8'), 'old')
  assert.deepEqual(x.on(), [2, 3])
  assert.equal((await s.health()).healthy, false)
  const b = t.builds
  await run()
  assert.equal(t.builds, b)
  writeFileSync(incoming, 'new')
  await run()
  assert.deepEqual(x.on(), [2, 3, 4])
  assert.match((await s.health()).message, /3 rules on; rules updated .* 1 new, 0 gone/)
  await run()
  assert.equal(t.builds, b + 1)
})
