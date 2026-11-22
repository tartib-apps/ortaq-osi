import { LocationType, Priority, RequestCategory, Specialization } from '@ortaq/shared'
import { z } from 'zod'

/**
 * Схемы ответов модели (docs/11 §1, правило 2). Модель возвращает только JSON по схеме;
 * всё, что не прошло zod, отбрасывается — свободный текст модели не исполняется и не парсится.
 *
 * Длины и диапазоны — обрезкой после ответа, а не ограничениями в JSON Schema: провайдер
 * компилирует схему в автомат, и maxLength/maxItems/minimum на вложенных массивах делают его
 * «слишком большим для обслуживания» (HTTP 400). Обрезка надёжнее отказа: длинный ответ — не повод терять результат.
 */
const text = (max: number) => z.string().transform((s) => s.slice(0, max))
const arr = <T extends z.ZodType>(item: T, max: number) => z.array(item).transform((a) => a.slice(0, max))
const list = (max: number, len: number) => arr(text(len), max)
const clamp = (min: number, max: number) => z.number().transform((n) => Math.min(max, Math.max(min, n)))
const int = () => z.number().transform((n) => Math.round(n))

export const triageOut = z.object({
  is_meaningful: z.boolean(),
  category: z.enum(RequestCategory),
  suggested_priority: z.enum(Priority),
  priority_reason: text(300),
  duplicate_of: int().nullable(),
  duplicate_confidence: clamp(0, 1),
  needs_clarification: z.boolean(),
  clarification_hint: text(300).nullable(),
  spam_likelihood: clamp(0, 1),
})

export const suggestOut = z.object({
  steps: arr(z.object({
    order: int(),
    title: text(120),
    specialization: z.enum(Specialization).nullable(),
    urgency: z.enum(['IMMEDIATE', 'TODAY', 'THIS_WEEK']),
  }), 15),
  estimated_specialization: z.enum(Specialization).nullable(),
  safety_notes: list(5, 300),
  requires_contractor: z.boolean(),
})

export const voiceOut = z.object({
  transcript: text(20_000),
  tasks: arr(z.object({
    title: text(200),
    description: text(1000).nullable(),
    specialization: z.enum(Specialization).nullable(),
    priority: z.enum(Priority),
    location_type: z.enum(LocationType).nullable(),
    entrance: int().nullable(),
    floor: int().nullable(),
    location_detail: text(200).nullable(),
    mentioned_assignee: text(80).nullable(),
    due_hint: text(80).nullable(),
  }), 30),
})
export type VoiceExtractionOut = z.infer<typeof voiceOut>

const proposal = z.object({
  index: int(),
  contractor_name: text(200).nullable(),
  total_price: z.number().nullable(),
  currency: text(8),
  duration_days: int().nullable(),
  warranty_months: int().nullable(),
  prepayment_percent: clamp(0, 100).nullable(),
  includes: list(20, 200),
  excludes: list(20, 200),
  hidden_costs: list(10, 300),
  payment_terms: text(300).nullable(),
})

export const proposalsOut = z.object({
  proposals: arr(proposal, 10),
  comparison: arr(z.object({ criterion: text(80), values: list(10, 200), best_index: int().nullable() }), 12),
  recommendation: z.object({ proposal_index: int().nullable(), reasoning: text(2000), risks: list(8, 300) }),
  warnings: list(12, 300),
})
export type ProposalAnalysisOut = z.infer<typeof proposalsOut>

export const legalOut = z.object({
  found: z.boolean(),
  answer: text(4000),
  /** Ссылки — номера переданных статей, а не текст: выдумать статью модель не может */
  citations: arr(z.object({ ref: int(), quote: text(600) }), 6),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  suggested_vote_decision_type: z.enum([
    'ROUTINE', 'CURRENT_REPAIR', 'TARIFF_CHANGE', 'TARGETED_CONTRIBUTION', 'CHAIRMAN_ELECTION', 'MAJOR_EXPENSE',
    'CAPITAL_REPAIR', 'MANAGEMENT_CHANGE', 'LIQUIDATION', 'COMMON_PROPERTY_DISPOSAL',
  ]).nullable(),
})
export type LegalAnswerOut = z.infer<typeof legalOut>

export const summaryOut = z.object({
  summary_text: text(1500),
  highlights: list(6, 200),
  needs_attention: list(5, 200),
})
export type SummaryOut = z.infer<typeof summaryOut>

export const receiptOut = z.object({
  /** Текст чека построчно, без ФИО плательщика, с маскированным номером карты */
  text: text(4000),
})
