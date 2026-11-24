import { Alert as Notice, Button, Stack } from '@mantine/core'
import { type Action, type Alert, useDecide, useDetail } from './api.ts'
import { Bandwidth, Load, Machine, NewTag, Sev, Status, bytes, sevColor, when } from './ui.tsx'

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
      <div className="label">Decide</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Button h={40} color="teal" variant="light" loading={m.isPending} onClick={() => go('allow')}>Allow</Button>
        <Button h={40} color="red" variant="light" disabled={!a.blockable} loading={m.isPending} onClick={() => go('block')}>Request block</Button>
        <Button h={40} variant="default" loading={m.isPending} onClick={() => go('silence_machine')}>Silence for machine</Button>
        <Button h={40} variant="default" loading={m.isPending} onClick={() => go('silence_all')}>Silence everywhere</Button>
      </div>
      <div className="dim">{note} <b>Decisions are recorded only for now: nothing is enforced yet.</b></div>
      {m.error && <Notice color="red">{m.error.message}</Notice>}
      {a.decision && <Button size="xs" variant="subtle" style={{ alignSelf: 'flex-start' }} onClick={() => m.mutate({ undo: a.decision!.id })}>Undo decision by {a.decision.user}</Button>}
    </Stack>
  )
}
