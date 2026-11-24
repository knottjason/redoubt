import { BlockList, isIPv4 } from 'node:net'
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
  first_seen: string; last_seen: string
}
export type DeviceEvent = { id: number; device: number; kind: 'new'; at: string; ack_at: string | null; ack_by: string | null }
/** A network the routers hand out addresses on. Watched networks raise an alert when a device never seen before turns up. */
export type Network = { cidr: string; server: string | null; auto: boolean; watched: boolean }
type Row = Omit<Device, 'random_mac' | 'dns' | 'static' | 'want_dns'> & { random_mac: number; dns: string; static: number; want_dns: number }

const day = 86_400_000
const slash24 = (ip: string) => `${ip.split('.').slice(0, 3).join('.')}.0/24`
const guest = /guest/i

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
      // An address belongs to one device at a time.
      db.prepare('UPDATE devices SET ip = NULL WHERE site = ? AND ip = ? AND id != ?').run(site, ip, id)
      db.prepare('INSERT INTO device_ips (device, ip, first, last) VALUES (?, ?, ?, ?) ON CONFLICT (device, ip) DO UPDATE SET last = max(last, excluded.last)').run(id, ip, when, when)
    }

    db.exec('BEGIN')
    try {
      const byMac = new Map<string, Fact[]>()
      for (const f of facts) if (f.mac && f.source !== 'dns') byMac.set(f.mac, [...(byMac.get(f.mac) ?? []), f])
      const done = new Set<string>()
      const claimed = new Set<number>()
      for (const [mac, fs] of byMac) {
        const lease = fs.find((f) => f.source === 'dhcp')
        const ip = lease?.ip ?? fs.find((f) => f.ip)?.ip ?? null
        const hostname = lease?.hostname ?? null
        const byHost = find.mac(mac) ? undefined : hostname ? find.host(hostname)?.id : undefined
        // The old lease of a phone that just changed its MAC: the device is already accounted for.
        if (byHost !== undefined && claimed.has(byHost)) continue
        const id = find.mac(mac)?.id ?? byHost ?? (ip ? find.ip(ip, true)?.id : undefined) ?? make(ip)
        claimed.add(id)
        const old = db.prepare('SELECT name, router_name FROM devices WHERE id = ?').get(id) as { name: string; router_name: string }
        const routerName = lease?.comment ?? ''
        // A rename on the router is newer than ours, so it takes over: two-way, newest wins.
        const name = routerName && routerName !== old.router_name && routerName !== old.name ? '' : old.name
        const when = fs.map((f) => f.seen).filter(Boolean).sort().at(-1) ?? at
        db.prepare(`UPDATE devices SET mac = ?, random_mac = ?, hostname = coalesce(?, hostname), ip = coalesce(?, ip), name = ?, router_name = ?, router = ?, interface = coalesce(?, interface),
          dns = ?, static = ?, last_seen = max(last_seen, ?) WHERE id = ?`)
          .run(mac, fs[0]!.random_mac ? 1 : 0, hostname, ip, name, routerName, (lease ?? fs[0]!).router, lease?.interface ?? fs[0]!.interface, JSON.stringify(ip ? dnsFor.get(ip) ?? [] : []), lease?.static ? 1 : 0, when, id)
        seenAt(ip, id, when)
        if (ip) done.add(ip)
      }
      // Addresses only DNS or traffic know about: a fixed address, a VPN client, a device behind another router.
      const rest = new Map<string, string>()
      for (const ip of dnsFor.keys()) rest.set(ip, at)
      for (const t of traffic) rest.set(t.ip, t.last)
      for (const [ip, when] of rest) {
        if (done.has(ip) || !isInternal(ip, internal)) continue
        const id = find.ip(ip, false)?.id ?? make(ip)
        db.prepare('UPDATE devices SET ip = ?, dns = CASE WHEN mac IS NULL THEN ? ELSE dns END, last_seen = max(last_seen, ?) WHERE id = ?').run(ip, JSON.stringify(dnsFor.get(ip) ?? []), when, id)
        seenAt(ip, id, when)
      }
      // A device seen for the first time on a watched network is worth a look, unless it is the very first look of all,
      // or a phone or laptop making up its MAC, which would cry wolf.
      if (!first) {
        for (const id of created) {
          const d = db.prepare('SELECT ip, random_mac FROM devices WHERE id = ?').get(id) as { ip: string | null; random_mac: number }
          if (d.ip && isIPv4(d.ip) && watched.check(d.ip, 'ipv4') && !d.random_mac) db.prepare("INSERT INTO device_events (device, kind, at) VALUES (?, 'new', ?)").run(id, at)
        }
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    reload()
    return { created: created.length }
  }

  return {
    refresh, networks, get,
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
        if (!isInternal(target.ip, internal)) return undefined
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
