import { Button } from '@mantine/core'
import { useDecide, useHistory } from '../api.ts'
import { Applied, Grid, Load, Status, when } from '../ui.tsx'

export function History() {
  const q = useHistory()
  const m = useDecide()
  return <div className="page"><b style={{ fontSize: 18 }}>History</b> <span className="dim">every decision, newest first</span><div style={{ height: 14 }} />
    <Load q={q}><Grid data={q.data ?? []} rowKey={(d) => String(d.id)} empty="No decisions yet." columns={[
      { accessorKey: 'created', header: 'When', cell: (c: any) => <span className="mono dim">{when(c.getValue())}</span> },
      { accessorKey: 'action', header: 'Decision', cell: ({ row }) => <Status d={row.original} /> },
      { accessorKey: 'signature', header: 'Rule', cell: ({ row: { original: d } }) => <>{d.signature}<div className="mono dim">sid {d.sid}</div>{d.reason && <div className="dim" style={{ maxWidth: 520 }}>Why: {d.reason}</div>}</> },
      { id: 'pair', header: 'Machine / remote', accessorFn: (d) => d.machine, cell: ({ row: { original: d } }) => <span className="mono">{d.machine && !d.action.endsWith('_all') ? `${d.machine} / ${['allow_machine', 'silence_machine'].includes(d.action) ? 'any' : d.remote}` : 'everywhere'}</span> },
      { id: 'applied', header: 'On the device', cell: ({ row }) => <Applied d={row.original} /> },
      { accessorKey: 'user', header: 'By' },
      { id: 'undo', header: '', cell: ({ row: { original: d } }) => d.undone ? <span className="dim">undone {when(d.undone)} by {d.undone_by}{d.undo_reason && <div>Why: {d.undo_reason}</div>}</span> : <Button size="compact-xs" variant="subtle" onClick={() => m.mutate({ undo: d.id })}>Undo</Button> },
    ]} /></Load></div>
}
