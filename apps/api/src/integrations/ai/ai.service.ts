import { Inject, Injectable, Logger } from '@nestjs/common'
import type { AiJobType } from '@prisma/client'
import { AI_FEATURES, ErrorCode, type AiUsage, type RequestCategory, type RequestPlan, type RequestTriage } from '@ortaq/shared'
import { asSystem } from '../../common/context'
import { AppError } from '../../common/errors'
import { env } from '../../config/env'
import { PrismaService } from '../../infra/prisma.service'
import {
  AI_PROVIDER, AiUnavailableError, type AiOut, type AiProvider, type LegalInput, type ProposalsInput, type SummaryFacts, type VoiceInput,
} from './ai.provider'
import { PROMPT_VERSION } from './prompts'
import { redact, restore } from './redactor'
import { INJECTION } from './rules-ai.provider'

const CANDIDATE_CHARS = 200

/** Сколько ждать модель. Триаж держит создание заявки — поэтому коротко; документы и аудио — дольше */
const TIMEOUT_MS: Record<AiJobType, number> = {
  REQUEST_TRIAGE: 12_000,
  REQUEST_SUGGEST: 30_000,
  RECEIPT_OCR: 30_000,
  VOICE_EXTRACT: 180_000,
  PROPOSAL_COMPARE: 180_000,
  LEGAL_QA: 150_000,
  WEEKLY_SUMMARY: 60_000,
}

type RequestText = { id: string; houseId: string; text: string; category: RequestCategory; location: string }

/** Исчерпан лимит дома: функция ИИ отключается с понятным сообщением, остальная работа идёт (docs/11 §4) */
export const aiLimit = (message: string) => new AppError(429, ErrorCode.AI_LIMIT, message)
export const aiUnavailable = (message = 'ИИ сейчас недоступен. Попробуйте позже или сделайте это вручную') =>
  new AppError(503, ErrorCode.AI_UNAVAILABLE, message)

/**
 * Единственная дверь к модели. Правило 1 (docs/11): ИИ готовит, человек решает —
 * результат всегда подсказка. Правило 2: вывод модели — данные, не команда.
 * Каждый вызов пишется в ai_jobs: без этого нельзя понять, полезен ли ИИ, и держать лимиты дома.
 */
@Injectable()
export class AiService {
  private readonly log = new Logger('Ai')

