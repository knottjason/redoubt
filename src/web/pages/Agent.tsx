import { useChat } from '@ai-sdk/react'
import { Alert as Notice, Button, Checkbox, Group, Select, Textarea } from '@mantine/core'
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { clearChat, stopChat, useHistory, useModels } from '../agent-api.ts'
import { Markdown } from '../Markdown.tsx'
import { Load } from '../ui.tsx'
import { Connect } from './Connect.tsx'

type Part = Record<string, any>
const toolName = (p: Part) => (p.type === 'dynamic-tool' ? p.toolName : String(p.type).slice(5)) as string
const isTool = (p: Part) => p.type === 'dynamic-tool' || String(p.type).startsWith('tool-')

const said: Record<string, string> = {
  allow: 'Allow this pair', allow_machine: 'Allow this rule for the machine', allow_all: 'Allow this rule everywhere',
  silence_machine: 'Silence this rule for the machine', silence_all: 'Silence this rule for everyone', block: 'Block the remote address',
}
function describe(p: Part): { what: string; detail: string } {
  const i = p.input ?? {}
  switch (toolName(p)) {
    case 'decide_alert': return { what: said[i.action] ?? i.action, detail: `${i.src} → ${i.dst} · sid ${i.sid} ${i.signature ?? ''}` }
    case 'set_rule': return { what: i.on ? 'Turn rule on' : i.machine ? 'Turn rule off for one machine' : 'Turn rule off', detail: `sid ${i.sid} ${i.signature ?? ''}${i.machine ? ` · ${i.machine}` : ''}` }
    case 'undo_decision': return { what: 'Undo decision', detail: `#${i.id}` }
    case 'rename_device': return { what: i.name ? `Name it "${i.name}"` : 'Clear its name', detail: i.ip ?? `device #${i.id}` }
    default: return { what: toolName(p), detail: JSON.stringify(i) }
  }
}

/** Every change the agent proposed in its latest reply, on one card. Untick to leave one out. */
function Plan({ parts, answer }: { parts: Part[]; answer: (yes: Set<string>) => void }) {
  const [off, setOff] = useState<Set<string>>(new Set())
  const n = parts.length - off.size
  return <div className="panel" style={{ padding: 14, display: 'grid', gap: 10, borderColor: '#4c8dff' }}>
    <div className="label">Proposed changes</div>
    {parts.map((p) => {
      const d = describe(p)
      const id = p.approval.id as string
      return <Checkbox key={id} checked={!off.has(id)} onChange={(e) => { const s = new Set(off); if (e.currentTarget.checked) s.delete(id); else s.add(id); setOff(s) }}
        label={<div><b>{d.what}</b> <span className="mono dim">{d.detail}</span>{p.input?.reason && <div className="dim">{p.input.reason}</div>}</div>} />
    })}
    <Group>
      <Button disabled={n === 0} onClick={() => answer(new Set(parts.map((p) => p.approval.id).filter((id) => !off.has(id))))}>{off.size === 0 ? 'Approve all' : `Approve (${n})`}</Button>
      <Button variant="subtle" color="gray" onClick={() => answer(new Set())}>Deny all</Button>
    </Group>
  </div>
}

const titles: Record<string, string> = {
  get_overview: 'Overview', get_status: 'Sensor status', list_alerts: 'Alerts', get_alert: 'Alert detail', list_rules_fired: 'Rules that fired',
  search_ruleset: 'Rule set search', list_machines: 'Machines', get_machine: 'Machine', list_devices: 'Devices', list_device_records: 'Device records',
  list_plugins: 'Plugins', list_decisions: 'Decisions', describe_tables: 'Database tables', query_sql: 'SQL query', report_gap: 'Reported a gap',
  decide_alert: 'Decision', set_rule: 'Rule change', undo_decision: 'Undo', rename_device: 'Rename device',
}
const changeTools = new Set(['decide_alert', 'set_rule', 'undo_decision', 'rename_device'])

