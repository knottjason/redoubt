import { createClient } from '@clickhouse/client'
import { isInternal, orient } from '../shared/net.ts'
import { config, hostName } from './config.ts'

const ch = createClient({ ...config.clickhouse, request_timeout: 30_000 })
type Params = Record<string, string | number | string[]>
async function q<T>(query: string, query_params: Params = {}): Promise<T[]> {
  const r = await ch.query({ query, query_params, format: 'JSONEachRow' })
  return (await r.json()) as T[]
}
const iso = (c: string) => `formatDateTime(${c}, '%Y-%m-%dT%H:%i:%SZ', 'UTC')`

export type AlertRow = {
  site: string; source: string
  sid: number; signature: string; category: string; severity: number; src: string; dst: string
  hits: number; first: string; last: string; machine: string; machineName: string; remote: string; remoteName: string
  direction: 'in' | 'out' | 'internal'; firstPair: string | null; isNew: boolean; blockable: boolean
}

export async function alerts(hours: number): Promise<AlertRow[]> {
  const rows = await q<{ sid: number; signature: string; category: string; severity: number; src: string; dst: string; hits: string; first: string; last: string }>(
    `SELECT sid, any(a.signature) AS signature, any(a.category) AS category, min(a.severity) AS severity, src, dst, count() AS hits,
       ${iso('min(ts)')} AS first, ${iso('max(ts)')} AS last
     FROM alerts a WHERE ts > now() - toIntervalHour({hours:UInt32}) AND a.signature NOT LIKE 'SURICATA %'
     GROUP BY sid, src, dst ORDER BY severity, max(ts) DESC LIMIT 2000`, { hours })
  const pairs = await q<{ src: string; dst: string; f: string; recent: number }>(
    `SELECT src, dst, ${iso('min(first_seen)')} AS f, min(first_seen) > now() - INTERVAL 24 HOUR AS recent FROM pairs
     WHERE (src, dst) IN (SELECT src, dst FROM alerts WHERE ts > now() - toIntervalHour({hours:UInt32})) GROUP BY src, dst`, { hours })
  const seen = new Map(pairs.map((p) => [`${p.src}|${p.dst}`, p]))
  return rows.map((r) => {
    const o = orient(r.src, r.dst, config.internal)
    const p = seen.get(`${r.src}|${r.dst}`)
    return {
      site: config.site, source: config.source, ...r, hits: Number(r.hits), ...o, machineName: hostName(o.machine), remoteName: hostName(o.remote),
      firstPair: p?.f ?? null, isNew: Boolean(p?.recent), blockable: !isInternal(o.remote, config.internal),
    }
  })
}

export async function alertDetail(sid: number, src: string, dst: string) {
  const { machine, remote } = orient(src, dst, config.internal)
  const [bars, samples, pair, bandwidth, around, names] = await Promise.all([
    q<{ h: number; n: string }>(`SELECT dateDiff('hour', ts, now()) AS h, count() AS n FROM alerts
      WHERE sid = {sid:UInt32} AND src = {src:String} AND dst = {dst:String} AND ts > now() - INTERVAL 24 HOUR GROUP BY h`, { sid, src, dst }),
    q<{ ts: string; sport: number; dport: number; proto: string; app: string }>(`SELECT ${iso('a.ts')} AS ts, sport, dport, proto, app
      FROM alerts a WHERE sid = {sid:UInt32} AND src = {src:String} AND dst = {dst:String} ORDER BY a.ts DESC LIMIT 5`, { sid, src, dst }),
    q<{ first: string; last: string; conns: string; bytes: string; n: string }>(`SELECT ${iso('min(first_seen)')} AS first, ${iso('max(last_seen)')} AS last,
      sum(conns) AS conns, sum(bytes) AS bytes, count() AS n FROM pairs
      WHERE (src = {m:String} AND dst = {r:String}) OR (src = {r:String} AND dst = {m:String})`, { m: machine, r: remote }),
    bandwidthOf(machine, 24),
    q<{ start: string; dst: string; dport: number; app: string; bytes: string }>(`SELECT ${iso('f.start')} AS start, dst, dport, app, bytes_in + bytes_out AS bytes FROM flows f
      WHERE src = {m:String} AND f.ts > now() - INTERVAL 24 HOUR AND f.ts BETWEEN
        (SELECT max(ts) FROM alerts WHERE sid = {sid:UInt32} AND src = {src:String} AND dst = {dst:String}) - INTERVAL 15 MINUTE AND
        (SELECT max(ts) FROM alerts WHERE sid = {sid:UInt32} AND src = {src:String} AND dst = {dst:String}) + INTERVAL 15 MINUTE
      ORDER BY bytes DESC LIMIT 12`, { m: machine, sid, src, dst }),
    q<{ name: string }>(`SELECT name, count() AS c FROM names WHERE src = {m:String} AND dst = {r:String} AND ts > now() - INTERVAL 7 DAY
      GROUP BY name ORDER BY c DESC LIMIT 5`, { m: machine, r: remote }),
  ])
  const p = pair[0]
  return {
    bars: Array.from({ length: 24 }, (_, i) => Number(bars.find((b) => b.h === 23 - i)?.n ?? 0)),
    samples, bandwidth, around, sites: names.map((n) => n.name),
    pair: p && Number(p.n) > 0 ? { first: p.first, last: p.last, connections: Number(p.conns), bytes: Number(p.bytes) } : null,
  }
}

