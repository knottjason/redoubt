import { Alert as Notice, Autocomplete, Button, Group, Modal, Radio, SegmentedControl, Stack, TextInput } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { useState } from 'react'
import { Link } from 'react-router'
import { useDecide, useMachines, useRules, useRuleset, useToggleRule } from '../api.ts'
import { Applied, Grid, Load, Sev, when } from '../ui.tsx'
import { Range } from './Machines.tsx'

export function Rules() {
  const [view, setView] = useState<'all' | 'on' | 'off' | 'fired'>('all')
  const [find, setFind] = useState('')
  const [hours, setHours] = useState('24')
  return <div className="page"><Group justify="space-between" mb={14}><b style={{ fontSize: 18 }}>Rules</b>
    <Group>{view === 'fired' && <Range v={hours} set={setHours} />}<TextInput size="xs" aria-label="Find" placeholder="Rule, sid or class…" value={find} onChange={(e) => setFind(e.currentTarget.value)} />
      <SegmentedControl size="xs" value={view} onChange={(v) => setView(v as typeof view)} data={[{ value: 'all', label: 'All' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }, { value: 'fired', label: 'Fired' }]} /></Group></Group>
    {view === 'fired' ? <Fired find={find} hours={Number(hours)} /> : <All key={view} find={find} state={view} />}</div>
}

function All({ find, state }: { find: string; state: 'all' | 'on' | 'off' }) {
  const [needle] = useDebouncedValue(find, 300)
  const [page, setPage] = useState({ needle: '', offset: 0 })
  const offset = page.needle === needle ? page.offset : 0
  const q = useRuleset(needle, state, offset)
  const toggle = useToggleRule()
  const [ask, setAsk] = useState<Row | null>(null)
  const d = q.data
  return <Load q={q}>{!d ? <Notice color="yellow">No plugin manages rules here yet. <Link to="/plugins">Add one</Link>, or look at the rules that fired.</Notice> : <>
    <Group mb={10} gap={16} className="dim"><span>{d.on.toLocaleString()} on, {d.off.toLocaleString()} off</span><span>{d.total.toLocaleString()} shown here</span></Group>
    <Grid data={d.rows} rowKey={(r) => String(r.sid)} empty="No rule matches." columns={[
      { accessorKey: 'sid', header: 'Sid', cell: (c: any) => <span className="mono">{c.getValue()}</span> },
      { accessorKey: 'msg', header: 'Rule', cell: ({ row: { original: r } }) => <>{r.msg}<div className="dim" style={{ fontSize: 11 }}>{r.classtype}</div></> },
      { accessorKey: 'on', header: 'Sensor', cell: (c: any) => <span style={{ color: c.getValue() ? '#6fe0ad' : '#9aa4b2' }}>{c.getValue() ? 'On' : 'Off'}</span> },
      { id: 'decision', header: 'Your decision', cell: ({ row: { original: r } }) => <>
        {r.decision && <div>{r.decision.action === 'rule_on' ? 'On' : 'Off'} for everyone <Applied d={r.decision} /> <Undo id={r.decision.id} /></div>}
        {r.hosts.map((h) => <div key={h.id}>Off for {h.name || h.machine} <Applied d={h} /> <Undo id={h.id} /></div>)}
        {!r.decision && !r.hosts.length && <span className="dim">None</span>}</> },
      { id: 'do', header: '', meta: { right: true }, cell: ({ row: { original: r } }) => !r.decision && <Button size="compact-xs" variant="default" onClick={() => { toggle.reset(); setAsk(r) }}>{r.on ? 'Turn off…' : 'Turn on…'}</Button> },
    ]} />
    <Group mt={12}><Button size="xs" variant="default" disabled={!offset} onClick={() => setPage({ needle, offset: Math.max(0, offset - 100) })}>Previous</Button>
      <span className="dim">{d.total ? offset + 1 : 0} to {Math.min(offset + 100, d.total)}</span>
      <Button size="xs" variant="default" disabled={offset + 100 >= d.total} onClick={() => setPage({ needle, offset: offset + 100 })}>Next</Button></Group>
    <Modal opened={!!ask} onClose={() => setAsk(null)} title={ask && `${ask.on ? 'Turn off' : 'Turn on'} rule ${ask.sid}`}>{ask && <Scope r={ask} toggle={toggle} done={() => setAsk(null)} />}</Modal>
  </>}</Load>
}

