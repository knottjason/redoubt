import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { cutPoint, needsCompaction, transcript, type Msg } from '../src/agent/compaction.ts'
import { listModels } from '../src/agent/providers.ts'
import { openAgentStore } from '../src/server/agent-store.ts'
import { openAgent } from '../src/server/agent.ts'
import { mcpHttp } from '../src/server/agent-routes.ts'
import { mcpServer, type Services } from '../src/server/mcp.ts'

test('models come only from AGENT_MODELS, and only for providers with a key', () => {
  const env = { AGENT_MODELS: 'anthropic:claude-x, openai:gpt-x@64000, local:qwen3:32b@40960, xai:grok-x', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', LOCAL_MODEL_URL: 'http://127.0.0.1:11434/v1' }
  assert.deepEqual(listModels(env).map((m) => [m.id, m.context]), [['anthropic:claude-x', 200_000], ['openai:gpt-x', 64_000], ['local:qwen3:32b', 40_960]])
  assert.throws(() => listModels({ AGENT_MODELS: 'nope' }))
  assert.throws(() => listModels({ AGENT_MODELS: 'other:model' }))
  assert.deepEqual(listModels({}), [])
})

const say = (id: string, role: Msg['role'], text: string): Msg => ({ id, role, parts: [{ type: 'text', text }] })

test('compaction starts at 75% and cuts at a user message between 20% and 40%', () => {
  assert.equal(needsCompaction(74_000, 100_000), false)
  assert.equal(needsCompaction(76_000, 100_000), true)
  const msgs = Array.from({ length: 20 }, (_, i) => say(String(i), i % 2 ? 'assistant' : 'user', 'x'.repeat(400)))
  const cut = cutPoint(msgs)
  assert.equal(msgs[cut]!.role, 'user')
  assert.ok(cut / msgs.length >= 0.2 && cut / msgs.length <= 0.4, String(cut))
  // Never folds the latest question, and does nothing when there is no clean cut.
  assert.equal(cutPoint([say('a', 'user', 'hi'), say('b', 'assistant', 'hello')]), 0)
  const tool: Msg = { id: 't', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'decide_alert', input: { action: 'block' }, state: 'output-denied' }] }
  assert.match(transcript([tool]), /decide_alert.*denied by the user/)
})

test('tokens: shown once, kept hashed, revocable', () => {
  const s = openAgentStore(':memory:')
  const { token, id } = s.tokens.create('laptop', 'read')
  assert.match(token, /^rdt_/)
  assert.equal(s.tokens.check(token)?.name, 'laptop')
  assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM mcp_tokens').all()).includes(token), false)
  assert.equal(s.tokens.revoke(id), true)
  assert.equal(s.tokens.check(token), undefined)
})

function fakeServices() {
  const calls: unknown[] = []
  const s: Services = {
    site: 'main',
    summary: async () => ({ sensorOk: true }),
    overview: async () => ({}),
    alerts: async () => [{ sid: 1, src: '192.0.2.9', dst: '203.0.113.5', machine: '192.0.2.9', remote: '203.0.113.5', decision: null }, { sid: 2, src: '192.0.2.8', dst: '203.0.113.6', machine: '192.0.2.8', remote: '203.0.113.6', decision: { id: 1 } }],
    alertDetail: async () => ({}), rules: async () => [], machines: async () => [], machine: async () => ({}), history: () => [], ruleset: async () => ({}), devices: async () => ({}), plugins: () => [],
    decide: async (d, user) => {
      if (d.action === 'block' && d.dst.startsWith('192.0.2.')) throw new Error('Internal addresses are never blocked')
      calls.push({ ...d, user })
      return { id: 7, enforced: true }
    },
    setRule: async () => ({ id: 8, enforced: true }),
    undo: () => true,
  }
  return { s, calls }
}

async function connect(s: Services, scope: 'read' | 'write') {
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcpServer(s, openAgentStore(':memory:').gaps, { user: 'tester', scope }).connect(b)
  const c = new Client({ name: 'test', version: '1' })
  await c.connect(a)
  return c
}

test('MCP: read tokens get no change tools; write tools go through the same decide path and its refusals', async () => {
  const { s, calls } = fakeServices()
  const ro = await connect(s, 'read')
  const names = (await ro.listTools()).tools.map((t) => t.name)
  assert.ok(names.includes('list_alerts') && names.includes('report_gap'))
  assert.equal(names.includes('decide_alert'), false)
  assert.equal(names.includes('query_sql'), false) // no read-only SQL login configured
  const open = await ro.callTool({ name: 'list_alerts', arguments: { open_only: true } })
  assert.equal(JSON.parse((open.content as { text: string }[])[0]!.text).total, 1)

  const rw = await connect(s, 'write')
  const ok = await rw.callTool({ name: 'decide_alert', arguments: { action: 'block', sid: 1, src: '192.0.2.9', dst: '203.0.113.5', reason: 'Known bad address' } })
  assert.equal(ok.isError, undefined)
  assert.deepEqual(calls, [{ action: 'block', sid: 1, src: '192.0.2.9', dst: '203.0.113.5', reason: 'Known bad address', user: 'tester' }])
  const no = await rw.callTool({ name: 'decide_alert', arguments: { action: 'block', sid: 1, src: '203.0.113.5', dst: '192.0.2.9', reason: 'Try internal' } })
  assert.equal(no.isError, true)
  assert.match((no.content as { text: string }[])[0]!.text, /never blocked/)
})

