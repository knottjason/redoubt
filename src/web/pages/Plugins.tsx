import { Alert as Notice, Button, Group, PasswordInput, TextInput } from '@mantine/core'
import { useState } from 'react'
import { useAddPlugin, useDescribe, usePlugins, useRemovePlugin } from '../api.ts'
import { Grid, Load, when } from '../ui.tsx'

const says: Record<string, string> = { 'rule.disable': 'turn rules off', 'rule.enable': 'turn rules on', 'rule.silence': 'silence a rule for one machine', 'block.pair': 'block one machine from one address', 'block.remote': 'block an address for everyone' }

export function Plugins() {
  const q = usePlugins()
  const look = useDescribe()
  const add = useAddPlugin()
  const del = useRemovePlugin()
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const error = look.error ?? add.error ?? del.error
  return <div className="page" style={{ display: 'grid', gap: 18 }}>
    <div><b style={{ fontSize: 18 }}>Plugins</b> <span className="dim">they do the work on your devices; Redoubt only asks</span></div>
    <Load q={q}><Grid data={q.data ?? []} rowKey={(p) => String(p.id)} empty="No plugins yet. Decisions are recorded only." columns={[
      { accessorKey: 'name', header: 'Plugin', cell: ({ row: { original: p } }) => <>{p.name} <span className="dim">{p.version}</span><div className="mono dim">{p.url}</div></> },
      { accessorKey: 'site', header: 'Site' },
      { id: 'can', header: 'Can', cell: ({ row: { original: p } }) => <span className="dim">{[...p.kinds.map((k) => says[k] ?? k), ...(p.devices ? ['list devices'] : [])].join(', ')}</span> },
      { accessorKey: 'entries', header: 'In place', meta: { right: true } },
      { id: 'state', header: 'State', cell: ({ row: { original: p } }) => p.error ? <span style={{ color: '#ff8a8a' }}>{p.error}</span> : p.dirty ? <span style={{ color: '#f5a524' }}>Sending changes</span> : <span style={{ color: '#6fe0ad' }}>{p.message || 'OK'}</span> },
      { accessorKey: 'last_ok', header: 'Last answer', cell: (c: any) => <span className="mono dim">{when(c.getValue())}</span> },
      { id: 'x', header: '', cell: ({ row: { original: p } }) => <Button size="compact-xs" variant="subtle" color="red" onClick={() => { if (confirm(`Remove ${p.name}?`)) del.mutate(p.id) }}>Remove</Button> },
    ]} /></Load>
    <form className="panel" style={{ padding: 14, display: 'grid', gap: 12, maxWidth: 560 }} onSubmit={(e) => { e.preventDefault(); look.mutate({ url, key }) }}>
      <div className="label">Add a plugin</div>
      <TextInput label="Address" placeholder="http://plugin:8790" value={url} onChange={(e) => { setUrl(e.currentTarget.value); look.reset() }} />
      <PasswordInput label="Shared key" autoComplete="off" value={key} onChange={(e) => { setKey(e.currentTarget.value); look.reset() }} />
      {look.data && <Notice color="yellow" title={`${look.data.name} ${look.data.version} wants to`}>{[...look.data.kinds.map((k) => says[k] ?? k), ...(look.data.devices ? ['list devices'] : [])].join(', ')}</Notice>}
      <Group>{look.data
        ? <Button type="button" loading={add.isPending} onClick={() => add.mutate({ url, key }, { onSuccess: () => { setUrl(''); setKey(''); look.reset() } })}>Approve and add</Button>
        : <Button type="submit" loading={look.isPending} disabled={!url || key.length < 32}>Look at it</Button>}</Group>
      {error && <Notice color="red">{error.message}</Notice>}
    </form>
  </div>
}
