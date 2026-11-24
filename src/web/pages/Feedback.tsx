import { Button } from '@mantine/core'
import { useCloseGap, useGaps } from '../agent-api.ts'
import { Grid, Load, when } from '../ui.tsx'

/** Gaps the agents ran into: missing tools, confusing data, workarounds. Stays on this machine. */
export function Feedback() {
  const q = useGaps()
  const close = useCloseGap()
  return <div className="page"><b style={{ fontSize: 18 }}>Feedback</b> <span className="dim">what the agents found missing or confusing</span><div style={{ height: 14 }} />
    <Load q={q}><Grid data={q.data ?? []} rowKey={(g) => String(g.id)} empty="Nothing reported yet." columns={[
      { accessorKey: 'created', header: 'When', cell: (c: any) => <span className="mono dim">{when(c.getValue())}</span> },
      { accessorKey: 'title', header: 'Gap', cell: ({ row: { original: g } }) => <><b>{g.title}</b><div className="dim" style={{ whiteSpace: 'pre-wrap', maxWidth: 720 }}>{g.details}</div></> },
      { accessorKey: 'reporter', header: 'From' },
      { id: 'x', header: '', cell: ({ row: { original: g } }) => g.closed ? <span className="dim">done {when(g.closed)}</span> : <Button size="compact-xs" variant="subtle" onClick={() => close.mutate(g.id)}>Done</Button> },
    ]} /></Load></div>
}