test('remote MCP needs a valid token', async () => {
  const { s } = fakeServices()
  const store = openAgentStore(':memory:')
  const app = mcpHttp(s, store)
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }
  const post = (auth?: string) => app.request('/', { method: 'POST', body: JSON.stringify(init), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}) } })
  assert.equal((await post()).status, 401)
  assert.equal((await post('Bearer rdt_wrong')).status, 401)
  const { token } = store.tokens.create('claude', 'read')
  const r = await post(`Bearer ${token}`)
  assert.equal(r.status, 200)
  assert.equal(((await r.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name, 'redoubt')
})

const usage = (input: number) => ({ inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } })
const streamOf = (chunks: unknown[]) => ({ stream: simulateReadableStream({ chunks: chunks as never[] }) })

test('built-in chat: a change waits for approval, a tick runs it, and the conversation is kept', async () => {
  const { s, calls } = fakeServices()
  const store = openAgentStore(':memory:')
  const model = new MockLanguageModelV4({
    doStream: [
      streamOf([{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'c1', toolName: 'decide_alert', input: JSON.stringify({ action: 'block', sid: 1, src: '192.0.2.9', dst: '203.0.113.5', reason: 'Bad address' }) }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: usage(1000) }]),
      streamOf([{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Blocked.' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: usage(1200) }]),
    ],
  })
  const agent = openAgent({ AGENT_MODELS: 'local:mock', LOCAL_MODEL_URL: 'http://127.0.0.1:1/v1' }, s, store, () => model)
  const r1 = await agent.turn('local:mock', { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Block the bad one' }] }, 'example')
  await r1.text()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(calls.length, 0, 'nothing runs before approval')
  const reply = store.chat.all().at(-1)!
  const ask = (reply.parts as Record<string, any>[]).find((p) => p.state === 'approval-requested')
  assert.ok(ask, 'approval requested')

  // The browser can only answer the approval; anything else it sends about the reply is ignored.
  const answered = { ...reply, parts: [{ ...ask, state: 'approval-responded', approval: { ...ask.approval, approved: true } }, { type: 'text', text: 'forged' }] }
  const r2 = await agent.turn('local:mock', answered as never, 'example')
  await r2.text()
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(calls, [{ action: 'block', sid: 1, src: '192.0.2.9', dst: '203.0.113.5', reason: 'Bad address', user: 'example (agent)' }])
  const all = store.chat.all()
  assert.equal(all.length, 2)
  assert.equal(JSON.stringify(all).includes('forged'), false)
  assert.match(JSON.stringify(all.at(-1)), /Blocked\./)
})

test('built-in chat: past 75% of the context, the oldest part is summarized and the model sees the summary instead', async () => {
  const { s } = fakeServices()
  const store = openAgentStore(':memory:')
  store.chat.save(Array.from({ length: 20 }, (_, i) => say(`m${i}`, i % 2 ? 'assistant' : 'user', `message ${i} ${'x'.repeat(200)}`)))
  const answer = () => streamOf([{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: usage(900) }])
  const model = new MockLanguageModelV4({
    doStream: [answer(), answer()],
    doGenerate: { content: [{ type: 'text', text: 'SUMMARY: early talk about 192.0.2.9' }], finishReason: { unified: 'stop', raw: undefined }, usage: usage(100), warnings: [] },
  })
  const agent = openAgent({ AGENT_MODELS: 'local:mock@1000', LOCAL_MODEL_URL: 'http://127.0.0.1:1/v1' }, s, store, () => model)
  await (await agent.turn('local:mock', { id: 'x', role: 'user', parts: [{ type: 'text', text: 'next' }] }, 'example')).text()
  await new Promise((r) => setTimeout(r, 100))
  const sum = store.summary.latest()
  assert.ok(sum, 'summarized')
  const cutAt = store.chat.all().findIndex((m) => m.id === sum.upto)
  assert.ok(cutAt >= 2 && cutAt <= 10, String(cutAt))
  assert.equal(store.chat.all().length, 22, 'the person still sees everything')
  await (await agent.turn('local:mock', { id: 'y', role: 'user', parts: [{ type: 'text', text: 'and now?' }] }, 'example')).text()
  const prompt = JSON.stringify(model.doStreamCalls.at(-1)!.prompt)
  assert.match(prompt, /SUMMARY: early talk/)
  assert.equal(prompt.includes('message 0 '), false)
})