// A connection's bytes are spread evenly over its life; putting them all where it ended would draw spikes that never happened.
async function bandwidth(up: string, down: string, where: string, hours: number, params: Params) {
  const step = hours <= 24 ? 900 : hours <= 168 ? 3600 : 14400
  return (await q<{ t: string; down: number; up: number }>(`SELECT ${iso('toDateTime(b * {step:UInt32})')} AS t, sum(d * part) AS down, sum(u * part) AS up FROM (
      SELECT d, u, arrayJoin(range(intDiv(greatest(s, since), {step:UInt32}), intDiv(e, {step:UInt32}) + 1)) AS b,
        if(e = s, 1, greatest(0, least(e, (b + 1) * {step:UInt32}) - greatest(s, b * {step:UInt32})) / (e - s)) AS part
      FROM (SELECT toInt64(toUnixTimestamp(f.start)) AS s, greatest(s, toInt64(toUnixTimestamp(f.end))) AS e,
          toInt64(toUnixTimestamp(now())) - {hours:UInt32} * 3600 AS since, ${down} AS d, ${up} AS u
        FROM flows f WHERE ${where} AND f.ts > now() - toIntervalHour({hours:UInt32}))
      WHERE e >= since) GROUP BY b ORDER BY b`, { ...params, hours, step }))
    .map((r) => ({ t: r.t, down: Math.round(Number(r.down)), up: Math.round(Number(r.up)) }))
}
const bandwidthOf = (ip: string, hours: number) =>
  bandwidth('if(src = {ip:String}, bytes_out, bytes_in)', 'if(src = {ip:String}, bytes_in, bytes_out)', '(src = {ip:String} OR dst = {ip:String})', hours, { ip })

const inside = (c: string) => `arrayExists(n -> isIPAddressInRange(${c}, n), {nets:Array(String)})`

export async function overview(hours: number) {
  const nets = config.internalList
  const [internet, top, rows, [last]] = await Promise.all([
    bandwidth(`if(${inside('src')}, bytes_out, bytes_in)`, `if(${inside('src')}, bytes_in, bytes_out)`, `${inside('src')} != ${inside('dst')}`, hours, { nets }),
    machines(hours),
    alerts(hours),
    q<{ age: string }>(`SELECT dateDiff('second', max(f.ts), now64(3)) AS age FROM flows f WHERE f.ts > now() - INTERVAL 1 DAY`),
  ])
  return {
    internet, top: top.slice(0, 8), alerts: rows,
    sources: [{ site: config.site, source: config.source, secondsAgo: Math.max(0, Number(last?.age ?? 0)) }],
  }
}

export async function rules(hours: number) {
  const rows = await q<{ sid: number; signature: string; category: string; severity: number; hits: string; pairs: string; last: string }>(
    `SELECT sid, any(a.signature) AS signature, any(a.category) AS category, min(a.severity) AS severity, count() AS hits, uniq(src, dst) AS pairs, ${iso('max(ts)')} AS last
     FROM alerts a WHERE ts > now() - toIntervalHour({hours:UInt32}) GROUP BY sid ORDER BY hits DESC LIMIT 1000`, { hours })
  return rows.map((r) => ({ ...r, hits: Number(r.hits), pairs: Number(r.pairs) }))
}

