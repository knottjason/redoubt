import { Button, Group, SegmentedControl, TextInput } from '@mantine/core'
import type { ColumnDef } from '@tanstack/react-table'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { type Alert, useAlerts } from '../api.ts'
import { Detail } from '../Detail.tsx'
import { Grid, Load, Machine, NewTag, Sev, Status, when } from '../ui.tsx'

const key = (a: Alert) => `${a.site}|${a.sid}|${a.src}|${a.dst}`
export const alertColumns: ColumnDef<Alert, any>[] = [
  { id: 'severity', accessorKey: 'severity', header: 'Sev', cell: (c) => <Sev s={c.row.original.severity} /> },
  { id: 'signature', accessorKey: 'signature', header: 'Rule', cell: ({ row: { original: a } }) => <><div className="clip" title={a.signature}>{a.signature}</div><div className="dim" style={{ fontSize: 11 }}>{a.category} {a.isNew && <NewTag />}</div></> },
  { id: 'machine', accessorFn: (a) => a.machineName || a.machine, header: 'Machine', cell: ({ row: { original: a } }) => <Machine ip={a.machine} name={a.machineName} /> },
  { id: 'remote', accessorKey: 'remote', header: 'Remote', cell: ({ row: { original: a } }) => <><span className="mono">{{ in: '←', out: '→', internal: '↔' }[a.direction]} {a.remote}</span><div className="dim">{a.remoteName}</div></> },
  { id: 'hits', accessorKey: 'hits', header: 'Hits', meta: { right: true }, cell: (c) => <span className="mono">{c.getValue()}</span> },
  { id: 'last', accessorKey: 'last', header: 'Last', cell: (c) => <span className="mono dim">{when(c.getValue())}</span> },
  { id: 'status', accessorFn: (a) => a.decision?.action ?? '', header: 'Status', cell: ({ row: { original: a } }) => <Status d={a.decision} /> },
]

const filters = { Open: (a: Alert) => !a.decision, Allowed: (a: Alert) => a.decision?.action === 'allow', Silenced: (a: Alert) => !!a.decision?.action.startsWith('silence'), Blocked: (a: Alert) => a.decision?.action === 'block' }

export function Alerts() {
  const [hours, setHours] = useState('24')
  const [filter, setFilter] = useState<keyof typeof filters>('Open')
  const [find, setFind] = useState(useSearchParams()[0].get('find') ?? '')
  const [sel, setSel] = useState<string>()
  const q = useAlerts(Number(hours))
  const all = q.data ?? []
  const f = find.toLowerCase()
  const rows = all.filter(filters[filter]).filter((a) => !f || [a.signature, a.machine, a.machineName, a.remote, a.remoteName, String(a.sid)].some((v) => v.toLowerCase().includes(f)))
  const current = all.find((a) => key(a) === sel) ?? rows[0]
  return (
    <div className="split">
      <main>
        <Group justify="space-between" mb={14}><div><b style={{ fontSize: 18 }}>Alerts</b> <span className="dim">grouped by rule + machine + remote</span></div>
          <SegmentedControl size="xs" value={hours} onChange={setHours} data={[{ value: '1', label: '1 h' }, { value: '24', label: '24 h' }, { value: '168', label: '7 d' }, { value: '720', label: '30 d' }]} /></Group>
        <Group mb={14} gap={6}>{(Object.keys(filters) as (keyof typeof filters)[]).map((k) => <Button key={k} size="xs" radius={16} variant={k === filter ? 'light' : 'default'} onClick={() => { setFilter(k); setSel(undefined) }}>{k}&nbsp;<span className="mono dim">{all.filter(filters[k]).length}</span></Button>)}
          <TextInput size="xs" ml="auto" aria-label="Find" placeholder="IP, machine, rule…" value={find} onChange={(e) => setFind(e.currentTarget.value)} /></Group>
        <Load q={q}><Grid data={rows} columns={alertColumns} rowKey={key} selected={current && key(current)} onPick={(a) => setSel(key(a))} empty="Nothing here. Quiet is good." /></Load>
      </main>
      <aside aria-label="Alert detail">{current ? <Detail key={key(current)} a={current} /> : <span className="dim">No alert selected.</span>}</aside>
    </div>
  )
}
