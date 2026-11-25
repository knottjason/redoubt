import { Alert as Notice, Button, Checkbox, Group, SegmentedControl, TextInput } from '@mantine/core'
import type { ColumnDef } from '@tanstack/react-table'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useInventory, useKnown, useMachine, useWatch } from '../api.ts'
import { Bandwidth, Grid, Load, NewTag, Rename, bytes, when } from '../ui.tsx'
import { alertColumns } from './Alerts.tsx'

export const Range = ({ v, set }: { v: string; set: (v: string) => void }) => <SegmentedControl size="xs" value={v} onChange={set} data={[{ value: '1', label: '1 h' }, { value: '24', label: '24 h' }, { value: '168', label: '7 d' }, { value: '720', label: '30 d' }]} />
const num = (f: (n: number) => string = String) => (c: { getValue: () => any }) => <span className="mono">{f(c.getValue())}</span>

type Inv = NonNullable<ReturnType<typeof useInventory>['data']>
type Row = Inv['devices'][number]
const Tag = ({ c, children, title }: { c: string; children: ReactNode; title?: string }) => <span title={title} style={{ color: c, fontWeight: 600, fontSize: 10.5, letterSpacing: 0.4, marginRight: 6 }}>{children}</span>
const columns: ColumnDef<Row, any>[] = [
  { id: 'name', accessorFn: (r) => r.shown || r.ip || r.mac, header: 'Device', cell: ({ row: { original: r } }) => <span className="named">{r.ip
    ? <Link to={`/machines/${encodeURIComponent(r.ip)}`} onClick={(e) => e.stopPropagation()}>{r.shown || r.ip}{r.shown && <div className="mono dim">{r.ip}</div>}</Link>
    : <span>{r.shown || r.mac}<div className="dim">no address now</div></span>}<Rename id={r.id} name={r.name} label={r.shown || r.ip || r.mac || ''} dns={r.want_dns} /></span> },
  { id: 'tags', accessorFn: (r) => (r.alert ? 3 : 0) + (r.isNew ? 2 : 0), header: '', cell: ({ row: { original: r } }) => <>
    {r.router_self && <Tag c="#7fb0ff" title={`${r.router_self}'s own interfaces and addresses (${r.ips.length})`}>ROUTER</Tag>}{r.alert && <Tag c="#ff8a8a" title="New on a watched network">ALERT</Tag>}{r.isNew && <Tag c="#f5a524">NEW</Tag>}{r.static && <Tag c="#9aa4b2" title="Fixed lease">STATIC</Tag>}{r.dns.length > 0 && <Tag c="#7fb0ff" title={r.dns.join(', ')}>DNS</Tag>}
    {r.name && r.router_name && r.name !== r.router_name && <Tag c="#f5a524" title={`The router calls it ${r.router_name}`}>DIFFERS</Tag>}</> },
  { accessorKey: 'mac', header: 'MAC', cell: ({ row: { original: r } }) => <><span className="mono">{r.mac ?? '–'}</span>{r.random_mac && <div className="dim" style={{ fontSize: 11 }}>private MAC</div>}</> },
  { accessorKey: 'hostname', header: 'Calls itself', cell: ({ row: { original: r } }) => <span className="dim">{r.hostname ?? ''}</span> },
  { accessorKey: 'interface', header: 'Network', cell: ({ row: { original: r } }) => <span className="dim">{r.interface ?? ''}</span> },
  { id: 'port', accessorFn: (r) => r.port ?? '', header: 'Switch port', cell: ({ row: { original: r }, table }) => {
    if (!r.port) return null
    const p = (table.options.meta as { ports?: Inv['ports'] } | undefined)?.ports?.find((x) => x.router === r.port_router && x.port === r.port)
    return <><span className="mono">{r.port}</span>{r.vlan !== null && <span className="dim"> · VLAN {r.vlan}</span>}<div className="dim" style={{ fontSize: 11 }}>{r.port_router}{p?.shared && <span style={{ color: '#f5a524' }}> · behind an AP or switch ({p.macs})</span>}</div></>
  } },
  { accessorKey: 'down', header: 'Down', meta: { right: true }, cell: num(bytes) }, { accessorKey: 'up', header: 'Up', meta: { right: true }, cell: num(bytes) },
  { accessorKey: 'connections', header: 'Conns', meta: { right: true }, cell: num() },
  { accessorKey: 'last_seen', header: 'Last seen', cell: ({ row: { original: r } }) => <span className="mono dim">{when(r.active && r.active > r.last_seen ? r.active : r.last_seen)}</span> },
]
const shows = { All: (_: Row) => true, Active: (r: Row) => r.connections > 0, New: (r: Row) => r.isNew || r.alert, Unnamed: (r: Row) => !r.shown } as const

