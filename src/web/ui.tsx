import { useState, type ReactNode } from 'react'
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from '@tanstack/react-table'
import { AreaChart } from '@mantine/charts'
import { ActionIcon, Alert as Notice, Badge, Button, Checkbox, Group, Loader, Popover, TextInput } from '@mantine/core'
import { Link } from 'react-router'
import { useRename, type Alert } from './api.ts'

export const bytes = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++ }
  return `${i ? n.toFixed(n < 10 ? 1 : 0) : n} ${u[i]}`
}
export const when = (iso: string | null) => {
  if (!iso) return '–'
  const d = new Date(iso)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

const sev = { 1: ['HIGH', '#ff6b6b', '#2a1416'], 2: ['MED', '#f5a524', '#2a2112'], 3: ['LOW', '#9aa4b2', '#1b222b'] } as const
export const sevColor = (s: number) => (sev[s as 1 | 2 | 3] ?? sev[3])[1]
export function Sev({ s }: { s: number }) {
  const [t, c, b] = sev[s as 1 | 2 | 3] ?? sev[3]
  return <Badge radius={4} size="sm" styles={{ root: { color: c, background: b, minWidth: 46 } }}>{t}</Badge>
}
const status = {
  allow: ['Allowed', '#6fe0ad', '#12291f'], allow_machine: ['Allowed · machine', '#6fe0ad', '#12291f'], silence_machine: ['Silenced · machine', '#9aa4b2', '#1b222b'],
  allow_all: ['Allowed · all', '#6fe0ad', '#12291f'], silence_all: ['Silenced · all', '#9aa4b2', '#1b222b'], rule_off: ['Rule off', '#9aa4b2', '#1b222b'], rule_on: ['Rule on', '#6fe0ad', '#12291f'], block: ['Block requested', '#ff8a8a', '#2a1416'],
} as const
export function Status({ d }: { d: Alert['decision'] }) {
  const [t, c, b] = d ? status[d.action] : (['Open', '#e6e9ee', '#1b222b'] as const)
  return <Badge radius={4} size="sm" tt="none" styles={{ root: { color: c, background: b } }}>{t}</Badge>
}
const appliedText = { requested: 'Requested', active: 'Active', failed: 'Failed', removing: 'Removing', removed: 'Removed' } as const
export function Applied({ d }: { d: { applied: { state: keyof typeof appliedText; error: string; plugin: string } | null } }) {
  if (!d.applied) return <span className="dim">Recorded only</span>
  const { state, error, plugin } = d.applied
  return <span title={error} style={{ color: state === 'failed' || error ? '#ff8a8a' : state === 'active' ? '#6fe0ad' : '#f5a524' }}>{appliedText[state]} · {plugin}{!error && (state === 'requested' || state === 'removing') && <div className="dim" style={{ fontSize: 11 }}>Working, up to a minute</div>}{error && <div style={{ fontSize: 11 }}>{error}</div>}</span>
}
export const NewTag = () => <span style={{ color: '#f5a524', fontWeight: 600, fontSize: 11 }}>NEW</span>

export function Machine({ ip, name }: { ip: string; name: string }) {
  return <span className="named"><Link to={`/machines/${encodeURIComponent(ip)}`} onClick={(e) => e.stopPropagation()}>{name || ip}{name && <div className="mono dim">{ip}</div>}</Link><Rename ip={ip} name={name} /></span>
}

/** Name a device from wherever its name shows. Only addresses inside the network can be named. */
export function Rename({ ip, id, name, label, dns = false, always }: { ip?: string; id?: number; name: string; label?: string; dns?: boolean; always?: boolean }) {
  const [open, setOpen] = useState(false)
  const [v, setV] = useState(name)
  const [d, setD] = useState(dns)
  const save = useRename()
  return <Popover opened={open} onChange={setOpen} position="bottom-start" withArrow trapFocus>
    <Popover.Target><ActionIcon className={always ? undefined : 'pencil'} variant="subtle" size="sm" color="gray" aria-label={`Name ${label || name || ip || 'this device'}`} onClick={(e) => { e.stopPropagation(); setV(name); setD(dns); save.reset(); setOpen((o) => !o) }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" /></svg>
    </ActionIcon></Popover.Target>
    <Popover.Dropdown onClick={(e) => e.stopPropagation()}>
      <form style={{ display: 'grid', gap: 10, width: 260 }} onSubmit={(e) => { e.preventDefault(); save.mutate({ ...(id !== undefined ? { id } : { ip }), name: v, dns: d }, { onSuccess: () => setOpen(false) }) }}>
        <TextInput size="xs" label="Name" data-autofocus placeholder={label || ip} value={v} maxLength={60} onChange={(e) => setV(e.currentTarget.value)} />
        <Checkbox size="xs" label="Also a DNS name (fixes its address)" checked={d} onChange={(e) => setD(e.currentTarget.checked)} />
        <div className="dim" style={{ fontSize: 11 }}>Leave empty to use the router's name.</div>
        {save.error && <Notice color="red" p={6}>{save.error.message}</Notice>}
        <Group justify="flex-end" gap={6}><Button size="compact-xs" variant="default" onClick={() => setOpen(false)}>Cancel</Button><Button size="compact-xs" type="submit" loading={save.isPending}>Save</Button></Group>
      </form>
    </Popover.Dropdown>
  </Popover>
}

export function Load({ q, children }: { q: { isPending: boolean; error: Error | null }; children: ReactNode }) {
  if (q.error) return <Notice color="red" title="Could not load">{q.error.message}</Notice>
  if (q.isPending) return <Loader size="sm" m="lg" />
  return children
}

export function Grid<T>({ data, columns, onPick, selected, rowKey, empty = 'Nothing here.' }: {
  data: T[]; columns: ColumnDef<T, any>[]; onPick?: (row: T) => void; selected?: string; rowKey: (row: T) => string; empty?: string
}) {
  const [sorting, setSorting] = useState<SortingState>([])
  const table = useReactTable({ data, columns, state: { sorting }, onSortingChange: setSorting, getRowId: rowKey, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() })
  const right = (c: ColumnDef<T, any>) => ((c.meta as { right?: boolean } | undefined)?.right ? 'r' : undefined)
  return (
    <div className="panel scroll">
      <table className="grid">
        <thead>{table.getHeaderGroups().map((g) => <tr key={g.id}>{g.headers.map((h) => (
          <th key={h.id} className={right(h.column.columnDef)}>
            <button onClick={h.column.getToggleSortingHandler()}>{flexRender(h.column.columnDef.header, h.getContext())}{{ asc: ' ↑', desc: ' ↓' }[h.column.getIsSorted() as string] ?? ''}</button>
          </th>))}</tr>)}</thead>
        <tbody>{table.getRowModel().rows.map((r) => (
          <tr key={r.id} className={`${onPick ? 'click' : ''} ${selected === r.id ? 'sel' : ''}`} tabIndex={onPick ? 0 : undefined}
            onClick={() => onPick?.(r.original)} onKeyDown={(e) => { if (onPick && e.key === 'Enter') onPick(r.original) }}>
            {r.getVisibleCells().map((c) => <td key={c.id} className={right(c.column.columnDef)}>{flexRender(c.column.columnDef.cell, c.getContext())}</td>)}
          </tr>))}</tbody>
      </table>
      {data.length === 0 && <div className="dim" style={{ padding: 28, textAlign: 'center' }}>{empty}</div>}
    </div>
  )
}

export function Bandwidth({ data, h = 160 }: { data: { t: string; down: number; up: number }[]; h?: number }) {
  if (!data.length) return <div className="dim">No traffic recorded yet.</div>
  return <AreaChart h={h} data={data.map((d) => ({ ...d, t: when(d.t) }))} dataKey="t" withDots={false} curveType="linear" strokeWidth={1.5} gridAxis="y" valueFormatter={bytes}
    series={[{ name: 'down', label: 'Down', color: 'accent.5' }, { name: 'up', label: 'Up', color: '#f5a524' }]} yAxisProps={{ width: 62 }} xAxisProps={{ minTickGap: 40 }} />
}
