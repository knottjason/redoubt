import { Button } from '@mantine/core'
import { useDecide, useHistory } from '../api.ts'
import { Grid, Load, Status, when } from '../ui.tsx'

export function History() {
  const q = useHistory()
  const m = useDecide()
  return <div className="page"><b style={{ fontSize: 18 }}>History</b> <span className="dim">every decision, newest first; nothing is enforced yet</span><div style={{ height: 14 }} />
    <Load q={q}><Grid data={q.data ?? []} rowKey={(d) => String(d.id)} empty="No decisions yet." columns={[
      { accessorKey: 'created', header: 'When', cell: (c: any) => <span className="mono dim">{when(c.getValue())}</span> },
      { accessorKey: 'action', header: 'Decision', cell: ({ row }) => <Status d={row.original} /> },
      { accessorKey: 'signature', header: 'Rule', cell: ({ row: { original: d } }) => <>{d.signature}<div className="mono dim">sid {d.sid}</div></> },
      { id: 'pair', header: 'Machine / remote', accessorFn: (d) => d.machine, cell: ({ row: { original: d } }) => <span className="mono">{d.machine} / {d.remote}</span> },
      { accessorKey: 'user', header: 'By' },
      { id: 'undo', header: '', cell: ({ row: { original: d } }) => d.undone ? <span className="dim">undone {when(d.undone)} by {d.undone_by}</span> : <Button size="compact-xs" variant="subtle" onClick={() => m.mutate({ undo: d.id })}>Undo</Button> },
    ]} /></Load></div>
}
