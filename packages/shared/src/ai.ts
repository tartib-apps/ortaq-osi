import { z } from 'zod'
import { Specialization } from './enums.js'
import { LocationType, Priority } from './requests.js'

/* Фаза 5: ИИ-надстройка (docs/11, docs/03 §17). ИИ готовит черновик — решает человек */

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max)

/** Ограничения входа (docs/11 §4) */
export const AI_LIMITS = {
  callsPerHour: 20,
  inputChars: 100_000,
  proposalFiles: 10,
  proposalFileBytes: 20 * 1024 * 1024,
  voiceSeconds: 600,
} as const

export const AI_FEATURES = ['REQUEST_TRIAGE', 'REQUEST_SUGGEST', 'RECEIPT_OCR', 'VOICE_EXTRACT', 'PROPOSAL_COMPARE', 'LEGAL_QA', 'WEEKLY_SUMMARY'] as const
export type AiFeature = (typeof AI_FEATURES)[number]

export type AiUsage = {
  provider: string
  model: string
  enabled: boolean
  hour: { used: number; limit: number }
  month: { tokens: number; limit: number; calls: number }
  by_type: { type: AiFeature; calls: number; failed: number; accepted: number; modified: number; rejected: number }[]
}

/* ───────── голосовые задачи (§3.4) ───────── */

export const AUDIO_MIME = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'] as const
export type AudioMime = (typeof AUDIO_MIME)[number]

export const createVoiceNoteBody = z.object({
  audio_file_id: z.uuid(),
  duration_sec: z.number().int().min(1).max(AI_LIMITS.voiceSeconds, 'Голосовое длиннее 10 минут'),
})
export type CreateVoiceNoteBody = z.input<typeof createVoiceNoteBody>

export type VoiceTaskCandidate = {
  title: string
  description: string | null
  specialization: Specialization | null
  priority: Priority
  location: { type: LocationType | null; entrance: number | null; floor: number | null; detail: string | null }
  /** Имя, услышанное в записи. Сопоставление с персоналом — подсказка, распознавание путает имена */
  mentioned_assignee: string | null
  suggested_assignee_id: string | null
  due_hint: string | null
}

export type VoiceNoteStatus = 'PROCESSING' | 'EXTRACTED' | 'FAILED' | 'REVIEWED'

export type VoiceNoteView = {
  id: string
  status: VoiceNoteStatus
  duration_sec: number
  transcript: string | null
  tasks: VoiceTaskCandidate[]
  error: string | null
  created_task_ids: string[]
  audio_file_id: string
  created_at: string
}

export const confirmVoiceTasksBody = z.object({
  tasks: z.array(z.object({
    title: trimmed(3, 200),
    description: trimmed(1, 2000).nullable().optional(),
    specialization: z.enum(Specialization).nullable().optional(),
    priority: z.enum(Priority).default('NORMAL'),
    assignee_id: z.uuid().nullable().optional(),
    contractor_id: z.uuid().nullable().optional(),
    due_at: z.iso.datetime().nullable().optional(),
  })).min(1, 'Выберите хотя бы одну задачу').max(30),
})
export type ConfirmVoiceTasksBody = z.input<typeof confirmVoiceTasksBody>

/* ───────── сравнение КП (§3.5) ───────── */

export const createComparisonBody = z.object({
  title: trimmed(3, 200),
  subject: trimmed(3, 1000).nullable().optional(),
  file_ids: z.array(z.uuid()).min(2, 'Нужно хотя бы два предложения').max(AI_LIMITS.proposalFiles, 'Не больше 10 предложений'),
})
export type CreateComparisonBody = z.input<typeof createComparisonBody>

export const decideComparisonBody = z.object({
  proposal_id: z.uuid(),
  note: trimmed(1, 1000).nullable().optional(),
})
export type DecideComparisonBody = z.input<typeof decideComparisonBody>

export type ParsedProposal = {
  contractor_name: string | null
  total_price: number | null
  currency: string
  duration_days: number | null
  warranty_months: number | null
  prepayment_percent: number | null
  includes: string[]
  excludes: string[]
  hidden_costs: string[]
  payment_terms: string | null
}

export type ProposalAnalysis = {
  proposals: ParsedProposal[]
  comparison: { criterion: string; values: string[]; best_index: number | null }[]
  recommendation: { proposal_index: number | null; reasoning: string; risks: string[] }
  warnings: string[]
}

export type ComparisonStatus = 'PROCESSING' | 'DONE' | 'FAILED' | 'DECIDED'

export type ComparisonView = {
  id: string
  title: string
  subject: string | null
  status: ComparisonStatus
  error: string | null
  analysis: ProposalAnalysis | null
  recommended_proposal_id: string | null
  decided_proposal_id: string | null
  decided_at: string | null
  decision_note: string | null
  proposals: { id: string; order: number; file_id: string; file_name: string; contractor_name: string | null; parsed: ParsedProposal | null }[]
  created_at: string
}

/* ───────── юрпомощник (§3.6) ───────── */

export const legalAskBody = z.object({ question: trimmed(5, 1000) })
export type LegalAskBody = z.input<typeof legalAskBody>

export type LegalCitation = { document: string; article: string; title: string; quote: string; source_url: string }

export type LegalAnswer = {
  id: string
  question: string
  /** false — основания в законодательстве не нашлось: ответа без источника не бывает */
  found: boolean
  answer: string
  citations: LegalCitation[]
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  suggested_action: { type: 'CREATE_VOTE'; decision_type: string } | null
  disclaimer: string
  created_at: string
}

/* ───────── еженедельная сводка (§3.7) ───────── */

export type WeeklySummaryView = {
  id: string
  week_start: string
  week_end: string
  summary_text: string
  highlights: string[]
  needs_attention: string[]
  published_at: string
}