export function Machines() {
  const [hours, setHours] = useState('24')
  const [params] = useSearchParams()
  const [find, setFind] = useState('')
  const [show, setShow] = useState<keyof typeof shows>(params.get('show') === 'new' ? 'New' : 'All')
  const nav = useNavigate()
  const q = useInventory(Number(hours))
  const known = useKnown()
  const all = q.data?.devices ?? []
  const f = find.toLowerCase()
  const rows = all.filter(shows[show]).filter((r) => !f || [r.shown, r.ip, r.mac, r.hostname, r.port, ...r.ips.map((i) => i.ip)].some((v) => v?.toLowerCase().includes(f)))
  const alerts = all.filter((r) => r.alert)
  return <div className="page" style={{ display: 'grid', gap: 14 }}>
    <Group justify="space-between"><b style={{ fontSize: 18 }}>Devices</b><Group><TextInput size="xs" aria-label="Find" placeholder="Name, IP, MAC, port…" value={find} onChange={(e) => setFind(e.currentTarget.value)} /><Range v={hours} set={setHours} /></Group></Group>
    {alerts.length > 0 && <div className="panel" style={{ padding: 12, borderColor: '#5a2a2e' }}><div className="label" style={{ marginBottom: 8 }}>New on a watched network</div>
      {alerts.map((r) => <Group key={r.id} justify="space-between" py={4}><span><b>{r.shown || r.ip}</b> <span className="mono dim">{r.ip} · {r.mac}</span> <span className="dim">first seen {when(r.first_seen)}</span></span>
        <Group gap={6}><Rename id={r.id} name={r.name} dns={r.want_dns} always /><Button size="compact-xs" variant="light" loading={known.isPending} onClick={() => known.mutate(r.id)}>It's known</Button></Group></Group>)}</div>}
    <Group gap={6}>{(Object.keys(shows) as (keyof typeof shows)[]).map((k) => <Button key={k} size="xs" radius={16} variant={k === show ? 'light' : 'default'} onClick={() => setShow(k)}>{k}&nbsp;<span className="mono dim">{all.filter(shows[k]).length}</span></Button>)}</Group>
    <Load q={q}><Grid data={rows} columns={columns} meta={{ ports: q.data?.ports ?? [] }} rowKey={(r) => `${r.site}|${r.id}`} onPick={(r) => r.ip && nav(`/machines/${encodeURIComponent(r.ip)}`)} empty="No devices yet. They appear once a router plugin lists them or the sensor sees traffic." /></Load>
    {q.data && <Watched nets={q.data.networks} />}
  </div>
}

function Watched({ nets }: { nets: Inv['networks'] }) {
  const watch = useWatch()
  const [cidr, setCidr] = useState('')
  return <div className="panel" style={{ padding: 14, display: 'grid', gap: 8, maxWidth: 620 }}>
    <div className="label">Alert when a new device joins</div>
    <div className="dim" style={{ fontSize: 12 }}>Networks are found from the routers' DHCP. Guest networks start off. Devices with a private (random) MAC never alert.</div>
    {nets.length === 0 && <div className="dim">No networks found yet.</div>}
    {nets.map((n) => <Group key={n.cidr} justify="space-between"><Checkbox size="xs" label={<><span className="mono">{n.cidr}</span> <span className="dim">{n.server ?? 'added by you'}</span></>} checked={n.watched} onChange={(e) => watch.mutate({ cidr: n.cidr, on: e.currentTarget.checked })} />
      {!n.auto && <Button size="compact-xs" variant="subtle" color="red" onClick={() => watch.mutate({ cidr: n.cidr, on: false })}>Remove</Button>}</Group>)}
    <form style={{ display: 'flex', gap: 6 }} onSubmit={(e) => { e.preventDefault(); watch.mutate({ cidr: cidr.trim(), on: true }, { onSuccess: () => setCidr('') }) }}>
      <TextInput size="xs" aria-label="Range to watch" placeholder="Add a range, e.g. 192.0.2.0/24" value={cidr} onChange={(e) => setCidr(e.currentTarget.value)} /><Button size="xs" type="submit" variant="default" disabled={!cidr.trim()}>Add</Button></form>
    {watch.error && <Notice color="red" p={6}>{watch.error.message}</Notice>}
  </div>
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
    <Group justify="space-between"><div className="named"><b style={{ fontSize: 18 }}>{d?.name || ip}</b> {d?.name && <span className="mono dim" style={{ alignSelf: 'center' }}>{ip}</span>}{d && <Rename ip={ip} id={d.device?.id} name={d.device?.name ?? ''} dns={d.device?.want_dns} always />}</div><Range v={hours} set={setHours} /></Group>
    <Load q={q}>{d && <>
      {d.device && <div className="tiles">
        <div className="inset"><div className="label">MAC</div><span className="mono">{d.device.mac ?? '–'}</span>{d.device.random_mac && <div className="dim" style={{ fontSize: 11 }}>private MAC</div>}</div>
        <div className="inset"><div className="label">Calls itself</div>{d.device.hostname ?? '–'}</div>
        <div className="inset"><div className="label">Router's name</div>{d.device.router_name || '–'}{d.device.name && d.device.router_name && d.device.name !== d.device.router_name && <div style={{ color: '#f5a524', fontSize: 11 }}>differs from Redoubt's</div>}</div>
        <div className="inset"><div className="label">DNS</div>{d.device.dns.join(', ') || '–'}{d.device.static && <div className="dim" style={{ fontSize: 11 }}>fixed lease</div>}</div>
        <div className="inset"><div className="label">Switch port</div>{d.device.port ? <><span className="mono">{d.device.port}</span>{d.device.vlan !== null && <span className="dim"> · VLAN {d.device.vlan}</span>}<div className="dim" style={{ fontSize: 11 }}>{d.device.port_router}</div></> : '–'}</div>
        <div className="inset"><div className="label">First seen</div><span className="mono">{when(d.device.first_seen)}</span></div>
      </div>}
      <div className="panel" style={{ padding: 14 }}><div className="label">Bandwidth</div><Bandwidth data={d.bandwidth} h={200} /></div>
      <div><div className="label" style={{ marginBottom: 6 }}>Alerts</div><Grid data={d.alerts} columns={alertColumns} rowKey={(a) => `${a.site}|${a.sid}|${a.src}|${a.dst}`} empty="No alerts for this machine." /></div>
      <div><div className="label" style={{ marginBottom: 6 }}>First contacted in the last 24 h</div><Grid data={d.fresh} rowKey={(f) => f.dst} empty="Nothing new." columns={[
        { accessorKey: 'dst', header: 'Destination', cell: ({ row: { original: f } }) => <><span className="mono">{f.dst}</span> <span className="dim">{f.remoteName}</span></> },
        { accessorKey: 'first', header: 'First', cell: (c: any) => <span className="mono dim">{when(c.getValue())}</span> },
        { accessorKey: 'conns', header: 'Connections', meta: { right: true }, cell: num() }, { accessorKey: 'bytes', header: 'Traffic', meta: { right: true }, cell: num(bytes) }]} /></div>
      <div><div className="label" style={{ marginBottom: 6 }}>Biggest connections it started (up to 300)</div><Grid data={d.connections} columns={conns} rowKey={(c) => `${c.start}|${c.dst}|${c.dport}|${c.up}|${c.down}|${c.secs}`} empty="No connections recorded." /></div>
    </>}</Load></div>
}
