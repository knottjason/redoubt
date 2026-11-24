import { readFileSync, statSync } from 'node:fs'
import { parseNetworks, specialNetworks } from '../shared/net.ts'

const env = process.env
const need = (k: string) => {
  const v = env[k]
  if (!v) throw new Error(`${k} is required`)
  return v
}

const name = (k: string, fallback: string) => {
  const v = env[k] || fallback
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(v)) throw new Error(`${k} must be lower-case letters, digits and dashes`)
  return v
}

const internalSpec = env.INTERNAL_NETWORKS ?? '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16'

export const config = {
  // Where this data was seen, and by which collector. A site keeps equal private addresses at two places apart.
  site: name('SITE', 'main'),
  source: name('SOURCE', 'suricata'),
  port: Number(env.PORT ?? 8787),
  clickhouse: {
    url: env.CLICKHOUSE_URL ?? 'http://127.0.0.1:8123',
    username: env.CLICKHOUSE_USER ?? 'redoubt',
    password: need('CLICKHOUSE_PASSWORD'),
    database: env.CLICKHOUSE_DATABASE ?? 'netmon',
  },
  internal: parseNetworks(internalSpec),
  internalList: `${internalSpec},${specialNetworks}`.split(',').map((n) => n.trim()).filter(Boolean),
  // Never blocked for everyone (one machine still can be): your resolvers, VPN peers, shared CDN ranges.
  neverBlock: parseNetworks(env.NEVER_BLOCK ?? ''),
  dataDir: env.DATA_DIR ?? './data',
  hostsFile: env.HOSTS_FILE ?? './hosts.json',
  trustedProxies: parseNetworks(env.TRUSTED_PROXIES ?? ''),
  authHeader: (env.AUTH_HEADER ?? 'remote-user').toLowerCase(),
  runQueue: env.RUN_QUEUE !== 'false',
  devUser: env.NODE_ENV === 'production' ? '' : (env.DEV_USER ?? ''),
  // The agent's read-only SQL. A separate login the ClickHouse server holds to readonly=1 with limits; no login, no SQL tool.
  agentClickhouse: env.CLICKHOUSE_AGENT_USER ? {
    url: env.CLICKHOUSE_URL ?? 'http://127.0.0.1:8123',
    username: env.CLICKHOUSE_AGENT_USER,
    password: need('CLICKHOUSE_AGENT_PASSWORD'),
    database: env.CLICKHOUSE_DATABASE ?? 'netmon',
  } : undefined,
}

let hosts: Record<string, string> = {}
let hostsMtime = 0
let learned: Record<string, string> = {}
export const setLearned = (names: Record<string, string>) => { learned = names }
export function hostName(ip: string): string {
  try {
    const m = statSync(config.hostsFile).mtimeMs
    if (m !== hostsMtime) {
      hosts = JSON.parse(readFileSync(config.hostsFile, 'utf8'))
      hostsMtime = m
    }
  } catch {
    // No names file: addresses are shown as they are.
  }
  return Object.hasOwn(learned, ip) ? learned[ip]! : Object.hasOwn(hosts, ip) ? hosts[ip]! : ''
}