/** The MCP result's text, parsed when it is JSON. */
function resultOf(p: Part): { value: unknown; error: string | null } {
  if (p.state === 'output-error') return { value: null, error: String(p.errorText ?? 'Failed') }
  const o = p.output as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined
  const text = o?.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') ?? (o === undefined ? '' : JSON.stringify(o))
  if (o?.isError) return { value: null, error: text || 'Failed' }
  try { return { value: JSON.parse(text), error: null } } catch { return { value: text, error: null } }
}
const short = (v: unknown) => { const t = typeof v === 'string' ? v : JSON.stringify(v); return t.length > 40 ? `${t.slice(0, 40)}…` : t }
function argSummary(name: string, i: Record<string, unknown>) {
  if (name === 'query_sql') return short(i.query)
  return Object.entries(i).filter(([k, v]) => k !== 'reason' && v !== undefined && v !== '' && v !== false).map(([k, v]) => `${k} ${short(v)}`).join(' · ')
}
function rowsOf(v: unknown): Record<string, unknown>[] | null {
  const r = Array.isArray(v) ? v : v && typeof v === 'object' ? ((v as { rows?: unknown }).rows ?? (v as { devices?: unknown }).devices) : null
  return Array.isArray(r) && r.length && r.every((x) => x && typeof x === 'object' && !Array.isArray(x)) ? r as Record<string, unknown>[] : null
}
const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
function ResultView({ value }: { value: unknown }) {
  const rows = rowsOf(value)
  if (rows) {
    const cols = Object.keys(rows[0]!).filter((k) => rows.some((r) => typeof r[k] !== 'object' || r[k] === null)).slice(0, 7)
    return <><div className="scroll" style={{ maxHeight: 320, border: '1px solid #222a33', borderRadius: 6 }}><table className="grid"><thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
      <tbody>{rows.slice(0, 50).map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} className="mono">{cell(r[c]).slice(0, 80)}</td>)}</tr>)}</tbody></table></div>
      <span className="dim">{rows.length > 50 ? `First 50 of ${rows.length} rows` : `${rows.length} row${rows.length === 1 ? '' : 's'}`}{cols.length < Object.keys(rows[0]!).length ? ', some columns hidden' : ''}</span></>
  }
  return <pre className="mono">{typeof value === 'string' ? value : JSON.stringify(value, null, 2).slice(0, 20_000)}</pre>
}

function ToolBlock({ p }: { p: Part }) {
  const [open, setOpen] = useState(false)
  const name = toolName(p)
  const input = (p.input ?? {}) as Record<string, unknown>
  const { value, error } = resultOf(p)
  const denied = p.state === 'output-denied' || p.approval?.approved === false
  const waiting = p.state === 'approval-requested'
  const running = !denied && !waiting && !error && p.state !== 'output-available'
  const [icon, color, status] = denied ? ['✕', '#9aa4b2', 'denied'] : error ? ['!', '#ff8a8a', 'failed'] : waiting ? ['?', '#f5a524', 'waiting for you'] : running ? ['•', '#4c8dff', 'running…'] : ['✓', changeTools.has(name) ? '#6fe0ad' : '#6b7685', '']
  const count = rowsOf(value)?.length
  return <div className="tool">
    <button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span style={{ color, width: 12, textAlign: 'center', fontWeight: 700 }}>{icon}</span>
      <span style={{ fontWeight: 500 }}>{titles[name] ?? name}</span>
      <span className="mono dim" style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: 1 }}>{argSummary(name, input)}</span>
      {status ? <span style={{ color, fontSize: 11 }}>{status}</span> : count !== undefined && <span className="dim" style={{ fontSize: 11 }}>{count} rows</span>}
      <span className="dim" style={{ fontSize: 10 }}>{open ? '▴' : '▾'}</span>
    </button>
    {open && <div className="tool-body">
      {typeof input.reason === 'string' && <div><span className="label">Why</span><div>{input.reason}</div></div>}
      <div><span className="label">Asked</span><pre className="mono">{name === 'query_sql' ? String(input.query) : JSON.stringify(input, null, 2)}</pre></div>
      {error && <div><span className="label">Error</span><pre className="mono" style={{ color: '#ff8a8a' }}>{error}</pre></div>}
      {!error && p.state === 'output-available' && <div><span className="label">Result</span><ResultView value={value} /></div>}
      {denied && <div className="dim">You did not approve this, so it was not run.</div>}
    </div>}
  </div>
}

/** Consecutive tool calls share one box. */
function Parts({ parts }: { parts: Part[] }) {
  const out: ReactNode[] = []
  let group: Part[] = []
  const flush = (k: number) => { if (group.length) out.push(<div key={`g${k}`} className="tools">{group.map((p) => <ToolBlock key={p.toolCallId} p={p} />)}</div>); group = [] }
  parts.forEach((p, i) => {
    if (isTool(p)) { group.push(p); return }
    flush(i)
    if (p.type === 'text' && p.text) out.push(<Markdown key={i} text={p.text} />)
  })
  flush(parts.length)
  return <>{out}</>
}

