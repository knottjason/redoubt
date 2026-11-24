import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { AgentStore, Scope } from './agent-store.ts'

const ip = z.union([z.ipv4(), z.ipv6()])
const hours = z.number().int().min(1).max(720).default(24).describe('How far back to look, in hours (max 720 = 30 days)')
const limit = (n: number) => z.number().int().min(1).max(n).default(Math.min(50, n)).describe(`Most rows to return (max ${n})`)

/** What the tools need from the rest of Redoubt. The routes use the same functions, so a tool can do nothing a button can't. */
export type Services = {
  site: string
  summary(): Promise<unknown>
  overview(hours: number): Promise<unknown>
  alerts(hours: number): Promise<Record<string, unknown>[]>
  alertDetail(sid: number, src: string, dst: string): Promise<unknown>
  rules(hours: number): Promise<unknown[]>
  machines(hours: number): Promise<unknown[]>
  machine(ip: string, hours: number): Promise<unknown>
  history(): unknown[]
  ruleset(q: { find: string; state: 'all' | 'on' | 'off'; offset: number }): Promise<unknown>
  devices(): Promise<unknown>
  inventory(hours: number): Promise<unknown>
  renameDevice(target: { id: number } | { ip: string }, name: string): unknown
  plugins(): unknown[]
  /**
   * Records a decision and hands it to the plugins. Throws with a message for the person when policy refuses it.
   * The rule's name is looked up by Redoubt from the sid, never taken from the model.
   */
  decide(d: { action: Action; sid: number; src: string; dst: string; reason: string }, user: string): Promise<{ id: number; enforced: boolean }>
  setRule(r: { sid: number; on: boolean; machine?: string | undefined; reason: string }, user: string): Promise<{ id: number; enforced: boolean }>
  undo(id: number, user: string, reason: string): boolean
  /** Read-only SQL, when a read-only ClickHouse login is configured. */
  sql?: (query: string) => Promise<{ rows: unknown[]; truncated: boolean }>
  schema?: () => Promise<unknown>
}
export const decideActions = ['allow', 'allow_machine', 'allow_all', 'silence_machine', 'silence_all', 'block'] as const
type Action = (typeof decideActions)[number]

/** Tools that change something. The built-in chat asks the person before any of these run. */
export const writeTools = ['decide_alert', 'set_rule', 'undo_decision', 'rename_device'] as const

export type Caller = { user: string; scope: Scope }

const instructions = `Redoubt watches a home network: Suricata alerts and connection records in ClickHouse (30 days), decisions people made in SQLite, and plugins that apply decisions to devices (firewall, sensor).
Start with get_overview or list_alerts. Addresses inside the configured internal networks are "machines"; others are "remote".
Policy, enforced by Redoubt whatever you ask: internal addresses are never blocked; a block on outgoing traffic stops that machine reaching that remote address (all ports); a block on incoming traffic stops that remote address for everyone; decisions stay until a person undoes them.
Recommend changes with evidence (alert counts, first seen, bytes, names) and propose them together so the person can approve them in one go.
If a tool is missing, data looks wrong, or you had to work around something, call report_gap.`

const out = (v: unknown) => {
  const text = JSON.stringify(v)
  // Keep a runaway result from filling the model's context.
  return { content: [{ type: 'text' as const, text: text.length > 60_000 ? `${text.slice(0, 60_000)}… [cut: ${text.length} characters in total; narrow the query]` : text }] }
}
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] })
const safe = <A,>(f: (a: A) => unknown) => async (a: A) => { try { return out(await f(a)) } catch (e) { return fail(e) } }
const ro = { readOnlyHint: true, openWorldHint: false }

