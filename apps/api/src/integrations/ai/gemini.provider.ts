import { Logger } from '@nestjs/common'
import type { RequestPlan, RequestTriage } from '@ortaq/shared'
import { z } from 'zod'
import {
  AiUnavailableError, type AiOut, type AiProvider, type LegalInput, type ProposalsInput, type SuggestInput, type SummaryFacts,
  type TriageInput, type VoiceInput,
} from './ai.provider'
import { legalPrompt, proposalsPrompt, RECEIPT_PROMPT, suggestPrompt, summaryPrompt, triagePrompt, voicePrompt } from './prompts'
import { legalOut, proposalsOut, receiptOut, suggestOut, summaryOut, triageOut, voiceOut } from './schemas'

const API = 'https://generativelanguage.googleapis.com/v1beta'
const EMBEDDING_MODEL = 'gemini-embedding-001'
export const EMBEDDING_DIM = 768
const EMBED_BATCH = 20
/** Бесплатный уровень считает каждую строку пакета: при 429 ждём и повторяем */
const EMBED_RETRIES = 5
/** Inline-вложение Gemini ограничено 20 МБ на запрос, base64 добавляет треть */
const MAX_INLINE_BYTES = 14 * 1024 * 1024

/** fast — разбор заявок, ответ за секунды; smart — документы, аудио и законы, где важнее качество */
type Tier = 'fast' | 'smart'
const TIER: Record<Tier, { thinking: string; timeoutMs: number }> = {
  fast: { thinking: 'minimal', timeoutMs: 20_000 },
  // На одну модель цепочки: зависшая первая не съедает всё время функции
  smart: { thinking: 'low', timeoutMs: 35_000 },
}
/** Перегрузка и лимиты провайдера — повод попробовать следующую модель цепочки, а не ошибка функции */
const RETRYABLE = new Set([429, 500, 502, 503, 504])
const RETRY_PAUSE_MS = 4000

type Part = { text: string } | { inline_data: { mime_type: string; data: string } }

type GenerateResponse = {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
  modelVersion?: string
  promptFeedback?: { blockReason?: string }
}

export type GeminiConfig = { apiKey: string; fastModels: string[]; smartModels: string[] }

/**
 * Gemini через REST (docs/11). Ответ всегда structured output по JSON Schema из zod-схемы
 * и повторно проверяется zod: схема на стороне провайдера — удобство, а не гарантия.
 */
export class GeminiProvider implements AiProvider {
  readonly name = 'gemini'
  readonly capable = true
  readonly model: string
  private readonly log = new Logger('Gemini')

  constructor(private readonly cfg: GeminiConfig) {
    this.model = cfg.fastModels[0] ?? 'gemini'
  }

  triage(i: TriageInput): Promise<AiOut<RequestTriage>> {
    const p = triagePrompt(i)
    return this.json('fast', triageOut, p.system, [{ text: p.user }])
  }

  suggest(i: SuggestInput): Promise<AiOut<RequestPlan>> {
    const p = suggestPrompt(i)
    return this.json('fast', suggestOut, p.system, [{ text: p.user }])
  }

  extractVoiceTasks(i: VoiceInput) {
    if (i.audio.length > MAX_INLINE_BYTES) throw new AiUnavailableError('Запись слишком большая для распознавания')
    const p = voicePrompt(i)
    return this.json('smart', voiceOut, p.system, [{ inline_data: { mime_type: i.mimeType, data: i.audio.toString('base64') } }, { text: p.user }])
  }

  compareProposals(i: ProposalsInput) {
    const p = proposalsPrompt(i)
    return this.json('smart', proposalsOut, p.system, [{ text: p.user }])
  }

  answerLegal(i: LegalInput) {
    const p = legalPrompt(i)
    return this.json('smart', legalOut, p.system, [{ text: p.user }])
  }

  weeklySummary(f: SummaryFacts) {
    const p = summaryPrompt(f)
    return this.json('fast', summaryOut, p.system, [{ text: p.user }])
  }

  async readReceipt(image: Buffer, mimeType: string): Promise<AiOut<string> | null> {
    if (image.length > MAX_INLINE_BYTES) return null
    const out = await this.json('fast', receiptOut, RECEIPT_PROMPT, [{ inline_data: { mime_type: mimeType, data: image.toString('base64') } }])
    return { ...out, value: out.value.text }
  }

