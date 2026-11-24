import { Alert as Notice, Button, Stack } from '@mantine/core'
import type { ReactNode } from 'react'
import { type Action, type Alert, useDecide, useDetail } from './api.ts'
import { Applied, Bandwidth, Load, Machine, NewTag, Sev, Status, bytes, sevColor, when } from './ui.tsx'

function Choice({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return <div><div className="label" style={{ marginBottom: 6 }}>{title} <span style={{ textTransform: 'none', letterSpacing: 0 }}>· {note}</span></div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: 8 }}>{children}</div></div>
}

export function Detail({ a }: { a: Alert }) {
  const q = useDetail(a)
  const m = useDecide()
  const who = a.machineName || a.machine
  const go = (action: Action) => m.mutate({ action, alert: a })
  const note = !a.blockable
    ? `Block is off: ${a.remote} is an internal address, and Redoubt never blocks inside the network.`
    : a.direction === 'out'
      ? `Block will mean ${who} cannot reach ${a.remote} on any port. Other machines are unaffected.`
      : `Block will mean ${a.remote} is dropped at the firewall for every machine.`
  const max = Math.max(1, ...(q.data?.bars ?? []))
  return (
    <Stack gap={16}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><Sev s={a.severity} /><span className="mono dim">sid {a.sid}</span><span style={{ flex: 1 }} /><Status d={a.decision} /></div>
      <h2 style={{ margin: 0, fontSize: 16, lineHeight: 1.35 }}>{a.signature}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div className="inset"><div className="label">Machine</div><Machine ip={a.machine} name={a.machineName} /></div>
        <div className="inset"><div className="label">Remote · {{ in: 'inbound', out: 'outbound', internal: 'internal' }[a.direction]}</div><div className="mono" style={{ whiteSpace: 'normal' }}>{a.remote}</div><div className="dim">{a.remoteName || q.data?.sites[0]}</div></div>
      </div>
      <Load q={q}>{q.data && <>
        <div className="inset"><div className="label">Has this happened before?</div>
          {q.data.pair ? <>{a.isNew && <><NewTag /> </>}First contact {when(q.data.pair.first)}, last {when(q.data.pair.last)}. {q.data.pair.connections} connections, {bytes(q.data.pair.bytes)}.</>
            : 'No finished connection between these two is recorded yet.'}
        </div>
        <div><div className="label">Hits, last 24 h</div><div className="inset bars">{q.data.bars.map((v, i) => <i key={i} title={`${23 - i} h ago: ${v}`} style={{ height: `${(v / max) * 100}%`, background: v ? sevColor(a.severity) : '#252c35' }} />)}</div></div>
        <div><div className="label">Bandwidth of {who}, 24 h</div><Bandwidth data={q.data.bandwidth} h={120} /></div>
        <div><div className="label">What else it was doing (±15 min)</div>
          {q.data.around.length === 0 ? <div className="dim">Nothing else finished in that window.</div> : q.data.around.map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}><span className="mono">{f.dst}:{f.dport}</span><span className="mono dim">{bytes(Number(f.bytes))} · {when(f.start)}</span></div>))}
        </div>
        <div><div className="label">Payload</div><div className="inset dim">Not collected yet.</div></div>
      </>}</Load>
      <Choice title="Allow" note="Leaves Open. The sensor keeps a record.">
        <Button h={40} px={6} color="teal" variant="light" loading={m.isPending} onClick={() => go('allow')}>This pair</Button>
        <Button h={40} px={6} color="teal" variant="light" loading={m.isPending} onClick={() => go('allow_machine')}>This host only</Button>
        <Button h={40} px={6} color="teal" variant="light" loading={m.isPending} onClick={() => go('allow_all')}>Everyone</Button>
      </Choice>
      <Choice title="Turn the rule off" note="The sensor stops recording it.">
        <Button h={40} px={6} variant="default" loading={m.isPending} onClick={() => go('silence_machine')}>This host only</Button>
        <Button h={40} px={6} variant="default" loading={m.isPending} onClick={() => { if (confirm(`Turn rule ${a.sid} off in the sensor for every machine? It records nothing while off.`)) go('silence_all') }}>Everyone</Button>
      </Choice>
      {q.data?.samples[0]?.dport === 53 && <Notice color="yellow">This is a DNS lookup, so "{who}" may be your DNS server asking for someone else. A choice for this host would then cover every machine behind it.</Notice>}
      <Choice title="Block" note="Drops traffic once a firewall plugin is connected; until then it is only recorded."><Button h={40} px={6} color="red" variant="light" disabled={!a.blockable} loading={m.isPending} onClick={() => { if (confirm(`${note} Block it?`)) go('block') }}>Block</Button></Choice>
      <div className="dim">{note} Host choices follow the address, so give that host a fixed one.</div>
      {m.error && <Notice color="red">{m.error.message}</Notice>}
      {a.decision && <div><Applied d={a.decision} /></div>}
      {a.decision && <Button size="xs" variant="subtle" style={{ alignSelf: 'flex-start' }} onClick={() => m.mutate({ undo: a.decision!.id })}>Undo decision by {a.decision.user}</Button>}
    </Stack>
  )
}
