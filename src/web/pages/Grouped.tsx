import { Fragment, useState } from 'react'
import type { Alert } from '../api.ts'
import { Machine, NewTag, Sev, Status, when } from '../ui.tsx'

export type GroupBy = 'rule' | 'category' | 'pair'
export const alertKey = (a: Alert) => `${a.site}|${a.sid}|${a.src}|${a.dst}`

function by<T>(rows: T[], f: (r: T) => string): T[][] {
  const m = new Map<string, T[]>()
  for (const r of rows) m.set(f(r), [...(m.get(f(r)) ?? []), r])
  return [...m.values()]
}
const worst = (r: Alert[]) => Math.min(...r.map((a) => a.severity))
const last = (r: Alert[]) => r.reduce((m, a) => (a.last > m ? a.last : m), '')
const hits = (r: Alert[]) => r.reduce((n, a) => n + a.hits, 0)
const hosts = (r: Alert[]) => new Set(r.map((a) => `${a.site}|${a.machine}`)).size
const order = (x: Alert[], y: Alert[]) => worst(x) - worst(y) || last(y).localeCompare(last(x))

export function Grouped({ rows, group, selected, onPick }: { rows: Alert[]; group: 'rule' | 'category'; selected?: string; onPick: (a: Alert) => void }) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const flip = (k: string) => setOpen((o) => { const n = new Set(o); if (!n.delete(k)) n.add(k); return n })
  const rules = (list: Alert[], depth: number) => by(list, (a) => `${a.site}|${a.sid}`).sort(order).map((r) => {
    const k = `r${r[0]!.site}|${r[0]!.sid}`
    return <Fragment key={k}>
      <Row k={k} open={open.has(k)} flip={flip} depth={depth} r={r} title={r[0]!.signature} sub={depth ? `sid ${r[0]!.sid}` : r[0]!.category} />
      {open.has(k) && by(r, (a) => a.machine).sort(order).map((h) => {
        const a = [...h].sort((x, y) => y.last.localeCompare(x.last))[0]!
        const picked = h.some((x) => alertKey(x) === selected)
        return <tr key={a.machine} className={`click ${picked ? 'sel' : ''}`} tabIndex={0} onClick={() => onPick(a)} onKeyDown={(e) => { if (e.key === 'Enter') onPick(a) }}>
          <td /><td style={{ paddingLeft: 30 + depth * 18 }}><Machine ip={a.machine} name={a.machineName} /></td>
          <td className="mono">{{ in: '←', out: '→', internal: '↔' }[a.direction]} {a.remote}{h.length > 1 && <Remotes all={h} selected={selected} onPick={onPick} />}<div className="dim">{a.remoteName}</div></td>
          <td className="r mono">{hits(h)}</td><td className="mono dim">{when(last(h))}</td><td>{h.some((x) => x.isNew) && <NewTag />} {a.decision && <Status d={a.decision} />}</td></tr>
      })}
    </Fragment>
  })
  return <div className="panel scroll"><table className="grid">
    <thead><tr><th>Sev</th><th>{group === 'rule' ? 'Rule' : 'Category'}</th><th>Hosts</th><th className="r">Hits</th><th>Last</th><th /></tr></thead>
    <tbody>{group === 'rule' ? rules(rows, 0) : by(rows, (a) => a.category).sort(order).map((c) => {
      const k = `c${c[0]!.category}`
      const n = new Set(c.map((a) => `${a.site}|${a.sid}`)).size
      return <Fragment key={k}><Row k={k} open={open.has(k)} flip={flip} depth={0} r={c} title={c[0]!.category || 'No category'} sub={`${n} ${n === 1 ? 'rule' : 'rules'}`} />{open.has(k) && rules(c, 1)}</Fragment>
    })}</tbody></table>
    {rows.length === 0 && <div className="dim" style={{ padding: 28, textAlign: 'center' }}>Nothing here. Quiet is good.</div>}</div>
}

function Row({ k, open, flip, depth, r, title, sub }: { k: string; open: boolean; flip: (k: string) => void; depth: number; r: Alert[]; title: string; sub: string }) {
  const n = hosts(r)
  return <tr className="click" tabIndex={0} aria-expanded={open} onClick={() => flip(k)} onKeyDown={(e) => { if (e.key === 'Enter') flip(k) }}>
    <td><Sev s={worst(r)} /></td>
    <td style={{ paddingLeft: 12 + depth * 18 }}><span className="dim">{open ? '▾' : '▸'}</span> <span title={title}>{title}</span><div className="dim" style={{ fontSize: 11, paddingLeft: 14 }}>{sub}</div></td>
    <td>{n} {n === 1 ? 'host' : 'hosts'}</td><td className="r mono">{hits(r)}</td><td className="mono dim">{when(last(r))}</td><td>{r.some((a) => a.isNew) && <NewTag />}</td></tr>
}

function Remotes({ all, selected, onPick }: { all: Alert[]; selected?: string; onPick: (a: Alert) => void }) {
  return <select aria-label="Remote" value={all.some((a) => alertKey(a) === selected) ? selected : ''} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
    onChange={(e) => { const a = all.find((x) => alertKey(x) === e.currentTarget.value); if (a) onPick(a) }} style={{ marginLeft: 8, background: '#151a20', color: '#9aa4b2', border: '1px solid #222a33', borderRadius: 4, fontSize: 11 }}>
    <option value="">{all.length} remotes</option>{all.map((a) => <option key={alertKey(a)} value={alertKey(a)}>{a.remote} ({a.hits})</option>)}</select>
}
