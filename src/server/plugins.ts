import { randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { kinds, prefix, same, signReply, signRequest, type Entry, type Fact, type Kind, type RulesRequest } from '../shared/plugin.ts'
import type { Decision } from './decisions.ts'

export type State = 'requested' | 'active' | 'failed' | 'removing' | 'removed'
type PluginRow = { id: number; site: string; url: string; key: string; name: string; version: string; kinds: string; rules: number; devices: number; revision: number; dirty: number; tries: number; next_try: number; last_ok: string | null; error: string; message: string }
export type EntryRow = { id: string; plugin: number; decision: number; kind: Kind; sid: number; machine: string; remote: string; label: string; state: State; error: string }

const describe = z.object({ name: z.string().min(1).max(60), version: z.string().max(40), kinds: z.array(z.enum(kinds)), rules: z.boolean(), devices: z.boolean().default(false) })
const nul = z.string().max(200).nullable()
const devicesReply = z.object({
  facts: z.array(z.object({ router: z.string().max(60), source: z.enum(['dhcp', 'arp', 'dns', 'bridge', 'neighbor', 'self']), ref: z.string().max(60), hash: z.string().max(64), mac: nul, random_mac: z.boolean(), ip: nul, comment: nul, hostname: nul,
    dns: z.array(z.string().max(200)).max(50), static: z.boolean(), interface: nul, vlan: z.number().int().min(0).max(4095).nullable().optional(), seen: nul })).max(20_000),
  errors: z.array(z.object({ router: z.string(), error: z.string() })),
})
const applied = z.object({ results: z.array(z.object({ id: z.string(), ok: z.boolean(), error: z.string().max(400).optional() })) })
const listed = z.object({ instance: z.string(), revision: z.number(), ids: z.array(z.string()), healthy: z.boolean(), message: z.string().max(400) })
const ruleList = z.object({ total: z.number(), on: z.number(), off: z.number(), rows: z.array(z.object({ sid: z.number(), msg: z.string(), classtype: z.string(), group: z.string(), severity: z.number(), on: z.boolean() })) })

/** Every action is safe to repeat, so a connection that had gone stale (say, the plugin restarted) is worth one more try. */
export async function call<T>(p: { url: string; key: string }, action: string, body: unknown, shape: z.ZodType<T>, timeout = 15_000): Promise<T> {
  try {
    return await once(p, action, body, shape, timeout)
  } catch (e) {
    if (!(e instanceof TypeError && e.message === 'fetch failed')) throw e
    return once(p, action, body, shape, timeout)
  }
}
async function once<T>(p: { url: string; key: string }, action: string, body: unknown, shape: z.ZodType<T>, timeout: number): Promise<T> {
  const path = prefix + action
  const text = JSON.stringify(body)
  const time = String(Date.now())
  const nonce = randomBytes(16).toString('hex')
  const r = await fetch(new URL(path, p.url), {
    method: 'POST', body: text, redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: { 'content-type': 'application/json', 'x-redoubt-time': time, 'x-redoubt-nonce': nonce, 'x-redoubt-signature': signRequest(p.key, time, nonce, path, text) },
  })
  const out = await r.text()
  if (r.status === 401) throw new Error('The plugin refused the key')
  if (!same(r.headers.get('x-redoubt-signature') ?? '', signReply(p.key, nonce, r.status, out))) throw new Error('The reply was not signed with the shared key')
  const json: unknown = JSON.parse(out)
  if (!r.ok) throw new Error(String((json as { error?: unknown }).error ?? r.status))
  return shape.parse(json)
}

/** What a decision asks of a device, if anything. */
export function wants(d: Pick<Decision, 'action' | 'sid' | 'machine' | 'remote' | 'signature'>, direction: 'in' | 'out'): Omit<Entry, 'id'> | undefined {
  const label = d.signature
  switch (d.action) {
    case 'rule_off': case 'silence_all': return { kind: 'rule.disable', sid: d.sid, label }
    case 'rule_on': return { kind: 'rule.enable', sid: d.sid, label }
    case 'silence_machine': return { kind: 'rule.silence', sid: d.sid, machine: d.machine, label }
    case 'block': return direction === 'in' ? { kind: 'block.remote', sid: d.sid, remote: d.remote, label } : { kind: 'block.pair', sid: d.sid, machine: d.machine, remote: d.remote, label }
    case 'allow': case 'allow_machine': case 'allow_all': return undefined
  }
}

export function openPlugins(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plugins (id INTEGER PRIMARY KEY, site TEXT NOT NULL, url TEXT NOT NULL UNIQUE, key TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL,
      kinds TEXT NOT NULL, rules INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 0, tries INTEGER NOT NULL DEFAULT 0,
      next_try INTEGER NOT NULL DEFAULT 0, last_ok TEXT, error TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, plugin INTEGER NOT NULL REFERENCES plugins(id), decision INTEGER NOT NULL, kind TEXT NOT NULL, sid INTEGER NOT NULL,
      machine TEXT NOT NULL, remote TEXT NOT NULL, label TEXT NOT NULL, state TEXT NOT NULL, error TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS entries_decision ON entries (decision);`)
  if (!db.prepare('PRAGMA table_info(plugins)').all().some((c) => c.name === 'devices')) db.exec('ALTER TABLE plugins ADD COLUMN devices INTEGER NOT NULL DEFAULT 0')
  db.prepare("INSERT OR IGNORE INTO settings (k, v) VALUES ('instance', ?)").run(randomUUID())
  const instance = (db.prepare("SELECT v FROM settings WHERE k = 'instance'").get() as { v: string }).v
  const rows = () => db.prepare('SELECT * FROM plugins ORDER BY id').all() as unknown as PluginRow[]
  const entriesOf = (id: number) => db.prepare("SELECT * FROM entries WHERE plugin = ? AND state != 'removed'").all(id) as unknown as EntryRow[]
  const now = () => new Date().toISOString()
  const touch = (id: number) => db.prepare('UPDATE plugins SET revision = revision + 1, dirty = 1, tries = 0, next_try = 0 WHERE id = ?').run(id)
  const busy = new Set<number>()

  async function deliver(p: PluginRow) {
    const mine = entriesOf(p.id)
    const entries: Entry[] = mine.filter((e) => e.state !== 'removing').map((e) => ({
      id: e.id, kind: e.kind, sid: e.sid, label: e.label, ...(e.machine && { machine: e.machine }), ...(e.remote && { remote: e.remote }) }))
    try {
      const r = await call(p, 'apply', { instance, revision: p.revision, entries }, applied, 280_000)
      const done = new Map(r.results.map((x) => [x.id, x]))
      db.exec('BEGIN')
      for (const e of mine) {
        const x = done.get(e.id)
        if (e.state === 'removing') db.prepare("UPDATE entries SET state = 'removed', error = '' WHERE id = ?").run(e.id)
        // An entry undone while we waited stays 'removing'; the next delivery takes it away.
        else db.prepare("UPDATE entries SET state = ?, error = ? WHERE id = ? AND state != 'removing'").run(x?.ok ? 'active' : 'failed', x?.ok ? '' : (x?.error ?? 'The plugin did not answer for this one'), e.id)
      }
      db.prepare("UPDATE plugins SET dirty = (revision != ?), tries = 0, next_try = 0, last_ok = ?, error = '' WHERE id = ?").run(p.revision, now(), p.id)
      db.exec('COMMIT')
      await check({ ...p, dirty: 1 })
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK')
      const wait = Math.min(300_000, 2_000 * 2 ** p.tries)
      db.prepare('UPDATE plugins SET tries = tries + 1, next_try = ?, error = ? WHERE id = ?').run(Date.now() + wait, reason(e), p.id)
    }
  }
  async function check(p: PluginRow) {
    try {
      const l = await call(p, 'list', {}, listed)
      const want = entriesOf(p.id).filter((e) => e.state === 'active').map((e) => e.id)
      const drift = l.instance && l.instance !== instance ? false : want.some((id) => !l.ids.includes(id)) || l.ids.some((id) => !want.includes(id))
      db.prepare('UPDATE plugins SET last_ok = ?, error = ?, message = ? WHERE id = ?').run(now(), l.healthy ? '' : l.message, drift ? 'Out of step; sending the list again' : l.message, p.id)
      if (drift && !p.dirty) touch(p.id)
    } catch (e) {
      db.prepare('UPDATE plugins SET error = ? WHERE id = ?').run(reason(e), p.id)
    }
  }
  async function each(list: PluginRow[], f: (p: PluginRow) => Promise<void>) {
    await Promise.all(list.filter((p) => !busy.has(p.id)).map(async (p) => {
      busy.add(p.id)
      try { await f(p) } finally { busy.delete(p.id) }
    }))
  }
  const deliverDue = () => each(rows().filter((p) => p.dirty && p.next_try <= Date.now()), deliver)

  return {
    instance, deliverDue, checkAll: () => each(rows(), check),
    list: () => rows().map(({ key: _key, kinds: k, ...p }) => ({ ...p, kinds: JSON.parse(k) as Kind[], entries: entriesOf(p.id).length })),
    async describe(url: string, key: string) { return call({ url, key }, 'describe', {}, describe) },
    async add(site: string, url: string, key: string) {
      const d = await call({ url, key }, 'describe', {}, describe)
      const taken = rows().filter((p) => p.site === site).find((p) => (JSON.parse(p.kinds) as Kind[]).some((k) => d.kinds.includes(k)))
      if (taken) throw new Error(`${taken.name} already handles that at this site`)
      db.prepare('INSERT INTO plugins (site, url, key, name, version, kinds, rules, devices) VALUES (?,?,?,?,?,?,?,?)').run(site, url, key, d.name, d.version, JSON.stringify(d.kinds), d.rules ? 1 : 0, d.devices ? 1 : 0)
      return d
    },
    /** Only once nothing of ours is left on the device. */
    remove(id: number) {
      if (entriesOf(id).length) throw new Error('Undo its decisions first, so nothing is left behind on the device')
      db.prepare('DELETE FROM entries WHERE plugin = ?').run(id)
      return Number(db.prepare('DELETE FROM plugins WHERE id = ?').run(id).changes) > 0
    },
    handles: (site: string, kind: Kind) => rows().some((p) => p.site === site && (JSON.parse(p.kinds) as Kind[]).includes(kind)),
    request(site: string, decision: number, e: Omit<Entry, 'id'>): boolean {
      const p = rows().find((x) => x.site === site && (JSON.parse(x.kinds) as Kind[]).includes(e.kind))
      if (!p) return false
      db.prepare("INSERT INTO entries (id, plugin, decision, kind, sid, machine, remote, label, state) VALUES (?,?,?,?,?,?,?,?,'requested')")
        .run(randomUUID(), p.id, decision, e.kind, e.sid ?? 0, e.machine ?? '', e.remote ?? '', e.label)
      touch(p.id)
      return true
    },
    undo(decision: number) {
      for (const e of db.prepare("SELECT * FROM entries WHERE decision = ? AND state NOT IN ('removing','removed')").all(decision) as unknown as EntryRow[]) {
        db.prepare("UPDATE entries SET state = 'removing' WHERE id = ?").run(e.id)
        touch(e.plugin)
      }
    },
    states: () => new Map((db.prepare(`SELECT e.decision, e.state, CASE WHEN e.error != '' THEN e.error ELSE p.error END AS error, p.name FROM entries e JOIN plugins p ON p.id = e.plugin`).all() as { decision: number; state: State; error: string; name: string }[])
      .map((e) => [e.decision, { state: e.state, error: e.error, plugin: e.name }])),
    async devices(site: string) {
      const facts: z.infer<typeof devicesReply>['facts'] = []
      const errors: { router: string; error: string }[] = []
      for (const p of rows().filter((x) => x.site === site && x.devices)) {
        try {
          const r = await call(p, 'devices', {}, devicesReply, 60_000)
          facts.push(...r.facts)
          errors.push(...r.errors)
        } catch (e) {
          errors.push({ router: p.name, error: reason(e) })
        }
      }
      return { facts, errors }
    },
    async rules(site: string, r: RulesRequest) {
      const p = rows().find((x) => x.site === site && x.rules)
      return p ? call(p, 'rules', r, ruleList, 30_000) : null
    },
  }
}
function reason(e: unknown): string {
  if (!(e instanceof Error)) return 'Failed'
  if (e.name === 'TimeoutError') return 'No answer in time'
  return (e.message === 'fetch failed' ? 'Cannot reach the plugin' : e.message).slice(0, 300)
}

/** The best name for each address: what a person called it, then what it calls itself, then DNS. */
export function namesFrom(facts: Pick<Fact, 'ip' | 'comment' | 'hostname' | 'dns' | 'source'>[]): Record<string, string> {
  const best: Record<string, { name: string; rank: number }> = {}
  for (const f of facts) {
    if (!f.ip) continue
    const [name, rank] = f.source === 'dhcp' && f.comment ? [f.comment, 3] : f.hostname ? [f.hostname, 2] : f.dns[0] ? [f.dns[0], 1] : ['', 0]
    if (name && rank > (best[f.ip]?.rank ?? 0)) best[f.ip] = { name, rank }
  }
  return Object.fromEntries(Object.entries(best).map(([ip, b]) => [ip, b.name]))
}
