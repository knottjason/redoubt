import { BlockList, isIP, isIPv4 } from 'node:net'
import type { DatabaseSync } from 'node:sqlite'
import { isInternal, parseNetworks } from '../shared/net.ts'
import type { Fact } from '../shared/plugin.ts'

/** One thing on the network, however many addresses it has had. */
export type Device = {
  id: number; site: string; mac: string | null; random_mac: boolean; hostname: string | null; ip: string | null
  /** What a person named it in Redoubt. Wins over everything else. */
  name: string
  /** What the router calls it (a lease comment), as last seen. */
  router_name: string
  router: string | null; interface: string | null; dns: string[]; static: boolean
  /** Asked for a DNS name and a fixed lease when the name is written back. */
  want_dns: boolean
  /** The switch port it is plugged into (the edge port, not an uplink), and the VLAN it was seen on. */
  port: string | null; port_router: string | null; vlan: number | null
  /** Set when this device is one of the routers themselves: its name in the plugin. */
  router_self: string | null
  first_seen: string; last_seen: string
}
/** A switch port and how many devices sit behind it. More than two means an access point or another switch. */
export type Port = { router: string; port: string; macs: number; shared: boolean }
export type DeviceEvent = { id: number; device: number; kind: 'new'; at: string; ack_at: string | null; ack_by: string | null }
/** A network the routers hand out addresses on. Watched networks raise an alert when a device never seen before turns up. */
export type Network = { cidr: string; server: string | null; auto: boolean; watched: boolean }
type Row = Omit<Device, 'random_mac' | 'dns' | 'static' | 'want_dns'> & { random_mac: number; dns: string; static: number; want_dns: number }

const day = 86_400_000
const slash24 = (ip: string) => `${ip.split('.').slice(0, 3).join('.')}.0/24`
const guest = /guest/i
/** Multicast and broadcast MACs (the group bit) and all zeros never name one device. */
export const deviceMac = (m: string) => !(parseInt(m.slice(0, 2), 16) & 1) && !/^(00:){5}00$/.test(m)
// Not one device: multicast, broadcast, loopback, unspecified, link-local. Link-local IPv6 addresses are real hosts, but every
// device has one beside its real address, so they would only make duplicates.
const notDevices = parseNetworks('0.0.0.0/8,127.0.0.0/8,169.254.0.0/16,224.0.0.0/3,::/127,fe80::/10,ff00::/8')
/** An address that can be one device on the network: ours, unicast, not a broadcast. */
export function deviceAddress(ip: string, internal: BlockList): boolean {
  const v4 = isIPv4(ip)
  if (!v4 && !isIP(ip)) return false
  if (notDevices.check(ip, v4 ? 'ipv4' : 'ipv6')) return false
  if (v4 && ip.endsWith('.255')) return false
  return isInternal(ip, internal)
}

/** Shown name: what a person called it here, then on the router, then what it calls itself, then DNS. */
export const shown = (d: Pick<Device, 'name' | 'router_name' | 'hostname' | 'dns'>) => d.name || d.router_name || d.hostname || d.dns[0] || ''

