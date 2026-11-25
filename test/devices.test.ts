import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openDevices } from '../src/server/devices.ts'
import { parseNetworks } from '../src/shared/net.ts'
import type { Fact } from '../src/shared/plugin.ts'

const own = parseNetworks('192.0.2.0/24,198.51.100.0/24')
const open = () => openDevices(new DatabaseSync(':memory:'), 'a', own)
const fact = (f: Partial<Fact>): Fact => ({ router: 'r1', source: 'dhcp', ref: '*1', hash: 'h', mac: null, random_mac: false, ip: null, comment: null, hostname: null, dns: [], static: false, interface: 'lan', seen: null, ...f })
const lease = (mac: string, ip: string, f: Partial<Fact> = {}) => fact({ mac, ip, random_mac: (parseInt(mac.slice(0, 2), 16) & 2) === 2, ...f })

test('a device keeps its name when its address changes', () => {
  const d = open()
  d.refresh([lease('00:11:22:33:44:55', '192.0.2.10', { comment: 'Printer' })])
  assert.equal(d.name('192.0.2.10'), 'Printer')
  d.refresh([lease('00:11:22:33:44:55', '192.0.2.11', { comment: 'Printer' })])
  assert.equal(d.list().length, 1)
  assert.equal(d.name('192.0.2.11'), 'Printer')
  // Old alerts still find it by the address it had then.
  assert.equal(d.name('192.0.2.10'), 'Printer')
})

test('a phone that made up a new MAC is found by its own name, not made twice', () => {
  const d = open()
  d.refresh([lease('02:00:00:00:00:01', '192.0.2.20', { hostname: 'Phone' })])
  d.rename({ ip: '192.0.2.20' }, 'Jane phone', false)
  d.refresh([lease('06:00:00:00:00:02', '192.0.2.21', { hostname: 'phone' })])
  assert.equal(d.list().length, 1)
  assert.equal(d.name('192.0.2.21'), 'Jane phone')
  // Both leases at once: the stale one is ignored, not made a second device.
  d.refresh([lease('06:00:00:00:00:02', '192.0.2.21', { hostname: 'phone' }), lease('02:00:00:00:00:01', '192.0.2.20', { hostname: 'phone' })])
  assert.equal(d.list().length, 1)
})

test('a fixed MAC is never taken over by a hostname match', () => {
  const d = open()
  d.refresh([lease('00:00:00:00:00:01', '192.0.2.30', { hostname: 'box' })])
  d.refresh([lease('00:00:00:00:00:01', '192.0.2.30', { hostname: 'box' }), lease('00:00:00:00:00:02', '192.0.2.31', { hostname: 'box' })])
  assert.equal(d.list().length, 2)
})

test('an address seen only in traffic becomes a device, and takes its MAC once a router reports it', () => {
  const d = open()
  d.refresh([], [{ ip: '192.0.2.40', last: '2026-01-01T00:00:00Z' }, { ip: '203.0.113.5', last: '2026-01-01T00:00:00Z' }])
  assert.deepEqual(d.list().map((x) => x.ip), ['192.0.2.40'])
  d.rename({ ip: '192.0.2.40' }, 'NAS', true)
  d.refresh([fact({ source: 'arp', mac: '00:00:00:00:00:40', ip: '192.0.2.40' })])
  const [nas] = d.list()
  assert.equal(d.list().length, 1)
  assert.equal(nas!.mac, '00:00:00:00:00:40')
  assert.equal(nas!.shown, 'NAS')
  assert.equal(nas!.want_dns, true)
})

test('two-way names: ours wins until the router is renamed, then the newer router name shows', () => {
  const d = open()
  d.refresh([lease('00:00:00:00:00:50', '192.0.2.50', { comment: 'old' })])
  d.rename({ ip: '192.0.2.50' }, 'mine', false)
  d.refresh([lease('00:00:00:00:00:50', '192.0.2.50', { comment: 'old' })])
  assert.equal(d.name('192.0.2.50'), 'mine')
  d.refresh([lease('00:00:00:00:00:50', '192.0.2.50', { comment: 'renamed on router' })])
  assert.equal(d.name('192.0.2.50'), 'renamed on router')
  // Our name having reached the router is not a rename there.
  d.rename({ ip: '192.0.2.50' }, 'again', false)
  d.refresh([lease('00:00:00:00:00:50', '192.0.2.50', { comment: 'again' })])
  assert.equal(d.list()[0]!.name, 'again')
})

