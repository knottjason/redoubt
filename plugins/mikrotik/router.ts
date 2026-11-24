export type Router = { name: string; url: string; read: Login; write?: Login }
export type Login = { user: string; password: string }
export type Item = Record<string, string>
export type Rest = { get(path: string): Promise<Item[]>; add(path: string, item: Item): Promise<void>; remove(path: string, id: string): Promise<void> }

/** RouterOS REST over HTTPS. The router's certificate must check out; there is no way to turn that off. */
export function rest(url: string, login: Login): Rest {
  if (!url.startsWith('https://')) throw new Error('The router address must be https')
  const auth = `Basic ${Buffer.from(`${login.user}:${login.password}`).toString('base64')}`
  async function go(method: string, path: string, body?: Item): Promise<unknown> {
    const r = await fetch(new URL(`/rest/${path}`, url), {
      method, redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { authorization: auth, ...(body && { 'content-type': 'application/json' }) }, ...(body && { body: JSON.stringify(body) }),
    })
    const text = await r.text()
    if (r.status === 404 && method === 'DELETE') return null
    if (!r.ok) {
      const j = (() => { try { return JSON.parse(text) as { message?: string; detail?: string } } catch { return {} } })()
      throw new Error(`Router: ${j.detail ?? j.message ?? r.status}`)
    }
    return text ? JSON.parse(text) : null
  }
  return {
    async get(path) { return (await go('GET', path)) as Item[] },
    async add(path, item) { await go('PUT', path, item) },
    async remove(path, id) { await go('DELETE', `${path}/${encodeURIComponent(id)}`) },
  }
}
