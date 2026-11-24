import { Alert as Notice, Button, Code, CopyButton, Group, SegmentedControl, TextInput } from '@mantine/core'
import { useState } from 'react'
import { useCreateToken, useRevokeToken, useTokens } from '../agent-api.ts'
import { when } from '../ui.tsx'

/** Tokens for other agents to use Redoubt's tools over MCP. */
export function Connect() {
  const q = useTokens()
  const make = useCreateToken()
  const revoke = useRevokeToken()
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'read' | 'write'>('read')
  const url = `${location.origin}/mcp`
  return <div style={{ display: 'grid', gap: 14 }}>
    <div><b>Other agents</b> <div className="dim">Any MCP client can use the same tools at <span className="mono">{url}</span> with a token. Read-only tokens can look; read-write tokens can make changes, and the client asks you first.</div></div>
    <form style={{ display: 'grid', gap: 8 }} onSubmit={(e) => { e.preventDefault(); make.mutate({ name, scope }, { onSuccess: () => setName('') }) }}>
      <TextInput size="xs" label="New token for" placeholder="e.g. laptop" value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <SegmentedControl size="xs" value={scope} onChange={(v) => setScope(v as 'read' | 'write')} data={[{ value: 'read', label: 'Read only' }, { value: 'write', label: 'Read and change' }]} />
      <Button size="xs" type="submit" disabled={!name.trim()} loading={make.isPending}>Make token</Button>
    </form>
    {make.data && <Notice color="yellow" title="Copy it now; it won't be shown again">
      <Code block style={{ wordBreak: 'break-all' }}>{make.data.token}</Code>
      <Group mt={6}><CopyButton value={make.data.token}>{({ copied, copy }) => <Button size="compact-xs" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>}</CopyButton></Group>
      <div className="dim" style={{ marginTop: 6 }}>Send it as <span className="mono">Authorization: Bearer …</span></div>
    </Notice>}
    {(make.error ?? revoke.error) && <Notice color="red">{(make.error ?? revoke.error)!.message}</Notice>}
    <div style={{ display: 'grid', gap: 8 }}>
      {(q.data ?? []).filter((t) => !t.revoked).map((t) => <div key={t.id} className="inset">
        <Group justify="space-between" wrap="nowrap"><span><b>{t.name}</b> <span className="dim">{t.scope === 'write' ? 'read and change' : 'read only'}</span></span>
          <Button size="compact-xs" variant="subtle" color="red" onClick={() => { if (confirm(`Revoke ${t.name}?`)) revoke.mutate(t.id) }}>Revoke</Button></Group>
        <div className="dim" style={{ fontSize: 11 }}>made {when(t.created)} · last used {when(t.last_used)}</div>
      </div>)}
    </div>
  </div>
}
