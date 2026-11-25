import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isIPv4, type BlockList } from 'node:net'
import { join } from 'node:path'
import { isInternal } from '../../src/shared/net.ts'
import type { Entry, Fact } from '../../src/shared/plugin.ts'
import type { Plugin } from '../lib/serve.ts'
import type { Item, Rest } from './router.ts'

export const list = 'redoubt_block'
export const chain = 'redoubt'
const mark = 'redoubt entry'
const maxEntries = 500

/** Put there once by a person. Every one is tied to the internet side, so nothing this plugin adds can touch traffic inside the network. */
export const scaffold: { path: string; item: Item }[] = [
  { path: 'ip/firewall/raw', item: { chain: 'prerouting', action: 'drop', 'in-interface-list': 'WAN', 'src-address-list': list } },
  { path: 'ip/firewall/filter', item: { chain: 'forward', action: 'drop', 'out-interface-list': 'WAN', 'dst-address-list': list } },
  { path: 'ip/firewall/filter', item: { chain: 'forward', action: 'jump', 'out-interface-list': 'WAN', 'jump-target': chain } },
]

type Wanted = { path: string; key: string; item: Item }
export function wanted(e: Entry): Wanted {
  return e.kind === 'block.remote'
    ? { path: 'ip/firewall/address-list', key: `remote ${e.remote}`, item: { list, address: e.remote!, comment: mark } }
    : { path: 'ip/firewall/filter', key: `pair ${e.machine} ${e.remote}`, item: { chain, action: 'drop', 'src-address': e.machine!, 'dst-address': e.remote!, comment: mark } }
}
export function problem(e: Entry, own: BlockList, never: BlockList): string | undefined {
  if (!isIPv4(e.remote ?? '')) return 'Only IPv4 addresses can be blocked'
  if (isInternal(e.remote!, own)) return 'Internal addresses are never blocked'
  if (e.kind === 'block.remote' && never.check(e.remote!, 'ipv4')) return 'That address is on the never-block list'
  if (e.kind === 'block.pair' && (!isIPv4(e.machine ?? '') || !isInternal(e.machine!, own))) return 'That is not one of your machines'
}
const host = (s = '') => s.replace(/:\d+$/, '')

/** `read` and `write` are separate logins; blocking needs both, listing devices only ever uses `read`. */
export function mikrotik(o: { routers: { name: string; read: Rest }[]; block?: { read: Rest; write: Rest }; own: BlockList; never: BlockList; stateDir: string }): Plugin {
  const file = join(o.stateDir, 'entries.json')
  const last = (): Entry[] => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Entry[]) : [])
  let trouble = ''

  async function inPlace(r: Rest): Promise<Map<string, { path: string; id: string }>> {
    const [addresses, rules] = await Promise.all([r.get(`ip/firewall/address-list?list=${list}`), r.get(`ip/firewall/filter?chain=${chain}`)])
    const at = new Map<string, { path: string; id: string }>()
    for (const a of addresses) if (a.comment === mark && a.disabled !== 'true' && a.dynamic !== 'true') at.set(`remote ${a.address}`, { path: 'ip/firewall/address-list', id: a['.id']! })
    for (const f of rules) if (f.comment === mark && f.disabled !== 'true' && f.action === 'drop') at.set(`pair ${f['src-address']} ${f['dst-address']}`, { path: 'ip/firewall/filter', id: f['.id']! })
    return at
  }
  async function ready(r: Rest) {
    const have = { 'ip/firewall/raw': await r.get('ip/firewall/raw'), 'ip/firewall/filter': await r.get('ip/firewall/filter') } as Record<string, Item[]>
    for (const s of scaffold) {
      const allowed = new Set([...Object.keys(s.item), '.id', 'comment', 'disabled', 'dynamic', 'invalid', 'bytes', 'packets', 'log', 'log-prefix'])
      const found = have[s.path]!.some((x) => x.disabled !== 'true' && Object.entries(s.item).every(([k, v]) => x[k] === v) && Object.keys(x).every((k) => allowed.has(k)))
      if (!found) throw new Error(`The router is not set up: ${s.item.chain} ${s.item.action} for ${s.item['jump-target'] ?? list} is missing or changed`)
    }
  }
  async function cut(b: { read: Rest; write: Rest }, entries: Entry[]) {
    if (!entries.length) return
    for (const c of await b.read.get('ip/firewall/connection?.proplist=.id,src-address,dst-address')) {
      const [s, d] = [host(c['src-address']), host(c['dst-address'])]
      if (entries.some((e) => e.kind === 'block.pair' ? s === e.machine && d === e.remote : s === e.remote || d === e.remote)) await b.write.remove('ip/firewall/connection', c['.id']!)
    }
  }

  return {
    describe: { name: 'MikroTik', version: '0.1.0', kinds: o.block ? ['block.pair', 'block.remote'] : [], rules: false, devices: true },
    async apply(entries) {
      if (!o.block) return { results: entries.map((e) => ({ id: e.id, ok: false, error: 'Blocking is not set up' })) }
      if (entries.length > maxEntries) throw new Error(`More than ${maxEntries} blocks; refusing`)
      const errors = new Map(entries.map((e) => [e.id, problem(e, o.own, o.never)] as const))
      const good = entries.filter((e) => !errors.get(e.id))
      try {
        if (good.length) await ready(o.block.read)
        const at = await inPlace(o.block.read)
        const want = new Map(good.map((e) => [wanted(e).key, wanted(e)] as const))
        for (const [key, x] of at) if (!want.has(key)) await o.block.write.remove(x.path, x.id)
        for (const [key, w] of want) if (!at.has(key)) await o.block.write.add(w.path, w.item)
        // Established connections skip the firewall on their fast path, so end them.
        await cut(o.block, good.filter((e) => !at.has(wanted(e).key)))
        const now = await inPlace(o.block.read)
        for (const e of good) if (!now.has(wanted(e).key)) errors.set(e.id, 'The router did not keep it')
        writeFileSync(`${file}.new`, JSON.stringify(entries), { mode: 0o600 })
        renameSync(`${file}.new`, file)
        trouble = ''
      } catch (e) {
        trouble = (e as Error).message
        throw e
      }
      return { results: entries.map((e) => { const error = errors.get(e.id); return error ? { id: e.id, ok: false, error } : { id: e.id, ok: true } }) }
    },
    async present() {
      if (!o.block) return []
      const at = await inPlace(o.block.read)
      return last().filter((e) => e.remote && at.has(wanted(e).key)).map((e) => e.id)
    },
    async health() {
      if (o.block && !trouble) {
        try { await ready(o.block.read) } catch (e) { return { healthy: false, message: (e as Error).message.slice(0, 300) } }
      }
      return { healthy: !trouble, message: trouble || (o.block ? 'Ready to block' : 'Devices only') }
    },
    async devices() {
      const facts: Fact[] = []
      const errors: { router: string; error: string }[] = []
      await Promise.all(o.routers.map(async ({ name, read }) => {
        const missing: string[] = []
        try { facts.push(...(await look(name, read, Date.now(), missing))) } catch (e) { errors.push({ router: name, error: (e as Error).message.slice(0, 200) }) }
        for (const m of missing) errors.push({ router: name, error: m.slice(0, 200) })
      }))
      return { facts, errors }
    },
  }
}