export function mcpServer(s: Services, gaps: AgentStore['gaps'], who: Caller): McpServer {
  const server = new McpServer({ name: 'redoubt', version: '0.1.0' }, { instructions })
  const t = server.registerTool.bind(server)

  t('get_overview', { description: 'Internet bandwidth over time, busiest machines, open alerts without a decision, and how fresh the data is.', inputSchema: { hours }, annotations: ro },
    safe(({ hours }) => s.overview(hours)))
  t('get_status', { description: 'Sensor health: packets, drops, whether data is arriving, and how far back records go.', annotations: ro }, safe(() => s.summary()))
  t('list_alerts', {
    description: 'Alerts grouped by rule and address pair, worst first, each with the decision covering it (if any) and whether it is new.',
    inputSchema: { hours, open_only: z.boolean().default(false).describe('Only alerts no decision covers yet'), machine: ip.optional().describe('Only alerts involving this address'), limit: limit(500) },
    annotations: ro,
  }, safe(async ({ hours, open_only, machine, limit }) => {
    let rows = await s.alerts(hours)
    if (open_only) rows = rows.filter((r) => !r.decision)
    if (machine) rows = rows.filter((r) => r.machine === machine || r.remote === machine)
    return { total: rows.length, rows: rows.slice(0, limit) }
  }))
  t('get_alert', { description: 'One alert pair in depth: hourly hits, samples, history of the pair, bandwidth, other connections around it, and site names.', inputSchema: { sid: z.number().int().positive(), src: ip, dst: ip }, annotations: ro },
    safe(({ sid, src, dst }) => s.alertDetail(sid, src, dst)))
  t('list_rules_fired', { description: 'Which Suricata rules fired, how often and between how many pairs.', inputSchema: { hours, limit: limit(1000) }, annotations: ro },
    safe(async ({ hours, limit }) => (await s.rules(hours)).slice(0, limit)))
  t('search_ruleset', {
    description: 'Search the sensor\'s full rule set (needs a rules plugin), with any decision on each rule.',
    inputSchema: { find: z.string().max(100).default(''), state: z.enum(['all', 'on', 'off']).default('all'), offset: z.number().int().min(0).default(0) }, annotations: ro,
  }, safe((q) => s.ruleset(q)))
  t('list_machines', { description: 'Internal machines by traffic: bytes up and down, connections, distinct destinations, last seen, name.', inputSchema: { hours, limit: limit(1000) }, annotations: ro },
    safe(async ({ hours, limit }) => (await s.machines(hours)).slice(0, limit)))
  t('get_machine', { description: 'One machine: bandwidth, biggest connections with names and first-seen, destinations first seen in the last day, and its alerts.', inputSchema: { ip, hours }, annotations: ro },
    safe(({ ip, hours }) => s.machine(ip, hours)))
  t('list_devices', { description: 'Every device on the network, merged: MAC, IP and its history, hostname, the name in Redoubt and on the router, DNS names, traffic over these hours, and whether it is new.', inputSchema: { hours }, annotations: ro },
    safe(({ hours }) => s.inventory(hours)))
  t('list_device_records', { description: 'The raw records behind list_devices: DHCP leases, ARP and static DNS from each router, one per source. For checking where a name or address came from.', annotations: ro }, safe(() => s.devices()))
  t('list_plugins', { description: 'Plugins at this site, what they handle, and whether they are healthy.', annotations: ro }, safe(() => s.plugins()))
  t('list_decisions', { description: 'Decisions made, newest first, with whether each is in place on the devices.', inputSchema: { limit: limit(500) }, annotations: ro },
    safe(({ limit }) => s.history().slice(0, limit)))
  if (s.sql && s.schema) {
    const sql = s.sql
    t('describe_tables', { description: 'Tables and columns of the ClickHouse database, for query_sql.', annotations: ro }, safe(() => s.schema!()))
    t('query_sql', {
      description: 'Run one read-only ClickHouse SELECT over the flow and alert tables, for questions the other tools can\'t answer. Results are capped; aggregate rather than dump. Call describe_tables first.',
      inputSchema: { query: z.string().min(1).max(5000) }, annotations: ro,
    }, safe(({ query }) => sql(query)))
  }
  t('report_gap', {
    description: 'Tell the people building Redoubt about a missing tool, wrong or confusing data, or a workaround you needed. Goes to the Feedback list.',
    inputSchema: { title: z.string().min(3).max(120), details: z.string().max(4000).describe('What you tried, what was missing or wrong, and what would have helped') },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, safe(({ title, details }) => ({ id: gaps.add(title, details, who.user) })))

  if (who.scope !== 'write') return server
  const change = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  t('decide_alert', {
    description: `Decide on an alert pair, exactly like the buttons on the Alerts page. allow: this pair is fine. allow_machine: this rule is fine for this machine. allow_all: fine everywhere.
silence_machine / silence_all: stop the rule alerting for this machine / everyone (changes the sensor). block: block the remote address (outgoing: for this machine only; incoming: for everyone). Internal addresses can't be blocked.`,
    inputSchema: {
      action: z.enum(decideActions), sid: z.number().int().positive(), src: ip, dst: ip,
      reason: z.string().min(3).max(500).describe('Why, in one or two sentences, shown to the person approving'),
    },
    annotations: change,
  }, safe((d) => s.decide(d, who.user)))
  t('set_rule', {
    description: 'Turn a Suricata rule on or off for everyone, or off for one internal machine.',
    inputSchema: {
      sid: z.number().int().positive(), on: z.boolean(), machine: ip.optional().describe('Turn off for this machine only'),
      reason: z.string().min(3).max(500).describe('Why, in one or two sentences, shown to the person approving'),
    },
    annotations: change,
  }, safe((r) => s.setRule(r, who.user)))
  t('undo_decision', {
    description: 'Undo a decision by id (from list_decisions), removing anything it put on the devices.',
    inputSchema: { id: z.number().int().positive(), reason: z.string().min(3).max(500) },
    annotations: change,
  }, safe(({ id, reason }) => (s.undo(id, who.user, reason) ? { ok: true } : { ok: false, error: 'Already undone' })))
  t('rename_device', {
    description: 'Name a device in Redoubt, by its id from list_devices or its IP address. An empty name clears it. Does not change the router.',
    inputSchema: {
      id: z.number().int().positive().optional(), ip: ip.optional(),
      name: z.string().max(60).regex(/^[^\u0000-\u001f\u007f]*$/),
      reason: z.string().min(3).max(500).describe('Why this name, shown to the person approving'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, safe(({ id, ip, name }) => {
    if ((id === undefined) === (ip === undefined)) throw new Error('Give the device id or its address, not both')
    const d = s.renameDevice(id !== undefined ? { id } : { ip: ip! }, name)
    if (!d) throw new Error('No such device here')
    return d
  }))
  return server
}
