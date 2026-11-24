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
  useQuery({ queryKey: ['alerts', hours], queryFn: () => unwrap(client.alerts.$get({ query: { hours: String(hours) } })), refetchInterval: 15_000, placeholderData: keepPreviousData })
export const useDetail = (k: { sid: number; src: string; dst: string } | null) =>
  useQuery({ queryKey: ['detail', k?.sid, k?.src, k?.dst], enabled: !!k, queryFn: () => unwrap(client.alerts.detail.$get({ query: { sid: String(k!.sid), src: k!.src, dst: k!.dst } })) })
export const useMachines = (hours: number) =>
  useQuery({ queryKey: ['machines', hours], queryFn: () => unwrap(client.machines.$get({ query: { hours: String(hours) } })), refetchInterval: 60_000, placeholderData: keepPreviousData })
export const useMachine = (ip: string, hours: number) =>
  useQuery({ queryKey: ['machine', ip, hours], queryFn: () => unwrap(client.machines[':ip'].$get({ param: { ip }, query: { hours: String(hours) } })), refetchInterval: 60_000, placeholderData: keepPreviousData })
export const useHistory = () => useQuery({ queryKey: ['decisions'], queryFn: () => unwrap(client.decisions.$get()) })

export type Alert = NonNullable<ReturnType<typeof useAlerts>['data']>[number]
export type Action = 'allow' | 'silence_machine' | 'silence_all' | 'block'

export function useDecide() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { action: Action; alert: Alert } | { undo: number }): Promise<unknown> =>
      'undo' in v
        ? unwrap(client.decisions[':id'].undo.$post({ param: { id: String(v.undo) } }, { headers: { 'content-type': 'application/json' } }))
        : unwrap(client.decisions.$post({ json: { action: v.action, sid: v.alert.sid, machine: v.alert.machine, remote: v.alert.remote, signature: v.alert.signature } })),
    onSuccess: () => qc.invalidateQueries(),
  })
}
