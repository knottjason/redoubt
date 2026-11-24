import { Group, SegmentedControl, TextInput } from '@mantine/core'
import type { ColumnDef } from '@tanstack/react-table'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useMachine, useMachines } from '../api.ts'
import { Bandwidth, Grid, Load, Machine, NewTag, bytes, when } from '../ui.tsx'
import { alertColumns } from './Alerts.tsx'

export const Range = ({ v, set }: { v: string; set: (v: string) => void }) => <SegmentedControl size="xs" value={v} onChange={set} data={[{ value: '1', label: '1 h' }, { value: '24', label: '24 h' }, { value: '168', label: '7 d' }, { value: '720', label: '30 d' }]} />
const num = (f: (n: number) => string = String) => (c: { getValue: () => any }) => <span className="mono">{f(c.getValue())}</span>

type Row = NonNullable<ReturnType<typeof useMachines>['data']>[number]
const columns: ColumnDef<Row, any>[] = [
  { id: 'name', accessorFn: (r) => r.name || r.ip, header: 'Machine', cell: ({ row: { original: r } }) => <Machine ip={r.ip} name={r.name} /> },
  { accessorKey: 'down', header: 'Down', meta: { right: true }, cell: num(bytes) }, { accessorKey: 'up', header: 'Up', meta: { right: true }, cell: num(bytes) },
  { accessorKey: 'connections', header: 'Connections', meta: { right: true }, cell: num() }, { accessorKey: 'destinations', header: 'Peers', meta: { right: true }, cell: num() },
  { accessorKey: 'last', header: 'Last', cell: (c) => <span className="mono dim">{when(c.getValue())}</span> },
]

export function Machines() {
  const [hours, setHours] = useState('24')
  const [find, setFind] = useState('')
  const nav = useNavigate()
  const q = useMachines(Number(hours))
  return <div className="page"><Group justify="space-between" mb={14}><b style={{ fontSize: 18 }}>Machines</b><Group><TextInput size="xs" aria-label="Find" placeholder="Name or IP…" value={find} onChange={(e) => setFind(e.currentTarget.value)} /><Range v={hours} set={setHours} /></Group></Group>
    <Load q={q}><Grid data={(q.data ?? []).filter((r) => `${r.name} ${r.ip}`.toLowerCase().includes(find.toLowerCase()))} columns={columns} rowKey={(r) => `${r.site}|${r.ip}`} onPick={(r) => nav(`/machines/${encodeURIComponent(r.ip)}`)} /></Load></div>
}

type Conn = NonNullable<ReturnType<typeof useMachine>['data']>['connections'][number]
const conns: ColumnDef<Conn, any>[] = [
  { accessorKey: 'start', header: 'Started', cell: (c) => <span className="mono dim">{when(c.getValue())}</span> },
  { id: 'to', accessorKey: 'dst', header: 'To', cell: ({ row: { original: c } }) => <><span className="mono">{c.dst}:{c.dport}</span> {c.isNew && <NewTag />}<div className="dim">{c.name || c.remoteName}</div></> },
  { accessorKey: 'app', header: 'App', cell: ({ row: { original: c } }) => <span className="dim">{c.app || c.proto}</span> },
  { accessorKey: 'secs', header: 'Seconds', meta: { right: true }, cell: num() }, { accessorKey: 'down', header: 'Down', meta: { right: true }, cell: num(bytes) }, { accessorKey: 'up', header: 'Up', meta: { right: true }, cell: num(bytes) },
  { accessorKey: 'first', header: 'First seen', cell: (c) => <span className="mono dim">{when(c.getValue())}</span> },
]

export function MachinePage() {
  const { ip = '' } = useParams()
  const [hours, setHours] = useState('24')
  const q = useMachine(ip, Number(hours))
  const d = q.data
  return <div className="page" style={{ display: 'grid', gap: 18 }}>
    <Group justify="space-between"><div><b style={{ fontSize: 18 }}>{d?.name || ip}</b> {d?.name && <span className="mono dim">{ip}</span>}</div><Range v={hours} set={setHours} /></Group>
    <Load q={q}>{d && <>
      <div className="panel" style={{ padding: 14 }}><div className="label">Bandwidth</div><Bandwidth data={d.bandwidth} h={200} /></div>
      <div><div className="label" style={{ marginBottom: 6 }}>Alerts</div><Grid data={d.alerts} columns={alertColumns} rowKey={(a) => `${a.site}|${a.sid}|${a.src}|${a.dst}`} empty="No alerts for this machine." /></div>
      <div><div className="label" style={{ marginBottom: 6 }}>First contacted in the last 24 h</div><Grid data={d.fresh} rowKey={(f) => f.dst} empty="Nothing new." columns={[
        { accessorKey: 'dst', header: 'Destination', cell: ({ row: { original: f } }) => <><span className="mono">{f.dst}</span> <span className="dim">{f.remoteName}</span></> },
        { accessorKey: 'first', header: 'First', cell: (c: any) => <span className="mono dim">{when(c.getValue())}</span> },
        { accessorKey: 'conns', header: 'Connections', meta: { right: true }, cell: num() }, { accessorKey: 'bytes', header: 'Traffic', meta: { right: true }, cell: num(bytes) }]} /></div>
      <div><div className="label" style={{ marginBottom: 6 }}>Biggest connections it started (up to 300)</div><Grid data={d.connections} columns={conns} rowKey={(c) => `${c.start}|${c.dst}|${c.dport}|${c.up}|${c.down}|${c.secs}`} empty="No connections recorded." /></div>
    </>}</Load></div>
}
