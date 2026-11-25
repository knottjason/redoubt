import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** Something Redoubt wants to be true on a device. Redoubt always sends the whole list; the plugin makes it so. */
export type Entry = { id: string; kind: Kind; sid?: number; machine?: string; remote?: string; label: string }
export const kinds = ['rule.disable', 'rule.enable', 'rule.silence', 'block.pair', 'block.remote'] as const
export type Kind = (typeof kinds)[number]

export type Describe = { name: string; version: string; kinds: Kind[]; rules: boolean; devices?: boolean }
export type ApplyRequest = { instance: string; revision: number; entries: Entry[] }
export type ApplyReply = { results: { id: string; ok: boolean; error?: string }[] }
export type ListReply = { instance: string; revision: number; ids: string[]; healthy: boolean; message: string }
export type RulesRequest = { find: string; state: 'all' | 'on' | 'off'; offset: number; limit: number }
export type RuleRow = { sid: number; msg: string; classtype: string; group: string; severity: number; on: boolean }
export type RulesReply = { total: number; on: number; off: number; rows: RuleRow[] }


/** One thing one source on one router says about a device. Plugins report what they see; Redoubt decides which facts are the same device. */
export type Fact = {
  router: string
  /** `bridge`: a switch's MAC table, so `interface` is the port. `neighbor`: LLDP/MNDP/CDP, so `hostname` is what the neighbour calls itself. */
  source: 'dhcp' | 'arp' | 'dns' | 'bridge' | 'neighbor'
  /** Opaque handle for this record on that router. Not stable across routers. */
  ref: string
  /** Changes whenever anything below changes, so a rename on the router is noticed. */
  hash: string
  mac: string | null
  /** The address was made up by the device (locally administered), so it is a poor identity. */
  random_mac: boolean
  ip: string | null
  /** The name a person gave it: the comment of a static lease. */
  comment: string | null
  /** The name the device gave itself. */
  hostname: string | null
  /** Static DNS names that point at this address. */
  dns: string[]
  /** It has a fixed lease. */
  static: boolean
  interface: string | null
  /** The VLAN it was seen on, for a `bridge` fact. */
  vlan?: number | null
  seen: string | null
}
export type DevicesReply = { facts: Fact[]; errors: { router: string; error: string }[] }

export const prefix = '/redoubt/v1/'
const mac = (key: string, parts: string[]) => createHmac('sha256', key).update(parts.join('\n')).digest('hex')
const hash = (body: string) => createHash('sha256').update(body).digest('hex')
export const signRequest = (key: string, time: string, nonce: string, path: string, body: string) => mac(key, ['request', time, nonce, path, hash(body)])
// A reply is tied to the nonce of its request, so an old reply can't be played back.
export const signReply = (key: string, nonce: string, status: number, body: string) => mac(key, ['reply', nonce, String(status), hash(body)])
export function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
