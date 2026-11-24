import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** Something Redoubt wants to be true on a device. Redoubt always sends the whole list; the plugin makes it so. */
export type Entry = { id: string; kind: Kind; sid?: number; machine?: string; remote?: string; label: string }
export const kinds = ['rule.disable', 'rule.enable', 'rule.silence', 'block.pair', 'block.remote'] as const
export type Kind = (typeof kinds)[number]

export type Describe = { name: string; version: string; kinds: Kind[]; rules: boolean }
export type ApplyRequest = { instance: string; revision: number; entries: Entry[] }
export type ApplyReply = { results: { id: string; ok: boolean; error?: string }[] }
export type ListReply = { instance: string; revision: number; ids: string[]; healthy: boolean; message: string }
export type RulesRequest = { find: string; state: 'all' | 'on' | 'off'; offset: number; limit: number }
export type RuleRow = { sid: number; msg: string; classtype: string; group: string; severity: number; on: boolean }
export type RulesReply = { total: number; on: number; off: number; rows: RuleRow[] }

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
