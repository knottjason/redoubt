import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Msg } from '../agent/compaction.ts'

export type Scope = 'read' | 'write'
export type Token = { id: number; name: string; scope: Scope; created: string; last_used: string | null; revoked: string | null }
export type Gap = { id: number; title: string; details: string; reporter: string; created: string; closed: string | null }

const hash = (t: string) => createHash('sha256').update(t).digest('hex')

/** The agent's own database, apart from decisions: the one conversation, its running summary, MCP tokens and reported gaps. */
export function openAgentStore(dir: string) {
  if (dir !== ':memory:') mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(dir === ':memory:' ? dir : join(dir, 'agent.sqlite'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS chat (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, role TEXT NOT NULL, json TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chat_summary (id INTEGER PRIMARY KEY, text TEXT NOT NULL, upto TEXT NOT NULL, model TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mcp_tokens (id INTEGER PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
      created TEXT NOT NULL, last_used TEXT, revoked TEXT);
    CREATE TABLE IF NOT EXISTS gaps (id INTEGER PRIMARY KEY, title TEXT NOT NULL, details TEXT NOT NULL, reporter TEXT NOT NULL, created TEXT NOT NULL, closed TEXT);`)
  const now = () => new Date().toISOString()
  return {
    db,
    chat: {
      all: () => (db.prepare('SELECT json FROM chat ORDER BY seq').all() as { json: string }[]).map((r) => JSON.parse(r.json) as Msg),
      /** Insert or replace by id, keeping the original position, so a message updated by a continued turn stays in place. */
      save(msgs: Msg[]) {
        const up = db.prepare(`INSERT INTO chat (id, role, json, created) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`)
        db.exec('BEGIN')
        try {
          for (const m of msgs) up.run(m.id, m.role, JSON.stringify(m), now())
          db.exec('COMMIT')
        } catch (e) {
          db.exec('ROLLBACK')
          throw e
        }
      },
      clear() { db.exec('DELETE FROM chat; DELETE FROM chat_summary') },
    },
    summary: {
      /** The newest summary and the id of the first message it does not cover. */
      latest: () => db.prepare('SELECT text, upto, model, created FROM chat_summary ORDER BY id DESC LIMIT 1').get() as { text: string; upto: string; model: string; created: string } | undefined,
      add: (text: string, upto: string, model: string) => { db.prepare('INSERT INTO chat_summary (text, upto, model, created) VALUES (?,?,?,?)').run(text, upto, model, now()) },
    },
    tokens: {
      list: () => db.prepare('SELECT id, name, scope, created, last_used, revoked FROM mcp_tokens ORDER BY id DESC').all() as unknown as Token[],
      /** The secret is shown once and only its hash is kept. */
      create(name: string, scope: Scope): { token: string; id: number } {
        const token = `rdt_${randomBytes(24).toString('base64url')}`
        const r = db.prepare('INSERT INTO mcp_tokens (name, scope, hash, created) VALUES (?,?,?,?)').run(name, scope, hash(token), now())
        return { token, id: Number(r.lastInsertRowid) }
      },
      check(token: string): Token | undefined {
        const t = db.prepare('SELECT id, name, scope, created, last_used, revoked FROM mcp_tokens WHERE hash = ? AND revoked IS NULL').get(hash(token)) as Token | undefined
        if (t) db.prepare('UPDATE mcp_tokens SET last_used = ? WHERE id = ?').run(now(), t.id)
        return t
      },
      revoke: (id: number) => Number(db.prepare('UPDATE mcp_tokens SET revoked = ? WHERE id = ? AND revoked IS NULL').run(now(), id).changes) > 0,
    },
    gaps: {
      list: () => db.prepare('SELECT * FROM gaps ORDER BY closed IS NOT NULL, id DESC LIMIT 500').all() as unknown as Gap[],
      add: (title: string, details: string, reporter: string) => Number(db.prepare('INSERT INTO gaps (title, details, reporter, created) VALUES (?,?,?,?)').run(title, details, reporter, now()).lastInsertRowid),
      close: (id: number) => Number(db.prepare('UPDATE gaps SET closed = ? WHERE id = ? AND closed IS NULL').run(now(), id).changes) > 0,
    },
  }
}
export type AgentStore = ReturnType<typeof openAgentStore>
