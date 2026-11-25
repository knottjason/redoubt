import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chain, list, look, mikrotik, scaffold, seconds } from '../plugins/mikrotik/mikrotik.ts'
import { rest, type Item, type Rest } from '../plugins/mikrotik/router.ts'
import { namesFrom } from '../src/server/plugins.ts'
import { parseNetworks } from '../src/shared/net.ts'
import type { Entry } from '../src/shared/plugin.ts'

function fake() {
  let n = 0
  const t: Record<string, Item[]> = { 'ip/firewall/raw': [], 'ip/firewall/filter': [], 'ip/firewall/address-list': [], 'ip/firewall/connection': [], 'ip/dhcp-server/lease': [], 'ip/arp': [], 'ip/dns/static': [], 'interface/bridge/host': [], 'ip/neighbor': [] }
  const put = (p: string, i: Item) => { t[p]!.push({ '.id': `*${(++n).toString(16)}`, disabled: 'false', ...i }) }
  for (const s of scaffold) put(s.path, { ...s.item, comment: 'redoubt' })
  // Someone else's entries, which must survive everything.
  put('ip/firewall/filter', { chain, action: 'drop', 'src-address': '192.0.2.50', comment: 'by hand' })
  put('ip/firewall/filter', { chain: 'forward', action: 'accept' })
  put('ip/firewall/address-list', { list, address: '203.0.113.200', comment: 'by hand' })
  put('ip/firewall/address-list', { list: 'other', address: '203.0.113.1', comment: 'redoubt entry' })
  const r: Rest = {
    async get(path) {
      const [p, query = ''] = path.split('?')
      const where = [...new URLSearchParams(query)].filter(([k]) => !k.startsWith('.'))
      return t[p!]!.filter((i) => where.every(([k, v]) => i[k] === v)).map((i) => ({ ...i }))
    },
    async add(p, i) { put(p, i) },
    async remove(p, id) { t[p] = t[p]!.filter((i) => i['.id'] !== id) },
  }
  return { t, r, put }
}
const own = parseNetworks('192.0.2.0/24')
const never = parseNetworks('198.51.100.53')
const pair = (id: string, remote = '203.0.113.5'): Entry => ({ id, kind: 'block.pair', machine: '192.0.2.9', remote, label: 'x' })
const remote = (id: string, a: string): Entry => ({ id, kind: 'block.remote', remote: a, label: 'x' })
function start() {
  const f = fake()
  return { ...f, p: mikrotik({ routers: [{ name: 'r', read: f.r }], block: { read: f.r, write: f.r }, own, never, stateDir: mkdtempSync(join(tmpdir(), 'redoubt-')) }) }
}

test('blocks are added once, connections cut, and undo leaves other entries alone', async () => {
  const x = start()
  const before = structuredClone(x.t)
  x.put('ip/firewall/connection', { 'src-address': '192.0.2.9:5000', 'dst-address': '203.0.113.5:443' })
  x.put('ip/firewall/connection', { 'src-address': '192.0.2.10:5000', 'dst-address': '203.0.113.5:443' })
  x.put('ip/firewall/connection', { 'src-address': '203.0.113.7:9', 'dst-address': '192.0.2.9:22' })
  const r = await x.p.apply([pair('a'), remote('b', '203.0.113.7')])
  assert.ok(r.results.every((y) => y.ok))
  assert.deepEqual(x.t['ip/firewall/connection']!.map((c) => c['src-address']), ['192.0.2.10:5000'])
  assert.deepEqual((await x.p.present!()).sort(), ['a', 'b'])
  const n = JSON.stringify(x.t)
  await x.p.apply([pair('a'), remote('b', '203.0.113.7')])
  assert.equal(JSON.stringify(x.t), n)
  x.t['ip/firewall/address-list'] = x.t['ip/firewall/address-list']!.filter((i) => i.address !== '203.0.113.7')
  assert.deepEqual(await x.p.present!(), ['a'])
  await x.p.apply([])
  assert.deepEqual(x.t['ip/firewall/filter'], before['ip/firewall/filter'])
  assert.deepEqual(x.t['ip/firewall/address-list'], before['ip/firewall/address-list'])
})

test('internal, never-block and nonsense addresses are refused one by one', async () => {
  const x = start()
  const r = await x.p.apply([remote('a', '192.0.2.1'), remote('b', '10.0.0.1'), remote('c', '198.51.100.53'), remote('d', '0.0.0.0/0'), remote('e', '2001:db8::1'),
    { ...pair('f'), machine: '203.0.113.9' }, remote('g', '203.0.113.8'), { ...pair('h'), remote: undefined }, pair('i', '198.51.100.53')])
  assert.deepEqual(r.results.filter((y) => y.ok).map((y) => y.id), ['g', 'i'])
})

