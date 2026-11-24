import { useChat } from '@ai-sdk/react'
import { Alert as Notice, Button, Checkbox, Group, Select, Textarea } from '@mantine/core'
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai'
import { useEffect, useMemo, useRef, useState } from 'react'
import { clearChat, stopChat, useHistory, useModels } from '../agent-api.ts'
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

function ToolLine({ p }: { p: Part }) {
  const [open, setOpen] = useState(false)
  const state = p.state === 'output-denied' || p.approval?.approved === false ? 'denied' : p.state === 'output-error' ? 'failed' : p.state === 'output-available' ? '' : '…'
  return <div className="dim" style={{ fontSize: 12 }}>
    <button type="button" style={{ all: 'unset', cursor: 'pointer' }} onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} {toolName(p)}</button> {state && <span style={{ color: state === 'denied' || state === 'failed' ? '#ff8a8a' : undefined }}>{state}</span>}
    {open && <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0 14px' }}>{JSON.stringify(p.input, null, 1)}{p.output !== undefined && `\n→ ${JSON.stringify(p.output).slice(0, 4000)}`}{p.errorText && `\n→ ${p.errorText}`}</pre>}
  </div>
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
          {(m.parts as Part[]).map((p, i) => p.type === 'text' ? <div key={i} style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{p.text}</div>
            : isTool(p) ? <ToolLine key={i} p={p} /> : null)}
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
