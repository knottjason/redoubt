import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { Entry, RuleRow } from '../../src/shared/plugin.ts'
import type { Plugin } from '../lib/serve.ts'

const run = promisify(execFile)
export type Paths = { rules: string; own: string; disable: string; enable: string; incoming?: string; cache?: string }
export type Tools = { build(disable: string, enable: string, out: string): Promise<void>; reload(): Promise<{ loaded: number; failed: number }> }

export const realTools: Tools = {
  async build(disable, enable, out) {
    await run('suricata-update', ['--offline', '--no-test', '--no-reload', '--disable-conf', disable, '--enable-conf', enable, '-o', out], { timeout: 120_000, maxBuffer: 1e7 })
  },
  async reload() {
    const sc = async (c: string) => {
      const { stdout } = await run('suricatasc', ['-c', c], { timeout: 180_000 })
      const r = JSON.parse(stdout) as { return: string; message: unknown }
      if (r.return !== 'OK') throw new Error(`Suricata refused ${c}`)
      return r.message
    }
    await sc('ruleset-reload-rules')
    const s = (await sc('ruleset-stats')) as { rules_loaded: number; rules_failed: number }[]
    return { loaded: s.reduce((n, x) => n + x.rules_loaded, 0), failed: s.reduce((n, x) => n + x.rules_failed, 0) }
  },
}

const sidOk = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) < 2 ** 32
const text = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
const head = '# Written by Redoubt. Changes made here are overwritten.\n'

export function render(entries: Entry[]) {
  const sids = (k: string) => [...new Set(entries.filter((e) => e.kind === k).map((e) => e.sid))].sort((a, b) => a! - b!)
  const silence = [...new Set(entries.filter((e) => e.kind === 'rule.silence').map((e) => `suppress gen_id 1, sig_id ${e.sid}, track by_either, ip ${e.machine}`))].sort()
  return { off: sids('rule.disable'), on: sids('rule.enable'), threshold: head + silence.map((l) => `${l}\n`).join('') }
}

export function problem(e: Entry, known: Set<number>): string | undefined {
  if (!sidOk(e.sid)) return 'Not a rule number'
  if (!known.has(e.sid)) return 'No such rule in this sensor'
  if (e.kind === 'rule.silence' && !isIP(e.machine ?? '')) return 'Not an address'
}

export async function readRules(file: string): Promise<RuleRow[]> {
  const rows: RuleRow[] = []
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    const m = /^(# *)?(?:alert|drop|reject|pass)\s.*?\(msg:"((?:[^"\\]|\\.)*)"/.exec(line)
    const sid = m && /[;\s]sid:\s*(\d+);/.exec(line)
    if (!m || !sid) continue
    const severity = { Informational: 3, Minor: 3, Major: 2, Critical: 1 }[/signature_severity (\w+)/.exec(line)?.[1] ?? ''] ?? 3
    const msg = m[2]!.replace(/\\(.)/g, '$1')
    rows.push({ sid: Number(sid[1]), msg, classtype: /classtype:\s*([\w-]+)/.exec(line)?.[1] ?? '', group: msg.split(' ').slice(0, 2).join(' '), severity, on: !m[1] })
  }
  return rows
}

