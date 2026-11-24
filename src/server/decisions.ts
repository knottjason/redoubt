import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const actions = ['allow', 'allow_machine', 'allow_all', 'silence_machine', 'silence_all', 'block', 'rule_off', 'rule_on'] as const
export type Action = (typeof actions)[number]
export type Decision = {
  id: number
  site: string
  action: Action
  sid: number
  machine: string
  remote: string
  signature: string
  user: string
  created: string
  undone: string | null
  undone_by: string | null
  /** Why, when it was given (the agent always gives one). */
  reason: string | null
  undo_reason: string | null
}

export function openDecisions(dir: string, site: string) {
  if (dir !== ':memory:') mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(dir === ':memory:' ? dir : join(dir, 'decisions.sqlite'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY, action TEXT NOT NULL, sid INTEGER NOT NULL, machine TEXT NOT NULL, remote TEXT NOT NULL,
      signature TEXT NOT NULL, user TEXT NOT NULL, created TEXT NOT NULL, undone TEXT, undone_by TEXT);
    CREATE INDEX IF NOT EXISTS decisions_active ON decisions (sid) WHERE undone IS NULL;`)
  // Databases made before sites existed: everything in them was decided at this site.
  if (!db.prepare('PRAGMA table_info(decisions)').all().some((c) => c.name === 'site')) {
    db.exec('BEGIN')
    db.exec("ALTER TABLE decisions ADD COLUMN site TEXT NOT NULL DEFAULT ''")
    db.prepare('UPDATE decisions SET site = ?').run(site)
    db.exec('COMMIT')
  }
  // Reasons came with the agent. Take a copy first and stop if that fails: a half-done migration is worse than none.
  const cols = db.prepare('PRAGMA table_info(decisions)').all().map((c) => c.name)
  if (!cols.includes('reason')) {
    if (dir !== ':memory:') db.exec(`VACUUM INTO '${join(dir, `decisions-before-reasons-${Date.now()}.sqlite`).replaceAll("'", "''")}'`)
    db.exec('BEGIN')
    db.exec('ALTER TABLE decisions ADD COLUMN reason TEXT')
    db.exec('ALTER TABLE decisions ADD COLUMN undo_reason TEXT')
    db.exec('COMMIT')
  }
  const now = () => new Date().toISOString()
  const all = (sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as unknown as Decision[]
  return {
    db,
    active: () => all('SELECT * FROM decisions WHERE undone IS NULL ORDER BY id DESC'),
    get: (id: number) => all('SELECT * FROM decisions WHERE id = ?', id)[0],
    history: () => all('SELECT * FROM decisions ORDER BY id DESC LIMIT 500'),
    add(d: Pick<Decision, 'site' | 'action' | 'sid' | 'machine' | 'remote' | 'signature' | 'user'> & { reason?: string | undefined }): number {
      const r = db.prepare('INSERT INTO decisions (site, action, sid, machine, remote, signature, user, created, reason) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(d.site, d.action, d.sid, d.machine, d.remote, d.signature, d.user, now(), d.reason ?? null)
      return Number(r.lastInsertRowid)
    },
    undo: (id: number, user: string, reason?: string) =>
      Number(db.prepare('UPDATE decisions SET undone = ?, undone_by = ?, undo_reason = ? WHERE id = ? AND undone IS NULL').run(now(), user, reason ?? null, id).changes) > 0,
  }
}

/** The newest active decision that covers this alert. A decision only ever applies at its own site. */
export function decisionFor(active: Decision[], site: string, sid: number, machine: string, remote: string): Decision | undefined {
  return active.find((d) =>
    d.site === site && d.sid === sid && d.action !== 'rule_on' && (d.action === 'silence_all' || d.action === 'allow_all' || d.action === 'rule_off' || (d.machine === machine && (d.action === 'silence_machine' || d.action === 'allow_machine' || d.remote === remote))))
}