test('nothing is added unless the three rules are there and exactly as they should be', async () => {
  for (const spoil of [
    (f: ReturnType<typeof start>) => { f.t['ip/firewall/raw'] = [] },
    (f: ReturnType<typeof start>) => { f.t['ip/firewall/filter']![0]!.disabled = 'true' },
    (f: ReturnType<typeof start>) => { delete f.t['ip/firewall/filter']![0]!['out-interface-list'] },
    (f: ReturnType<typeof start>) => { f.t['ip/firewall/filter']![1]!.protocol = 'tcp' },
  ]) {
    const x = start()
    spoil(x)
    const n = x.t['ip/firewall/address-list']!.length
    await assert.rejects(x.p.apply([remote('a', '203.0.113.8')]), /not set up/)
    assert.equal(x.t['ip/firewall/address-list']!.length, n)
    assert.equal((await x.p.health()).healthy, false)
  }
})

test('devices: raw facts per source, with hashes that ignore last seen', async () => {
  const f = fake()
  f.put('ip/dhcp-server/lease', { 'mac-address': '02:00:5e:00:53:01', address: '192.0.2.20', 'host-name': 'phone', dynamic: 'true', server: 'lan', 'last-seen': '1h2m' })
  f.put('ip/dhcp-server/lease', { 'mac-address': '00:00:5E:00:53:02', address: '192.0.2.21', comment: 'Printer', 'host-name': 'PRN', 'last-seen': 'never' })
  f.put('ip/arp', { 'mac-address': '00:00:5E:00:53:02', address: '192.0.2.21', interface: 'lan', status: 'reachable' })
  f.put('ip/dns/static', { name: 'printer.example.com', address: '192.0.2.21' })
  const a = await look('r', f.r, 1e12)
  assert.deepEqual(a.map((x) => [x.source, x.ip, x.comment, x.hostname, x.static, x.random_mac]), [
    ['dhcp', '192.0.2.20', null, 'phone', false, true], ['dhcp', '192.0.2.21', 'Printer', 'PRN', true, false], ['arp', '192.0.2.21', null, null, false, false], ['dns', '192.0.2.21', null, null, false, false]])
  assert.equal(a[0]!.seen, new Date(1e12 - 3720_000).toISOString())
  assert.deepEqual((await look('r', f.r, 2e12)).map((x) => x.hash), a.map((x) => x.hash))
  f.t['ip/dhcp-server/lease']![1]!.comment = 'Big printer'
  assert.notEqual((await look('r', f.r))[1]!.hash, a[1]!.hash)
  assert.deepEqual(namesFrom(a), { '192.0.2.20': 'phone', '192.0.2.21': 'Printer' })
  assert.equal(seconds('1w2d3h4m5s'), 788645)
  assert.equal(seconds('1s200ms'), 1)
})

test('devices: a switch reports MACs per port and its neighbours; local and invalid rows are skipped', async () => {
  const f = fake()
  f.put('interface/bridge/host', { 'mac-address': '00:00:5E:00:53:10', 'on-interface': 'ether20', vid: '1', local: 'false' })
  f.put('interface/bridge/host', { 'mac-address': '00:00:5E:00:53:11', 'on-interface': 'bridge', local: 'true' })
  f.put('interface/bridge/host', { 'mac-address': '00:00:5E:00:53:12', 'on-interface': 'ether3', invalid: 'true' })
  f.put('ip/neighbor', { 'mac-address': '00:00:5E:00:53:13', interface: 'ether17,bridge', identity: 'ap1', platform: 'MikroTik', board: 'cAP', address: '192.0.2.13' })
  const a = await look('sw', f.r)
  assert.deepEqual(a.map((x) => [x.source, x.mac, x.interface, x.vlan ?? null, x.hostname, x.comment, x.ip]), [
    ['bridge', '00:00:5E:00:53:10', 'ether20', 1, null, null, null], ['neighbor', '00:00:5E:00:53:13', 'ether17', null, 'ap1', 'MikroTik cAP', '192.0.2.13']])
  // A router without a bridge or neighbour discovery still answers.
  const broken: Rest = { ...f.r, async get(path) { if (path.startsWith('interface/bridge')) throw new Error('Router: no such command'); if (path.startsWith('ip/neighbor')) throw new Error('Router: 403'); return f.r.get(path) } }
  const trouble: string[] = []
  assert.deepEqual(await look('fw', broken, Date.now(), trouble), [])
  assert.deepEqual(trouble, ['ip/neighbor: Router: 403'])
})

test('a router address without TLS is refused', () => assert.throws(() => rest('http://192.0.2.1', { user: 'a', password: 'b' }), /https/))
