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
import { namesFrom, openPlugins } from './plugins.ts'

const decisions = openDecisions(config.dataDir, config.site)
const plugins = openPlugins(decisions.db)
const service = createService(decisions, plugins, config)
if (config.runQueue) {
  setInterval(() => void plugins.deliverDue(), 2_000).unref()
  setInterval(() => void plugins.checkAll(), 60_000).unref()
  void plugins.checkAll()
  const learn = async () => setLearned(namesFrom((await plugins.devices(config.site)).facts))
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
    return { ...m, alerts: decided(m.alerts) }
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
  plugins: () => plugins.list(),
}
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
  .get('/summary', async (c) => c.json({ ...(await data.summary()), user: c.get('user') }))
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
app.get('/healthz', (c) => c.text('ok'))
app.onError((e, c) => {
  console.error(e)
  return c.json({ error: 'Something went wrong' }, 500)
})
export type AppType = typeof app