export function openDevices(db: DatabaseSync, site: string, internal: BlockList) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS devices (id INTEGER PRIMARY KEY, site TEXT NOT NULL, mac TEXT, random_mac INTEGER NOT NULL DEFAULT 0, hostname TEXT, ip TEXT,
      name TEXT NOT NULL DEFAULT '', router_name TEXT NOT NULL DEFAULT '', router TEXT, interface TEXT, dns TEXT NOT NULL DEFAULT '[]', static INTEGER NOT NULL DEFAULT 0,
      want_dns INTEGER NOT NULL DEFAULT 0, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS devices_mac ON devices (site, mac) WHERE mac IS NOT NULL;
    CREATE INDEX IF NOT EXISTS devices_ip ON devices (site, ip);
    CREATE TABLE IF NOT EXISTS device_ips (device INTEGER NOT NULL REFERENCES devices(id), ip TEXT NOT NULL, first TEXT NOT NULL, last TEXT NOT NULL, PRIMARY KEY (device, ip));
    CREATE INDEX IF NOT EXISTS device_ips_ip ON device_ips (ip);
    CREATE TABLE IF NOT EXISTS device_events (id INTEGER PRIMARY KEY, device INTEGER NOT NULL REFERENCES devices(id), kind TEXT NOT NULL, at TEXT NOT NULL, ack_at TEXT, ack_by TEXT);`)
  for (const [c, t] of [['port', 'TEXT'], ['port_router', 'TEXT'], ['vlan', 'INTEGER'], ['router_self', 'TEXT']] as const)
    if (!db.prepare('PRAGMA table_info(devices)').all().some((x) => x.name === c)) db.exec(`ALTER TABLE devices ADD COLUMN ${c} ${t}`)
  const setting = <T>(k: string, fallback: T): T => {
    const r = db.prepare('SELECT v FROM settings WHERE k = ?').get(k) as { v: string } | undefined
    return r ? (JSON.parse(r.v) as T) : fallback
  }
  const save = (k: string, v: unknown) => db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v))
  const wk = `device_watch:${site}`
  const watchSettings = () => ({ custom: [], off: [], on: [], ...setting<{ custom?: string[]; off?: string[]; on?: string[] }>(wk, {}) }) as { custom: string[]; off: string[]; on: string[] }

  const parse = (r: Row): Device => ({ ...r, random_mac: !!r.random_mac, static: !!r.static, want_dns: !!r.want_dns, dns: JSON.parse(r.dns) as string[] })
  const all = () => (db.prepare('SELECT * FROM devices WHERE site = ? ORDER BY id').all(site) as unknown as Row[]).map(parse)
  const get = (id: number) => { const r = db.prepare('SELECT * FROM devices WHERE id = ? AND site = ?').get(id, site) as unknown as Row | undefined; return r && parse(r) }

  let names = new Map<string, string>()
  function index() {
    const m = new Map<string, string>()
    // Older addresses first, so the device holding an address now wins.
    for (const r of db.prepare('SELECT i.ip, d.id FROM device_ips i JOIN devices d ON d.id = i.device WHERE d.site = ? ORDER BY i.last').all(site) as { ip: string; id: number }[]) {
      const d = byId.get(r.id)
      if (d && shown(d)) m.set(r.ip, shown(d))
    }
    for (const d of byId.values()) if (d.ip && shown(d)) m.set(d.ip, shown(d))
    names = m
  }
  /** Fold one device into another: its addresses, alerts and name move over, and the earliest first sighting stays. */
  function merge(from: number, into: number) {
    if (from === into) return
    const a = db.prepare('SELECT name, want_dns, first_seen, last_seen FROM devices WHERE id = ?').get(from) as { name: string; want_dns: number; first_seen: string; last_seen: string } | undefined
    if (!a) return
    db.prepare(`INSERT INTO device_ips (device, ip, first, last) SELECT ?, ip, first, last FROM device_ips WHERE device = ?
      ON CONFLICT (device, ip) DO UPDATE SET first = min(first, excluded.first), last = max(last, excluded.last)`).run(into, from)
    db.prepare('DELETE FROM device_ips WHERE device = ?').run(from)
    db.prepare('UPDATE device_events SET device = ? WHERE device = ?').run(into, from)
    db.prepare(`UPDATE devices SET name = CASE WHEN name = '' THEN ? ELSE name END, want_dns = CASE WHEN name = '' AND ? != '' THEN ? ELSE want_dns END,
      first_seen = min(first_seen, ?), last_seen = max(last_seen, ?) WHERE id = ?`).run(a.name, a.name, a.want_dns, a.first_seen, a.last_seen, into)
    db.prepare('DELETE FROM devices WHERE id = ?').run(from)
  }
  // Devices left with no MAC and no address, from before addresses were merged: fold each into whoever holds its last address now.
  {
    const blanks = db.prepare('SELECT id FROM devices WHERE site = ? AND mac IS NULL AND ip IS NULL').all(site) as { id: number }[]
    for (const { id } of blanks) {
      const holder = db.prepare(`SELECT d.id FROM device_ips i JOIN devices d ON d.ip = i.ip AND d.site = ? AND d.id != ? WHERE i.device = ? ORDER BY i.last DESC LIMIT 1`).get(site, id, id) as { id: number } | undefined
      if (holder) merge(id, holder.id)
    }
  }
  // Multicast and broadcast MACs were never devices.
  for (const { id, mac } of db.prepare("SELECT id, mac FROM devices WHERE site = ? AND mac IS NOT NULL AND name = ''").all(site) as { id: number; mac: string }[]) {
    if (deviceMac(mac)) continue
    for (const t of ['device_events', 'device_ips']) db.prepare(`DELETE FROM ${t} WHERE device = ?`).run(id)
    db.prepare('DELETE FROM devices WHERE id = ?').run(id)
  }
  // Clear out addresses that were wrongly made devices: nothing a person or a router said about them is lost.
  {
    const junk = (db.prepare("SELECT id, ip FROM devices WHERE site = ? AND mac IS NULL AND name = '' AND router_name = ''").all(site) as { id: number; ip: string | null }[])
      .filter((d) => !d.ip || !deviceAddress(d.ip, internal)).map((d) => d.id)
    for (const id of junk) for (const t of ['device_events', 'device_ips']) db.prepare(`DELETE FROM ${t} WHERE device = ?`).run(id)
    for (const id of junk) db.prepare('DELETE FROM devices WHERE id = ?').run(id)
  }
  let ports: Port[] = setting<Port[]>(`device_ports:${site}`, [])
  let byId = new Map<number, Device>()
  const reload = () => { byId = new Map(all().map((d) => [d.id, d])); index() }
  reload()

  const nk = `device_nets:${site}`
  /** Networks the routers hand out addresses on, remembered from the last look so they survive a restart. */
  function networks(facts?: Pick<Fact, 'source' | 'ip' | 'interface'>[]): Network[] {
    const w = watchSettings()
    // Kept once found, so a quiet network doesn't drop off the list.
    const auto = new Map<string, string | null>(setting<[string, string | null][]>(nk, []))
    if (facts?.some((f) => f.source === 'dhcp')) {
      for (const f of facts) if (f.source === 'dhcp' && f.ip && isIPv4(f.ip) && isInternal(f.ip, internal)) auto.set(slash24(f.ip), f.interface)
      save(nk, [...auto])
    }
    // A guest network is off until someone turns it on; every other one is on until someone turns it off.
    const out: Network[] = [...auto].map(([cidr, server]) => ({ cidr, server, auto: true, watched: guest.test(server ?? '') ? w.on.includes(cidr) : !w.off.includes(cidr) }))
    for (const c of w.custom) if (!auto.has(c)) out.push({ cidr: c, server: null, auto: false, watched: true })
    return out.sort((a, b) => a.cidr.localeCompare(b.cidr, undefined, { numeric: true }))
  }
  const watchList = (nets: Network[]) => { try { return parseNetworks(nets.filter((n) => n.watched).map((n) => n.cidr).join(',')) } catch { return new BlockList() } }

  /**
   * Fold what the routers and the sensor saw into devices. A device is found by its MAC, then (for a phone that
   * changed its random MAC) by the name it gives itself, then by its address.
   */
  function refresh(facts: Fact[], traffic: { ip: string; last: string }[] = [], now = new Date()) {
    const at = now.toISOString()
    const first = !(db.prepare('SELECT 1 FROM devices WHERE site = ? LIMIT 1').get(site))
    const nets = networks(facts)
    const watched = watchList(nets)
    const created: number[] = []
    const dnsFor = new Map<string, string[]>()
    for (const f of facts) if (f.source === 'dns' && f.ip) dnsFor.set(f.ip, [...(dnsFor.get(f.ip) ?? []), ...f.dns])
    // Every switch learns every MAC on its uplinks too, so a device's port is the one carrying the fewest MACs.
    const bridges = facts.filter((f) => f.source === 'bridge' && f.mac && f.interface)
    const perPort = new Map<string, Set<string>>()
    for (const f of bridges) { const k = `${f.router}|${f.interface}`; perPort.set(k, (perPort.get(k) ?? new Set()).add(f.mac!)) }
    const edge = new Map<string, Fact>()
    for (const f of bridges) {
      const best = edge.get(f.mac!)
      if (!best || perPort.get(`${f.router}|${f.interface}`)!.size < perPort.get(`${best.router}|${best.interface}`)!.size) edge.set(f.mac!, f)
    }
    if (bridges.length) ports = [...perPort].map(([k, m]) => { const [router, port] = k.split('|') as [string, string]; return { router, port, macs: m.size, shared: m.size > 2 } })
      .sort((a, b) => a.router.localeCompare(b.router) || a.port.localeCompare(b.port, undefined, { numeric: true }))

    const find = {
      mac: (mac: string) => db.prepare('SELECT id FROM devices WHERE site = ? AND mac = ?').get(site, mac) as { id: number } | undefined,
      // Only devices that could have changed their MAC: random ones, or ones we only know by address.
      host: (h: string) => db.prepare('SELECT id FROM devices WHERE site = ? AND hostname = ? COLLATE NOCASE AND (random_mac = 1 OR mac IS NULL) ORDER BY last_seen DESC LIMIT 1').get(site, h) as { id: number } | undefined,
      ip: (ip: string, macless: boolean) => db.prepare(`SELECT id FROM devices WHERE site = ? AND ip = ? ${macless ? 'AND mac IS NULL' : ''} ORDER BY last_seen DESC LIMIT 1`).get(site, ip) as { id: number } | undefined,
    }
    const make = (ip: string | null) => {
      const id = Number(db.prepare('INSERT INTO devices (site, ip, first_seen, last_seen) VALUES (?, ?, ?, ?)').run(site, ip, at, at).lastInsertRowid)
      created.push(id)
      return id
    }
    const seenAt = (ip: string | null, id: number, when: string) => {
      if (!ip) return
      // An address belongs to one device at a time. A device known only by this address was this one all along.
      for (const o of db.prepare('SELECT id, mac FROM devices WHERE site = ? AND ip = ? AND id != ?').all(site, ip, id) as { id: number; mac: string | null }[]) {
        if (o.mac === null) merge(o.id, id)
        else db.prepare('UPDATE devices SET ip = NULL WHERE id = ?').run(o.id)
      }
      db.prepare('INSERT INTO device_ips (device, ip, first, last) VALUES (?, ?, ?, ?) ON CONFLICT (device, ip) DO UPDATE SET last = max(last, excluded.last)').run(id, ip, when, when)
    }

    db.exec('BEGIN')
    try {
      // Each router's own MACs and addresses become one device for that router, absorbing any strays made from them before.
      const selfMacs = new Set<string>()
      const selfIps = new Set<string>()
      const own = facts.filter((f) => f.source === 'self')
      for (const router of new Set(own.map((f) => f.router))) {
        const fs = own.filter((f) => f.router === router)
        const macs = [...new Set(fs.map((f) => f.mac).filter((m): m is string => !!m && deviceMac(m)))]
        const ips = [...new Set(fs.map((f) => f.ip).filter((i): i is string => !!i && deviceAddress(i, internal)))]
        macs.forEach((m) => selfMacs.add(m))
        ips.forEach((i) => selfIps.add(i))
        const holders = [...new Set([
          ...macs.map((m) => find.mac(m)?.id), ...ips.flatMap((i) => (db.prepare('SELECT id FROM devices WHERE site = ? AND ip = ?').all(site, i) as { id: number }[]).map((x) => x.id)),
        ].filter((x): x is number => x !== undefined))]
        const mine = db.prepare('SELECT id FROM devices WHERE site = ? AND router_self = ?').get(site, router) as { id: number } | undefined
        const named = holders.find((h) => (db.prepare('SELECT name FROM devices WHERE id = ?').get(h) as { name: string }).name)
        // Not through make(): a router is never a "new device" alert.
        const id = mine?.id ?? named ?? holders[0] ?? Number(db.prepare('INSERT INTO devices (site, first_seen, last_seen) VALUES (?, ?, ?)').run(site, at, at).lastInsertRowid)
        for (const h of holders) merge(h, id)
        db.prepare('UPDATE devices SET mac = NULL WHERE site = ? AND id != ? AND mac IN (SELECT value FROM json_each(?))').run(site, id, JSON.stringify(macs))
        const main = fs.find((f) => f.mac && /^bridge/i.test(f.interface ?? '')) ?? fs.find((f) => f.mac)
        const ip = fs.find((f) => f.ip && selfIps.has(f.ip) && /^(bridge|vlan)/i.test(f.interface ?? ''))?.ip ?? ips[0] ?? null
        db.prepare(`UPDATE devices SET router_self = ?, mac = coalesce(?, mac), random_mac = 0, hostname = ?, ip = coalesce(?, ip), router = ?, last_seen = ? WHERE id = ?`)
          .run(router, main?.mac && deviceMac(main.mac) ? main.mac : macs[0] ?? null, fs[0]!.hostname ?? router, ip, router, at, id)
        for (const i of ips) seenAt(i, id, at)
        if (ip) db.prepare('UPDATE devices SET ip = ? WHERE id = ?').run(ip, id)
      }
      const byMac = new Map<string, Fact[]>()
      for (const f of facts) if (f.mac && f.source !== 'dns' && f.source !== 'self' && deviceMac(f.mac) && !selfMacs.has(f.mac)) byMac.set(f.mac, [...(byMac.get(f.mac) ?? []), f])
      const done = new Set<string>(selfIps)
      const claimed = new Set<number>()
      for (const [mac, fs] of byMac) {
        const lease = fs.find((f) => f.source === 'dhcp')
        const neighbor = fs.find((f) => f.source === 'neighbor')
        const at_ = edge.get(mac)
        const ip = lease?.ip ?? fs.find((f) => f.ip)?.ip ?? null
        const hostname = lease?.hostname ?? neighbor?.hostname ?? null
        const byHost = find.mac(mac) ? undefined : hostname ? find.host(hostname)?.id : undefined
        // The old lease of a phone that just changed its MAC: the device is already accounted for.
        if (byHost !== undefined && claimed.has(byHost)) continue
        const id = find.mac(mac)?.id ?? byHost ?? (ip ? find.ip(ip, true)?.id : undefined) ?? make(ip)
        claimed.add(id)
        const old = db.prepare('SELECT name, router_name FROM devices WHERE id = ?').get(id) as { name: string; router_name: string }
        const routerName = lease?.comment ?? ''
        // A rename on the router is newer than ours, so it takes over: two-way, newest wins.
        const name = routerName && routerName !== old.router_name && routerName !== old.name ? '' : old.name
        const when = fs.filter((f) => f.source !== 'bridge').map((f) => f.seen).filter(Boolean).sort().at(-1) ?? at
        db.prepare(`UPDATE devices SET mac = ?, random_mac = ?, hostname = coalesce(?, hostname), ip = coalesce(?, ip), name = ?, router_name = ?, router = ?, interface = coalesce(?, interface),
          dns = ?, static = ?, last_seen = max(last_seen, ?) WHERE id = ?`)
          .run(mac, fs[0]!.random_mac ? 1 : 0, hostname, ip, name, routerName, (lease ?? fs[0]!).router, lease?.interface ?? fs.find((f) => f.source === 'arp')?.interface ?? null, JSON.stringify(ip ? dnsFor.get(ip) ?? [] : []), lease?.static ? 1 : 0, when, id)
        if (at_) db.prepare('UPDATE devices SET port = ?, port_router = ?, vlan = ? WHERE id = ?').run(at_.interface, at_.router, at_.vlan ?? null, id)
        seenAt(ip, id, when)
        if (ip) done.add(ip)
      }
      // Addresses only DNS or traffic know about: a fixed address, a VPN client, a device behind another router.
      const rest = new Map<string, string>()
      for (const ip of dnsFor.keys()) rest.set(ip, at)
      for (const t of traffic) rest.set(t.ip, t.last)
      for (const [ip, when] of rest) {
        if (done.has(ip) || !deviceAddress(ip, internal)) continue
        const id = find.ip(ip, false)?.id ?? make(ip)
        db.prepare('UPDATE devices SET ip = ?, dns = CASE WHEN mac IS NULL THEN ? ELSE dns END, last_seen = max(last_seen, ?) WHERE id = ?').run(ip, JSON.stringify(dnsFor.get(ip) ?? []), when, id)
        seenAt(ip, id, when)
      }
      // A device seen for the first time on a watched network is worth a look, unless it is the very first look of all,
      // or a phone or laptop making up its MAC, which would cry wolf.
      if (!first) {
        for (const id of created) {
          const d = db.prepare('SELECT ip, random_mac FROM devices WHERE id = ?').get(id) as { ip: string | null; random_mac: number } | undefined
          if (d?.ip && isIPv4(d.ip) && watched.check(d.ip, 'ipv4') && !d.random_mac) db.prepare("INSERT INTO device_events (device, kind, at) VALUES (?, 'new', ?)").run(id, at)
        }
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    if (bridges.length) save(`device_ports:${site}`, ports)
    reload()
    return { created: created.length }
  }

  return {
    refresh, networks, get,
    ports: () => ports,
    names: () => Object.fromEntries(names),
    /** The best name for an address, now or in the past. */
    name: (ip: string) => names.get(ip) ?? '',
    byIp: (ip: string) => [...byId.values()].find((d) => d.ip === ip) ?? (() => {
      const r = db.prepare('SELECT i.device FROM device_ips i JOIN devices d ON d.id = i.device WHERE d.site = ? AND i.ip = ? ORDER BY i.last DESC LIMIT 1').get(site, ip) as { device: number } | undefined
      return r ? byId.get(r.device) : undefined
    })(),
    list(now = Date.now()) {
      const open = new Set((db.prepare('SELECT device FROM device_events WHERE ack_at IS NULL').all() as { device: number }[]).map((e) => e.device))
      return [...byId.values()].map((d) => ({ ...d, shown: shown(d), isNew: now - Date.parse(d.first_seen) < day, alert: open.has(d.id),
        ips: (db.prepare('SELECT ip, first, last FROM device_ips WHERE device = ? ORDER BY last DESC LIMIT 20').all(d.id) as { ip: string; first: string; last: string }[]) }))
    },
    /** Name a device here. An address nobody knows yet becomes a device. */
    rename(target: { id: number } | { ip: string }, name: string, wantDns: boolean): Device | undefined {
      let id = 'id' in target ? get(target.id)?.id : [...byId.values()].find((d) => d.ip === target.ip)?.id
      if (id === undefined && 'ip' in target) {
        if (!deviceAddress(target.ip, internal)) return undefined
        const at = new Date().toISOString()
        id = Number(db.prepare('INSERT INTO devices (site, ip, first_seen, last_seen) VALUES (?, ?, ?, ?)').run(site, target.ip, at, at).lastInsertRowid)
        db.prepare('INSERT OR IGNORE INTO device_ips (device, ip, first, last) VALUES (?, ?, ?, ?)').run(id, target.ip, at, at)
      }
      if (id === undefined) return undefined
      db.prepare('UPDATE devices SET name = ?, want_dns = ? WHERE id = ?').run(name.trim(), wantDns ? 1 : 0, id)
      reload()
      return byId.get(id)
    },
    events: () => db.prepare(`SELECT e.* FROM device_events e JOIN devices d ON d.id = e.device WHERE d.site = ? AND e.ack_at IS NULL ORDER BY e.id DESC LIMIT 200`).all(site) as unknown as DeviceEvent[],
    ack: (device: number, user: string) => Number(db.prepare('UPDATE device_events SET ack_at = ?, ack_by = ? WHERE device = ? AND ack_at IS NULL').run(new Date().toISOString(), user, device).changes) > 0,
    /** Turn a found network on or off, or add and remove ranges of your own. */
    watch(cidr: string, on: boolean) {
      parseNetworks(cidr)
      const w = watchSettings()
      const auto = networks().find((n) => n.auto && n.cidr === cidr)
      const strip = (l: string[], x: string) => l.filter((v) => v !== x)
      w.off = strip(w.off, cidr)
      w.on = strip(w.on, cidr)
      w.custom = strip(w.custom, cidr)
      if (auto) (on ? w.on : w.off).push(cidr)
      else if (on) w.custom.push(cidr)
      save(wk, w)
      return networks()
    },
  }
}
export type Devices = ReturnType<typeof openDevices>
