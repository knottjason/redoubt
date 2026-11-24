import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { secureHeaders } from 'hono/secure-headers'
import { getConnInfo } from '@hono/node-server/conninfo'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { isInternal } from '../shared/net.ts'
import { config } from './config.ts'
import * as data from './data.ts'
import { actions, decisionFor, openDecisions } from './decisions.ts'

const decisions = openDecisions(config.dataDir)
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
  .get('/alerts', zValidator('query', hours), async (c) => {
    const active = decisions.active()
    const rows = await data.alerts(c.req.valid('query').hours)
    return c.json(rows.map((r) => ({ ...r, decision: decisionFor(active, r.sid, r.machine, r.remote) ?? null })))
  })
  .get('/alerts/detail', zValidator('query', alertKey), async (c) => {
    const { sid, src, dst } = c.req.valid('query')
    return c.json(await data.alertDetail(sid, src, dst))
  })
  .get('/machines', zValidator('query', hours), async (c) => c.json(await data.machines(c.req.valid('query').hours)))
  .get('/machines/:ip', zValidator('param', z.object({ ip })), zValidator('query', hours), async (c) => {
    const active = decisions.active()
    const m = await data.machine(c.req.valid('param').ip, c.req.valid('query').hours)
    return c.json({ ...m, alerts: m.alerts.map((r) => ({ ...r, decision: decisionFor(active, r.sid, r.machine, r.remote) ?? null })) })
  })
  .get('/decisions', (c) => c.json(decisions.history()))
  .post('/decisions', zValidator('json', z.object({
    action: z.enum(actions), sid: z.number().int().positive(), machine: ip, remote: ip, signature: z.string().min(1).max(300),
  })), (c) => {
    const d = c.req.valid('json')
    if (d.action === 'block' && isInternal(d.remote, config.internal)) return c.json({ error: 'Internal addresses are never blocked' }, 400)
    return c.json({ id: decisions.add({ ...d, user: c.get('user') }), enforced: false }, 201)
  })
  .post('/decisions/:id/undo', zValidator('param', z.object({ id: z.coerce.number().int().positive() })), (c) =>
    decisions.undo(c.req.valid('param').id, c.get('user')) ? c.json({ ok: true }) : c.json({ error: 'Already undone' }, 404))

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
