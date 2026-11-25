import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { secureHeaders } from 'hono/secure-headers'
import { getConnInfo } from '@hono/node-server/conninfo'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { config, hostName, setLearned } from './config.ts'
import * as data from './data.ts'
import { decisionFor, openDecisions } from './decisions.ts'
import { createService, ruleActions } from './decide.ts'
import { openPlugins } from './plugins.ts'
import { openDevices, shown } from './devices.ts'
import { openAgent } from './agent.ts'
import { agentApi, mcpHttp } from './agent-routes.ts'
import { openAgentStore } from './agent-store.ts'
import type { Services } from './mcp.ts'
import { openSql } from './sql.ts'

const decisions = openDecisions(config.dataDir, config.site)
const plugins = openPlugins(decisions.db)
const service = createService(decisions, plugins, config)
const devices = openDevices(decisions.db, config.site, config.internal)
if (config.runQueue) {
  setInterval(() => void plugins.deliverDue(), 2_000).unref()
  setInterval(() => void plugins.checkAll(), 60_000).unref()
  void plugins.checkAll()
  const learn = async () => {
    try {
      const [{ facts }, traffic] = await Promise.all([plugins.devices(config.site), data.machines(1).catch(() => [])])
      devices.refresh(facts, traffic.map((t) => ({ ip: t.ip, last: t.last })))
    } catch (e) { console.error('Devices:', e) }
    setLearned(devices.names())
  }
  setInterval(() => void learn(), 300_000).unref()
  void learn()
}
const withState = <T extends { decision: { id: number } | null }>(rows: T[]) => {
  const s = plugins.states()
  return rows.map((r) => ({ ...r, decision: r.decision && { ...r.decision, applied: s.get(r.decision.id) ?? null } }))
}
const decided = (rows: data.AlertRow[]) => {
  const active = decisions.active()
  return withState(rows.map((r) => ({ ...r, decision: decisionFor(active, r.site, r.sid, r.machine, r.remote) ?? null })))
}
/** Everything the routes do, for anything else inside the server that needs the same answers and the same checks. */
export const services = {
  ...service,
  alerts: async (hours: number) => decided(await data.alerts(hours)),
  overview: async (hours: number) => {
    const { alerts, ...o } = await data.overview(hours)
    return { ...o, open: decided(alerts).filter((r) => !r.decision) }
  },
  machine: async (ip: string, hours: number) => {
    const m = await data.machine(ip, hours)
    const d = devices.byIp(ip)
    return { ...m, alerts: decided(m.alerts), device: d ? { ...d, shown: shown(d) } : null }
  },
  history: () => {
    const s = plugins.states()
    return decisions.history().map((d) => ({ ...d, applied: s.get(d.id) ?? null }))
  },
  ruleset: async (query: { find: string; state: 'all' | 'on' | 'off'; offset: number }) => {
    const r = await plugins.rules(config.site, { ...query, limit: 100 })
    if (!r) return null
    const s = plugins.states()
    const here = decisions.active().filter((d) => d.site === config.site)
    const own = new Map(here.filter((d) => ruleActions.includes(d.action)).reverse().map((d) => [d.sid, { ...d, applied: s.get(d.id) ?? null }]))
    return { ...r, rows: r.rows.map((x) => ({
      ...x, decision: own.get(x.sid) ?? null,
      hosts: here.filter((d) => d.sid === x.sid && d.action === 'silence_machine').map((d) => ({ ...d, name: hostName(d.machine), applied: s.get(d.id) ?? null })),
    })) }
  },
  devices: () => plugins.devices(config.site),
  /** Every device, with what it did on the network over these hours. */
  inventory: async (hours: number) => {
    const traffic = new Map((await data.machines(hours).catch(() => [])).map((m) => [m.ip, m]))
    return {
      devices: devices.list().map((d) => {
        const t = d.ip ? traffic.get(d.ip) : undefined
        return { ...d, site: config.site, up: t?.up ?? 0, down: t?.down ?? 0, connections: t?.connections ?? 0, destinations: t?.destinations ?? 0, active: t?.last ?? null }
      }),
      networks: devices.networks(),
      ports: devices.ports(),
    }
  },
  renameDevice: (target: { id: number } | { ip: string }, name: string, dns: boolean) => {
    const d = devices.rename(target, name, dns)
    setLearned(devices.names())
    return d
  },
  ackDevice: (id: number, user: string) => devices.ack(id, user),
  watchNetwork: (cidr: string, on: boolean) => devices.watch(cidr, on),
  plugins: () => plugins.list(),
}
// The agent and remote MCP clients get the same functions as the routes, so they can do nothing a button can't.
const refusedThrows = <T extends object>(r: T): Exclude<T, { error: string }> => { if ('error' in r) throw new Error(String(r.error)); return r as Exclude<T, { error: string }> }
const sqlLogin = config.agentClickhouse && openSql(config.agentClickhouse)
// The rule's name always comes from the sensor or the alerts, never from what a model typed.
async function signatureOf(sid: number): Promise<string> {
  try {
    const hit = (await services.ruleset({ find: String(sid), state: 'all', offset: 0 }))?.rows.find((r) => r.sid === sid)
    if (hit) return hit.msg
  } catch {
    // No rules plugin, or it is down: the alerts still know the name.
  }
  const seen = await data.signatureOf(sid)
  if (seen) return seen
  throw new Error(`No rule with sid ${sid} is known to the sensor or seen in alerts`)
}
const agentServices: Services = {
  ...services, renameDevice: (t, name) => services.renameDevice(t, name, false), site: config.site, summary: data.summary, alertDetail: data.alertDetail, rules: data.rules, machines: data.machines,
  decide: async (d, user) => refusedThrows(services.decide({ ...d, signature: await signatureOf(d.sid), site: config.site, user })),
  setRule: async (r, user) => refusedThrows(services.setRule({ ...r, signature: await signatureOf(r.sid), user })),
  ...(sqlLogin && { sql: sqlLogin.sql, schema: sqlLogin.schema }),
}
const agentStore = openAgentStore(config.dataDir)
const agent = openAgent(process.env, agentServices, agentStore)