export function suricata(p: Paths, tools: Tools = realTools): Plugin {
  mkdirSync(p.own, { recursive: true })
  const live = join(p.rules, 'suricata.rules')
  const threshold = join(p.own, 'threshold.config')
  let cache: { at: number; rows: RuleRow[] } | undefined
  let busy = false
  let trouble = ''
  async function all() {
    const at = statSync(live).mtimeMs
    if (cache?.at !== at) cache = { at, rows: await readRules(live) }
    return cache.rows
  }

  const wasOff = join(p.own, 'disabled.json')
  const updates = join(p.own, 'update.json')
  type Update = { applied: string; tried: string; at: string; note: string; added: number; gone: number }
  const lastUpdate = (): Update => ({ applied: '', tried: '', at: '', note: '', added: 0, gone: 0, ...(JSON.parse(text(updates) || '{}') as Partial<Update>) })

  /** Every change to the sensor goes through here: build aside, check, swap, reload, and put everything back if the sensor objects. */
  async function change(c: { off: (number | undefined)[]; on: (number | undefined)[]; rebuild: boolean; threshold: string; maxMoved: number; download?: { from: string; to: string } }) {
    const oldThreshold = text(threshold) || head
    const silence = c.threshold !== oldThreshold
    if (!c.rebuild && !silence) return { added: 0, gone: 0 }
    busy = true
    const work = mkdtempSync(join(tmpdir(), 'redoubt-'))
    const keep = join(p.rules, 'suricata.rules.redoubt-previous')
    const oldDownload = join(work, 'previous.tar.gz')
    let replaced = false
    let touched = false
    let moved = { added: 0, gone: 0 }
    try {
      if (c.rebuild) {
        const lines = (base: string, sids: (number | undefined)[]) => `${text(base)}\n${sids.join('\n')}\n`
        writeFileSync(join(work, 'disable.conf'), lines(p.disable, c.off))
        writeFileSync(join(work, 'enable.conf'), lines(p.enable, c.on))
        if (c.download) {
          copyFileSync(c.download.to, oldDownload)
          swap(c.download.from, c.download.to)
        }
        const out = join(work, 'out')
        mkdirSync(out)
        await tools.build(join(work, 'disable.conf'), join(work, 'enable.conf'), out)
        const next = await readRules(join(out, 'suricata.rules'))
        const rows = await all()
        const before = rows.filter((r) => r.on).length
        const after = next.filter((r) => r.on).length
        // Anything bigger than what was asked for means the rebuild went wrong.
        if (Math.abs(after - before) > c.maxMoved || after === 0) throw new Error(`The rebuilt rules look wrong: ${before} on before, ${after} after. Nothing was changed`)
        const had = new Set(rows.map((r) => r.sid))
        const has = new Set(next.map((r) => r.sid))
        moved = { added: [...has].filter((x) => !had.has(x)).length, gone: [...had].filter((x) => !has.has(x)).length }
        copyFileSync(live, keep)
        replaced = true
        touched = true
        swap(join(out, 'suricata.rules'), live)
      }
      if (silence) {
        touched = true
        writeThreshold(c.threshold)
      }
      const r = await tools.reload()
      if (r.failed > 0 || r.loaded === 0) throw new Error(`Suricata could not load ${r.failed} rules`)
      trouble = ''
      return moved
    } catch (e) {
      trouble = (e as Error).message
      if (existsSync(oldDownload)) swap(oldDownload, c.download!.to)
      if (replaced) renameSync(keep, live)
      if (text(threshold) !== oldThreshold && touched) writeThreshold(oldThreshold)
      if (touched) await tools.reload().catch((x: Error) => { trouble += `; putting it back failed: ${x.message}` })
      throw new Error(trouble)
    } finally {
      cache = undefined
      busy = false
      rmSync(work, { recursive: true, force: true })
    }
  }

  /** A new rule download is waiting: take it, keeping every choice. */
  async function update() {
    const from = join(p.incoming!, 'emerging.rules.tar.gz')
    if (!existsSync(from)) return
    const sum = createHash('sha256').update(readFileSync(from)).digest('hex')
    const last = lastUpdate()
    if (sum === last.applied || sum === last.tried) return
    const cached = readdirSync(p.cache!).filter((f) => /^[0-9a-f]{32}-emerging\.rules\.tar\.gz$/.test(f))
    if (cached.length !== 1) throw new Error('Cannot tell which rule download the sensor uses')
    const to = join(p.cache!, cached[0]!)
    const at = new Date().toISOString()
    const note = (u: Partial<Update>) => writeFileSync(updates, JSON.stringify({ ...last, at, ...u }))
    const same = createHash('sha256').update(readFileSync(to)).digest('hex') === sum
    if (same) return note({ applied: sum, tried: '', note: 'already current' })
    const chosen = JSON.parse(text(wasOff) || '{"off":[],"on":[]}') as { off: number[]; on: number[] }
    const on = (await all()).filter((r) => r.on).length
    try {
      const moved = await change({ ...chosen, rebuild: true, threshold: text(threshold) || head, maxMoved: Math.max(500, Math.round(on * 0.1)), download: { from, to } })
      note({ applied: sum, tried: '', note: 'updated', ...moved })
      console.log('rules updated', moved)
    } catch (e) {
      // Not tried again until there is a different download.
      note({ tried: sum, note: `failed: ${(e as Error).message}` })
      throw e
    }
  }

  return {
    describe: { name: 'Suricata', version: '0.1.0', kinds: ['rule.disable', 'rule.enable', 'rule.silence'], rules: true },
    async apply(entries) {
      const known = new Set((await all()).map((r) => r.sid))
      const errors = new Map(entries.map((e) => [e.id, problem(e, known)] as const))
      const want = render(entries.filter((e) => !errors.get(e.id)))
      const choice = JSON.stringify({ off: want.off, on: want.on, base: text(p.disable), baseOn: text(p.enable) })
      const rebuild = text(wasOff) ? choice !== text(wasOff) : want.off.length + want.on.length > 0
      await change({ off: want.off, on: want.on, rebuild, threshold: want.threshold, maxMoved: 200 + entries.length })
      if (rebuild) writeFileSync(wasOff, choice)
      return { results: entries.map((e) => { const error = errors.get(e.id); return error ? { id: e.id, ok: false, error } : { id: e.id, ok: true } }) }
    },
    ...(p.incoming && p.cache ? { background: { every: 600_000, run: update } } : {}),
    async health() {
      const u = lastUpdate()
      const day = u.at.slice(0, 16).replace('T', ' ')
      const about = !u.at ? '' : u.note.startsWith('failed') ? `; rule update ${day} UTC ${u.note}` : `; rules updated ${day} UTC, ${u.added} new, ${u.gone} gone`
      return { healthy: !trouble && !u.note.startsWith('failed'), message: (busy ? 'Reloading rules' : trouble || `${(await all()).filter((r) => r.on).length} rules on${about}`).slice(0, 390) }
    },
    async rules({ find, state, offset, limit }) {
      const rows = await all()
      const f = String(find).toLowerCase()
      const hit = rows.filter((r) => (state === 'all' || r.on === (state === 'on')) && (!f || `${r.sid} ${r.msg} ${r.classtype}`.toLowerCase().includes(f)))
      const on = rows.filter((r) => r.on).length
      return { total: hit.length, on, off: rows.length - on, rows: hit.slice(offset, offset + Math.min(limit, 200)) }
    },
  }
  function swap(from: string, to: string) {
    copyFileSync(from, `${to}.new`)
    renameSync(`${to}.new`, to)
  }
  function writeThreshold(s: string) {
    writeFileSync(`${threshold}.new`, s)
    renameSync(`${threshold}.new`, threshold)
  }
}
