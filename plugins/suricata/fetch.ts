// The only part with internet access, and it has access to nothing else: it downloads the rules and leaves them in a folder.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const url = process.env.RULES_URL ?? 'https://rules.emergingthreats.net/open/suricata-8.0.8/emerging.rules.tar.gz'
const dir = process.env.INCOMING_DIR ?? '/incoming'
const file = join(dir, 'emerging.rules.tar.gz')
const max = 60_000_000

async function get(u: string): Promise<Buffer> {
  const r = await fetch(u, { signal: AbortSignal.timeout(120_000) })
  if (!r.ok || !r.body) throw new Error(`${u}: ${r.status}`)
  const parts: Uint8Array[] = []
  let size = 0
  for await (const c of r.body) {
    size += c.length
    if (size > max) throw new Error('Download is too big')
    parts.push(c)
  }
  return Buffer.concat(parts)
}
const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex')

async function once(): Promise<string> {
  const want = (await get(`${url}.md5`)).toString('utf8').trim().split(/\s+/)[0] ?? ''
  if (!/^[0-9a-f]{32}$/.test(want)) throw new Error('No checksum published')
  if (existsSync(file) && md5(readFileSync(file)) === want) return 'no change'
  const body = await get(url)
  if (md5(body) !== want) throw new Error('The download does not match its checksum')
  writeFileSync(`${file}.new`, body)
  renameSync(`${file}.new`, file)
  return `${body.length} bytes`
}

for (;;) {
  let wait = 24 * 3600_000
  try {
    console.log(new Date().toISOString(), await once())
  } catch (e) {
    console.error(new Date().toISOString(), (e as Error).message)
    wait = 3600_000
  }
  await new Promise((r) => setTimeout(r, wait + Math.random() * 600_000))
}
export {}