test('new devices raise an event on watched networks only, never on the first look or for random MACs', () => {
  const d = open()
  d.refresh([lease('00:00:00:00:00:01', '192.0.2.2'), lease('00:00:00:00:00:02', '198.51.100.2', { interface: 'guest-dhcp' })])
  assert.equal(d.events().length, 0)
  assert.deepEqual(d.networks().map((n) => [n.cidr, n.watched]), [['192.0.2.0/24', true], ['198.51.100.0/24', false]])
  d.refresh([lease('00:00:00:00:00:03', '192.0.2.3'), lease('00:00:00:00:00:04', '198.51.100.4', { interface: 'guest-dhcp' }), lease('02:00:00:00:00:05', '192.0.2.5')])
  const ev = d.events()
  assert.equal(ev.length, 1)
  assert.equal(d.get(ev[0]!.device)!.ip, '192.0.2.3')
  assert.equal(d.ack(ev[0]!.device, 'someone'), true)
  assert.equal(d.events().length, 0)
  d.watch('198.51.100.0/24', true)
  d.watch('192.0.2.0/24', false)
  d.refresh([lease('00:00:00:00:00:06', '198.51.100.6', { interface: 'guest-dhcp' }), lease('00:00:00:00:00:07', '192.0.2.7')])
  assert.deepEqual(d.events().map((e) => d.get(e.device)!.ip), ['198.51.100.6'])
  assert.throws(() => d.watch('nonsense', true))
})

test('multicast, broadcast, link-local and outside addresses never become devices, and old ones are cleared', () => {
  const db = new DatabaseSync(':memory:')
  const d = openDevices(db, 'a', own)
  const at = '2026-01-01T00:00:00Z'
  d.refresh([], ['224.0.0.251', '239.255.255.250', '255.255.255.255', '192.0.2.255', '0.0.0.0', 'ff02::fb', 'fe80::1', '::', '203.0.113.5', '192.0.2.8'].map((ip) => ({ ip, last: at })))
  assert.deepEqual(d.list().map((x) => x.ip), ['192.0.2.8'])
  assert.equal(d.rename({ ip: 'ff02::1' }, 'x', false), undefined)
  db.prepare("INSERT INTO devices (site, ip, first_seen, last_seen) VALUES ('a', 'ff02::fb', ?, ?)").run(at, at)
  assert.deepEqual(openDevices(db, 'a', own).list().map((x) => x.ip), ['192.0.2.8'])
})

test('a device sits on its edge port, not on the uplink every switch learns it on; busy ports are flagged', () => {
  const d = open()
  const br = (mac: string, port: string, router = 'sw', vlan: number | null = 1) => fact({ source: 'bridge', router, mac, interface: port, vlan })
  const clients = ['00:00:00:00:01:01', '00:00:00:00:01:02', '00:00:00:00:01:03']
  d.refresh([lease('00:00:00:00:00:20', '192.0.2.66'), br('00:00:00:00:00:20', 'ether20'), br('00:00:00:00:00:20', 'sfp1', 'core'),
    br('00:00:00:00:00:30', 'sfp1', 'core'), br('00:00:00:00:00:31', 'sfp1', 'core'), ...clients.map((m) => br(m, 'ether17'))])
  const x = d.list().find((v) => v.ip === '192.0.2.66')!
  assert.deepEqual([x.port, x.port_router, x.vlan], ['ether20', 'sw', 1])
  assert.deepEqual(d.ports().map((p) => [p.router, p.port, p.macs, p.shared]), [['core', 'sfp1', 3, true], ['sw', 'ether17', 3, true], ['sw', 'ether20', 1, false]])
  // A look without switch data keeps what was learned.
  d.refresh([lease('00:00:00:00:00:20', '192.0.2.66')])
  assert.equal(d.ports().length, 3)
  assert.equal(d.list().find((v) => v.ip === '192.0.2.66')!.port, 'ether20')
})
