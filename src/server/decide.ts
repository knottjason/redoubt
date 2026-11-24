import type { BlockList } from 'node:net'
import { isInternal, orient } from '../shared/net.ts'
import type { Action, openDecisions } from './decisions.ts'
import { wants, type openPlugins } from './plugins.ts'

export const ruleActions: Action[] = ['rule_off', 'rule_on', 'silence_all']
type Refused = { error: string; status: 400 | 409 }
type Done = { id: number; enforced: boolean }

/** The only way a decision is made. Every check that must hold, whoever asks, is here. */
export function createService(decisions: ReturnType<typeof openDecisions>, plugins: ReturnType<typeof openPlugins>, c: { site: string; internal: BlockList; neverBlock: BlockList }) {
  const refuse = (error: string, status: 400 | 409 = 400): Refused => ({ error, status })
  function transaction<T>(f: () => T): T {
    decisions.db.exec('BEGIN')
    try {
      const r = f()
      decisions.db.exec('COMMIT')
      return r
    } catch (e) {
      decisions.db.exec('ROLLBACK')
      throw e
    }
  }
  const record = (d: Parameters<typeof decisions.add>[0], direction: 'in' | 'out' = 'out'): Done => transaction(() => {
    const entry = wants(d, direction)
    const id = decisions.add(d)
    return { id, enforced: entry ? plugins.request(d.site, id, entry) : false }
  })

  return {
    /** A choice about an alert. Takes the raw addresses, and works out itself which side is ours. */
    decide({ src, dst, ...d }: { site: string; action: Exclude<Action, 'rule_on' | 'rule_off'>; sid: number; src: string; dst: string; signature: string; user: string; reason?: string | undefined }): Done | Refused {
      if (d.site !== c.site) return refuse('That is another site')
      const { machine, remote, direction } = orient(src, dst, c.internal)
      if (d.action === 'block') {
        if (isInternal(remote, c.internal)) return refuse('Internal addresses are never blocked')
        if (direction === 'in' && c.neverBlock.check(remote, remote.includes(':') ? 'ipv6' : 'ipv4')) return refuse('That address is on the never-block list')
      }
      return record({ ...d, machine, remote }, direction === 'in' ? 'in' : 'out')
    },
    /** A rule on or off for everyone, or off for one machine. */
    setRule({ sid, on, signature, machine, user, reason }: { sid: number; on: boolean; signature: string; machine?: string | undefined; user: string; reason?: string | undefined }): Done | Refused {
      const here = decisions.active().filter((d) => d.site === c.site && d.sid === sid)
      if (machine !== undefined) {
        if (on) return refuse('A rule can be turned off for one machine, not on')
        if (!isInternal(machine, c.internal)) return refuse('That is not one of your machines')
        if (!plugins.handles(c.site, 'rule.silence')) return refuse('No plugin manages rules at this site', 409)
        if (here.some((d) => d.machine === machine && d.action === 'silence_machine')) return refuse('Already off for that machine', 409)
        return record({ site: c.site, action: 'silence_machine', sid, machine, remote: '', signature, user, reason })
      }
      if (!plugins.handles(c.site, on ? 'rule.enable' : 'rule.disable')) return refuse('No plugin manages rules at this site', 409)
      if (here.some((d) => ruleActions.includes(d.action))) return refuse('Undo the earlier decision on this rule first', 409)
      return record({ site: c.site, action: on ? 'rule_on' : 'rule_off', sid, machine: '', remote: '', signature, user, reason })
    },
    undo: (id: number, user: string, reason?: string): boolean => transaction(() => {
      const ok = decisions.undo(id, user, reason)
      if (ok) plugins.undo(id)
      return ok
    }),
  }
}
