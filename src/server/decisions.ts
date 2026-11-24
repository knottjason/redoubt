import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const actions = ['allow', 'silence_machine', 'silence_all', 'block'] as const
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
  const now = () => new Date().toISOString()
  const all = (sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as unknown as Decision[]
  return {
    active: () => all('SELECT * FROM decisions WHERE undone IS NULL ORDER BY id DESC'),
    history: () => all('SELECT * FROM decisions ORDER BY id DESC LIMIT 500'),
    add(d: Pick<Decision, 'site' | 'action' | 'sid' | 'machine' | 'remote' | 'signature' | 'user'>): number {
      const r = db.prepare('INSERT INTO decisions (site, action, sid, machine, remote, signature, user, created) VALUES (?,?,?,?,?,?,?,?)')
        .run(d.site, d.action, d.sid, d.machine, d.remote, d.signature, d.user, now())
      return Number(r.lastInsertRowid)
    },
    undo: (id: number, user: string) =>
      Number(db.prepare('UPDATE decisions SET undone = ?, undone_by = ? WHERE id = ? AND undone IS NULL').run(now(), user, id).changes) > 0,
  }
}

/** The newest active decision that covers this alert. A decision only ever applies at its own site. */
export function decisionFor(active: Decision[], site: string, sid: number, machine: string, remote: string): Decision | undefined {
  return active.find((d) =>
    d.site === site && d.sid === sid && (d.action === 'silence_all' || (d.machine === machine && (d.action === 'silence_machine' || d.remote === remote))))
}
