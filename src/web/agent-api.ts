import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = (await r.json().catch(() => null)) as { error?: unknown } | null
  if (!r.ok) throw new Error(typeof j?.error === 'string' ? j.error : `Request failed (${r.status})`)
  return j as T
}

export type Model = { id: string; label: string; context: number }
export type Token = { id: number; name: string; scope: 'read' | 'write'; created: string; last_used: string | null; revoked: string | null }
export type Gap = { id: number; title: string; details: string; reporter: string; created: string; closed: string | null }

export const useModels = () => useQuery({ queryKey: ['agent', 'models'], queryFn: () => call<Model[]>('/agent/models') })
export const useHistory = () => useQuery({ queryKey: ['agent', 'messages'], queryFn: () => call<{ messages: any[]; summarizedUpTo: string | null; busy: boolean }>('/agent/messages'), refetchOnWindowFocus: false })
export const useTokens = () => useQuery({ queryKey: ['agent', 'tokens'], queryFn: () => call<Token[]>('/agent/tokens') })
export const useGaps = () => useQuery({ queryKey: ['feedback'], queryFn: () => call<Gap[]>('/feedback'), refetchInterval: 30_000 })

function useDo<V, T>(f: (v: V) => Promise<T>) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: f, onSuccess: () => qc.invalidateQueries({ queryKey: ['agent'] }).then(() => qc.invalidateQueries({ queryKey: ['feedback'] })) })
}
export const useCreateToken = () => useDo((v: { name: string; scope: 'read' | 'write' }) => call<{ token: string; id: number }>('/agent/tokens', v))
export const useRevokeToken = () => useDo((id: number) => call(`/agent/tokens/${id}/revoke`, {}))
export const useCloseGap = () => useDo((id: number) => call(`/feedback/${id}/close`, {}))
export const clearChat = () => call('/agent/clear', {})
export const stopChat = () => call('/agent/stop', {})