export function seconds(s = ''): number | null {
  if (!s || s === 'never') return null
  const unit: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 }
  let n = 0
  for (const m of s.matchAll(/(\d+)([wdhms])(?!s)/g)) n += Number(m[1]) * unit[m[2]!]!
  return n
}
const mac = (s?: string) => (s && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(s) ? s.toUpperCase() : null)
const clean = (s?: string) => (s ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) || null : null)

/** `trouble` collects sources that exist but could not be read (a login missing a policy, say), without failing the rest. */
export async function look(router: string, r: Rest, now = Date.now(), trouble: string[] = []): Promise<Fact[]> {
  // A router without a bridge or neighbour discovery just has none of those; anything else is worth saying.
  const maybe = (path: string) => r.get(path).catch((e: Error) => {
    if (!/no such command|not found|\b404\b/i.test(e.message)) trouble.push(`${path}: ${e.message}`)
    return [] as Item[]
  })
  const [leases, arps, dns, hosts, neighbors] = await Promise.all([r.get('ip/dhcp-server/lease'), r.get('ip/arp'), r.get('ip/dns/static'), maybe('interface/bridge/host'), maybe('ip/neighbor')])
  const make = (source: Fact['source'], ref: string, f: Partial<Fact>): Fact => {
    const m = f.mac ?? null
    const x = { router, source, ref, mac: m, random_mac: m ? (parseInt(m.slice(0, 2), 16) & 2) === 2 : false, ip: null, comment: null, hostname: null, dns: [], static: false, interface: null, ...f }
    const { seen: _seen, ...stable } = { seen: null, ...x }
    return { ...x, seen: f.seen ?? null, hash: createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16) }
  }
  const seen = (s?: string) => { const n = seconds(s); return n === null ? null : new Date(now - n * 1000).toISOString() }
  const out: Fact[] = []
  for (const l of leases) {
    if (l.disabled === 'true') continue
    const fixed = l.dynamic !== 'true'
    out.push(make('dhcp', l['.id']!, { mac: mac(l['active-mac-address'] ?? l['mac-address']), ip: l['active-address'] ?? l.address ?? null, comment: clean(l.comment), hostname: clean(l['host-name']), static: fixed, interface: l['active-server'] ?? l.server ?? null, seen: seen(l['last-seen']) }))
  }
  for (const a of arps) if (a.disabled !== 'true' && mac(a['mac-address'])) out.push(make('arp', a['.id']!, { mac: mac(a['mac-address']), ip: a.address ?? null, interface: a.interface ?? null, comment: clean(a.comment), seen: a.status === 'reachable' ? new Date(now).toISOString() : null }))
  for (const d of dns) if (d.disabled !== 'true' && d.dynamic !== 'true' && (d.type ?? 'A') === 'A' && d.address && d.name) out.push(make('dns', d['.id']!, { ip: d.address, dns: [clean(d.name)!], comment: clean(d.comment) }))
  for (const h of hosts) {
    if (h.local === 'true' || h.invalid === 'true' || h.external === 'true' || h.disabled === 'true' || !mac(h['mac-address'])) continue
    const vid = Number(h.vid)
    out.push(make('bridge', h['.id']!, { mac: mac(h['mac-address']), interface: h['on-interface'] ?? h.interface ?? null, vlan: Number.isInteger(vid) && vid > 0 ? vid : null, seen: new Date(now).toISOString() }))
  }
  for (const n of neighbors) {
    if (!mac(n['mac-address'])) continue
    const what = [n.platform, n.board].map((x) => clean(x)).filter(Boolean).join(' ')
    out.push(make('neighbor', n['.id']!, { mac: mac(n['mac-address']), ip: n.address && /^[\d.]+$/.test(n.address) ? n.address : null, interface: clean(n.interface?.split(',')[0]), hostname: clean(n.identity), comment: what || null }))
  }
  return out
}