export async function machines(hours: number) {
  const rows = await q<{ ip: string; up: string; down: string; conns: string; dests: string; last: string }>(
    `SELECT ip, sum(u) AS up, sum(d) AS down, count() AS conns, uniq(other) AS dests, ${iso('max(t)')} AS last FROM (
       SELECT src AS ip, dst AS other, bytes_out AS u, bytes_in AS d, f.ts AS t FROM flows f WHERE f.ts > now() - toIntervalHour({hours:UInt32})
       UNION ALL SELECT dst, src, bytes_in, bytes_out, f.ts FROM flows f WHERE f.ts > now() - toIntervalHour({hours:UInt32}))
     WHERE ${inside('ip')} GROUP BY ip ORDER BY up + down DESC LIMIT 1000`, { hours, nets: config.internalList })
  return rows.map((r) => ({
    site: config.site, ip: r.ip, name: hostName(r.ip), up: Number(r.up), down: Number(r.down), connections: Number(r.conns), destinations: Number(r.dests), last: r.last,
  }))
}

export async function machine(ip: string, hours: number) {
  const [bandwidth, connections, fresh, all] = await Promise.all([
    bandwidthOf(ip, hours),
    q<{ start: string; secs: number; dst: string; dport: number; proto: string; app: string; up: string; down: string; name: string; first: string; recent: number }>(
      `SELECT ${iso('f.start')} AS start, dateDiff('second', f.start, f.end) AS secs, f.dst AS dst, dport, proto, app, bytes_out AS up, bytes_in AS down,
         n.name AS name, ${iso('p.first')} AS first, p.first > now() - INTERVAL 24 HOUR AS recent
       FROM (SELECT * FROM flows WHERE src = {ip:String} AND ts > now() - toIntervalHour({hours:UInt32}) ORDER BY bytes_in + bytes_out DESC LIMIT 300) f
       LEFT JOIN (SELECT flow_id, any(name) AS name FROM names WHERE src = {ip:String} AND ts > now() - toIntervalHour({hours:UInt32} + 1) GROUP BY flow_id) n ON n.flow_id = f.flow_id
       LEFT JOIN (SELECT dst, min(first_seen) AS first FROM pairs WHERE src = {ip:String} GROUP BY dst) p ON p.dst = f.dst
       ORDER BY up + down DESC`, { ip, hours }),
    q<{ dst: string; first: string; conns: string; bytes: string }>(`SELECT dst, ${iso('min(first_seen)')} AS first, sum(conns) AS conns, sum(bytes) AS bytes FROM pairs
       WHERE src = {ip:String} GROUP BY dst HAVING min(first_seen) > now() - INTERVAL 24 HOUR ORDER BY bytes DESC LIMIT 50`, { ip }),
    alerts(hours),
  ])
  return {
    site: config.site, ip, name: hostName(ip), bandwidth, alerts: all.filter((a) => a.machine === ip || a.remote === ip),
    connections: connections.map((c) => ({ ...c, up: Number(c.up), down: Number(c.down), remoteName: hostName(c.dst), isNew: Boolean(c.recent) })),
    fresh: fresh.map((f) => ({ ...f, conns: Number(f.conns), bytes: Number(f.bytes), remoteName: hostName(f.dst) })),
  }
}

export async function summary() {
  const [s] = await q<{ dp: string; dd: string; age: string }>(`SELECT max(packets) - min(packets) AS dp, max(drops) - min(drops) AS dd,
     dateDiff('second', max(ts), now64(3)) AS age FROM stats WHERE ts > now() - INTERVAL 10 MINUTE`)
  const [h] = await q<{ f: string }>(`SELECT ${iso('min(ts)')} AS f FROM flows`)
  return { drops: Number(s?.dd ?? 0), packets: Number(s?.dp ?? 0), sensorOk: Number(s?.age ?? 1e9) < 180 && Number(s?.dp ?? 0) > 0, since: h?.f ?? null }
}

/** A rule's name as the sensor reported it, from the last 30 days of alerts. */
export async function signatureOf(sid: number): Promise<string | null> {
  const [r] = await q<{ s: string }>(`SELECT any(a.signature) AS s FROM alerts a WHERE sid = {sid:UInt32} AND ts > now() - INTERVAL 30 DAY HAVING count() > 0`, { sid })
  return r?.s || null
}