  async embed(texts: string[], kind: 'query' | 'document'): Promise<number[][] | null> {
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH)
      const body = {
        requests: batch.map((t) => ({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text: t }] },
          taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
          outputDimensionality: EMBEDDING_DIM,
        })),
      }
      let res = await this.post<{ embeddings?: { values: number[] }[] }>(`${API}/models/${EMBEDDING_MODEL}:batchEmbedContents`, body, 60_000)
      // Запрос жильца не ждёт минуту: повторы — только для загрузки корпуса
      for (let attempt = 1; !res.ok && res.status === 429 && kind === 'document' && attempt <= EMBED_RETRIES; attempt++) {
        await new Promise((r) => setTimeout(r, 15_000 * attempt))
        res = await this.post<{ embeddings?: { values: number[] }[] }>(`${API}/models/${EMBEDDING_MODEL}:batchEmbedContents`, body, 60_000)
      }
      if (!res.ok) throw new AiUnavailableError(`Эмбеддинги: HTTP ${res.status}`)
      const vectors = res.body.embeddings?.map((e) => normalize(e.values)) ?? []
      if (vectors.length !== batch.length) throw new AiUnavailableError('Эмбеддинги: неполный ответ')
      out.push(...vectors)
    }
    return out
  }

  /**
   * Цепочка моделей: перегруженная первая не роняет функцию, если ответит вторая. Если перегружены
   * все — второй проход после паузы: 503 у провайдера обычно длится секунды
   */
  private async json<T>(tier: Tier, schema: z.ZodType<T, unknown>, system: string, parts: Part[]): Promise<AiOut<T>> {
    const models = tier === 'fast' ? this.cfg.fastModels : this.cfg.smartModels
    let last = 'модели не настроены'
    const passes = tier === 'fast' ? [models] : [models, models]
    for (const [pass, chain] of passes.entries()) {
      if (pass > 0) await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS))
      const res = await this.chain(chain, schema, system, parts, TIER[tier])
      if ('value' in res) return res
      last = res.error
      if (!res.retryable) break
    }
    throw new AiUnavailableError(last)
  }

  private async chain<T>(models: string[], schema: z.ZodType<T, unknown>, system: string, parts: Part[], tier: (typeof TIER)[Tier]): Promise<AiOut<T> | { error: string; retryable: boolean }> {
    let last = 'модели не настроены'
    for (const model of models) {
      const res = await this.post<GenerateResponse>(`${API}/models/${model}:generateContent`, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseJsonSchema: jsonSchema(schema),
          thinkingConfig: { thinkingLevel: tier.thinking },
        },
      }, tier.timeoutMs).catch((e: unknown) => ({ ok: false as const, status: 0, error: e instanceof Error ? e.message : String(e) }))

      if (!res.ok) {
        last = 'error' in res ? res.error : `HTTP ${res.status}`
        if (res.status === 0 || RETRYABLE.has(res.status)) {
          this.log.warn(`${model}: ${last}, пробую следующую модель`)
          continue
        }
        return { error: `${model}: ${last}`, retryable: false }
      }
      const body = res.body
      if (body.promptFeedback?.blockReason) return { error: `Запрос отклонён провайдером: ${body.promptFeedback.blockReason}`, retryable: false }
      const candidate = body.candidates?.[0]
      const raw = candidate?.content?.parts?.filter((p) => !p.thought && p.text).map((p) => p.text).join('') ?? ''
      if (!raw) {
        last = `пустой ответ (${candidate?.finishReason ?? 'нет кандидатов'})`
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        last = 'ответ не JSON'
        continue
      }
      const valid = schema.safeParse(parsed)
      if (!valid.success) {
        last = `ответ не по схеме: ${valid.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
        continue
      }
      const usage = body.usageMetadata
      return {
        value: valid.data,
        tokensIn: usage?.promptTokenCount ?? 0,
        tokensOut: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
        model: body.modelVersion ?? model,
      }
    }
    return { error: last, retryable: true }
  }

  private async post<T>(url: string, body: unknown, timeoutMs: number): Promise<{ ok: true; status: number; body: T } | { ok: false; status: number }> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.cfg.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      // Тело ошибки провайдера не логируем целиком: в нём может оказаться фрагмент запроса
      return { ok: false, status: res.status }
    }
    return { ok: true, status: res.status, body: (await res.json()) as T }
  }
}

const schemaCache = new WeakMap<z.ZodType, object>()

/** JSON Schema для structured output: без служебных ключей, которые провайдер не принимает */
export function jsonSchema(schema: z.ZodType): object {
  const cached = schemaCache.get(schema)
  if (cached) return cached
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any', io: 'input' }) as Record<string, unknown>
  schemaCache.set(schema, rest)
  return rest
}

/** Векторы с усечённой размерностью приходят ненормированными — косинус считаем по нормированным */
function normalize(v: number[]): number[] {
  const norm = Math.hypot(...v) || 1
  return v.map((x) => x / norm)
}
