import { execFile } from 'node:child_process'
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { Entry, RuleRow } from '../../src/shared/plugin.ts'
import type { Plugin } from '../lib/serve.ts'

const run = promisify(execFile)
export type Paths = { rules: string; own: string; disable: string; enable: string }
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

  return {
    describe: { name: 'Suricata', version: '0.1.0', kinds: ['rule.disable', 'rule.enable', 'rule.silence'], rules: true },
    async apply(entries) {
      const known = new Set((await all()).map((r) => r.sid))
      const errors = new Map(entries.map((e) => [e.id, problem(e, known)] as const))
      const want = render(entries.filter((e) => !errors.get(e.id)))
      const wasOff = join(p.own, 'disabled.json')
      const choice = JSON.stringify({ off: want.off, on: want.on, base: text(p.disable), baseOn: text(p.enable) })
      const rebuild = text(wasOff) ? choice !== text(wasOff) : want.off.length + want.on.length > 0
      const silence = want.threshold !== (text(threshold) || head)
      if (rebuild || silence) {
        busy = true
        const work = mkdtempSync(join(tmpdir(), 'redoubt-'))
        const oldThreshold = text(threshold) || head
        const keep = join(p.rules, 'suricata.rules.redoubt-previous')
        let replaced = false
        try {
          if (rebuild) {
            const lines = (base: string, sids: (number | undefined)[]) => `${text(base)}\n${sids.join('\n')}\n`
            writeFileSync(join(work, 'disable.conf'), lines(p.disable, want.off))
            writeFileSync(join(work, 'enable.conf'), lines(p.enable, want.on))
            const out = join(work, 'out')
            mkdirSync(out)
            await tools.build(join(work, 'disable.conf'), join(work, 'enable.conf'), out)
            const next = await readRules(join(out, 'suricata.rules'))
            const before = (await all()).filter((r) => r.on).length
            const after = next.filter((r) => r.on).length
            // Each choice moves one rule, plus a few that depend on it. Anything bigger means the rebuild went wrong.
            if (Math.abs(after - before) > 200 + entries.length || after === 0) throw new Error(`The rebuilt rules look wrong: ${before} on before, ${after} after. Nothing was changed`)
            copyFileSync(live, keep)
            copyFileSync(join(out, 'suricata.rules'), `${live}.new`)
            renameSync(`${live}.new`, live)
            replaced = true
          }
          if (silence) writeThreshold(want.threshold)
          const r = await tools.reload()
          if (r.failed > 0 || r.loaded === 0) throw new Error(`Suricata could not load ${r.failed} rules`)
          if (rebuild) writeFileSync(wasOff, choice)
          trouble = ''
        } catch (e) {
          trouble = (e as Error).message
          if (replaced) renameSync(keep, live)
          if (text(threshold) !== oldThreshold) writeThreshold(oldThreshold)
          if (replaced || silence) await tools.reload().catch((x: Error) => { trouble += `; putting it back failed: ${x.message}` })
          throw new Error(trouble)
        } finally {
          cache = undefined
          busy = false
          rmSync(work, { recursive: true, force: true })
        }
      }
      return { results: entries.map((e) => { const error = errors.get(e.id); return error ? { id: e.id, ok: false, error } : { id: e.id, ok: true } }) }
    },
    async health() {
      return { healthy: !trouble, message: busy ? 'Reloading rules' : trouble || `${(await all()).filter((r) => r.on).length} rules on` }
    },
    async rules({ find, state, offset, limit }) {
      const rows = await all()
      const f = String(find).toLowerCase()
      const hit = rows.filter((r) => (state === 'all' || r.on === (state === 'on')) && (!f || `${r.sid} ${r.msg} ${r.classtype}`.toLowerCase().includes(f)))
      const on = rows.filter((r) => r.on).length
      return { total: hit.length, on, off: rows.length - on, rows: hit.slice(offset, offset + Math.min(limit, 200)) }
    },
  }
  function writeThreshold(s: string) {
    writeFileSync(`${threshold}.new`, s)
    renameSync(`${threshold}.new`, threshold)
  }
}
