import { createClient } from '@clickhouse/client'

const maxRows = 500
const allowed = /^\s*(select|with|show|describe|desc|explain)\b/i

/**
 * The agent's own SQL, through a separate ClickHouse login that the server itself holds to readonly=1 with time and row limits.
 * The checks here only give the model a clear error; the login is what makes it safe.
 */
export function openSql(c: { url: string; username: string; password: string; database: string }) {
  const ch = createClient({ ...c, request_timeout: 30_000 })
  return {
    async sql(query: string) {
      const q = query.trim().replace(/;\s*$/, '')
      if (!allowed.test(q)) throw new Error('Only SELECT, WITH, SHOW, DESCRIBE and EXPLAIN are allowed')
      if (q.includes(';')) throw new Error('One statement at a time')
      const r = await ch.query({ query: q, format: 'JSONEachRow' })
      const rows: unknown[] = []
      for await (const batch of r.stream()) {
        for (const row of batch) {
          if (rows.length === maxRows) { r.close(); return { rows, truncated: true } }
          rows.push(row.json())
        }
      }
      return { rows, truncated: false }
    },
    async schema() {
      const r = await ch.query({ query: `SELECT table, name, type, comment FROM system.columns WHERE database = {db:String} ORDER BY table, position`, query_params: { db: c.database }, format: 'JSONEachRow' })
      const cols = (await r.json()) as { table: string; name: string; type: string; comment: string }[]
      const out: Record<string, string[]> = {}
      for (const x of cols) (out[x.table] ??= []).push(`${x.name} ${x.type}${x.comment ? ` -- ${x.comment}` : ''}`)
      return out
    },
  }
}