  constructor(
    private readonly db: PrismaService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  /** Есть ли настоящая модель: без неё голосовые и полноценные ответы недоступны */
  get capable(): boolean {
    return this.provider.capable
  }

  /** null — модель недоступна: заявка уходит председателю с пометкой «без автопроверки» */
  async triage(req: RequestText, candidates: { number: number; text: string }[], names: string[]): Promise<{ jobId: string; triage: RequestTriage } | null> {
    const own = redact(req.text, names)
    const input = {
      text: own.text,
      category: req.category,
      location: req.location,
      candidates: candidates.map((c) => ({ number: c.number, text: redact(c.text, names).text.slice(0, CANDIDATE_CHARS) })),
    }
    const res = await this.tryCall('REQUEST_TRIAGE', req.houseId, { request_id: req.id }, async () => {
      const out = await this.provider.triage(input)
      const t = out.value
      // Попытка командовать моделью видна и правилом: модель могла её не заметить в длинном тексте
      const injected = INJECTION.test(req.text)
      return {
        ...out,
        value: {
          ...t,
          priority_reason: restore(t.priority_reason, own.map),
          clarification_hint: t.clarification_hint && restore(t.clarification_hint, own.map),
          // Номер дубликата принимаем только из списка кандидатов: модель не выдумывает ссылки
          duplicate_of: candidates.some((c) => c.number === t.duplicate_of) ? t.duplicate_of : null,
          spam_likelihood: injected ? Math.max(t.spam_likelihood, 0.8) : t.spam_likelihood,
        },
      }
    })
    return res && { jobId: res.jobId, triage: res.value }
  }

  async suggest(req: RequestText, names: string[]): Promise<{ jobId: string; plan: RequestPlan } | null> {
    const own = redact(req.text, names)
    const res = await this.tryCall('REQUEST_SUGGEST', req.houseId, { request_id: req.id }, async () => {
      const out = await this.provider.suggest({ text: own.text, category: req.category, location: req.location })
      const p = out.value
      return { ...out, value: { ...p, steps: p.steps.slice(0, 15).map((s, i) => ({ ...s, order: i + 1, title: restore(s.title, own.map).slice(0, 120) })) } }
    })
    return res && { jobId: res.jobId, plan: res.value }
  }

  /** Голосовое: аудио нельзя обезличить, поэтому модель не получает ни справочник людей, ни данные дома */
  voice(houseId: string, voiceNoteId: string, input: VoiceInput) {
    return this.call('VOICE_EXTRACT', houseId, { voice_note_id: voiceNoteId }, () => this.provider.extractVoiceTasks(input))
  }

  /** Тексты КП обезличиваются здесь: телефоны, ИИН, почта, карты и известные системе ФИО не уходят наружу */
  async proposals(houseId: string, comparisonId: string, input: ProposalsInput, names: string[]) {
    const maps: Map<string, string>[] = []
    const documents = input.documents.map((d) => {
      const r = redact(d.text, names)
      maps.push(r.map)
      return { index: d.index, text: r.text }
    })
    const subject = input.subject && redact(input.subject, names).text
    return this.call('PROPOSAL_COMPARE', houseId, { comparison_id: comparisonId }, () => this.provider.compareProposals({ subject, documents }), { maps })
  }

  legal(houseId: string, questionRef: string, input: LegalInput) {
    return this.call('LEGAL_QA', houseId, { question_ref: questionRef }, () => this.provider.answerLegal(input))
  }

  summary(houseId: string, week: string, facts: SummaryFacts) {
    return this.call('WEEKLY_SUMMARY', houseId, { week_start: week }, () => this.provider.weeklySummary(facts))
  }

  /** Распознавание чека по фото. null — модель не умеет или недоступна: поля введёт жилец */
  async receipt(houseId: string | null, receiptRef: string, image: Buffer, mimeType: string): Promise<string | null> {
    if (!this.provider.capable || !houseId) return null
    const res = await this.tryCall('RECEIPT_OCR', houseId, { receipt_ref: receiptRef }, async () => {
      const out = await this.provider.readReceipt(image, mimeType)
      if (!out) throw new AiUnavailableError('Провайдер не распознаёт изображения')
      // Номер карты маскируем и после модели: модель могла переписать его целиком
      return { ...out, value: out.value.replace(/\b(?:\d[ -]?){12,15}(\d{4})\b/g, '•• $1') }
    })
    return res?.value ?? null
  }

  /** Эмбеддинги вопросов и статей. Вызов не пишется в журнал: в нём нет данных дома */
  async embed(texts: string[], kind: 'query' | 'document'): Promise<number[][] | null> {
    try {
      return await this.provider.embed(texts, kind)
    } catch (e) {
      this.log.warn(`Эмбеддинги недоступны: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  /** Что председатель сделал с подсказкой: принял, поправил, отклонил */
  async decide(jobId: string | undefined | null, decision: 'ACCEPTED' | 'MODIFIED' | 'REJECTED') {
    if (!jobId) return
    // Позднейшая правка человека информативнее раннего согласия: «принял, потом исправил» — это MODIFIED
    const where = decision === 'ACCEPTED' ? { id: jobId, humanDecision: null } : { id: jobId }
    await asSystem(() => this.db.run((tx) => tx.aiJob.updateMany({ where, data: { humanDecision: decision } })))
  }

  /** Расход дома: лимиты, качество подсказок по доле принятых (docs/11 §5) */
  async usage(houseId: string): Promise<AiUsage> {
    const { hourly, monthly } = limits()
    const since = new Date(Date.now() - 3600_000)
    const rows = await asSystem(() => this.db.run(async (tx) => ({
      hour: await tx.aiJob.count({ where: { houseId, createdAt: { gte: since }, status: { not: 'REJECTED' } } }),
      month: await tx.aiJob.aggregate({ where: { houseId, createdAt: { gte: monthStart() } }, _sum: { tokensIn: true, tokensOut: true }, _count: true }),
      byType: await tx.aiJob.groupBy({ by: ['type', 'status', 'humanDecision'], where: { houseId, createdAt: { gte: monthStart() } }, _count: true }),
    })))
    return {
      provider: this.provider.name,
      model: this.provider.model,
      enabled: this.provider.capable,
      hour: { used: rows.hour, limit: hourly },
      month: { tokens: (rows.month._sum.tokensIn ?? 0) + (rows.month._sum.tokensOut ?? 0), limit: monthly, calls: rows.month._count },
      by_type: AI_FEATURES.map((type) => {
        const of = rows.byType.filter((r) => r.type === type)
        const n = (f: (r: (typeof of)[number]) => boolean) => of.filter(f).reduce((s, r) => s + r._count, 0)
        return {
          type, calls: n((r) => r.status !== 'REJECTED'), failed: n((r) => r.status === 'FAILED'),
          accepted: n((r) => r.humanDecision === 'ACCEPTED'), modified: n((r) => r.humanDecision === 'MODIFIED'), rejected: n((r) => r.humanDecision === 'REJECTED'),
        }
      }).filter((t) => t.calls > 0),
    }
  }

  /** Вызов, который не должен ронять основной сценарий: при отказе — null и ручной путь */
  private async tryCall<T>(type: AiJobType, houseId: string, inputRef: object, fn: () => Promise<AiOut<T>>): Promise<{ jobId: string; value: T } | null> {
    try {
      return await this.call(type, houseId, inputRef, fn)
    } catch {
      return null
    }
  }

  /**
   * Вызов с лимитами и журналом. Бросает AppError: лимит (429) или недоступность (503).
   * maps — карты обезличивания: восстанавливаем реальные значения в ответе перед сохранением
   */
  private async call<T>(type: AiJobType, houseId: string, inputRef: object, fn: () => Promise<AiOut<T>>, opts: { maps?: Map<string, string>[] } = {}): Promise<{ jobId: string; value: T }> {
    const blocked = await this.overLimit(houseId)
    const base = { houseId, type, provider: this.provider.name, inputRef: { ...inputRef, prompt: PROMPT_VERSION } }
    if (blocked) {
      await this.record({ ...base, model: this.provider.model, status: 'REJECTED', error: blocked })
      throw aiLimit(blocked)
    }

    const started = Date.now()
    let out: AiOut<T> | null = null
    let error: string | null = null
    let timer: NodeJS.Timeout | undefined
    try {
      out = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AiUnavailableError('timeout')), TIMEOUT_MS[type]) }),
      ])
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      this.log.warn(`${type} не выполнен: ${error}`)
    } finally {
      clearTimeout(timer)
    }
    const value = out && opts.maps?.length ? (restoreDeep(out.value, opts.maps) as T) : out?.value
    const job = await this.record({
      ...base, model: out?.model ?? this.provider.model,
      // Ссылка на сущность, а не текст: в журнале вызовов нет содержимого заявок и документов
      output: (value ?? undefined) as object | undefined,
      status: out ? 'DONE' : 'FAILED', latencyMs: Date.now() - started, error,
      tokensIn: out?.tokensIn ?? null, tokensOut: out?.tokensOut ?? null,
    })
    if (!out) throw aiUnavailable()
    return { jobId: job.id, value: value as T }
  }

  private async overLimit(houseId: string): Promise<string | null> {
    const { hourly, monthly } = limits()
    const since = new Date(Date.now() - 3600_000)
    const [calls, tokens] = await asSystem(() => this.db.run(async (tx) => [
      await tx.aiJob.count({ where: { houseId, createdAt: { gte: since }, status: { not: 'REJECTED' } } }),
      await tx.aiJob.aggregate({ where: { houseId, createdAt: { gte: monthStart() } }, _sum: { tokensIn: true, tokensOut: true } }),
    ] as const))
    if (calls >= hourly) return `Лимит ИИ дома — ${hourly} запросов в час. Попробуйте через час или сделайте это вручную`
    const used = (tokens._sum.tokensIn ?? 0) + (tokens._sum.tokensOut ?? 0)
    if (used >= monthly) return 'Месячная квота ИИ дома исчерпана. Функции ИИ вернутся в начале следующего месяца'
    return null
  }

  private record(data: Parameters<PrismaService['client']['aiJob']['create']>[0]['data']) {
    return asSystem(() => this.db.run((tx) => tx.aiJob.create({ data })))
  }
}

function limits() {
  return { hourly: env().AI_HOURLY_CALLS, monthly: env().AI_MONTHLY_TOKENS }
}

function monthStart(): Date {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}

/** Обратная подстановка во все строки ответа: в КП плейсхолдеры могут оказаться где угодно */
function restoreDeep(v: unknown, maps: Map<string, string>[]): unknown {
  if (typeof v === 'string') return maps.reduce((s, m) => restore(s, m), v)
  if (Array.isArray(v)) return v.map((x) => restoreDeep(x, maps))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, restoreDeep(x, maps)]))
  return v
}
