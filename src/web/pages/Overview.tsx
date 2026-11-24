import { Group } from '@mantine/core'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useOverview } from '../api.ts'
import { Bandwidth, Grid, Load, Machine, bytes, sevColor } from '../ui.tsx'
import { alertColumns } from './Alerts.tsx'
import { Range } from './Machines.tsx'

const ago = (s: number) => (s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`)

export function Overview() {
  const [hours, setHours] = useState('24')
  const nav = useNavigate()
  const q = useOverview(Number(hours))
  const d = q.data
  return <div className="page" style={{ display: 'grid', gap: 18 }}>
    <Group justify="space-between"><b style={{ fontSize: 18 }}>Overview</b><Range v={hours} set={setHours} /></Group>
    <Load q={q}>{d && <>
      <div className="tiles">
        {([['High', 1], ['Medium', 2], ['Low', 3]] as const).map(([t, s]) => <div className="inset" key={s}><div className="label">{t}, open</div><b style={{ color: sevColor(s) }}>{d.open.filter((a) => (s === 3 ? a.severity >= 3 : a.severity === s)).length}</b></div>)}
        <div className="inset"><div className="label">New pairs, open</div><b>{d.open.filter((a) => a.isNew).length}</b></div>
        <div className="inset"><div className="label">Internet down</div><b>{bytes(d.internet.reduce((n, r) => n + r.down, 0))}</b></div>
        <div className="inset"><div className="label">Internet up</div><b>{bytes(d.internet.reduce((n, r) => n + r.up, 0))}</b></div>
      </div>
      <div className="panel" style={{ padding: 14 }}><div className="label">Internet traffic, finished connections</div><Bandwidth data={d.internet} h={200} /></div>
      <div><div className="label" style={{ marginBottom: 6 }}>Most serious open alerts · <Link to="/alerts">see all {d.open.length}</Link></div>
        <Grid data={d.open.slice(0, 6)} columns={alertColumns} rowKey={(a) => `${a.site}|${a.sid}|${a.src}|${a.dst}`} onPick={(a) => nav(`/alerts?find=${a.sid}`)} empty="Nothing open. Quiet is good." /></div>
      <div><div className="label" style={{ marginBottom: 6 }}>Busiest machines, all traffic</div><Grid data={d.top} rowKey={(r) => `${r.site}|${r.ip}`} columns={[
        { id: 'name', header: 'Machine', accessorFn: (r) => r.name || r.ip, cell: ({ row: { original: r } }) => <Machine ip={r.ip} name={r.name} /> },
        { accessorKey: 'down', header: 'Down', meta: { right: true }, cell: (c: any) => <span className="mono">{bytes(c.getValue())}</span> },
        { accessorKey: 'up', header: 'Up', meta: { right: true }, cell: (c: any) => <span className="mono">{bytes(c.getValue())}</span> }]} /></div>
      <div><div className="label" style={{ marginBottom: 6 }}>Sources</div><Grid data={d.sources} rowKey={(s) => `${s.site}|${s.source}`} columns={[
        { accessorKey: 'site', header: 'Site' }, { accessorKey: 'source', header: 'Source' },
        { accessorKey: 'secondsAgo', header: 'Last data', cell: (c: any) => <span className="mono"><span className="dot" style={{ background: c.getValue() < 180 ? '#3ccf8e' : '#ff6b6b' }} />{ago(c.getValue())}</span> }]} /></div>
    </>}</Load></div>
}
