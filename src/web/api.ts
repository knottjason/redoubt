import { hc } from 'hono/client'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AppType } from '../server/app.ts'

const client = hc<AppType>('/').api

type Failure = { success: false } | { error: string }
type Body<R> = R extends { json(): Promise<infer B> } ? Exclude<B, Failure> : never

async function unwrap<R extends { ok: boolean; status: number; json(): Promise<unknown> }>(p: Promise<R>): Promise<Body<R>> {
  const r = await p
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: unknown } | null
    throw new Error(typeof body?.error === 'string' ? body.error : `Request failed (${r.status})`)
  }
  return (await r.json()) as Body<R>
}

export const useSummary = () => useQuery({ queryKey: ['summary'], queryFn: () => unwrap(client.summary.$get()), refetchInterval: 30_000 })
export const useAlerts = (hours: number) =>
  useQuery({ queryKey: ['alerts', hours], queryFn: () => unwrap(client.alerts.$get({ query: { hours: String(hours) } })), refetchInterval: (q) => ((q.state.data as { decision: { applied: { state: string } | null } | null }[] | undefined)?.some((a) => ['requested', 'removing'].includes(a.decision?.applied?.state ?? '')) ? 3_000 : 15_000), placeholderData: keepPreviousData })
export const useDetail = (k: { sid: number; src: string; dst: string } | null) =>
  useQuery({ queryKey: ['detail', k?.sid, k?.src, k?.dst], enabled: !!k, queryFn: () => unwrap(client.alerts.detail.$get({ query: { sid: String(k!.sid), src: k!.src, dst: k!.dst } })) })
export const useMachines = (hours: number) =>
  useQuery({ queryKey: ['machines', hours], queryFn: () => unwrap(client.machines.$get({ query: { hours: String(hours) } })), refetchInterval: 60_000, placeholderData: keepPreviousData })
export const useMachine = (ip: string, hours: number) =>
  useQuery({ queryKey: ['machine', ip, hours], queryFn: () => unwrap(client.machines[':ip'].$get({ param: { ip }, query: { hours: String(hours) } })), refetchInterval: 60_000, placeholderData: keepPreviousData })
export const useOverview = (hours: number) =>
  useQuery({ queryKey: ['overview', hours], queryFn: () => unwrap(client.overview.$get({ query: { hours: String(hours) } })), refetchInterval: 30_000, placeholderData: keepPreviousData })
export const useRules = (hours: number) =>
  useQuery({ queryKey: ['rules', hours], queryFn: () => unwrap(client.rules.$get({ query: { hours: String(hours) } })), refetchInterval: 60_000, placeholderData: keepPreviousData })
export const useRuleset = (find: string, state: 'all' | 'on' | 'off', offset: number) =>
  useQuery({ queryKey: ['ruleset', find, state, offset], queryFn: () => unwrap(client.ruleset.$get({ query: { find, state, offset: String(offset) } })), refetchInterval: 3_000, placeholderData: keepPreviousData })
export const useInventory = (hours: number) =>
  useQuery({ queryKey: ['inventory', hours], queryFn: () => unwrap(client.inventory.$get({ query: { hours: String(hours) } })), refetchInterval: 60_000, placeholderData: keepPreviousData })
export const useRename = () => useAct((v: { id?: number; ip?: string; name: string; dns: boolean }) => unwrap(client.inventory.name.$post({ json: v })))
export const useKnown = () => useAct((id: number) => unwrap(client.inventory[':id'].known.$post({ param: { id: String(id) } }, { headers: { 'content-type': 'application/json' } })))
export const useWatch = () => useAct((v: { cidr: string; on: boolean }) => unwrap(client.inventory.watch.$post({ json: v })))
export const usePlugins = () => useQuery({ queryKey: ['plugins'], queryFn: () => unwrap(client.plugins.$get()), refetchInterval: 5_000 })
const json = { headers: { 'content-type': 'application/json' } }
export function useAct<V>(f: (v: V) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: f, onSuccess: () => qc.invalidateQueries() })
}
export const useToggleRule = () => useAct((v: { sid: number; on: boolean; signature: string; machine?: string }) => unwrap(client.ruleset[':sid'].$post({ param: { sid: String(v.sid) }, json: { on: v.on, signature: v.signature, ...(v.machine && { machine: v.machine }) } })))
export const useDescribe = () => useMutation({ mutationFn: (v: { url: string; key: string }) => unwrap(client.plugins.describe.$post({ json: v })) })
export const useAddPlugin = () => useAct((v: { url: string; key: string }) => unwrap(client.plugins.$post({ json: v })))
export const useRemovePlugin = () => useAct((id: number) => unwrap(client.plugins[':id'].remove.$post({ param: { id: String(id) } }, json)))
export const useHistory = () => useQuery({ queryKey: ['decisions'], queryFn: () => unwrap(client.decisions.$get()), refetchInterval: 3_000 })

export type Alert = NonNullable<ReturnType<typeof useAlerts>['data']>[number]
export type Action = 'allow' | 'allow_machine' | 'allow_all' | 'silence_machine' | 'silence_all' | 'block'

export function useDecide() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { action: Action; alert: Alert } | { undo: number }): Promise<unknown> =>
      'undo' in v
        ? unwrap(client.decisions[':id'].undo.$post({ param: { id: String(v.undo) } }, { headers: { 'content-type': 'application/json' } }))
        : unwrap(client.decisions.$post({ json: { site: v.alert.site, action: v.action, sid: v.alert.sid, src: v.alert.src, dst: v.alert.dst, signature: v.alert.signature } })),
    onSuccess: () => qc.invalidateQueries(),
  })
}