type Row = NonNullable<NonNullable<ReturnType<typeof useRuleset>['data']>>['rows'][number]

function Undo({ id }: { id: number }) {
  const m = useDecide()
  return <Button size="compact-xs" variant="subtle" loading={m.isPending} onClick={() => m.mutate({ undo: id })}>Undo</Button>
}

function Scope({ r, toggle, done }: { r: Row; toggle: ReturnType<typeof useToggleRule>; done: () => void }) {
  const [scope, setScope] = useState<'host' | 'all'>(r.on ? 'host' : 'all')
  const [host, setHost] = useState('')
  const machines = useMachines(720).data ?? []
  const labels = machines.map((m) => ({ ip: m.ip, text: m.name ? `${m.name} (${m.ip})` : m.ip }))
  const ip = labels.find((l) => l.text === host)?.ip ?? host.trim()
  const go = () => toggle.mutate({ sid: r.sid, on: !r.on, signature: r.msg.slice(0, 300), ...(scope === 'host' && { machine: ip }) }, { onSuccess: done })
  return <Stack gap={14}>
    <div>{r.msg}</div>
    {r.on && <Radio.Group value={scope} onChange={(v) => setScope(v as typeof scope)}><Stack gap={8}>
      <Radio value="host" label="One host: the rule stays on for everyone else" />
      <Radio value="all" label="Whole rule: off for everyone" /></Stack></Radio.Group>}
    {scope === 'host' && <><Autocomplete label="Host" placeholder="Name or address" data={[...new Set(labels.map((l) => l.text))]} value={host} onChange={setHost} limit={30} />
      <div className="dim">It follows the address, so give that host a fixed one.</div></>}
    <div className="dim">{r.on ? 'The sensor records nothing for what you turn off.' : 'Turns the rule on for everyone.'} Takes up to a minute.</div>
    {toggle.error && <Notice color="red">{toggle.error.message}</Notice>}
    <Group><Button loading={toggle.isPending} disabled={scope === 'host' && !ip} onClick={go}>{r.on ? 'Turn off' : 'Turn on'}</Button><Button variant="default" onClick={done}>Cancel</Button></Group>
  </Stack>
}

function Fired({ find, hours }: { find: string; hours: number }) {
  const q = useRules(hours)
  const n = (c: { getValue: () => any }) => <span className="mono">{c.getValue()}</span>
  return <Load q={q}><Grid data={(q.data ?? []).filter((r) => `${r.sid} ${r.signature} ${r.category}`.toLowerCase().includes(find.toLowerCase()))} rowKey={(r) => String(r.sid)} empty="No rule fired." columns={[
    { accessorKey: 'severity', header: 'Sev', cell: (c: any) => <Sev s={c.getValue()} /> },
    { accessorKey: 'signature', header: 'Rule', cell: ({ row: { original: r } }) => <>{r.signature.startsWith('SURICATA ') ? <>{r.signature} <span className="dim">(sensor message, hidden on Alerts)</span></> : <Link to={`/alerts?find=${r.sid}`}>{r.signature}</Link>}<div className="dim" style={{ fontSize: 11 }}>{r.category}</div></> },
    { accessorKey: 'sid', header: 'Sid', cell: n }, { accessorKey: 'hits', header: 'Hits', meta: { right: true }, cell: n }, { accessorKey: 'pairs', header: 'Pairs', meta: { right: true }, cell: n },
    { accessorKey: 'last', header: 'Last', cell: (c: any) => <span className="mono dim">{when(c.getValue())}</span> }]} /></Load>
}
