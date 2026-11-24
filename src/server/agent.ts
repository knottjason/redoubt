import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMCPClient } from '@ai-sdk/mcp'
import { convertToModelMessages, createUIMessageStreamResponse, isStepCount, streamText, toUIMessageStream, type UIMessage } from 'ai'
import { cutPoint, needsCompaction, roughTokens, summarize, type Msg } from '../agent/compaction.ts'
import { languageModel, listModels, type ModelInfo } from '../agent/providers.ts'
import type { AgentStore } from './agent-store.ts'
import { mcpServer, writeTools, type Services } from './mcp.ts'

type Env = Record<string, string | undefined>

const system = (site: string, summary: string | undefined) => `You are the assistant built into Redoubt, a security app for a home network (site "${site}").
You investigate with the tools and explain plainly. Back every claim with what a tool showed.
To change anything, call the change tools; each call is shown to the person on one card with a checkbox per change, so propose related changes together in one step and give each a clear reason. Nothing runs until they approve. If they untick a change, it comes back to you as denied: accept it.
Never claim a change was made unless its tool result says so. Redoubt refuses changes its policy forbids; tell the person why when that happens.
Times from tools are UTC.${summary ? `\n\nEarlier in this conversation (summarized):\n${summary}` : ''}`

export function openAgent(env: Env, services: Services, store: AgentStore, makeModel: typeof languageModel = languageModel) {
  const models = listModels(env)
  let running: AbortController | null = null
  let compacting: Promise<void> | null = null

  /** The messages the model sees: everything after the newest summary. */
  const context = (all: Msg[]) => {
    const s = store.summary.latest()
    const from = s ? all.findIndex((m) => m.id === s.upto) : 0
    return { summary: s?.text, msgs: from > 0 ? all.slice(from) : all }
  }

  async function compact(model: ModelInfo) {
    const all = store.chat.all()
    const { summary, msgs } = context(all)
    const cut = cutPoint(msgs)
    if (cut < 1) return
    const text = await summarize(makeModel(env, model), summary ?? null, msgs.slice(0, cut))
    if (text) store.summary.add(text, msgs[cut]!.id, model.id)
  }
  const compactInBackground = (model: ModelInfo) => {
    compacting ??= compact(model).catch((e) => console.error('compaction failed', e)).finally(() => { compacting = null })
  }

  /** Only what a person may add: their own text, or yes/no answers to approvals already asked. Nothing else from the browser is trusted. */
  function merge(all: Msg[], incoming: UIMessage): Msg[] | string {
    if (incoming.role === 'user') {
      const text = incoming.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim()
      if (!text) return 'Empty message'
      if (text.length > 20_000) return 'Message too long'
      return [...all, { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] }]
    }
    const last = all.at(-1)
    if (incoming.role !== 'assistant' || !last || last.id !== incoming.id) return 'Only the latest reply can be answered'
    const answers = new Map<string, boolean>()
    for (const p of incoming.parts as Record<string, any>[]) if (p.state === 'approval-responded' && p.approval?.id) answers.set(p.approval.id, Boolean(p.approval.approved))
    let changed = false
    const parts = (last.parts as Record<string, any>[]).map((p) => {
      if (p.state !== 'approval-requested' || !answers.has(p.approval?.id)) return p
      changed = true
      return { ...p, state: 'approval-responded', approval: { ...p.approval, approved: answers.get(p.approval.id) } }
    })
    return changed ? [...all.slice(0, -1), { ...last, parts }] : 'Nothing to approve'
  }

  async function turn(modelId: string, incoming: UIMessage, user: string): Promise<Response> {
    const model = models.find((m) => m.id === modelId)
    if (!model) return Response.json({ error: 'That model is not set up' }, { status: 400 })
    if (running) return Response.json({ error: 'Already working on a reply' }, { status: 409 })
    await compacting
    const merged = merge(store.chat.all(), incoming)
    if (typeof merged === 'string') return Response.json({ error: merged }, { status: 400 })
    store.chat.save(merged.slice(-1))
    // A smaller model than the last one may not fit what is there: fold first.
    if (needsCompaction(context(merged).msgs.reduce((n, m) => n + roughTokens(m), 0), model.context)) await compact(model).catch((e) => console.error('compaction failed', e))
    const { summary, msgs } = context(store.chat.all())

    const abort = new AbortController()
    running = abort
    const [client, server] = InMemoryTransport.createLinkedPair()
    // The built-in chat may change things, but only after the approval card.
    await mcpServer(services, store.gaps, { user: `${user} (agent)`, scope: 'write' }).connect(server)
    const mcp = await createMCPClient({ transport: client, protocolVersionDiscovery: false })
    const done = () => { running = null; void mcp.close() }
    try {
      const tools = await mcp.tools()
      const result = streamText({
        model: makeModel(env, model),
        system: system(services.site, summary),
        messages: await convertToModelMessages(msgs as UIMessage[], { tools }),
        tools,
        toolApproval: Object.fromEntries(writeTools.filter((n) => n in tools).map((n) => [n, 'user-approval' as const])),
        stopWhen: isStepCount(30),
        abortSignal: abort.signal,
      })
      result.consumeStream() // finish and save even if the browser goes away
      return createUIMessageStreamResponse({
        stream: toUIMessageStream({
          stream: result.stream,
          tools,
          originalMessages: msgs as UIMessage[],
          generateMessageId: () => crypto.randomUUID(),
          onError: (e) => (e instanceof Error ? e.message : 'The model failed'),
          onEnd: async ({ messages }) => {
            try {
              store.chat.save(messages as Msg[])
              const steps = await result.steps
              const used = steps.at(-1)?.usage.inputTokens ?? 0
              if (needsCompaction(used, model.context)) compactInBackground(model)
            } catch (e) {
              console.error('saving the reply failed', e)
            } finally {
              done()
            }
          },
        }),
      })
    } catch (e) {
      done()
      throw e
    }
  }

  return {
    models: () => models.map(({ id, label, context }) => ({ id, label, context })),
    history: () => {
      const s = store.summary.latest()
      return { messages: store.chat.all(), summarizedUpTo: s?.upto ?? null, busy: Boolean(running) }
    },
    turn,
    stop: () => { running?.abort(); return Boolean(running) },
    clear: () => { if (running) return false; store.chat.clear(); return true },
  }
}
