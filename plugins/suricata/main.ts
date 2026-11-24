import { createPlugin } from '../lib/serve.ts'
import { suricata } from './suricata.ts'

const env = process.env
const own = env.OWN_DIR ?? '/var/lib/suricata/redoubt'
const plugin = suricata({ rules: env.RULES_DIR ?? '/var/lib/suricata/rules', own, disable: env.BASE_DISABLE ?? '/etc/redoubt/disable.conf', enable: env.BASE_ENABLE ?? '/etc/redoubt/enable.conf',
  ...(env.INCOMING_DIR && { incoming: env.INCOMING_DIR, cache: env.CACHE_DIR ?? '/var/lib/suricata/update/cache' }) })
const server = createPlugin(plugin, { key: env.PLUGIN_KEY ?? '', stateDir: own })
server.listen(Number(env.PORT ?? 8790), () => console.log('Suricata plugin ready'))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
