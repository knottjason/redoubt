import { createServer } from 'node:http'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prefix, same, signReply, signRequest, type ApplyReply, type ApplyRequest, type Describe, type DevicesReply, type Entry, type ListReply, type RulesReply, type RulesRequest } from '../../src/shared/plugin.ts'

export type Plugin = {
  describe: Describe
  /** Make exactly these entries true. Throw if nothing was changed; report per-entry problems in the results. */
  apply(entries: Entry[]): Promise<ApplyReply>
  health(): Promise<{ healthy: boolean; message: string }>
  /** What is really on the device, when the plugin can look. Otherwise Redoubt is told what was last applied. */
  present?(): Promise<string[]>
  /** Work of its own, never at the same time as apply. */
  background?: { every: number; run(): Promise<void> }
  devices?(): Promise<DevicesReply>
  rules?(r: RulesRequest): Promise<RulesReply>
}
type State = { instance: string; revision: number; ids: string[] }
export class Refuse extends Error {
  status = 409
}

const maxBody = 4_000_000
const window = 60_000

/** Everything a plugin needs besides its own work: signatures, replay protection, one change at a time, refusing to go backwards. */
export function createPlugin(plugin: Plugin, o: { key: string; stateDir: string }) {
  if (o.key.length < 32) throw new Error('The shared key must be at least 32 characters')
  mkdirSync(o.stateDir, { recursive: true })
  const file = join(o.stateDir, 'state.json')
  let state: State = { instance: '', revision: 0, ids: [] }
  try {
    state = JSON.parse(readFileSync(file, 'utf8')) as State
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const save = (s: State) => {
    writeFileSync(`${file}.new`, JSON.stringify(s), { mode: 0o600 })
    renameSync(`${file}.new`, file)
    state = s
  }
  const seen = new Map<string, number>()
  let queue: Promise<unknown> = Promise.resolve()

  async function apply(r: ApplyRequest): Promise<ApplyReply> {
    if (typeof r.instance !== 'string' || !r.instance || !Number.isInteger(r.revision) || !Array.isArray(r.entries)) throw new Refuse('Malformed request')
    if (state.instance && state.instance !== r.instance) throw new Refuse('This plugin belongs to another Redoubt')
    // A Redoubt that lost its data would otherwise send an empty list and undo everything.
    if (r.revision < state.revision) throw new Refuse('Redoubt is behind what was already applied; was its data restored?')
    for (const e of r.entries) if (!plugin.describe.kinds.includes(e.kind)) throw new Refuse(`Cannot do ${String(e.kind)}`)
    const reply = await plugin.apply(r.entries)
    save({ instance: r.instance, revision: r.revision, ids: reply.results.filter((x) => x.ok).map((x) => x.id) })
    return reply
  }

  async function handle(action: string, body: string): Promise<unknown> {
    switch (action) {
      case 'describe': return plugin.describe
      case 'list': return { instance: state.instance, revision: state.revision, ids: plugin.present ? await plugin.present() : state.ids, ...(await plugin.health()) } satisfies ListReply
      case 'apply': {
        const run = queue.then(() => apply(JSON.parse(body) as ApplyRequest))
        queue = run.catch(() => {})
        return run
      }
      case 'devices':
        if (plugin.devices) return plugin.devices()
        break
      case 'rules': if (plugin.rules) return plugin.rules(JSON.parse(body) as RulesRequest)
    }
    throw Object.assign(new Error('Unknown action'), { status: 404 })
  }

  if (plugin.background) {
    const { every, run } = plugin.background
    const go = () => { queue = queue.then(run).catch((e: Error) => console.error('background', e.message)) }
    setTimeout(go, 5_000).unref()
    setInterval(go, every).unref()
  }

  return createServer((req, res) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > maxBody) req.destroy()
      else chunks.push(c)
    })
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const path = req.url ?? ''
      const time = String(req.headers['x-redoubt-time'] ?? '')
      const nonce = String(req.headers['x-redoubt-nonce'] ?? '')
      const now = Date.now()
      for (const [n, t] of seen) if (now - t > 2 * window) seen.delete(n)
      const good = req.method === 'POST' && path.startsWith(prefix) && /^[0-9a-f]{32}$/.test(nonce) && Math.abs(now - Number(time)) <= window &&
        same(String(req.headers['x-redoubt-signature'] ?? ''), signRequest(o.key, time, nonce, path, body)) && !seen.has(nonce)
      if (!good) return void res.writeHead(401).end()
      seen.set(nonce, now)
      let status = 200
      let out: unknown
      try {
        out = await handle(path.slice(prefix.length), body)
      } catch (e) {
        status = (e as { status?: number }).status ?? 500
        out = { error: (e as Error).message.slice(0, 300) }
        console.error(path, out)
      }
      const text = JSON.stringify(out)
      res.writeHead(status, { 'content-type': 'application/json', 'x-redoubt-signature': signReply(o.key, nonce, status, text) }).end(text)
    })
  })
}