function Chat({ initial, summarizedUpTo }: { initial: UIMessage[]; summarizedUpTo: string | null }) {
  const models = useModels()
  const [model, setModel] = useState<string | null>(() => { try { return localStorage.getItem('agent-model') } catch { return null } })
  const chosen = models.data?.find((m) => m.id === model)?.id ?? models.data?.[0]?.id ?? null
  const modelRef = useRef(chosen)
  modelRef.current = chosen
  const transport = useMemo(() => new DefaultChatTransport({
    api: '/api/agent/chat',
    // The server holds the conversation; send only what is new.
    prepareSendMessagesRequest: ({ messages }) => ({ body: { model: modelRef.current, message: messages.at(-1) } }),
  }), [])
  const { messages, sendMessage, addToolApprovalResponse, status, error, setMessages, stop } = useChat({ messages: initial, transport, sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses })
  const [text, setText] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [messages.length, status])
  const busy = status === 'submitted' || status === 'streaming'
  const last = messages.at(-1)
  const pending = !busy && last?.role === 'assistant' ? (last.parts as Part[]).filter((p) => isTool(p) && p.state === 'approval-requested' && !p.approval?.isAutomatic) : []
  const send = () => { const t = text.trim(); if (!t || !chosen) return; setText(''); void sendMessage({ text: t }) }

  return <div style={{ display: 'grid', gap: 14, maxWidth: 900 }}>
    <Group justify="space-between">
      <div><b style={{ fontSize: 18 }}>Agent</b> <span className="dim">asks before it changes anything</span></div>
      <Group gap="xs">
        <Select size="xs" w={260} placeholder="No models set up" data={(models.data ?? []).map((m) => ({ value: m.id, label: m.label }))} value={chosen}
          onChange={(v) => { setModel(v); try { if (v) localStorage.setItem('agent-model', v) } catch { /* private window */ } }} allowDeselect={false} />
        {busy ? <Button size="xs" variant="default" onClick={() => { void stopChat(); void stop() }}>Stop</Button>
          : <Button size="xs" variant="subtle" color="gray" disabled={!messages.length} onClick={() => { if (confirm('Start a new conversation? The current one is deleted.')) void clearChat().then(() => setMessages([])) }}>New conversation</Button>}
      </Group>
    </Group>
    {models.data?.length === 0 && <Notice color="yellow">No models are set up. Add provider keys and AGENT_MODELS to the server's environment and restart.</Notice>}
    <div style={{ display: 'grid', gap: 14 }}>
      {messages.map((m) => <div key={m.id}>
        {m.id === summarizedUpTo && <div className="dim" style={{ fontSize: 11, textAlign: 'center', margin: '4px 0 12px' }}>— earlier messages are summarized for the agent —</div>}
        <div className={m.role === 'user' ? 'inset' : ''} style={m.role === 'user' ? { justifySelf: 'end', maxWidth: '80%', marginLeft: 'auto' } : undefined}>
          {m.role === 'user' ? (m.parts as Part[]).map((p, i) => p.type === 'text' ? <div key={i} style={{ whiteSpace: 'pre-wrap' }}>{p.text}</div> : null) : <Parts parts={m.parts as Part[]} />}
        </div>
      </div>)}
      {status === 'submitted' && <div className="dim">Thinking…</div>}
      {pending.length > 0 && <Plan key={last!.id} parts={pending} answer={(yes) => { for (const p of pending) void addToolApprovalResponse({ id: p.approval.id, approved: yes.has(p.approval.id) }) }} />}
      {error && <Notice color="red">{error.message}</Notice>}
      <div ref={end} />
    </div>
    <form onSubmit={(e) => { e.preventDefault(); send() }} style={{ display: 'grid', gap: 8 }}>
      <Textarea autosize minRows={2} maxRows={10} placeholder={pending.length ? 'Answer the card above first' : 'Ask about your network…'} value={text} disabled={!chosen || pending.length > 0}
        onChange={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!busy) send() } }} />
      <Group justify="flex-end"><Button type="submit" disabled={busy || !text.trim() || !chosen || pending.length > 0}>Send</Button></Group>
    </form>
  </div>
}

export function Agent() {
  const h = useHistory()
  return <div className="split">
    <main><Load q={h}>{h.data && <Chat initial={h.data.messages} summarizedUpTo={h.data.summarizedUpTo} />}</Load></main>
    <aside><Connect /></aside>
  </div>
}
