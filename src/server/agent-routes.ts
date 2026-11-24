import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { UIMessage } from 'ai'
import type { AgentStore } from './agent-store.ts'
import type { openAgent } from './agent.ts'
import { mcpServer, type Services } from './mcp.ts'

type Env = { Variables: { user: string } }
const id = z.object({ id: z.coerce.number().int().positive() })

/** The built-in chat, MCP tokens and the Feedback list. Mounted under /api, so it is behind the same sign-in as everything else. */
export function agentApi(agent: ReturnType<typeof openAgent>, store: AgentStore) {
  return new Hono<Env>()
    .get('/agent/models', (c) => c.json(agent.models()))
    .get('/agent/messages', (c) => c.json(agent.history()))
    .post('/agent/chat', zValidator('json', z.object({ model: z.string().max(200), message: z.looseObject({ id: z.string().max(100), role: z.enum(['user', 'assistant']), parts: z.array(z.unknown()).max(500) }) })),
      async (c) => { const { model, message } = c.req.valid('json'); return agent.turn(model, message as UIMessage, c.get('user')) })
    .post('/agent/stop', (c) => c.json({ stopped: agent.stop() }))
    .post('/agent/clear', (c) => (agent.clear() ? c.json({ ok: true }) : c.json({ error: 'Stop the reply first' }, 409)))
    .get('/agent/tokens', (c) => c.json(store.tokens.list()))
    .post('/agent/tokens', zValidator('json', z.object({ name: z.string().trim().min(1).max(60), scope: z.enum(['read', 'write']) })), (c) => {
      const { name, scope } = c.req.valid('json')
      return c.json(store.tokens.create(name, scope), 201)
    })
    .post('/agent/tokens/:id/revoke', zValidator('param', id), (c) => (store.tokens.revoke(c.req.valid('param').id) ? c.json({ ok: true }) : c.json({ error: 'No such token' }, 404)))
    .get('/feedback', (c) => c.json(store.gaps.list()))
    .post('/feedback/:id/close', zValidator('param', id), (c) => (store.gaps.close(c.req.valid('param').id) ? c.json({ ok: true }) : c.json({ error: 'Already closed' }, 404)))
}

/**
 * Remote MCP over streamable HTTP, stateless: a fresh server per request.
 * Signed in by a token made on the Agent page, not by the proxy. A remote agent's own client asks the person before changes.
 */
export function mcpHttp(services: Services, store: AgentStore) {
  return new Hono().all('/', async (c) => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1]
    const who = token ? store.tokens.check(token) : undefined
    if (!who) return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'A valid token is required' }, id: null }, 401, { 'WWW-Authenticate': 'Bearer' })
    if (c.req.method !== 'POST') return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }, 405, { Allow: 'POST' })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    const server = mcpServer(services, store.gaps, { user: `token:${who.name}`, scope: who.scope })
    await server.connect(transport)
    try {
      return await transport.handleRequest(c.req.raw)
    } finally {
      void server.close()
    }
  })
}