const pluginUrl = z.url({ protocol: /^https?$/ }).max(200)
const pluginKey = z.string().min(32).max(200)
const ip = z.union([z.ipv4(), z.ipv6()])
const hours = z.object({ hours: z.coerce.number().int().min(1).max(720).default(24) })
const alertKey = z.object({ sid: z.coerce.number().int().positive(), src: ip, dst: ip })
type Env = { Variables: { user: string } }

function trusted(addr: string | undefined): boolean {
  if (!addr) return false
  const a = addr.replace(/^::ffff:/i, '')
  return config.trustedProxies.check(a, a.includes(':') ? 'ipv6' : 'ipv4')
}

const api = new Hono<Env>()
  .use(async (c, next) => {
    const user = (trusted(getConnInfo(c).remote.address) ? c.req.header(config.authHeader) : undefined) || config.devUser
    if (!user) return c.json({ error: 'Not signed in' }, 401)
    c.set('user', user)
    await next()
  })
  .get('/summary', async (c) => c.json({ ...(await data.summary()), newDevices: devices.events().length, user: c.get('user') }))
  .get('/alerts', zValidator('query', hours), async (c) => c.json(await services.alerts(c.req.valid('query').hours)))
  .get('/alerts/detail', zValidator('query', alertKey), async (c) => {
    const { sid, src, dst } = c.req.valid('query')
    return c.json(await data.alertDetail(sid, src, dst))
  })
  .get('/overview', zValidator('query', hours), async (c) => c.json(await services.overview(c.req.valid('query').hours)))
  .get('/rules', zValidator('query', hours), async (c) => c.json(await data.rules(c.req.valid('query').hours)))
  .get('/machines', zValidator('query', hours), async (c) => c.json(await data.machines(c.req.valid('query').hours)))
  .get('/machines/:ip', zValidator('param', z.object({ ip })), zValidator('query', hours), async (c) =>
    c.json(await services.machine(c.req.valid('param').ip, c.req.valid('query').hours)))
  .get('/decisions', (c) => c.json(services.history()))
  .post('/decisions', zValidator('json', z.object({
    site: z.literal(config.site), action: z.enum(['allow', 'allow_machine', 'allow_all', 'silence_machine', 'silence_all', 'block']), sid: z.number().int().positive(), src: ip, dst: ip, signature: z.string().min(1).max(300),
  })), (c) => {
    const r = service.decide({ ...c.req.valid('json'), user: c.get('user') })
    return 'error' in r ? c.json({ error: r.error }, r.status) : c.json(r, 201)
  })
  .post('/decisions/:id/undo', zValidator('param', z.object({ id: z.coerce.number().int().positive() })), (c) =>
    service.undo(c.req.valid('param').id, c.get('user')) ? c.json({ ok: true }) : c.json({ error: 'Already undone' }, 404))
  .get('/ruleset', zValidator('query', z.object({ find: z.string().max(100).default(''), state: z.enum(['all', 'on', 'off']).default('all'), offset: z.coerce.number().int().min(0).default(0) })), async (c) => {
    try { return c.json(await services.ruleset(c.req.valid('query'))) } catch (e) { return c.json({ error: (e as Error).message }, 502) }
  })
  .post('/ruleset/:sid', zValidator('param', z.object({ sid: z.coerce.number().int().positive() })), zValidator('json', z.object({ on: z.boolean(), signature: z.string().min(1).max(300), machine: ip.optional() })), (c) => {
    const r = service.setRule({ ...c.req.valid('param'), ...c.req.valid('json'), user: c.get('user') })
    return 'error' in r ? c.json({ error: r.error }, r.status) : c.json(r, 201)
  })
  .get('/devices', async (c) => c.json(await services.devices()))
  .get('/inventory', zValidator('query', hours), async (c) => c.json(await services.inventory(c.req.valid('query').hours)))
  .post('/inventory/name', zValidator('json', z.object({ id: z.number().int().positive().optional(), ip: ip.optional(), name: z.string().max(60).regex(/^[^\u0000-\u001f\u007f]*$/), dns: z.boolean().default(false) })
    .refine((v) => (v.id === undefined) !== (v.ip === undefined), 'Give the device or its address')), (c) => {
    const { id, ip: addr, name, dns } = c.req.valid('json')
    const d = services.renameDevice(id !== undefined ? { id } : { ip: addr! }, name, dns)
    return d ? c.json(d) : c.json({ error: 'No such device here' }, 404)
  })
  .post('/inventory/:id/known', zValidator('param', z.object({ id: z.coerce.number().int().positive() })), (c) => c.json({ ok: services.ackDevice(c.req.valid('param').id, c.get('user')) }))
  .post('/inventory/watch', zValidator('json', z.object({ cidr: z.cidrv4(), on: z.boolean() })), (c) => c.json(services.watchNetwork(c.req.valid('json').cidr, c.req.valid('json').on)))
  .get('/plugins', (c) => c.json(services.plugins()))
  .post('/plugins/describe', zValidator('json', z.object({ url: pluginUrl, key: pluginKey })), async (c) => {
    const { url, key } = c.req.valid('json')
    try { return c.json(await plugins.describe(url, key)) } catch (e) { return c.json({ error: (e as Error).message }, 502) }
  })
  .post('/plugins', zValidator('json', z.object({ url: pluginUrl, key: pluginKey })), async (c) => {
    const { url, key } = c.req.valid('json')
    try { return c.json(await plugins.add(config.site, url, key), 201) } catch (e) { return c.json({ error: (e as Error).message }, 400) }
  })
  .post('/plugins/:id/remove', zValidator('param', z.object({ id: z.coerce.number().int().positive() })), (c) => {
    try { return plugins.remove(c.req.valid('param').id) ? c.json({ ok: true }) : c.json({ error: 'No such plugin' }, 404) } catch (e) { return c.json({ error: (e as Error).message }, 409) }
  })
  .route('/', agentApi(agent, agentStore))

export const app = new Hono()
  .use(secureHeaders({ contentSecurityPolicy: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], frameAncestors: ["'none'"] } }))
  .use('/api/*', csrf())
  .use('/api/*', async (c, next) => {
    // JSON only for writes, so a plain cross-site form can never record a decision.
    if (c.req.method !== 'GET' && !c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'JSON only' }, 415)
    await next()
    c.header('Cache-Control', 'no-store')
  })
  .route('/api', api)
  // Signed in by its own tokens, not the proxy: point the proxy's sign-in rules past this path.
  .route('/mcp', mcpHttp(agentServices, agentStore))
app.get('/healthz', (c) => c.text('ok'))
app.onError((e, c) => {
  console.error(e)
  return c.json({ error: 'Something went wrong' }, 500)
})
export type AppType = typeof app
