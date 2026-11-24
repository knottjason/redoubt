import { BlockList, isIP } from 'node:net'

export function parseNetworks(spec: string): BlockList {
  const list = new BlockList()
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [addr = '', bits] = part.split('/')
    const family = isIP(addr)
    if (!family) throw new Error(`Invalid network: ${part}`)
    const prefix = bits === undefined ? (family === 4 ? 32 : 128) : Number(bits)
    list.addSubnet(addr, prefix, family === 4 ? 'ipv4' : 'ipv6')
  }
  return list
}

// Never treated as outside, whatever the configuration says.
export const specialNetworks = '0.0.0.0/8,10.0.0.0/8,100.64.0.0/10,127.0.0.0/8,169.254.0.0/16,172.16.0.0/12,192.168.0.0/16,224.0.0.0/3,::/127,fc00::/7,fe80::/10,ff00::/8'
const special = parseNetworks(specialNetworks)

export function isInternal(ip: string, own: BlockList): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  const addr = mapped?.[1] ?? ip
  const family = isIP(addr)
  if (!family) return true
  const type = family === 4 ? 'ipv4' : 'ipv6'
  return own.check(addr, type) || special.check(addr, type)
}

/** Which side of a connection is ours, and which way it went. */
export function orient(src: string, dst: string, own: BlockList) {
  const s = isInternal(src, own)
  const d = isInternal(dst, own)
  if (s || !d) return { machine: src, remote: dst, direction: s && d ? ('internal' as const) : ('out' as const) }
  return { machine: dst, remote: src, direction: 'in' as const }
}
