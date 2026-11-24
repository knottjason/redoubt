import { useState, type ReactNode } from 'react'
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from '@tanstack/react-table'
import { AreaChart } from '@mantine/charts'
import { Alert as Notice, Badge, Loader } from '@mantine/core'
import { Link } from 'react-router'
import type { Alert } from './api.ts'

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
  allow: ['Allowed', '#6fe0ad', '#12291f'], silence_machine: ['Silenced · machine', '#9aa4b2', '#1b222b'],
  silence_all: ['Silenced · all', '#9aa4b2', '#1b222b'], block: ['Block requested', '#ff8a8a', '#2a1416'],
} as const
export function Status({ d }: { d: Alert['decision'] }) {
  const [t, c, b] = d ? status[d.action] : (['Open', '#e6e9ee', '#1b222b'] as const)
  return <Badge radius={4} size="sm" tt="none" styles={{ root: { color: c, background: b } }}>{t}</Badge>
}
export const NewTag = () => <span style={{ color: '#f5a524', fontWeight: 600, fontSize: 11 }}>NEW</span>

export function Machine({ ip, name }: { ip: string; name: string }) {
  return <Link to={`/machines/${encodeURIComponent(ip)}`} onClick={(e) => e.stopPropagation()}>{name || ip}{name && <div className="mono dim">{ip}</div>}</Link>
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
