import { readFileSync } from 'node:fs'
import { parseNetworks } from '../../src/shared/net.ts'
import { createPlugin } from '../lib/serve.ts'
import { mikrotik } from './mikrotik.ts'
import { rest, type Router } from './router.ts'

const env = process.env
const stateDir = env.STATE_DIR ?? '/data'
const { routers, block } = JSON.parse(readFileSync(env.ROUTERS_FILE ?? '/run/secrets/routers.json', 'utf8')) as { routers: Router[]; block?: string }
const b = routers.find((r) => r.name === block)
if (block && !b?.write) throw new Error('The blocking router needs a write login')
const plugin = mikrotik({
  routers: routers.map((r) => ({ name: r.name, read: rest(r.url, r.read) })),
  ...(b?.write && { block: { read: rest(b.url, b.read), write: rest(b.url, b.write) } }),
  own: parseNetworks(env.INTERNAL_NETWORKS ?? '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16'),
  never: parseNetworks(env.NEVER_BLOCK ?? ''),
  stateDir,
})
const server = createPlugin(plugin, { key: env.PLUGIN_KEY ?? '', stateDir })
server.listen(Number(env.PORT ?? 8790), () => console.log('MikroTik plugin ready'))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
