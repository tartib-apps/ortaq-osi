import type { RequestCategory, RequestPlan, RequestTriage } from '@ortaq/shared'
import type { LegalAnswerOut, ProposalAnalysisOut, SummaryOut, VoiceExtractionOut } from './schemas'

/**
 * Языковая модель за интерфейсом (docs/11). Провайдер получает только обезличенный текст:
 * вызывать его напрямую нельзя, только через AiService, который делает redact() и считает лимиты.
 * Смена Gemini на другую модель — новая реализация интерфейса, а не переписывание функций.
 */
export const AI_PROVIDER = Symbol('AiProvider')

export type TriageInput = {
  /** Обезличенный текст заявки */
  text: string
  category: RequestCategory
  location: string
  /** Открытые заявки по той же локации: номер и обезличенный краткий текст */
  candidates: { number: number; text: string }[]
}

export type SuggestInput = { text: string; category: RequestCategory; location: string }

/** Аудио обезличить нельзя — поэтому модель не получает справочник людей: имя сопоставляем у себя */
export type VoiceInput = { audio: Buffer; mimeType: string; entrances: number; floors: number | null }

export type ProposalsInput = {
  subject: string | null
  /** Обезличенный текстовый слой каждого КП в порядке загрузки */
  documents: { index: number; text: string }[]
}

export type LegalInput = {
  /** Обезличенный вопрос председателя */
  question: string
  articles: { ref: number; document: string; article: string; title: string; content: string }[]
}

/** Только агрегаты дома: ни фамилий, ни номеров квартир (docs/11 §3.7) */
export type SummaryFacts = {
  week: { start: string; end: string }
  requests: { created: number; done: number; open_critical: number; done_by_category: Record<string, number>; done_titles: string[] }
  tasks: { approved: number; approved_titles: string[]; overdue: number }
  finance: { expenses_total: number; expenses_by_category: Record<string, number>; income_total: number; collection_rate_percent: number | null }
  votes: { active: { title: string; ends_at: string; turnout_percent: number }[]; closed: { title: string; decided: boolean }[] }
  announcements: number
}

/** Вывод модели и расход токенов: без токенов нельзя держать месячную квоту дома */
export type AiOut<T> = { value: T; tokensIn?: number; tokensOut?: number; model?: string }

export interface AiProvider {
  readonly name: string
  readonly model: string
  /** false — внешней модели нет, работают правила: функции, которым нужна настоящая модель, недоступны */
  readonly capable: boolean
  triage(input: TriageInput): Promise<AiOut<RequestTriage>>
  suggest(input: SuggestInput): Promise<AiOut<RequestPlan>>
  extractVoiceTasks(input: VoiceInput): Promise<AiOut<VoiceExtractionOut>>
  compareProposals(input: ProposalsInput): Promise<AiOut<ProposalAnalysisOut>>
  answerLegal(input: LegalInput): Promise<AiOut<LegalAnswerOut>>
  weeklySummary(input: SummaryFacts): Promise<AiOut<SummaryOut>>
  /** Векторы для поиска по статьям; null — эмбеддинги недоступны, поиск идёт полнотекстом */
  embed(texts: string[], kind: 'query' | 'document'): Promise<number[][] | null>
  /** Текст чека с фото: без ФИО плательщика, номер карты маскирован. null — не умеет */
  readReceipt(image: Buffer, mimeType: string): Promise<AiOut<string> | null>
}

/** Модель недоступна или ответила не по схеме: вызывающий переходит на ручной путь */
export class AiUnavailableError extends Error {
  constructor(message = 'Модель недоступна') {
    super(message)
  }
}
