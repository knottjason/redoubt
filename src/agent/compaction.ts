import { generateText, type LanguageModel } from 'ai'

/** The part of a stored chat message compaction needs. Matches the AI SDK's UIMessage. */
export type Msg = { id: string; role: 'system' | 'user' | 'assistant'; parts: unknown[] }

export const compactAt = 0.75
// Fold away about this share of what the model sees, never less than `min` or more than `max` when a clean cut exists.
const share = { min: 0.2, aim: 0.3, max: 0.4 }

/** Rough size in tokens. */
export const roughTokens = (m: Msg) => Math.ceil(JSON.stringify(m.parts).length / 4)

export function needsCompaction(inputTokens: number, context: number): boolean {
  return inputTokens > context * compactAt
}

/**
 * Where to cut: the index of the first message that stays. Always the start of a user message,
 * so a tool call is never separated from its result, and never the latest user message.
 * Returns 0 when there is nothing sensible to fold.
 */
export function cutPoint(msgs: Msg[]): number {
  const sizes = msgs.map(roughTokens)
  const total = sizes.reduce((a, b) => a + b, 0)
  const lastUser = msgs.findLastIndex((m) => m.role === 'user')
  let best = 0
  let bestDist = Infinity
  let before = 0
  for (let i = 0; i < msgs.length; i++) {
    if (i > 0 && i < lastUser && msgs[i]!.role === 'user') {
      const f = before / total
      // Inside the band, closest to the aim wins; outside it, only if nothing inside exists.
      const dist = Math.abs(f - share.aim) + (f < share.min || f > share.max ? 1 : 0)
      if (dist < bestDist) { best = i; bestDist = dist }
    }
    before += sizes[i]!
  }
  return best
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more characters]` : s)

/** Plain text of messages for the summarizer. Tool results are clipped: the summary keeps conclusions, not data. */
export function transcript(msgs: Msg[]): string {
  const lines: string[] = []
  for (const m of msgs) {
    for (const p of m.parts as Record<string, unknown>[]) {
      if (p.type === 'text') lines.push(`${m.role.toUpperCase()}: ${p.text}`)
      else if (typeof p.type === 'string' && (p.type.startsWith('tool-') || p.type === 'dynamic-tool')) {
        const name = p.type === 'dynamic-tool' ? String(p.toolName) : p.type.slice(5)
        lines.push(`TOOL ${name}(${clip(JSON.stringify(p.input ?? {}), 300)}) -> ${p.state === 'output-denied' ? 'denied by the user' : clip(JSON.stringify(p.output ?? p.errorText ?? null), 1500)}`)
      }
    }
  }
  return lines.join('\n')
}

const instructions = `You keep the running memory of a conversation between a person and the assistant built into Redoubt, a home network security app.
Write a summary that replaces the earlier part of the conversation. The assistant will see only your summary plus the newer messages.
Keep: what the person asked for and why, decisions made (allowed, blocked, silenced, rules turned on or off, and what was denied), conclusions about machines and addresses, open questions, the person's stated preferences, and anything promised for later.
Keep exact IPs, ports, rule ids (sid), decision ids and hostnames. Drop raw tool output and repetition. Use short sections and bullet points. No preamble.`

/** A new running summary that folds `older` into the previous one. */
export async function summarize(model: LanguageModel, previous: string | null, older: Msg[], abortSignal?: AbortSignal): Promise<string> {
  const { text } = await generateText({
    model,
    system: instructions,
    prompt: `${previous ? `Summary so far:\n${previous}\n\n` : ''}Conversation to fold in:\n${transcript(older)}`,
    abortSignal,
  })
  return text.trim()
}
