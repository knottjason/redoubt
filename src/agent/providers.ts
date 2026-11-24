import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createXai } from '@ai-sdk/xai'
import type { LanguageModel } from 'ai'

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'xai' | 'local'
export type ModelInfo = { id: string; provider: ProviderId; model: string; label: string; context: number }
type Env = Record<string, string | undefined>

const keys: Record<Exclude<ProviderId, 'local'>, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  xai: 'XAI_API_KEY',
}
// Used when AGENT_MODELS gives no context size. Small for local models, which are often run with a short context.
const defaultContext: Record<ProviderId, number> = { anthropic: 200_000, openai: 128_000, google: 1_000_000, xai: 128_000, local: 32_768 }

/**
 * The models on offer, from AGENT_MODELS: comma separated `provider:model`, optionally `@context` in tokens.
 * Model ids change too often to hard-code. A model whose provider has no key is left out, never guessed at.
 *   AGENT_MODELS=anthropic:claude-sonnet-5-5,local:qwen3:32b@40960
 */
export function listModels(env: Env): ModelInfo[] {
  const out: ModelInfo[] = []
  for (const raw of (env.AGENT_MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const at = raw.lastIndexOf('@')
    const spec = at > 0 && /^\d+$/.test(raw.slice(at + 1)) ? raw.slice(0, at) : raw
    const colon = spec.indexOf(':')
    const provider = spec.slice(0, colon) as ProviderId
    const model = spec.slice(colon + 1)
    if (colon < 1 || !model || !(provider in defaultContext)) throw new Error(`AGENT_MODELS: cannot read "${raw}" (want provider:model, provider one of ${Object.keys(defaultContext).join(', ')})`)
    if (!available(env, provider)) continue
    const context = spec === raw ? defaultContext[provider] : Number(raw.slice(at + 1))
    const label = provider === 'local' ? `${model} (${env.LOCAL_MODEL_NAME || 'local'})` : model
    out.push({ id: `${provider}:${model}`, provider, model, label, context })
  }
  return out
}

export function available(env: Env, p: ProviderId): boolean {
  return p === 'local' ? Boolean(env.LOCAL_MODEL_URL) : Boolean(env[keys[p]])
}

/** An AI SDK model for one of the listed models. Keys come from the environment only. */
export function languageModel(env: Env, m: Pick<ModelInfo, 'provider' | 'model'>): LanguageModel {
  switch (m.provider) {
    case 'anthropic': return createAnthropic({ apiKey: env[keys.anthropic] })(m.model)
    case 'openai': return createOpenAI({ apiKey: env[keys.openai] })(m.model)
    case 'google': return createGoogleGenerativeAI({ apiKey: env[keys.google] })(m.model)
    case 'xai': return createXai({ apiKey: env[keys.xai] })(m.model)
    // Ollama, llama.cpp, vLLM, LM Studio: anything that speaks the OpenAI chat API.
    case 'local': return createOpenAICompatible({ name: 'local', baseURL: env.LOCAL_MODEL_URL!, apiKey: env.LOCAL_MODEL_KEY || undefined })(m.model)
  }
}
