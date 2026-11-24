import { Group, TextInput } from '@mantine/core'
import { useState } from 'react'
import { Link } from 'react-router'
import { useRules } from '../api.ts'
import { Grid, Load, Sev, when } from '../ui.tsx'
import { Range } from './Machines.tsx'

export function Rules() {
  const [hours, setHours] = useState('24')
  const [find, setFind] = useState('')
  const q = useRules(Number(hours))
  const n = (c: { getValue: () => any }) => <span className="mono">{c.getValue()}</span>
  return <div className="page"><Group justify="space-between" mb={14}><div><b style={{ fontSize: 18 }}>Rules</b> <span className="dim">rules that fired; turning rules on and off is not built yet</span></div>
    <Group><TextInput size="xs" aria-label="Find" placeholder="Rule or sid…" value={find} onChange={(e) => setFind(e.currentTarget.value)} /><Range v={hours} set={setHours} /></Group></Group>
    <Load q={q}><Grid data={(q.data ?? []).filter((r) => `${r.sid} ${r.signature} ${r.category}`.toLowerCase().includes(find.toLowerCase()))} rowKey={(r) => String(r.sid)} empty="No rule fired." columns={[
      { accessorKey: 'severity', header: 'Sev', cell: (c: any) => <Sev s={c.getValue()} /> },
      { accessorKey: 'signature', header: 'Rule', cell: ({ row: { original: r } }) => <>{r.signature.startsWith('SURICATA ') ? <>{r.signature} <span className="dim">(sensor message, hidden on Alerts)</span></> : <Link to={`/alerts?find=${r.sid}`}>{r.signature}</Link>}<div className="dim" style={{ fontSize: 11 }}>{r.category}</div></> },
      { accessorKey: 'sid', header: 'Sid', cell: n }, { accessorKey: 'hits', header: 'Hits', meta: { right: true }, cell: n }, { accessorKey: 'pairs', header: 'Pairs', meta: { right: true }, cell: n },
      { accessorKey: 'last', header: 'Last', cell: (c: any) => <span className="mono dim">{when(c.getValue())}</span> }]} /></Load></div>
}
